"""Las instrucciones de extraccion son prompt, pero su regresion es cara.

Con la ontologia generica de upstream, las tres entidades mas conectadas del
grafo eran "General Partner" (43), "Partnership" (40) y "Limited Partners"
(38) — roles del articulado de los contratos — por delante de la sociedad real
y del dueño. Nadie lo nota hasta que una busqueda devuelve el concepto en vez
de la persona, asi que conviene que un test avise si alguien afloja el texto.
"""

import pathlib
import re

RAIZ = pathlib.Path(__file__).resolve().parents[2]
QUEUE = RAIZ / "infra" / "graphiti" / "patches" / "queue_service.py"
CONFIG = RAIZ / "infra" / "graphiti" / "config.yaml"


def test_las_instrucciones_llegan_al_extractor():
    texto = QUEUE.read_text(encoding="utf-8")
    assert "INSTRUCCIONES_EXTRACCION" in texto
    assert "custom_extraction_instructions=INSTRUCCIONES_EXTRACCION" in texto


def test_las_instrucciones_nombran_los_casos_que_fallaron():
    texto = QUEUE.read_text(encoding="utf-8")
    for caso in ("General Partner", "Limited Partners", "Third Party Purchaser"):
        assert caso in texto, f"falta el contraejemplo {caso!r}"
    assert "NO extraigas" in texto


def test_la_ontologia_tiene_persona_y_no_tipos_cajon_de_sastre():
    cfg = CONFIG.read_text(encoding="utf-8")
    nombres = set(re.findall(r'- name: "([^"]+)"', cfg))
    assert {"Persona", "Organizacion", "Lugar", "Cuenta"} <= nombres
    # Topic y Object decian "use as last resort": legitiman abstracciones y son
    # justo donde caian los conceptos de contrato.
    assert "Topic" not in nombres
    assert "Object" not in nombres


def test_cada_tipo_dice_tambien_lo_que_no_es():
    """La descripcion negativa es la que evita el ruido, no la positiva."""
    cfg = CONFIG.read_text(encoding="utf-8")
    bloque = cfg.split("entity_types:")[1]
    descripciones = re.findall(r"description: \"([^\"]+)\"", bloque)
    con_negativa = [d for d in descripciones if " NO " in d or "NO son" in d or "NO es" in d]
    assert len(con_negativa) >= 5, "casi ningun tipo acota lo que NO debe capturar"
