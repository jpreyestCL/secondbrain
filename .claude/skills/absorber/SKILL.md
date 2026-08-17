---
name: absorber
description: Leer documentos y guardarlos en el second brain extrayendo los hechos aquí, sin que el servidor use LLM (/absorber <archivo|carpeta>). Usar cuando el usuario adjunta un documento o pide meter archivos al grafo. Es el camino rápido — 0,3 s por documento frente a ~2 min por trozo del pipeline `brain`.
---

# /absorber — leer el documento aquí, guardar hechos ya extraídos

Tú lees el documento y mandas **entidades y hechos estructurados** con la herramienta MCP `add_facts`. El servidor no usa LLM: deduplica, embebe en un lote y escribe.

**Por qué existe.** El camino `add_memory` manda texto crudo y el servidor extrae: medido, ~8 llamadas de LLM + ~22 embeddings + ~70 consultas al grafo **por trozo de 4,4 KB**, o sea 110-150 s. `add_facts` cuesta **306 ms por documento entero**. La diferencia no es la velocidad de ninguna capa: es que la unidad de trabajo pasa de "trozo" a "documento".

## Cuándo NO usar esto

- **Texto crudo que no puedes leer** (no tienes el archivo, solo una ruta en el servidor) → `add_memory`.
- **Carpetas de cientos de archivos** que hay que escanear, extraer con OCR y reanudar → el CLI `brain` (skill `/ingest`). Este camino es para lo que puedes leer tú.
- **Datos tabulares crudos** (planillas contables, cartolas con miles de filas) y **borradores superados por una versión firmada** → NO entran (regla de oro 9). Genera una ficha que describa qué es el archivo y dónde está, y absorbe la ficha.

## Procedimiento

### 1. Leer el documento

Léelo entero antes de extraer nada. PDFs escaneados e imágenes: úsalos con tu visión. Si no puedes leerlo, dilo y para — no adivines por el nombre del archivo.

### 2. Fijar la fecha REAL

**La regla más importante.** `fecha` es la fecha del documento o del hecho, **nunca la de hoy** salvo que el hecho sea genuinamente de hoy. Un grafo temporal con fechas de ingesta es un grafo inútil.

Prioridad: **contenido del documento > fecha en el nombre o la ruta > metadatos del archivo > preguntar al usuario**.

Si el documento tiene varias fechas (firmado el X, modificado el Y, vigente desde el Z), la fecha del documento es la de su **otorgamiento**; las vigencias van en `desde`/`hasta` de cada hecho.

**Si no logras determinarla, omite `fecha`.** Sin fecha no se invalida nada, que es mejor que invalidar por una fecha inventada.

### 3. Redactar secretos ANTES de mandar nada

Contraseñas, tokens, API keys, PIN, CVV, frases semilla, claves privadas: **no salen de aquí**. Guarda solo la referencia — una entidad `Credencial` que diga qué existe y dónde está, sin el valor.

RUT, número de cuenta, dirección y pasaporte **sí** entran: son datos del usuario sobre sí mismo, no secretos. Van con `sensibilidad`.

### 4. Extraer entidades y hechos

**Entidades** — solo cosas CONCRETAS e IDENTIFICABLES, con `tipo` de esta lista (cualquier otra cosa entra como `Entidad` y pierde la ontología):

`Persona` · `Organizacion` · `Lugar` · `Documento` · `Cuenta` · `Activo` · `Obligacion` · `Evento` · `Condicion` · `Credencial`

**NO extraigas** roles ni partes de un contrato ("General Partner", "el comprador", "Receiving Party"), ni figuras jurídicas ("Partnership", "Agreement", "Percentage Interest"), ni términos que aparecerían igual en el contrato de otra persona. Si Juan Pablo es el General Partner de Invest Andes LP, las entidades son **la persona** y **la sociedad**; "General Partner" es la relación entre ambas.

> Esto no es teórico: con una ontología genérica, las tres entidades más conectadas del grafo llegaron a ser `General Partner`, `Partnership` y `Limited Partners` — por delante de la sociedad real y del dueño.

**Nombres**: usa el nombre completo y canónico, igual que lo escribirías la próxima vez. La deduplicación del servidor junta mayúsculas, tildes y siglas (`Inversiones Linets S.p.A.` = `INVERSIONES LINETS SPA`) pero **no adivina** que "Banco Chile" es "Banco de Chile". Tú ves el documento entero; el servidor solo ve el nombre.

**Hechos** — `sujeto`, `relacion`, `objeto`, y opcionalmente `hecho` (la frase completa, que es lo que se busca después), `desde` y `hasta`.

La `relacion` es la clave de la invalidación: un hecho nuevo con el **mismo sujeto y la misma relación** y fecha posterior invalida al anterior. Así que sé consistente — usa siempre `"tiene cuenta en"`, no a veces `"posee cuenta"`. Si el hecho nuevo **no** debe invalidar al viejo (dos cuentas simultáneas), usa relaciones distintas o deja claro el `objeto`.

### 5. Guardar

```
add_facts(
  documento="2022-04-06 Escritura Lote 11 Matanzas.pdf",
  fecha="2022-04-06",
  dominio="finanzas",
  tipo_documento="escritura",
  sensibilidad="financial",
  entidades=[
    {"nombre": "Juan Pablo Reyes Tollini", "tipo": "Persona"},
    {"nombre": "Inversiones Linets SpA", "tipo": "Organizacion"},
    {"nombre": "Lote 11 Altos de Matanzas", "tipo": "Activo",
     "resumen": "Bien raíz en Litueche, inscrito a fojas 1234 del CBR"}
  ],
  hechos=[
    {"sujeto": "Juan Pablo Reyes Tollini", "relacion": "es representante de",
     "objeto": "Inversiones Linets SpA",
     "hecho": "Juan Pablo Reyes Tollini es representante legal de Inversiones Linets SpA"},
    {"sujeto": "Inversiones Linets SpA", "relacion": "es dueña de",
     "objeto": "Lote 11 Altos de Matanzas",
     "hecho": "Inversiones Linets SpA adquirió el Lote 11 de Altos de Matanzas por 45.000.000 CLP",
     "desde": "2022-04-06"}
  ],
  texto_fuente="Comparece don Juan Pablo Reyes Tollini, en representación de..."
)
```

`dominio`: `personal` · `salud` · `finanzas` · `trabajo` · `proyectos` · `legal` (metadata, **nunca** partición: el `group_id` es siempre el tenant).

`sensibilidad`: `medical` · `financial` · `pii`, si aplica.

`texto_fuente`: el fragmento del que salieron los hechos, para poder rastrearlos después. No mandes el documento entero si es enorme; manda lo que sustenta los hechos.

### 6. Reportar

Di qué entidades **nuevas** se crearon, cuáles se reusaron y cuántos hechos quedaron invalidados. Si se invalidó algo, **dilo explícitamente**: significa que un dato anterior dejó de estar vigente, y el usuario debería saberlo.

## Errores que devuelve

`add_facts` valida antes de escribir y devuelve **todos** los problemas juntos. El más común: un hecho que menciona una entidad que no declaraste en `entidades` — declara toda entidad que uses como `sujeto` u `objeto`.

## Varios documentos

Una llamada **por documento**. No juntes documentos distintos en una sola: el episodio y su fecha son por documento, y mezclarlos rompe la trazabilidad de dónde salió cada hecho.

## Una carpeta entera

**Paso 1 — preparar (una vez por carpeta). Lo corres TÚ, no el usuario.**

```bash
brain add <carpeta> --review     # escanea, extrae, clasifica y SE DETIENE antes de enviar
```

`--review` es lo que evita que se vaya por el camino lento (`ingest-graph`, ~2 min por trozo y con costo de API). Sin `--review` enviaría todo por ahí.

Con cientos de archivos esto tarda (el OCR domina): **lánzalo en segundo plano** y sigue. Si `next-batch` devuelve `aviso`, es que este paso falta o no terminó.

**Paso 2 — absorber en tandas.** No leas los PDFs: el texto ya está extraído en disco.

```bash
brain next-batch --limit 10        # JSON con doc_id, fecha detectada, dominio y TEXTO
```

Para cada documento del lote: extrae los hechos, llama a `add_facts`, y **solo cuando el servidor confirme**:

```bash
brain mark-done <doc_id> --episode <uuid que devolvio add_facts>
```

Después repite `next-batch`. `pendientes_totales` te dice cuánto queda.

**Si viene un `aviso`, léelo y para.** Significa que esa carpeta no está en el ledger — falta el paso 1. Cero pendientes ahí **no** quiere decir que esté ingerida: quiere decir que no se ha escaneado nada. `resumen_ledger` te dice en qué estado está cada documento del ámbito, para que un cero se pueda explicar.

**El marcado es un paso aparte a propósito**: si marcara al entregar, cada tanda interrumpida perdería documentos en silencio. Si algo se corta, esos documentos simplemente vuelven a salir en la próxima tanda.

`fecha_detectada` viene de una heurística por nombre y contenido. **Si el texto del documento la contradice, manda el texto** — tú lo estás leyendo, la heurística no.

Ojo con `truncado: true`: el texto viene cortado y puede faltar información al final.
