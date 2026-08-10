"""ingest_chunks: tenant group_id, resume-on-retry, transient retries."""

import asyncio
import json

import brain_ingest.graph as graph_mod
from brain_ingest.graph import ingest_chunks


class _FakeEpisode:
    def __init__(self, uuid):
        self.uuid = uuid


class _FakeResult:
    def __init__(self, uuid):
        self.episode = _FakeEpisode(uuid)


_fake_counter = 0


class _FakeGraphiti:
    def __init__(self, fail=None):
        global _fake_counter
        _fake_counter += 1
        self._id = _fake_counter
        self.episodes = []
        self.calls = 0
        # fail: callable(call_number, kwargs) -> exception or None
        self.fail = fail

    async def build_indices_and_constraints(self):
        pass

    async def add_episode(self, **kwargs):
        self.calls += 1
        if self.fail is not None:
            exc = self.fail(self.calls, kwargs)
            if exc is not None:
                raise exc
        self.episodes.append(kwargs)
        return _FakeResult(f"uuid-{self._id}-{len(self.episodes)}")

    async def close(self):
        pass


def _prep_doc(cfg, ledger, chunks, path="/docs/examen_lipidico.pdf"):
    _, doc_id = ledger.upsert_file(path, "sha-" + path, 10, 1e9)
    ledger.set_classification(doc_id, "salud", "examen", "2026-07-12", ["medical"])
    (cfg.chunks_dir / f"{doc_id}.json").write_text(
        json.dumps(chunks), encoding="utf-8"
    )
    return doc_id


def _use_fake(monkeypatch, fake):
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda tenant: fake)
    monkeypatch.setattr(graph_mod, "RETRY_BASE_DELAY", 0)


def test_ingest_chunks_uses_tenant_group_id_and_domain_metadata(
    cfg, ledger, monkeypatch
):
    fake = _FakeGraphiti()
    _use_fake(monkeypatch, fake)

    doc_id = _prep_doc(
        cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "colesterol 210"}]
    )

    counts = asyncio.run(ingest_chunks(cfg, ledger))
    assert counts == {"docs": 1, "episodes": 1, "errors": 0, "skipped": 0}

    ep = fake.episodes[0]
    # group_id is the tenant (== graph name), NEVER the domain.
    assert ep["group_id"] == cfg.tenant == "jpreyest"
    # Domain travels as metadata: name prefix + source_description.
    assert ep["name"].startswith("[salud] examen_lipidico.pdf")
    assert ep["source_description"].startswith("dominio: salud | tipo: examen | origen: ")
    assert f"doc_id={doc_id}" in ep["source_description"]
    assert ep["reference_time"].isoformat().startswith("2026-07-12")


def test_ledger_episode_stores_tenant_group_id_and_domain(cfg, ledger, monkeypatch):
    """Fix 7: episodes.group_id is the tenant; the domain has its own column."""
    fake = _FakeGraphiti()
    _use_fake(monkeypatch, fake)
    doc_id = _prep_doc(
        cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}]
    )
    asyncio.run(ingest_chunks(cfg, ledger))
    [ep] = ledger.episodes_for_doc(doc_id)
    assert ep["group_id"] == cfg.tenant == "jpreyest"
    assert ep["domain"] == "salud"


def test_resume_skips_already_recorded_chunks(cfg, ledger, monkeypatch):
    """Fix 3a: chunk indices already in the ledger are not re-ingested."""
    fake = _FakeGraphiti()
    _use_fake(monkeypatch, fake)
    doc_id = _prep_doc(
        cfg,
        ledger,
        [
            {"chunk_idx": 0, "total_chunks": 2, "text": "uno"},
            {"chunk_idx": 1, "total_chunks": 2, "text": "dos"},
        ],
    )
    # A previous run already ingested chunk 0.
    ledger.record_episode("pre-existing", doc_id, 0, cfg.tenant, domain="salud")

    counts = asyncio.run(ingest_chunks(cfg, ledger))
    assert counts["episodes"] == 1  # only chunk 1
    assert fake.calls == 1
    assert "dos" in fake.episodes[0]["episode_body"]
    assert {e["chunk_idx"] for e in ledger.episodes_for_doc(doc_id)} == {0, 1}


def test_transient_errors_are_retried_with_backoff(cfg, ledger, monkeypatch):
    """Fix 3b: connection/timeout errors retry up to 3 attempts."""
    fake = _FakeGraphiti(
        fail=lambda call, kw: ConnectionError("boom") if call <= 2 else None
    )
    _use_fake(monkeypatch, fake)
    doc_id = _prep_doc(
        cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}]
    )
    counts = asyncio.run(ingest_chunks(cfg, ledger))
    assert fake.calls == 3  # two transient failures + one success
    assert counts == {"docs": 1, "episodes": 1, "errors": 0, "skipped": 0}
    assert ledger.get(doc_id).status == "ingested"


def test_midway_failure_leaves_partial_then_retry_resumes(cfg, ledger, monkeypatch):
    """Fix 3c: mid-document failure records partial episodes; retry resumes."""
    # Chunk 0 succeeds; chunk 1 fails persistently (every attempt).
    fake = _FakeGraphiti(
        fail=lambda call, kw: ConnectionError("down") if "dos" in kw["episode_body"] else None
    )
    _use_fake(monkeypatch, fake)
    doc_id = _prep_doc(
        cfg,
        ledger,
        [
            {"chunk_idx": 0, "total_chunks": 2, "text": "uno"},
            {"chunk_idx": 1, "total_chunks": 2, "text": "dos"},
        ],
    )
    counts = asyncio.run(ingest_chunks(cfg, ledger))
    assert counts["errors"] == 1 and counts["docs"] == 0
    row = ledger.get(doc_id)
    assert row.status == "error"
    # Partial progress is recorded.
    assert [e["chunk_idx"] for e in ledger.episodes_for_doc(doc_id)] == [0]

    # Retry with the connection healthy: only chunk 1 is ingested — no dupes.
    fake2 = _FakeGraphiti()
    _use_fake(monkeypatch, fake2)
    counts = asyncio.run(ingest_chunks(cfg, ledger, [doc_id]))
    assert counts == {"docs": 1, "episodes": 1, "errors": 0, "skipped": 0}
    assert fake2.calls == 1
    assert "dos" in fake2.episodes[0]["episode_body"]
    assert [e["chunk_idx"] for e in ledger.episodes_for_doc(doc_id)] == [0, 1]
    assert ledger.get(doc_id).status == "ingested"


def test_empty_chunks_marks_doc_skipped(cfg, ledger, monkeypatch):
    """Fix 8: 0-chunk docs become status=skipped ('sin contenido')."""
    fake = _FakeGraphiti()
    _use_fake(monkeypatch, fake)
    doc_id = _prep_doc(cfg, ledger, [])
    counts = asyncio.run(ingest_chunks(cfg, ledger))
    assert counts == {"docs": 0, "episodes": 0, "errors": 0, "skipped": 1}
    row = ledger.get(doc_id)
    assert row.status == "skipped"
    assert row.error == "sin contenido"
    assert fake.calls == 0


def test_doc_id_rejects_ingested_and_superseded_unless_force(cfg, ledger, monkeypatch):
    """Fix 6b: explicit --doc-id refuses ingested/superseded rows without --force."""
    fake = _FakeGraphiti()
    _use_fake(monkeypatch, fake)
    doc_id = _prep_doc(
        cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}]
    )
    ledger.set_status(doc_id, "ingested")

    counts = asyncio.run(ingest_chunks(cfg, ledger, [doc_id]))
    assert counts["skipped"] == 1 and counts["docs"] == 0
    assert fake.calls == 0

    # Superseded rows are refused too.
    _, new_id = ledger.upsert_file("/docs/examen_lipidico.pdf", "sha-v2", 10, 2e9)
    assert ledger.get(doc_id).superseded
    counts = asyncio.run(ingest_chunks(cfg, ledger, [doc_id]))
    assert counts["skipped"] == 1 and fake.calls == 0

    # --force allows processing (resume logic still prevents duplicates).
    counts = asyncio.run(ingest_chunks(cfg, ledger, [doc_id], force=True))
    assert counts["docs"] == 1 and counts["episodes"] == 1
    assert fake.calls == 1


def test_build_graphiti_splits_llm_deepseek_and_embedder_ollama(monkeypatch):
    """LLM=DeepSeek (generic client) + embedder=Ollama/mxbai 1024 dims, como el server."""
    import brain_ingest.graph as graph_mod

    monkeypatch.setenv("OPENAI_API_KEY", "sk-deepseek")
    monkeypatch.setenv("OPENAI_API_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("MODEL_NAME", "deepseek-chat")
    monkeypatch.setenv("EMBEDDER_API_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("EMBEDDER_MODEL", "mxbai-embed-large")
    monkeypatch.setenv("EMBEDDER_DIMENSIONS", "1024")
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)

    captured = {}

    class FakeGraphiti:
        def __init__(self, graph_driver=None, llm_client=None, embedder=None, cross_encoder=None):
            captured["llm"] = llm_client
            captured["embedder"] = embedder

    import graphiti_core
    import graphiti_core.driver.falkordb_driver as fdrv
    monkeypatch.setattr(graphiti_core, "Graphiti", FakeGraphiti, raising=False)
    monkeypatch.setattr(fdrv, "FalkorDriver", lambda **kw: object(), raising=False)

    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient

    graph_mod.build_graphiti("jpreyest")

    assert isinstance(captured["llm"], OpenAIGenericClient)
    assert captured["llm"].config.base_url == "https://api.deepseek.com/v1"
    assert captured["llm"].config.model == "deepseek-chat"
    assert captured["embedder"].config.base_url == "http://127.0.0.1:11434/v1"
    assert captured["embedder"].config.embedding_model == "mxbai-embed-large"
    assert captured["embedder"].config.embedding_dim == 1024
    # El embedder apunta a un endpoint LOCAL: no se filtra la key real.
    assert captured["embedder"].config.api_key == graph_mod.LOCAL_API_KEY_PLACEHOLDER


# --- build_graphiti: regression tests for the two API-key / model bugs -------


def _capture_build(monkeypatch):
    """Run build_graphiti with Graphiti/FalkorDriver stubbed; return captured kwargs."""
    import graphiti_core
    import graphiti_core.driver.falkordb_driver as fdrv

    captured = {}

    class FakeGraphiti:
        def __init__(self, graph_driver=None, llm_client=None, embedder=None, cross_encoder=None):
            captured["llm"] = llm_client
            captured["embedder"] = embedder

    monkeypatch.setattr(graphiti_core, "Graphiti", FakeGraphiti, raising=False)
    monkeypatch.setattr(fdrv, "FalkorDriver", lambda **kw: object(), raising=False)
    graph_mod.build_graphiti("jpreyest")
    return captured


def _clear_llm_env(monkeypatch):
    for var in (
        "OPENAI_API_KEY",
        "OPENAI_API_URL",
        "EMBEDDER_API_URL",
        "EMBEDDER_MODEL",
        "EMBEDDER_DIMENSIONS",
        "MODEL_NAME",
        "OLLAMA_BASE_URL",
        "OLLAMA_LLM_MODEL",
    ):
        monkeypatch.delenv(var, raising=False)


def test_openai_key_only_sends_real_key_to_embedder(monkeypatch):
    """Bug 1: with only OPENAI_API_KEY set, embed_url is None (=> api.openai.com).

    The old code sent the literal "ollama" as the API key, so every embedding
    request 401'd. The real key must be used when the endpoint is unset or
    OpenAI-official.
    """
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-real-openai-key")

    captured = _capture_build(monkeypatch)

    assert captured["embedder"].config.api_key == "sk-real-openai-key"
    assert captured["embedder"].config.base_url is None
    assert captured["llm"].config.api_key == "sk-real-openai-key"


def test_explicit_openai_official_url_uses_real_key(monkeypatch):
    """The real key is also used when the endpoint is explicitly api.openai.com."""
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-real-openai-key")
    monkeypatch.setenv("OPENAI_API_URL", "https://api.openai.com/v1")

    captured = _capture_build(monkeypatch)

    assert captured["embedder"].config.api_key == "sk-real-openai-key"
    assert captured["llm"].config.api_key == "sk-real-openai-key"


def test_local_ollama_endpoint_never_receives_the_real_key(monkeypatch):
    """A local endpoint keeps the inert placeholder (no key leak)."""
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    monkeypatch.setenv("EMBEDDER_API_URL", "http://localhost:11434/v1")

    captured = _capture_build(monkeypatch)

    assert captured["embedder"].config.api_key == graph_mod.LOCAL_API_KEY_PLACEHOLDER


def test_ollama_only_config_still_works_without_openai_key(monkeypatch):
    """No OPENAI_API_KEY + OLLAMA_BASE_URL: placeholder key, generic client."""
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient

    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("OLLAMA_LLM_MODEL", "qwen2.5:7b")

    captured = _capture_build(monkeypatch)

    assert isinstance(captured["llm"], OpenAIGenericClient)
    assert captured["llm"].config.api_key == graph_mod.LOCAL_API_KEY_PLACEHOLDER
    assert captured["llm"].config.model == "qwen2.5:7b"


def test_model_name_honoured_when_llm_url_unset(monkeypatch):
    """Bug 2: llm_url None left llm_client=None, so graphiti built its own
    default client and MODEL_NAME was silently ignored."""
    from graphiti_core.llm_client.openai_client import OpenAIClient

    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-real-openai-key")
    monkeypatch.setenv("MODEL_NAME", "gpt-4.1-mini")

    captured = _capture_build(monkeypatch)

    assert captured["llm"] is not None, "llm_client must never be left to graphiti's default"
    assert isinstance(captured["llm"], OpenAIClient)
    assert captured["llm"].config.model == "gpt-4.1-mini"
    assert captured["llm"].config.small_model == "gpt-4.1-mini"
    assert captured["llm"].config.base_url is None


def test_model_name_honoured_on_official_openai_url(monkeypatch):
    """Same bug via the other branch: base_url pointing at api.openai.com."""
    from graphiti_core.llm_client.openai_client import OpenAIClient

    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-real-openai-key")
    monkeypatch.setenv("OPENAI_API_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("MODEL_NAME", "gpt-4o")

    captured = _capture_build(monkeypatch)

    assert isinstance(captured["llm"], OpenAIClient)
    assert captured["llm"].config.model == "gpt-4o"
    assert captured["llm"].config.base_url == "https://api.openai.com/v1"


def test_reasoning_model_gets_reasoning_params(monkeypatch):
    """gpt-5/o1/o3 need reasoning+verbosity; other models must get None."""
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-real-openai-key")
    monkeypatch.setenv("MODEL_NAME", "gpt-5-mini")

    captured = _capture_build(monkeypatch)
    assert captured["llm"].reasoning == "minimal"
    assert captured["llm"].verbosity == "low"

    monkeypatch.setenv("MODEL_NAME", "gpt-4o-mini")
    captured = _capture_build(monkeypatch)
    assert captured["llm"].reasoning is None
    assert captured["llm"].verbosity is None


def test_no_llm_config_at_all_raises(monkeypatch):
    import pytest

    _clear_llm_env(monkeypatch)
    with pytest.raises(graph_mod.GraphConfigError):
        graph_mod.build_graphiti("jpreyest")
