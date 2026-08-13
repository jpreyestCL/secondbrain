"""Heuristicas de fecha del clasificador automatico (scripts/clasificar-auto.py).

Cada caso de aqui fallo de verdad al clasificar ~/Documents/Sociedades.
"""

import importlib.util
import pathlib

import pytest

_RUTA = pathlib.Path(__file__).resolve().parents[1] / "src" / "brain_ingest" / "autoclas.py"
_spec = importlib.util.spec_from_file_location("clasificar_auto", _RUTA)
ca = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ca)


@pytest.mark.parametrize(
    "nombre,esperado,porque",
    [
        ("octubre2023.pdf", "2023-10-01", "mes+año pegados en el nombre"),
        ("noviembre2025.pdf", "2025-11-01", "idem, con año posterior"),
        ("May2023.pdf", "2023-05-01", "mes en ingles"),
        ("2022-10-31 - Ontario LP Declaration.pdf", "2022-10-31", "ISO en el nombre"),
        ("05-2026 ALV Spa.xlsx", "2026-05-01", "mm-aaaa"),
        ("Shareholders Agreement 01.16.24.docx", "2024-01-16", "mm.dd.aa del estudio"),
    ],
)
def test_fecha_del_nombre(nombre, esperado, porque):
    f, _ = ca.del_nombre(nombre, "/docs")
    assert f == esperado, porque


def test_el_nombre_gana_al_contenido():
    """`octubre2023.pdf` es de octubre aunque el texto abra con 30/09/2023.

    Confiar en la primera fecha del texto fechaba mal las cartolas: el
    encabezado del banco trae la fecha de corte del periodo anterior.
    """
    doc = {"path": "/docs/octubre2023.pdf", "excerpt": "ESTADO DE CUENTA 30/09/2023 saldo"}
    fecha, origen = ca.fecha_de(doc)
    assert fecha == "2023-10-01"
    assert origen == "nombre mes+año"


def test_fecha_escrita_en_palabras():
    """Las escrituras publicas chilenas fechan en palabras."""
    doc = {
        "path": "/docs/reconocimiento.docx",
        "excerpt": "EN SANTIAGO DE CHILE, a tres de julio del año dos mil veintiseis, ante mi",
    }
    assert ca.fecha_de(doc)[0] == "2026-07-03"


def test_no_adivina_fechas_numericas_ambiguas():
    """`12/06/2024` puede ser 12 de junio o 6 de diciembre: no se elige.

    Una fecha inventada es peor que una imprecisa marcada como tal, porque el
    grafo la presenta como un hecho.
    """
    assert ca.del_texto("Invoice Date 12/06/2024") is None
    # Con dia > 12 deja de ser ambiguo y si se acepta.
    assert ca.del_texto("Invoice Date 25/06/2024") == "2024-06-25"


def test_rechaza_fechas_futuras():
    """Un '2049' en una poliza es su vencimiento, no su fecha de emision."""
    assert ca.valida(2049, 1, 1) is None
    assert ca.valida(1970, 1, 1) is None


def test_tipo_y_dominio_desde_la_ruta():
    assert ca.tipo_de("/x/2026-06-18 - Escritura de compraventa.pdf") == "escritura"
    assert ca.tipo_de("/x/Cartolas/octubre.xls") == "cartola"
    validos = ["personal", "salud", "finanzas", "trabajo", "proyectos"]
    assert ca.dominio_de("/x/examenes/hemograma.pdf", None, validos) == "salud"
    assert ca.dominio_de("/x/Sociedades/escritura.pdf", None, validos) == "finanzas"
    assert ca.dominio_de("/x/lo-que-sea.pdf", "trabajo", validos) == "trabajo"
