import pytest


@pytest.fixture
def brain_home(tmp_path, monkeypatch):
    home = tmp_path / "brain"
    monkeypatch.setenv("BRAIN_HOME", str(home))
    return home


@pytest.fixture
def cfg(brain_home):
    from brain_ingest.config import load_config

    return load_config()


@pytest.fixture
def ledger(cfg):
    from brain_ingest.ledger import Ledger

    lg = Ledger(cfg.ledger_path)
    yield lg
    lg.close()
