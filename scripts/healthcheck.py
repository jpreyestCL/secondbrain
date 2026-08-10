#!/usr/bin/env python3
"""End-to-end healthcheck for the second brain (gateway + Graphiti MCP).

Performs a REAL round trip against a deployed instance:

  0. ``GET  /.well-known/oauth-authorization-server``  endpoint discovery (RFC 8414)
  1. ``POST /api/auth/sign-in/email``      email + password -> session cookie
  2. ``POST /api/auth/mcp/register``       dynamic client registration (DCR)
  3. ``GET  /api/auth/mcp/authorize``      PKCE S256 -> authorization code
  4. ``POST /api/auth/mcp/token``          code + verifier -> access token
  5. ``POST /mcp`` ``initialize``          MCP handshake (+ notifications/initialized)
  6. ``tools/call add_memory``             writes a canary episode with a unique marker
  7. poll ``get_episodes`` + ``search_memory_facts`` until the canary shows up
  8. ``tools/call delete_episode``         removes the canary so the graph stays clean

Exits 0 only if every step succeeded AND the canary was found. Any failure
prints ``HEALTHCHECK FAILED: <reason>`` on stderr and exits non-zero.

Cleanup is best-effort but always attempted (even on failure), so a broken run
does not leave canary episodes behind.

Standard library only -- no pip install required. Configuration via env:

    BRAIN_URL        base URL of the gateway, e.g. https://mybrain.example.cl
    BRAIN_EMAIL      account email
    BRAIN_PASSWORD   account password
    BRAIN_TIMEOUT    seconds to wait for the canary to be processed (default 180)
    BRAIN_CLIENT_ID  optional: reuse a previously registered OAuth client and
                     skip DCR (the gateway rate-limits DCR to 20/min/IP)

See scripts/README.md for cron / systemd timer usage.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: The gateway enforces a redirect_uri allowlist; this is the canonical entry
#: (the callback claude.ai itself uses). Overridable for local experiments.
DEFAULT_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback"

MCP_PROTOCOL_VERSION = "2025-06-18"
USER_AGENT = "secondbrain-healthcheck/1.0"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_CONFIG = 2


class HealthcheckError(RuntimeError):
    """Any failure that must make the script exit non-zero."""


# ---------------------------------------------------------------------------
# Tiny HTTP client (stdlib only) with a cookie jar
# ---------------------------------------------------------------------------


class Response:
    __slots__ = ("status", "headers", "body", "url")

    def __init__(self, status: int, headers, body: bytes, url: str):
        self.status = status
        self.headers = headers
        self.body = body
        self.url = url

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HealthcheckError(
                f"expected JSON from {self.url} (HTTP {self.status}) but got: "
                f"{self.text[:300]!r} ({exc})"
            ) from exc

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Keep 3xx responses instead of following them (we need the Location)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    """Cookie-aware HTTP client. ``verbose`` logs one line per request."""

    def __init__(self, base_url: str, timeout: float = 30.0, verbose: bool = False):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.verbose = verbose
        self.jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect()
        )

    def log(self, msg: str) -> None:
        if self.verbose:
            print(f"  {msg}", file=sys.stderr, flush=True)

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body=None,
        form_body=None,
        headers: dict | None = None,
        timeout: float | None = None,
        no_cookies: bool = False,
    ) -> Response:
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        data = None
        hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        elif form_body is not None:
            data = urllib.parse.urlencode(form_body).encode("utf-8")
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
        hdrs.update(headers or {})

        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        # Un opener sin cookie jar: para el DCR, que debe viajar como lo hace un
        # cliente MCP real (server-to-server, sin sesion del navegador).
        opener = self._opener
        if no_cookies:
            opener = urllib.request.build_opener(_NoRedirect())
        try:
            with opener.open(req, timeout=timeout or self.timeout) as resp:
                out = Response(resp.status, resp.headers, resp.read(), url)
        except urllib.error.HTTPError as exc:  # 4xx/5xx still carry a body
            out = Response(exc.code, exc.headers, exc.read(), url)
        except urllib.error.URLError as exc:
            raise HealthcheckError(f"cannot reach {url}: {exc.reason}") from exc
        except TimeoutError as exc:
            raise HealthcheckError(f"timeout talking to {url}") from exc
        self.log(f"{method} {url} -> {out.status}")
        return out


# ---------------------------------------------------------------------------
# OAuth 2.1 + PKCE
# ---------------------------------------------------------------------------


def pkce_pair() -> tuple[str, str]:
    """Return ``(code_verifier, code_challenge)`` for PKCE S256."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def discover(client: Client) -> dict:
    """RFC 8414 metadata. Falls back to the Better Auth defaults if absent."""
    defaults = {
        "registration_endpoint": f"{client.base_url}/api/auth/mcp/register",
        "authorization_endpoint": f"{client.base_url}/api/auth/mcp/authorize",
        "token_endpoint": f"{client.base_url}/api/auth/mcp/token",
    }
    resp = client.request("GET", "/.well-known/oauth-authorization-server")
    if resp.status != 200:
        client.log(f"discovery unavailable (HTTP {resp.status}), using default paths")
        return defaults
    data = resp.json()
    methods = data.get("code_challenge_methods_supported") or []
    if methods and "S256" not in methods:
        raise HealthcheckError(
            f"authorization server does not advertise PKCE S256 (got {methods})"
        )
    return {k: data.get(k) or v for k, v in defaults.items()}


def login(client: Client, email: str, password: str) -> None:
    """Better Auth email sign-in; leaves the session cookie in the jar.

    Deliberately sends no ``Origin``/``Referer``: Better Auth's origin check
    only validates when one of those (or a ``Sec-Fetch-*`` header) is present,
    and a mismatched Origin would be rejected with 403 INVALID_ORIGIN.
    """
    resp = client.request(
        "POST", "/api/auth/sign-in/email", json_body={"email": email, "password": password}
    )
    if resp.status != 200:
        raise HealthcheckError(
            f"login failed for {email}: HTTP {resp.status} {resp.text[:300]}"
        )
    if not any(c.name.endswith("session_token") for c in client.jar):
        raise HealthcheckError(
            "login returned 200 but no session cookie was set — cannot continue "
            f"(cookies: {[c.name for c in client.jar]})"
        )


def register_client(client: Client, endpoint: str, redirect_uri: str) -> tuple[str, str | None]:
    """RFC 7591 dynamic client registration. Returns ``(client_id, secret)``.

    ``token_endpoint_auth_method: "none"`` registers a *public* client, so the
    response carries no ``client_secret`` and the token exchange is PKCE-only.

    IMPORTANTE: se envia SIN la cookie de sesion. Better Auth aplica su chequeo
    de origen (CSRF) a las peticiones que llevan sesion, y el DCR no manda
    ``Origin`` -> 403 MISSING_OR_NULL_ORIGIN. Los clientes MCP reales (claude.ai)
    registran server-to-server sin cookie, asi que esto refleja el flujo real.
    """
    body = {
        "client_name": "secondbrain-healthcheck",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }
    resp = client.request("POST", endpoint, json_body=body, no_cookies=True)
    if resp.status == 429:
        raise HealthcheckError(
            "dynamic client registration is rate-limited (HTTP 429). Set "
            "BRAIN_CLIENT_ID to reuse a previously registered client."
        )
    if resp.status not in (200, 201):  # the gateway answers 201 Created
        raise HealthcheckError(
            "dynamic client registration failed: HTTP "
            f"{resp.status} {resp.text[:400]} — if this is a 400 about "
            f"redirect_uri, {redirect_uri} is not on the gateway allowlist "
            "(ALLOWED_REDIRECT_HOSTS)"
        )
    data = resp.json()
    client_id = data.get("client_id")
    if not client_id:
        raise HealthcheckError(f"DCR response has no client_id: {data}")
    return client_id, data.get("client_secret")


def _code_from_location(location: str, redirect_uri: str, state: str) -> str | None:
    if not location.startswith(redirect_uri.split("?")[0]):
        return None
    query = urllib.parse.urlparse(location).query
    params = urllib.parse.parse_qs(query)
    if "error" in params:
        raise HealthcheckError(
            f"authorize returned an OAuth error: {params['error'][0]} "
            f"{params.get('error_description', [''])[0]}"
        )
    code = params.get("code", [None])[0]
    if code is None:
        return None
    got_state = params.get("state", [None])[0]
    if got_state != state:
        raise HealthcheckError(
            f"state mismatch on the authorization redirect (sent {state!r}, got {got_state!r})"
        )
    return code



def _submit_consent(client: "Client", html: str, page_url: str) -> "Response":
    """Aprueba la pantalla de consentimiento y devuelve la respuesta del POST.

    El gateway muestra una pantalla propia antes de emitir el código (defensa
    frente al robo de tokens vía redirect_uri). Un cliente real la ve en el
    navegador; aquí la enviamos igual que lo haría el usuario al pulsar
    "Autorizar": mismos campos ocultos + CSRF + Origin/Referer del propio sitio.
    """
    action_m = re.search(r'<form[^>]*action="([^"]+)"', html)
    action = action_m.group(1) if action_m else "/consentimiento"
    fields: dict[str, str] = {}
    for m in re.finditer(r"<input\b[^>]*>", html):
        tag = m.group(0)
        name_m = re.search(r'name="([^"]+)"', tag)
        value_m = re.search(r'value="([^"]*)"', tag)
        if name_m:
            fields[name_m.group(1)] = value_m.group(1) if value_m else ""
    fields["decision"] = "autorizar"
    return client.request(
        "POST",
        action,
        form_body=fields,
        headers={
            "Origin": client.base_url,
            "Referer": page_url,
            "Accept": "text/html,application/json",
        },
    )


def authorize(
    client: Client,
    endpoint: str,
    client_id: str,
    redirect_uri: str,
) -> tuple[str, str]:
    """Run the authorization step with the logged-in session; return (code, verifier).

    With a valid session cookie and without ``prompt=consent`` the server
    answers a single 302 whose ``Location`` already carries ``?code=&state=`` —
    there is no HTML consent screen to submit. Redirects are NOT followed: the
    Location points at claude.ai and following it would leak the code.
    """
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(16)
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        # Only openid/profile/email/offline_access are accepted.
        "scope": "openid profile email offline_access",
    }
    url = f"{endpoint}?{urllib.parse.urlencode(params)}"
    resp = client.request("GET", url, headers={"Accept": "text/html,application/json"})

    # Pantalla de consentimiento propia del gateway: aprobarla y reintentar.
    if resp.status == 200 and "text/html" in (resp.headers.get("Content-Type") or ""):
        client.log("consent screen shown -> approving")
        post = _submit_consent(client, resp.text, url)
        if post.status in (301, 302, 303, 307, 308):
            loc = post.headers.get("Location") or ""
            code = _code_from_location(loc, redirect_uri, state)
            if code:
                return code, verifier
            # El POST vuelve a /authorize: repetir el GET, ya consentido.
            resp = client.request(
                "GET",
                loc if loc.startswith("http") else f"{client.base_url}{loc}",
                headers={"Accept": "text/html,application/json"},
            )
        else:
            raise HealthcheckError(
                f"consent submit returned HTTP {post.status}: {post.text[:200]}"
            )

    if resp.status in (301, 302, 303, 307, 308):
        location = resp.headers.get("Location") or ""
        if location.startswith("/login") or "/login?" in location:
            raise HealthcheckError(
                "authorize redirected to the login page — the session cookie "
                "was not accepted (check BRAIN_EMAIL / BRAIN_PASSWORD, and that "
                "BRAIN_URL matches the gateway's BASE_URL so the cookie domain "
                "and the https/__Secure- cookie prefix line up)"
            )
        code = _code_from_location(location, redirect_uri, state)
        if code:
            return code, verifier
        raise HealthcheckError(
            f"authorize redirected to {location[:200]!r} without an "
            "authorization code"
        )
    if resp.status == 400:
        raise HealthcheckError(
            f"authorize rejected the request: HTTP 400 {resp.text[:300]} — the "
            f"redirect_uri {redirect_uri} must be on the gateway allowlist AND "
            "byte-identical to the one registered via DCR"
        )
    if resp.status == 200:
        raise HealthcheckError(
            "authorize returned HTTP 200 (an HTML page) instead of a 302 "
            "carrying ?code=. The gateway now renders an interactive consent "
            "screen; this script must be taught to submit it. Body starts "
            f"with: {resp.text[:200]!r}"
        )
    raise HealthcheckError(
        f"authorize did not redirect: HTTP {resp.status} {resp.text[:300]}"
    )


def exchange_token(
    client: Client,
    endpoint: str,
    code: str,
    verifier: str,
    client_id: str,
    client_secret: str | None,
    redirect_uri: str,
) -> str:
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": verifier,
    }
    if client_secret:  # confidential clients only; public (PKCE) clients omit it
        form["client_secret"] = client_secret
    # Sin cookie de sesion: el canje de token es server-to-server (asi lo hace
    # claude.ai). Con cookie, Better Auth exige Origin y responde 403.
    resp = client.request("POST", endpoint, form_body=form, no_cookies=True)
    if resp.status != 200:
        raise HealthcheckError(
            f"token exchange failed: HTTP {resp.status} {resp.text[:400]}"
        )
    data = resp.json()
    token = data.get("access_token")
    if not token:
        raise HealthcheckError(f"token response has no access_token: {data}")
    return token


# ---------------------------------------------------------------------------
# MCP (streamable HTTP)
# ---------------------------------------------------------------------------


def _parse_sse(body: str):
    """Yield JSON payloads from a text/event-stream body."""
    for block in body.replace("\r\n", "\n").split("\n\n"):
        payload = "".join(
            line[5:].lstrip() for line in block.split("\n") if line.startswith("data:")
        )
        if payload:
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                continue


class MCPClient:
    """Minimal MCP streamable-HTTP JSON-RPC client."""

    def __init__(self, client: Client, token: str, path: str = "/mcp"):
        self.http = client
        self.token = token
        self.path = path
        self.session_id: str | None = None
        self._id = 0

    def _headers(self) -> dict:
        h = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    def _send(self, payload: dict, timeout: float | None = None) -> Response:
        resp = self.http.request(
            "POST", self.path, json_body=payload, headers=self._headers(), timeout=timeout
        )
        sid = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id")
        if sid:
            self.session_id = sid
        return resp

    def _rpc(self, method: str, params: dict | None = None, timeout: float | None = None):
        self._id += 1
        payload = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            payload["params"] = params
        resp = self._send(payload, timeout=timeout)
        if resp.status == 401:
            raise HealthcheckError(
                f"MCP {method}: HTTP 401 — the access token was rejected by {self.path}"
            )
        if resp.status == 403:
            raise HealthcheckError(
                f"MCP {method}: HTTP 403 — the account has no tenant mapped "
                "(tenants.json) on the gateway"
            )
        if resp.status >= 400:
            raise HealthcheckError(f"MCP {method}: HTTP {resp.status} {resp.text[:300]}")

        ctype = (resp.headers.get("Content-Type") or "").lower()
        messages = (
            list(_parse_sse(resp.text)) if "text/event-stream" in ctype else [resp.json()]
        )
        for msg in messages:
            if msg.get("id") == self._id:
                if "error" in msg:
                    err = msg["error"]
                    raise HealthcheckError(
                        f"MCP {method} returned an error: "
                        f"{err.get('code')} {err.get('message')}"
                    )
                return msg.get("result", {})
        raise HealthcheckError(
            f"MCP {method}: no JSON-RPC response with id={self._id} "
            f"(body: {resp.text[:300]!r})"
        )

    def _notify(self, method: str, params: dict | None = None) -> None:
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)

    def initialize(self) -> dict:
        result = self._rpc(
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "secondbrain-healthcheck", "version": "1.0"},
            },
        )
        self._notify("notifications/initialized")
        return result

    def list_tools(self) -> list[str]:
        result = self._rpc("tools/list")
        return [t.get("name", "") for t in result.get("tools", [])]

    def call_tool(self, name: str, arguments: dict, timeout: float | None = None) -> str:
        """Call a tool and return its response flattened to text (+ structured JSON)."""
        result = self._rpc(
            "tools/call", {"name": name, "arguments": arguments}, timeout=timeout
        )
        chunks = [
            item.get("text", "")
            for item in (result.get("content") or [])
            if item.get("type") == "text"
        ]
        if result.get("structuredContent") is not None:
            chunks.append(json.dumps(result["structuredContent"], ensure_ascii=False))
        text = "\n".join(c for c in chunks if c)
        if result.get("isError"):
            raise HealthcheckError(f"MCP tool {name} reported an error: {text[:400]}")
        return text


# ---------------------------------------------------------------------------
# The probe
# ---------------------------------------------------------------------------


def _pick(available: list[str], *candidates: str) -> str:
    for c in candidates:
        if c in available:
            return c
    raise HealthcheckError(
        f"none of the expected tools {candidates} are exposed by the MCP server "
        f"(available: {sorted(available)})"
    )


def _iter_json_objects(text: str):
    """Yield every JSON object embedded in a tool response (text or structured)."""
    for line in text.split("\n"):
        line = line.strip()
        if not line.startswith(("{", "[")):
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue
    # El texto plano de FastMCP es JSON pretty-printed (multilinea): intentar
    # tambien parsear el bloque completo, no solo linea a linea.
    try:
        yield json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass


def _episode_lists(obj):
    """Todas las listas de episodios dentro de una respuesta de tool.

    FastMCP envuelve la salida en ``structuredContent.result``, y el texto plano
    viene como JSON *pretty-printed* (multilinea). Por eso hay que mirar tanto el
    nivel raiz como ``result``, en vez de asumir ``obj["episodes"]``.
    """
    if isinstance(obj, list):
        yield obj
        return
    if not isinstance(obj, dict):
        return
    for node in (obj, obj.get("result")):
        if isinstance(node, dict) and isinstance(node.get("episodes"), list):
            yield node["episodes"]


def _find_episode_uuid(episodes_text: str, marker: str) -> str | None:
    """Locate the UUID of the episode carrying ``marker`` in a get_episodes reply."""
    for obj in _iter_json_objects(episodes_text):
      for candidates in _episode_lists(obj):
        if not isinstance(candidates, list):
            continue
        for ep in candidates:
            if not isinstance(ep, dict):
                continue
            blob = json.dumps(ep, ensure_ascii=False)
            if marker in blob and isinstance(ep.get("uuid"), str):
                return ep["uuid"]
    return None


def _fetch_episode_uuid(mcp: "MCPClient", marker: str, max_episodes: int = 20) -> str | None:
    """Best effort lookup of the canary episode's UUID via get_episodes."""
    try:
        out = mcp.call_tool("get_episodes", {"max_episodes": max_episodes})
    except HealthcheckError as exc:
        mcp.http.log(f"get_episodes failed: {exc}")
        return None
    return _find_episode_uuid(out, marker)


def run(args) -> None:
    marker = f"HC-{uuid.uuid4().hex[:12].upper()}"
    now = datetime.now(timezone.utc)
    canary_name = f"healthcheck {marker}"
    # Cuerpo DELIBERADAMENTE minimo y sin entidades reconocibles (sin fechas,
    # nombres, rutas ni organizaciones). Motivo: `delete_episode` borra el
    # episodio pero NO las entidades que el LLM extrajo de el, y no existe una
    # tool para borrar nodos. Con un texto rico, cada corrida dejaba basura
    # permanente en el grafo del usuario (observado: HC-..., "scripts", "el 2026").
    canary_body = f"ping {marker}"

    client = Client(args.url, timeout=args.http_timeout, verbose=args.verbose)

    print("[1/8] discovering OAuth endpoints", file=sys.stderr)
    meta = discover(client)

    print(f"[2/8] login as {args.email}", file=sys.stderr)
    login(client, args.email, args.password)

    if args.client_id:
        print(f"[3/8] reusing OAuth client {args.client_id}", file=sys.stderr)
        client_id, client_secret = args.client_id, args.client_secret
    else:
        print("[3/8] dynamic client registration", file=sys.stderr)
        client_id, client_secret = register_client(
            client, meta["registration_endpoint"], args.redirect_uri
        )

    print("[4/8] authorize (PKCE S256) + token exchange", file=sys.stderr)
    code, verifier = authorize(
        client, meta["authorization_endpoint"], client_id, args.redirect_uri
    )
    token = exchange_token(
        client,
        meta["token_endpoint"],
        code,
        verifier,
        client_id,
        client_secret,
        args.redirect_uri,
    )

    print("[5/8] MCP initialize", file=sys.stderr)
    mcp = MCPClient(client, token, path=args.mcp_path)
    info = mcp.initialize()
    server = (info.get("serverInfo") or {}).get("name", "?")
    print(f"      connected to MCP server: {server}", file=sys.stderr)

    tools = mcp.list_tools()
    add_tool = _pick(tools, "add_memory", "add_episode")
    search_tool = _pick(tools, "search_memory_facts", "search_facts")
    delete_tool = _pick(tools, "delete_episode", "remove_episode")
    if "get_status" in tools:
        status = mcp.call_tool("get_status", {})
        client.log(f"get_status -> {status[:200]!r}")
        if '"error"' in status:
            raise HealthcheckError(f"MCP get_status reports a problem: {status[:300]}")

    episode_uuid: str | None = None
    episode_seen = False
    failure: HealthcheckError | None = None
    try:
        print(f"[6/8] {add_tool}: writing canary {marker}", file=sys.stderr)
        # add_memory is ASYNCHRONOUS: it enqueues and returns immediately, so
        # the read-back below has to poll. group_id is deliberately omitted —
        # the tenant's server overrides it anyway.
        add_out = mcp.call_tool(
            add_tool,
            {
                "name": canary_name,
                "episode_body": canary_body,
                "source": "text",
                "source_description": "healthcheck automatizado (scripts/healthcheck.py)",
                "reference_time": now.isoformat().replace("+00:00", "Z"),
            },
            timeout=args.http_timeout,
        )
        client.log(f"{add_tool} -> {add_out[:200]!r}")

        print(
            f"[7/8] polling up to {args.timeout:.0f}s for the canary "
            f"(get_episodes + {search_tool})",
            file=sys.stderr,
        )
        deadline = time.monotonic() + args.timeout
        attempt = 0
        found = False
        while True:
            attempt += 1
            # (a) has the episode been persisted at all?
            if episode_uuid is None:
                episode_uuid = _fetch_episode_uuid(mcp, marker)
                if episode_uuid:
                    episode_seen = True
                    client.log(f"canary episode persisted as {episode_uuid}")
            # (b) has it been extracted into searchable facts?
            if episode_seen:
                try:
                    out = mcp.call_tool(
                        search_tool,
                        {"query": marker, "max_facts": 10},
                        timeout=args.http_timeout,
                    )
                except HealthcheckError as exc:
                    client.log(f"{search_tool} attempt {attempt} errored: {exc}")
                    out = ""
                if marker in out:
                    found = True
                    break
            # El episodio persistido YA demuestra el camino completo: el tool
            # respondio, la cola lo proceso y el LLM/embedder corrieron. Salimos
            # en cuanto existe; los "hechos" son un extra informativo.
            if episode_seen:
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(args.poll_interval, remaining))

        if not episode_seen:
            raise HealthcheckError(
                f"canary {marker} was accepted by {add_tool} but never "
                f"appeared in get_episodes after {args.timeout:.0f}s "
                f"({attempt} polls) — the ingestion queue is stuck or the "
                "LLM/embedder backend is failing."
            )
        if found:
            print(f"      canary found (episodio + hechos) tras {attempt} sondeo(s)", file=sys.stderr)
        else:
            # Esperado: el canario es deliberadamente minimo ("ping HC-...") para
            # no dejar entidades basura en el grafo del usuario, asi que no
            # genera hechos. Ver el comentario en canary_body.
            print(f"      canary found (episodio) tras {attempt} sondeo(s); "
                  f"sin hechos extraidos, esperado con el canario minimo", file=sys.stderr)
    except HealthcheckError as exc:
        failure = exc
    finally:
        # Cleanup is ALWAYS attempted so a failed run leaves no canary behind.
        print(f"[8/8] cleanup: {delete_tool}", file=sys.stderr)
        if episode_uuid is None:
            episode_uuid = _fetch_episode_uuid(mcp, marker)
        if episode_uuid:
            try:
                mcp.call_tool(delete_tool, {"uuid": episode_uuid})
                print(f"      deleted canary episode {episode_uuid}", file=sys.stderr)
            except HealthcheckError as exc:
                msg = f"could not delete canary episode {episode_uuid}: {exc}"
                if failure is None:
                    failure = HealthcheckError(msg)
                else:
                    print(f"      WARNING: {msg}", file=sys.stderr)
        elif failure is None:
            failure = HealthcheckError(
                f"could not resolve the UUID of canary {marker}; it may be left "
                "behind in the graph — remove it manually"
            )
        else:
            print(
                f"      WARNING: canary {marker} could not be located for "
                "cleanup; it may be left behind in the graph",
                file=sys.stderr,
            )

    if failure is not None:
        raise failure


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="healthcheck.py",
        description=(
            "End-to-end healthcheck: OAuth (login -> DCR -> PKCE -> token), MCP "
            "initialize, add a canary memory, poll until it is searchable, then "
            "delete it. Exits non-zero on any failure."
        ),
        epilog=(
            "Environment: BRAIN_URL, BRAIN_EMAIL, BRAIN_PASSWORD, BRAIN_TIMEOUT. "
            "See scripts/README.md for cron and systemd-timer setup."
        ),
    )
    p.add_argument(
        "--url",
        default=os.environ.get("BRAIN_URL"),
        help="Gateway base URL (env BRAIN_URL), e.g. https://mybrain.example.cl",
    )
    p.add_argument("--email", default=os.environ.get("BRAIN_EMAIL"), help="env BRAIN_EMAIL")
    p.add_argument(
        "--password", default=os.environ.get("BRAIN_PASSWORD"), help="env BRAIN_PASSWORD"
    )
    p.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("BRAIN_TIMEOUT", "180")),
        help="seconds to wait for the canary to become searchable (env BRAIN_TIMEOUT, default 180)",
    )
    p.add_argument(
        "--http-timeout",
        type=float,
        default=float(os.environ.get("BRAIN_HTTP_TIMEOUT", "60")),
        help="per-request HTTP timeout in seconds (default 60)",
    )
    p.add_argument(
        "--poll-interval",
        type=float,
        default=float(os.environ.get("BRAIN_POLL_INTERVAL", "5")),
        help="seconds between search polls (default 5)",
    )
    p.add_argument(
        "--redirect-uri",
        default=os.environ.get("BRAIN_REDIRECT_URI", DEFAULT_REDIRECT_URI),
        help=f"must be on the gateway allowlist (default {DEFAULT_REDIRECT_URI})",
    )
    p.add_argument(
        "--mcp-path",
        default=os.environ.get("BRAIN_MCP_PATH", "/mcp"),
        help="MCP endpoint path (default /mcp)",
    )
    p.add_argument(
        "--client-id",
        default=os.environ.get("BRAIN_CLIENT_ID"),
        help=(
            "reuse an already registered OAuth client instead of doing DCR "
            "(env BRAIN_CLIENT_ID); the gateway rate-limits DCR to 20/min/IP"
        ),
    )
    p.add_argument(
        "--client-secret",
        default=os.environ.get("BRAIN_CLIENT_SECRET"),
        help="only needed with --client-id for a confidential client",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="log every HTTP request")
    args = p.parse_args(argv)

    missing = [
        name
        for name, value in (
            ("BRAIN_URL / --url", args.url),
            ("BRAIN_EMAIL / --email", args.email),
            ("BRAIN_PASSWORD / --password", args.password),
        )
        if not value
    ]
    if missing:
        p.error("missing required configuration: " + ", ".join(missing))
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    started = time.monotonic()
    try:
        run(args)
    except HealthcheckError as exc:
        print(f"HEALTHCHECK FAILED: {exc}", file=sys.stderr)
        return EXIT_FAILED
    except KeyboardInterrupt:
        print("HEALTHCHECK FAILED: interrupted", file=sys.stderr)
        return EXIT_FAILED
    except Exception as exc:  # noqa: BLE001 — never leak a traceback to cron
        print(f"HEALTHCHECK FAILED: unexpected {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_FAILED
    print(f"HEALTHCHECK OK ({time.monotonic() - started:.1f}s)")
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as exc:
        # argparse exits with 2 on bad usage; keep that distinct from a failure.
        raise SystemExit(EXIT_CONFIG if exc.code == 2 else exc.code)
