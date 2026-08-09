"""Configuration for brain_ingest.

Everything lives under the brain home directory (default ``~/.brain``,
overridable via the ``BRAIN_HOME`` env var — used heavily by tests).

The system is multi-tenant with hard isolation: every tenant has its own
ledger, working directories and FalkorDB graph. The graph name equals the
tenant name (the FalkorDB driver uses the episode ``group_id`` as the graph
name, and ``group_id == tenant`` always; domains are metadata, not
partitions). The CLI operates on one tenant at a time (``tenant`` in
config.toml, overridable with the global ``--tenant`` flag).

Optional per-tenant FalkorDB ACL credentials may live in config.toml
(``falkordb_tenant_user`` / ``falkordb_tenant_password``); the
``FALKORDB_TENANT_USER`` / ``FALKORDB_TENANT_PASSWORD`` env vars take
precedence (see ``graph.tenant_credentials``).

Layout::

    ~/.brain/
        config.toml            global config (created with defaults on first run)
        <tenant>/
            ledger.sqlite      the tenant's ledger database (WAL mode)
            extracted/         extracted text per document (<doc_id>.txt|.json)
            chunks/            chunk files per document (<doc_id>.json)
            work/              classification work manifests
"""

from __future__ import annotations

import logging
import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("brain")

DEFAULT_DOMAINS = ["personal", "salud", "finanzas", "trabajo", "proyectos"]
DEFAULT_TENANT = "jpreyest"

# Tenant names become directory names under BRAIN_HOME and FalkorDB graph
# names — they must be non-empty and free of path separators / traversal.
TENANT_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")


def validate_tenant(tenant: str) -> str:
    if not TENANT_RE.fullmatch(tenant):
        raise ValueError(
            f"invalid tenant name {tenant!r}: must be non-empty, start with a "
            "lowercase letter or digit, and contain only lowercase letters, "
            "digits, '-' or '_' (no spaces, uppercase, '/', '..' or other "
            "path characters)"
        )
    return tenant

DEFAULT_CONFIG_TOML = """\
# brain_ingest configuration
# Active tenant. All state (ledger, extracted text, work manifests) lives
# under ~/.brain/<tenant>/ and graph data in the FalkorDB graph named after
# the tenant (group_id == tenant == graph name).
# Override per-invocation with `brain --tenant <name> <cmd>`.
tenant = "jpreyest"

# Directory where original documents are archived / scanned from.
archive_dir = "{archive_dir}"

# Knowledge domains. Metadata only (source_description + episode name prefix,
# NOT Graphiti group_ids); validated by `brain classify --apply`.
domains = ["personal", "salud", "finanzas", "trabajo", "proyectos"]

# Per-tenant FalkorDB ACL credentials (optional; the FALKORDB_TENANT_USER /
# FALKORDB_TENANT_PASSWORD env vars take precedence over these keys).
# falkordb_tenant_user = "tenant_jpreyest"
# falkordb_tenant_password = "..."
"""


def brain_home() -> Path:
    return Path(os.environ.get("BRAIN_HOME", "~/.brain")).expanduser()


@dataclass
class Config:
    home: Path
    archive_dir: Path
    tenant: str = DEFAULT_TENANT
    domains: list[str] = field(default_factory=lambda: list(DEFAULT_DOMAINS))

    @property
    def tenant_dir(self) -> Path:
        return self.home / self.tenant

    @property
    def graph_database(self) -> str:
        """Name of this tenant's FalkorDB graph (hard isolation per tenant).

        Equals the tenant name: the FalkorDB driver uses the episode group_id
        as the graph name, and group_id == tenant always.
        """
        return self.tenant

    @property
    def ledger_path(self) -> Path:
        return self.tenant_dir / "ledger.sqlite"

    @property
    def extracted_dir(self) -> Path:
        return self.tenant_dir / "extracted"

    @property
    def chunks_dir(self) -> Path:
        return self.tenant_dir / "chunks"

    @property
    def work_dir(self) -> Path:
        return self.tenant_dir / "work"


def load_config(tenant: str | None = None) -> Config:
    """Load ``config.toml``, creating it (and the tenant tree) on first run.

    ``tenant`` (the CLI ``--tenant`` flag) overrides the config file value.
    """
    home = brain_home()
    home.mkdir(parents=True, exist_ok=True)
    cfg_path = home / "config.toml"
    if not cfg_path.exists():
        default_archive = home / "archive"
        cfg_path.write_text(
            DEFAULT_CONFIG_TOML.format(archive_dir=default_archive), encoding="utf-8"
        )
        log.info("created default config at %s", cfg_path)

    data = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    cfg = Config(
        home=home,
        archive_dir=Path(data.get("archive_dir", str(home / "archive"))).expanduser(),
        tenant=validate_tenant(tenant or str(data.get("tenant", DEFAULT_TENANT))),
        domains=list(data.get("domains", DEFAULT_DOMAINS)),
    )
    for d in (cfg.extracted_dir, cfg.chunks_dir, cfg.work_dir):
        d.mkdir(parents=True, exist_ok=True)
    return cfg
