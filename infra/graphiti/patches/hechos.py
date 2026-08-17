"""Ingesta de hechos YA EXTRAIDOS, sin LLM en el servidor.

Por qué existe
--------------
El camino normal (`add_memory`) manda texto crudo y Graphiti hace la
extracción en el servidor. Medido en este despliegue, cada trozo de documento
cuesta:

    ~8 llamadas al LLM  +  ~22 embeddings  +  ~70 consultas al grafo
    ≈ 110-150 s y USD 0,0066

Y el trozo mediano son 4,4 KB, así que un corpus de 840 documentos son 2.017
trozos: **~62 horas y USD 8**. El peaje es casi todo fijo por episodio, o sea
que se paga 2.017 veces para mover paquetes pequeños.

Aquí el cliente (Claude, con la suscripción del usuario) ya hizo la lectura y
la extracción, y manda entidades y hechos estructurados. El servidor entonces:

    1 llamada de embeddings (en lote)  +  ~4 consultas al grafo
    por DOCUMENTO, no por trozo

Sin LLM en el servidor. Lo que aquí se resuelve sin modelo es lo que Graphiti
resolvía con él: deduplicar entidades y decidir qué hecho queda invalidado.

Qué se pierde, y por qué se acepta
----------------------------------
Graphiti deduplica preguntándole al LLM si "Inversiones Linets SpA" y
"Inversiones Linets" son lo mismo. Aquí se hace por nombre normalizado, que es
más estricto: dos escrituras distintas del mismo nombre crean dos entidades.
A cambio es determinista, gratis e instantáneo — y el ruido que veíamos venía
justo de que el LLM inventaba variantes ("Inversión Linets SpA"). El cliente,
que ve el documento entero, está en mejor posición para normalizar el nombre
que un modelo que solo ve un trozo de 4 KB.

La invalidación temporal sí se conserva, con una regla explícita: un hecho
nuevo sobre el MISMO sujeto y la MISMA relación, con fecha posterior, invalida
al anterior. Es la regla que el grafo necesita para responder "¿cuál es mi
cuenta?" frente a "¿y antes?".
"""

from __future__ import annotations

import logging
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

#: Dominios válidos (SCHEMA.md). El dominio es metadata, NUNCA partición: el
#: `group_id` es siempre el tenant.
DOMINIOS = {"personal", "salud", "finanzas", "trabajo", "proyectos", "legal"}

#: Marcas de sensibilidad que viajan con el episodio.
SENSIBILIDAD = {"medical", "financial", "pii"}


def normalizar(nombre: str) -> str:
    """Clave de deduplicación: sin tildes, sin puntuación, sin mayúsculas.

    Es a propósito más estricta que el criterio del LLM. Junta
    "Inversiones Linets SpA", "INVERSIONES LINETS S.P.A." e "inversiones
    linets spa", que es el 90% de los duplicados reales, y no intenta adivinar
    si "Banco Chile" y "Banco de Chile" son lo mismo — eso es trabajo del
    cliente, que ve el documento completo.
    """
    sin_tildes = "".join(
        c for c in unicodedata.normalize("NFD", nombre) if unicodedata.category(c) != "Mn"
    )
    limpio = re.sub(r"[^a-z0-9]+", " ", sin_tildes.lower()).strip()
    # Las siglas se escriben con puntos ("S.p.A.", "S.A.", "EE.UU.") y al
    # quitar la puntuacion quedan como letras sueltas: "s p a". Se vuelven a
    # juntar para que "Inversiones Linets S.p.A." y "Inversiones Linets SpA"
    # sean la misma entidad. Solo se colapsan RACHAS de dos o mas letras
    # sueltas: asi "Juan P Reyes" no se convierte en "juan preyes".
    return re.sub(r"\b(?:[a-z] ){1,}[a-z]\b", lambda m: m.group(0).replace(" ", ""), limpio)


#: Tipos de SCHEMA.md. Lo que no este aqui entra como `Entidad` a secas: la
#: etiqueta va INTERPOLADA en el Cypher (no se puede parametrizar), asi que
#: aceptar texto libre seria inyeccion.
TIPOS = {
    "Persona", "Organizacion", "Lugar", "Documento", "Cuenta",
    "Activo", "Obligacion", "Evento", "Condicion", "Credencial",
}


def _etiqueta_segura(tipo: str) -> str:
    """Etiqueta de nodo validada contra la ontologia."""
    limpio = re.sub(r"[^A-Za-z]", "", (tipo or "").strip().capitalize())
    return limpio if limpio in TIPOS else "Entidad"


def _fecha(valor: Any) -> datetime | None:
    """Acepta ISO con o sin zona; sin fecha devuelve None, nunca 'hoy'.

    Regla de oro 1: un grafo temporal con fechas de ingesta es un grafo
    inútil. Si el cliente no sabe la fecha, es mejor que el hecho no la tenga
    a que mienta.
    """
    if not valor:
        return None
    if isinstance(valor, datetime):
        return valor if valor.tzinfo else valor.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        logger.warning(f'fecha ilegible: {valor!r}; se guarda sin fecha')
        return None


def validar(entidades: list[dict], hechos: list[dict]) -> list[str]:
    """Errores de forma, devueltos TODOS juntos.

    Devolverlos de a uno obliga al cliente a ida y vuelta por cada campo mal
    puesto, y cada ida y vuelta es una llamada de LLM del usuario.
    """
    problemas: list[str] = []
    nombres = set()
    for i, e in enumerate(entidades):
        n = (e.get("nombre") or "").strip()
        if not n:
            problemas.append(f"entidades[{i}]: falta 'nombre'")
        else:
            nombres.add(normalizar(n))
        if not (e.get("tipo") or "").strip():
            problemas.append(f"entidades[{i}] ({n}): falta 'tipo'")

    for i, h in enumerate(hechos):
        for campo in ("sujeto", "relacion", "objeto"):
            if not (h.get(campo) or "").strip():
                problemas.append(f"hechos[{i}]: falta '{campo}'")
        # Un hecho que apunta a una entidad no declarada dejaria el grafo con
        # nodos huerfanos sin tipo ni resumen.
        for campo in ("sujeto", "objeto"):
            v = (h.get(campo) or "").strip()
            if v and normalizar(v) not in nombres:
                problemas.append(
                    f"hechos[{i}]: '{v}' no esta en 'entidades' (declara toda entidad que uses)"
                )
    return problemas


class IngestaDirecta:
    """Escribe entidades y hechos ya extraidos, sin pasar por el LLM."""

    def __init__(self, driver, embedder, group_id: str):
        self.driver = driver
        self.embedder = embedder
        self.group_id = group_id

    async def _existentes(self) -> dict[str, str]:
        """Mapa nombre-normalizado -> uuid de lo que ya hay en el grafo.

        Una sola consulta para todo el tenant. Con miles de entidades esto
        sigue siendo mucho más barato que una llamada de LLM por entidad, que
        es lo que hacía el camino anterior.
        """
        registros, _, _ = await self.driver.execute_query(
            "MATCH (n:Entity {group_id: $gid}) RETURN n.uuid AS uuid, n.name AS name",
            gid=self.group_id,
        )
        return {normalizar(r["name"]): r["uuid"] for r in registros if r.get("name")}

    async def ingerir(
        self,
        documento: str,
        entidades: list[dict],
        hechos: list[dict],
        fecha_documento: Any = None,
        dominio: str = "personal",
        doc_type: str = "documento",
        origen: str = "",
        sensibilidad: str = "",
        texto_fuente: str = "",
    ) -> dict[str, Any]:
        import uuid as _uuid

        ahora = datetime.now(timezone.utc)
        valido = _fecha(fecha_documento)
        dominio = dominio if dominio in DOMINIOS else "personal"

        ya = await self._existentes()

        # --- entidades: reusar lo que exista, crear el resto ---------------
        por_clave: dict[str, str] = {}
        nuevas: list[dict] = []
        for e in entidades:
            nombre = e["nombre"].strip()
            clave = normalizar(nombre)
            if clave in ya:
                por_clave[clave] = ya[clave]
                continue
            if clave in por_clave:  # repetida dentro del mismo documento
                continue
            u = str(_uuid.uuid4())
            por_clave[clave] = u
            nuevas.append(
                {
                    "uuid": u,
                    "name": nombre,
                    "tipo": (e.get("tipo") or "Entidad").strip(),
                    "summary": (e.get("resumen") or "").strip(),
                }
            )

        # --- embeddings: UNA llamada para nombres nuevos + hechos ----------
        # El camino anterior hacía ~22 por episodio, secuenciales.
        textos = [n["name"] for n in nuevas] + [
            (h.get("hecho") or f"{h['sujeto']} {h['relacion']} {h['objeto']}").strip()
            for h in hechos
        ]
        vectores = await self._embeber(textos)
        v_nuevas = vectores[: len(nuevas)]
        v_hechos = vectores[len(nuevas) :]

        # --- episodio del DOCUMENTO (uno, no uno por trozo) ---------------
        ep_uuid = str(_uuid.uuid4())
        descripcion = f"dominio: {dominio} | tipo: {doc_type} | origen: {origen or 'cliente'}"
        await self.driver.execute_query(
            """
            CREATE (e:Episodic {uuid: $uuid, group_id: $gid, name: $name,
                                content: $content, source: 'text',
                                source_description: $desc,
                                entity_edges: [],
                                created_at: $created, valid_at: $valid})
            """,
            uuid=ep_uuid,
            gid=self.group_id,
            name=f"[{dominio}] {documento}",
            content=texto_fuente[:20000],
            desc=descripcion + (f" | sensibilidad: {sensibilidad}" if sensibilidad else ""),
            created=ahora.isoformat(),
            valid=(valido or ahora).isoformat(),
        )

        # --- entidades nuevas, en UNA consulta ----------------------------
        if nuevas:
            # Cypher NO acepta la etiqueta como parametro, asi que hay que
            # agrupar por tipo y hacer una consulta por tipo. Pasarla como dato
            # (`f.labels`) dejaba a TODAS las entidades como :Entity a secas y
            # perdia la ontologia — y la ontologia no es decorativa: sin tipos
            # concretos las entidades mas conectadas del grafo acabaron siendo
            # "General Partner" y "Partnership" en vez de la sociedad real.
            por_tipo: dict[str, list] = {}
            for n, v in zip(nuevas, v_nuevas):
                por_tipo.setdefault(_etiqueta_segura(n["tipo"]), []).append(
                    {"uuid": n["uuid"], "name": n["name"], "summary": n["summary"], "emb": v}
                )
            for tipo, filas in por_tipo.items():
                await self.driver.execute_query(
                    f"""
                    UNWIND $filas AS f
                    CREATE (n:Entity:{tipo} {{uuid: f.uuid, name: f.name, group_id: $gid,
                                      summary: f.summary, created_at: $created,
                                      name_embedding: vecf32(f.emb)}})
                    """,
                    filas=filas,
                    gid=self.group_id,
                    created=ahora.isoformat(),
                )

        # --- invalidacion temporal ----------------------------------------
        # Un hecho nuevo sobre el mismo SUJETO, la misma RELACION y el mismo
        # OBJETO, con fecha posterior, invalida al anterior. Es lo que permite
        # responder "cual es mi saldo" y tambien "y antes". Los hechos NUNCA se
        # borran.
        #
        # El objeto tiene que entrar en la comparacion. Sin el, "Cien Aventuras
        # LLC es titular de la cuenta de AHORRO" invalidaba "es titular de la
        # cuenta CORRIENTE" — dos hechos simultaneamente verdaderos. Paso: el
        # grafo quedo afirmando que la empresa habia dejado de tener una cuenta
        # de la que teniamos saldos dos anos despues. Una relacion puede ser de
        # uno a muchos, y el sujeto+relacion no basta para saberlo.
        invalidados = 0
        if valido:
            for h in hechos:
                s = por_clave.get(normalizar(h["sujeto"]))
                o = por_clave.get(normalizar(h["objeto"]))
                if not (s and o):
                    continue
                registros, _, _ = await self.driver.execute_query(
                    """
                    MATCH (a:Entity {uuid: $s})-[r:RELATES_TO {group_id: $gid}]->(b:Entity {uuid: $o})
                    WHERE r.name = $rel AND r.invalid_at IS NULL
                      AND (r.valid_at IS NULL OR r.valid_at < $nuevo)
                    SET r.invalid_at = $nuevo
                    RETURN count(r) AS n
                    """,
                    s=s, o=o, gid=self.group_id, rel=h["relacion"].strip(),
                    nuevo=valido.isoformat(),
                )
                invalidados += int(registros[0]["n"]) if registros else 0

        # --- hechos, en UNA consulta --------------------------------------
        filas_h = []
        for h, v in zip(hechos, v_hechos):
            s = por_clave.get(normalizar(h["sujeto"]))
            o = por_clave.get(normalizar(h["objeto"]))
            if not (s and o):
                continue
            desde = _fecha(h.get("desde")) or valido
            hasta = _fecha(h.get("hasta"))
            filas_h.append(
                {
                    "uuid": str(_uuid.uuid4()),
                    "s": s,
                    "o": o,
                    "name": h["relacion"].strip(),
                    "fact": (h.get("hecho") or f"{h['sujeto']} {h['relacion']} {h['objeto']}").strip(),
                    "emb": v,
                    "valid": desde.isoformat() if desde else None,
                    "invalid": hasta.isoformat() if hasta else None,
                }
            )

        if filas_h:
            await self.driver.execute_query(
                """
                UNWIND $filas AS f
                MATCH (a:Entity {uuid: f.s}), (b:Entity {uuid: f.o})
                CREATE (a)-[r:RELATES_TO {uuid: f.uuid, group_id: $gid, name: f.name,
                                          fact: f.fact, created_at: $created,
                                          valid_at: f.valid, invalid_at: f.invalid,
                                          episodes: [$ep],
                                          fact_embedding: vecf32(f.emb)}]->(b)
                """,
                filas=filas_h, gid=self.group_id, created=ahora.isoformat(), ep=ep_uuid,
            )

            # El enlace inverso episodio -> aristas.
            #
            # Las aristas ya guardan `episodes: [$ep]`, asi que la informacion
            # estaba; el problema es de FORMA. `EpisodicNode` de graphiti declara
            # `entity_edges: list[str]`, y una propiedad ausente en el grafo se lee
            # como None, que pydantic rechaza.
            #
            # Y el dano no se queda en el episodio malo: `get_episodes` valida
            # TODOS los episodios del group_id, asi que UNO solo escrito por aqui
            # rompia la lectura del tenant entero — y tambien `delete_episode`, que
            # pasa por `EpisodicNode.get_by_uuid`. O sea que un episodio mal escrito
            # dejaba el grafo sin forma de enumerarlo ni de limpiarlo.
            await self.driver.execute_query(
                """
                MATCH (e:Episodic {uuid: $ep})
                SET e.entity_edges = $uuids
                """,
                ep=ep_uuid, uuids=[f["uuid"] for f in filas_h],
            )

        # --- el episodio MENCIONA a sus entidades -------------------------
        if por_clave:
            await self.driver.execute_query(
                """
                MATCH (e:Episodic {uuid: $ep})
                UNWIND $uuids AS u
                MATCH (n:Entity {uuid: u})
                CREATE (e)-[:MENTIONS {group_id: $gid, uuid: randomUUID()}]->(n)
                """,
                ep=ep_uuid, uuids=list(por_clave.values()), gid=self.group_id,
            )

        return {
            "episodio": ep_uuid,
            "entidades_nuevas": len(nuevas),
            "entidades_reusadas": len(por_clave) - len(nuevas),
            "hechos": len(filas_h),
            "hechos_invalidados": invalidados,
        }

    async def _embeber(self, textos: list[str]) -> list[list[float]]:
        if not textos:
            return []
        # `create_batch` en una sola llamada; el embedder ya viene configurado
        # con el modelo y la dimension del tenant.
        limpios = [t.replace("\n", " ") for t in textos]
        return await self.embedder.create_batch(limpios)
