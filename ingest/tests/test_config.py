"""Configuracion del CLI: de donde salen las claves y el estado."""

import os

def test_carga_entorno_desde_brain_home(tmp_path, monkeypatch):
    """Las claves se leen de ~/.brain/env, no del .env del repo.

    graphiti_core llama a load_dotenv(), que busca el .env subiendo desde el
    DIRECTORIO ACTUAL: el CLI funcionaba dentro del repo y fallaba fuera, que es
    justo lo que rompe una instalacion global. Peor aun, fallaba en silencio
    (sin claves, la config caia a valores por defecto en vez de detenerse).
    """
    from brain_ingest.config import cargar_entorno

    monkeypatch.setenv("BRAIN_HOME", str(tmp_path))
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    (tmp_path / "env").write_text(
        "# comentario\n"
        "\n"
        'LLM_API_KEY="sk-de-brain-home"\n'
        "EMBEDDER_MODEL=nvidia/nv-embed-v1\n",
        encoding="utf-8",
    )

    assert cargar_entorno() == tmp_path / "env"
    assert os.environ["LLM_API_KEY"] == "sk-de-brain-home"  # comillas removidas
    assert os.environ["EMBEDDER_MODEL"] == "nvidia/nv-embed-v1"


def test_el_entorno_ya_definido_manda(tmp_path, monkeypatch):
    """Poder sobrescribir una variable puntualmente sin editar el archivo."""
    from brain_ingest.config import cargar_entorno

    monkeypatch.setenv("BRAIN_HOME", str(tmp_path))
    monkeypatch.setenv("LLM_API_KEY", "sk-del-entorno")
    (tmp_path / "env").write_text("LLM_API_KEY=sk-del-archivo\n", encoding="utf-8")

    cargar_entorno()
    assert os.environ["LLM_API_KEY"] == "sk-del-entorno"


def test_sin_archivo_env_no_falla(tmp_path, monkeypatch):
    from brain_ingest.config import cargar_entorno

    monkeypatch.setenv("BRAIN_HOME", str(tmp_path))
    assert cargar_entorno() is None
