"""Tenant isolation: separate state trees and separate FalkorDB graphs."""

from brain_ingest.config import load_config
from brain_ingest.graph import graph_database, tenant_credentials


def test_two_tenants_have_isolated_paths_and_graphs(brain_home):
    a = load_config(tenant="alice")
    b = load_config(tenant="bob")

    assert a.ledger_path != b.ledger_path
    assert a.ledger_path == brain_home / "alice" / "ledger.sqlite"
    assert b.ledger_path == brain_home / "bob" / "ledger.sqlite"
    assert a.extracted_dir != b.extracted_dir
    assert a.work_dir != b.work_dir
    assert a.chunks_dir != b.chunks_dir

    # Graph name == tenant name (group_id == tenant; the FalkorDB driver
    # uses group_id as the graph name).
    assert a.graph_database == "alice"
    assert b.graph_database == "bob"
    assert graph_database("alice") != graph_database("bob")


def test_default_tenant_from_config(brain_home):
    cfg = load_config()
    assert cfg.tenant == "jpreyest"
    assert cfg.graph_database == "jpreyest"

    # config.toml value is used when no override is passed.
    cfg_path = brain_home / "config.toml"
    cfg_path.write_text(
        cfg_path.read_text(encoding="utf-8").replace('tenant = "jpreyest"', 'tenant = "carla"'),
        encoding="utf-8",
    )
    assert load_config().tenant == "carla"
    # CLI --tenant flag wins over config.toml.
    assert load_config(tenant="dora").tenant == "dora"


def test_invalid_tenant_names_rejected(brain_home):
    """Fix 10: tenant names are sanitized (no traversal, no empty/uppercase)."""
    import pytest

    for bad in ("../x", "a/b", "", "UPPER", "-lead", "_lead", "con espacio", "ñandu"):
        with pytest.raises(ValueError, match="invalid tenant name"):
            load_config(tenant=bad) if bad else _load_empty(brain_home)

    # Valid names still work.
    assert load_config(tenant="tenant-1_ok").tenant == "tenant-1_ok"


def _load_empty(brain_home):
    """Empty tenant set via config.toml (CLI empty string falls back to it)."""
    cfg_path = brain_home / "config.toml"
    load_config()  # ensure config exists
    cfg_path.write_text(
        cfg_path.read_text(encoding="utf-8").replace(
            'tenant = "jpreyest"', 'tenant = ""'
        ),
        encoding="utf-8",
    )
    return load_config()


def test_tenant_credentials_precedence(brain_home, monkeypatch):
    load_config()  # creates config.toml
    for var in (
        "FALKORDB_TENANT_USER",
        "FALKORDB_TENANT_PASSWORD",
        "FALKORDB_USERNAME",
        "FALKORDB_PASSWORD",
    ):
        monkeypatch.delenv(var, raising=False)

    # Nothing configured -> no credentials.
    assert tenant_credentials("alice") == (None, None)

    # Legacy env vars are the last fallback.
    monkeypatch.setenv("FALKORDB_USERNAME", "legacy")
    monkeypatch.setenv("FALKORDB_PASSWORD", "legacy-pw")
    assert tenant_credentials("alice") == ("legacy", "legacy-pw")

    # config.toml beats the legacy vars.
    cfg_path = brain_home / "config.toml"
    cfg_path.write_text(
        cfg_path.read_text(encoding="utf-8")
        + '\nfalkordb_tenant_user = "tenant_alice"\nfalkordb_tenant_password = "toml-pw"\n',
        encoding="utf-8",
    )
    assert tenant_credentials("alice") == ("tenant_alice", "toml-pw")

    # Tenant env vars beat everything.
    monkeypatch.setenv("FALKORDB_TENANT_USER", "tenant_env")
    monkeypatch.setenv("FALKORDB_TENANT_PASSWORD", "env-pw")
    assert tenant_credentials("alice") == ("tenant_env", "env-pw")


def test_tenant_credentials_default_username(brain_home, monkeypatch):
    for var in ("FALKORDB_TENANT_USER", "FALKORDB_USERNAME", "FALKORDB_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("FALKORDB_TENANT_PASSWORD", "pw")
    # Password without username -> ACL convention tenant_<name>.
    assert tenant_credentials("bob") == ("tenant_bob", "pw")
