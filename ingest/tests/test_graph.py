"""ingest_chunks: group_id is ALWAYS the tenant; the domain is metadata."""

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


class _FakeGraphiti:
    def __init__(self):
        self.episodes = []

    async def build_indices_and_constraints(self):
        pass

    async def add_episode(self, **kwargs):
        self.episodes.append(kwargs)
        return _FakeResult(f"uuid-{len(self.episodes)}")

    async def close(self):
        pass


def test_ingest_chunks_uses_tenant_group_id_and_domain_metadata(
    cfg, ledger, monkeypatch
):
    fake = _FakeGraphiti()
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda tenant: fake)

    _, doc_id = ledger.upsert_file("/docs/examen_lipidico.pdf", "sha", 10, 1e9)
    ledger.set_classification(doc_id, "salud", "examen", "2026-07-12", ["medical"])
    (cfg.chunks_dir / f"{doc_id}.json").write_text(
        json.dumps([{"chunk_idx": 0, "total_chunks": 1, "text": "colesterol 210"}]),
        encoding="utf-8",
    )

    counts = asyncio.run(ingest_chunks(cfg, ledger))
    assert counts == {"docs": 1, "episodes": 1, "errors": 0}

    ep = fake.episodes[0]
    # group_id is the tenant (== graph name), NEVER the domain.
    assert ep["group_id"] == cfg.tenant == "jpreyest"
    # Domain travels as metadata: name prefix + source_description.
    assert ep["name"].startswith("[salud] examen_lipidico.pdf")
    assert ep["source_description"].startswith("dominio: salud | tipo: examen | origen: ")
    assert f"doc_id={doc_id}" in ep["source_description"]
    assert ep["reference_time"].isoformat().startswith("2026-07-12")
