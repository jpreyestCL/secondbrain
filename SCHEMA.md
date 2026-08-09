# SCHEMA — Ontología del Second Brain

Este documento define la ontología del grafo de conocimiento personal (Graphiti sobre FalkorDB).
Toda ingesta —manual (`/guardar`) o por lote (`/ingest`)— debe respetar este esquema.

## 1. Dominios (metadata, NO particiones)

Hay **un grafo por tenant** y el `group_id` de todo episodio es **siempre el tenant** (el driver de FalkorDB usa el `group_id` como nombre del grafo; el servidor MCP lo fuerza al tenant). Los dominios **no** son `group_ids` ni particiones del grafo: son **metadata** que viaja en dos lugares:

- en el `source_description`: `dominio: <dominio> | tipo: <doc_type> | origen: <descripcion>`
- como prefijo en el nombre del episodio: `[<dominio>] ...`

El filtrado por dominio al consultar es blando (query semántica y/o filtrar por `source_description`); la frontera dura de aislamiento es el grafo + ACL por tenant. Ver ADR-006 en `docs/decisiones.md`.

| Dominio | Contenido |
|---|---|
| `personal` | Identidad, familia, hogar, trámites, vehículos, viajes, notas de vida |
| `salud` | Exámenes, diagnósticos, tratamientos, médicos, isapre/seguros de salud |
| `finanzas` | Cuentas bancarias, tarjetas, inversiones, deudas, impuestos, suscripciones pagadas |
| `trabajo` | Empleo, empleadores, clientes, contratos, boletas/facturas de servicios |
| `proyecto-<slug>` | Un dominio por proyecto (ej: `proyecto-secondbrain`, `proyecto-100aventuras`). Decisiones, avances, hitos |

Reglas:
- Si un hecho toca dos dominios (ej: sueldo = trabajo + finanzas), va en el dominio del **documento de origen**; se puede referenciar cruzado con una arista `RELACIONADO_CON`.
- Nunca inventar dominios nuevos sin registrarlo aquí y en `docs/decisiones.md`.
- El código fuente de repos **no** se ingesta al grafo (ver CLAUDE.md: eso es de codebase-memory-mcp).

## 2. Tipos de entidad

Definiciones estilo Pydantic. Los atributos son opcionales salvo que se indique; solo se llenan si el documento los contiene (no inventar).

```python
class Persona(BaseModel):
    """Una persona real: el usuario, familiares, médicos, contactos, contrapartes."""
    nombre_completo: str
    rut: str | None = None            # formato 12.345.678-9
    relacion: str | None = None       # "yo", "familiar", "médico", "contacto laboral", etc.
    email: str | None = None
    telefono: str | None = None

class CuentaBancaria(BaseModel):
    """Cuenta bancaria o producto financiero con número identificable."""
    banco: str                        # ej: "Banco de Chile"
    tipo: str                         # "corriente", "vista", "ahorro", "tarjeta de crédito"
    numero: str | None = None         # número de cuenta (dato sensible: flag, no secreto)
    moneda: str = "CLP"
    titular: str | None = None        # nombre de la Persona titular

class Institucion(BaseModel):
    """Organización: banco, isapre, AFP, empresa, servicio público, universidad."""
    nombre: str
    tipo: str | None = None           # "banco", "isapre", "AFP", "empresa", "servicio público"
    rut: str | None = None
    pais: str = "Chile"

class Proyecto(BaseModel):
    """Proyecto personal o profesional con identidad propia."""
    nombre: str
    slug: str                         # coincide con proyecto-<slug>
    estado: str | None = None         # "activo", "pausado", "terminado"
    descripcion: str | None = None

class Cliente(BaseModel):
    """Cliente de trabajo independiente o freelance."""
    nombre: str
    empresa: str | None = None
    contacto: str | None = None
    estado: str | None = None         # "activo", "prospecto", "cerrado"

class Dispositivo(BaseModel):
    """Hardware del usuario: computadores, teléfonos, discos, routers."""
    nombre: str                       # ej: "MacBook Pro 14 2023"
    tipo: str | None = None           # "laptop", "teléfono", "disco", "router"
    serie: str | None = None
    fecha_compra: date | None = None

class ExamenMedico(BaseModel):
    """Resultado de examen o procedimiento médico."""
    nombre: str                       # ej: "Perfil lipídico"
    fecha: date                       # fecha real del examen (obligatoria)
    laboratorio: str | None = None    # Institucion que lo emitió
    resultado_resumen: str | None = None   # valores relevantes en texto
    medico_solicitante: str | None = None

class Documento(BaseModel):
    """Documento archivado: contrato, certificado, factura, escritura."""
    titulo: str
    tipo: str                         # "contrato", "certificado", "factura", "boleta", "escritura"
    fecha_emision: date | None = None
    emisor: str | None = None
    source_path: str | None = None    # ruta en archive/<dominio>/

class Suscripcion(BaseModel):
    """Servicio recurrente pagado o gratuito."""
    servicio: str                     # ej: "Netflix", "Claude Max"
    plan: str | None = None
    monto: float | None = None
    moneda: str = "CLP"
    periodicidad: str | None = None   # "mensual", "anual"
    estado: str | None = None         # "activa", "cancelada"

class Credencial(BaseModel):
    """SOLO referencia a que una credencial existe y dónde vive.
    PROHIBIDO almacenar el secreto (contraseña, token, clave, PIN, frase semilla)."""
    servicio: str                     # ej: "AWS cuenta personal"
    tipo: str | None = None           # "contraseña", "API key", "SSH key", "2FA"
    ubicacion: str | None = None      # dónde está guardada: "1Password", "llavero macOS"
    usuario: str | None = None        # el identificador público sí puede guardarse
    ultima_rotacion: date | None = None

class Evento(BaseModel):
    """Suceso puntual con fecha: viaje, trámite, operación, mudanza, hito."""
    nombre: str
    fecha: date
    lugar: str | None = None
    descripcion: str | None = None
```

## 3. Tipos de arista (edges)

| Arista | Origen → Destino | Ejemplo |
|---|---|---|
| `TIENE_CUENTA` | Persona → CuentaBancaria | jpreyest TIENE_CUENTA cuenta corriente Banco de Chile |
| `TRABAJA_EN` | Persona → Institucion / Cliente | jpreyest TRABAJA_EN Acme SpA |
| `PERTENECE_A` | CuentaBancaria/Documento/ExamenMedico → Institucion; Cliente → Proyecto | cuenta PERTENECE_A Banco de Chile |
| `USA` | Persona/Proyecto → Dispositivo / Suscripcion / Credencial | jpreyest USA MacBook Pro |
| `RELACIONADO_CON` | cualquiera → cualquiera (genérica, incluye referencias entre dominios) | ExamenMedico RELACIONADO_CON Evento "operación rodilla" |
| `REEMPLAZA_A` | X → X del mismo tipo (supersesión) | cuenta nueva REEMPLAZA_A cuenta antigua |

Temporalidad: cada arista lleva `valid_at` (cuándo el hecho empezó a ser cierto). Cuando un hecho nuevo contradice o reemplaza uno anterior, el anterior recibe `invalid_at` — **no se borra**. `REEMPLAZA_A` se usa además para dejar explícita la cadena de supersesión (cuentas, dispositivos, contratos).

## 4. Prioridad de extracción de fecha (`reference_time`)

`reference_time` de un episodio = la fecha real del hecho/documento, **nunca** la fecha de ingesta por defecto. Orden de prioridad:

1. **Contenido del documento**: fecha impresa en el texto (fecha de emisión, fecha del examen, fecha de firma). Siempre gana.
2. **Metadatos del archivo**: fecha en el nombre del archivo (`2024-03-15_contrato.pdf`) o metadatos EXIF/PDF de creación.
3. **`mtime` del archivo**: última modificación en disco, como aproximación de último recurso.
4. **Preguntar al usuario**: si ninguna fuente es confiable o hay ambigüedad (varias fechas plausibles, mtime claramente incorrecto por copia de archivos), preguntar antes de ingestar.

Si solo se conoce mes o año, usar el primer día del período (ej: `2023-06-01` para "junio 2023") y anotarlo en el `source_description`.

## 5. Manejo de sensibilidad

| Nivel | Qué es | Tratamiento |
|---|---|---|
| `secret` | Contraseñas, tokens, API keys, PIN, CVV, frases semilla, claves privadas | **Redactar antes de ingestar.** Se reemplaza por `[REDACTADO]` y se guarda solo la referencia (entidad `Credencial` con `ubicacion`). Jamás entra al grafo ni al archivo de chunks. |
| `medical` | Diagnósticos, exámenes, tratamientos | Se ingesta completo con dominio `salud` (metadata), con flag `sensitivity: medical` en el `source_description`. |
| `financial` | Números de cuenta, saldos, deudas, sueldos | Se ingesta completo (los números de cuenta no son secretos, pero sí sensibles), con flag `sensitivity: financial`. |
| `normal` | Todo lo demás | Sin flag. |

Regla de oro: ante la duda entre `secret` y sensible, tratar como `secret` y preguntar al usuario.

## 6. `source_description` estructurado

Formato para episodios (una línea, campos separados por `|`; los tres primeros son obligatorios — el dominio vive aquí, no en el `group_id`):

```
dominio: <dominio> | tipo: <doc_type> | origen: <manual|/guardar|/ingest|documento <ruta>> | source_path: <archive/...> | sensitivity: <normal|medical|financial> | fecha_confianza: <contenido|metadata|mtime|usuario>
```
