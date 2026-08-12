"""Ingesta remota por MCP: empujar episodios sin acceso al servidor.

Por qué existe: ``ingest-graph`` escribe directo a FalkorDB, y FalkorDB solo
escucha en el localhost del servidor. Eso deja la ingesta masiva reservada a
quien administra la máquina — el resto de los usuarios tiene el CLI instalado y
un camino cerrado. Este módulo usa el MISMO conector MCP que usa Claude:

    autenticación OAuth 2.1 + PKCE (navegador)  ->  token
    token  ->  POST /mcp  ->  add_memory por cada chunk

Ventajas sobre el camino directo, además de no necesitar SSH:

* El servidor pone el modelo de chat y el de embeddings, así que desaparece el
  riesgo de ingerir con una dimensión de embeddings distinta y corromper la
  búsqueda del grafo.
* El gateway autentica y enruta al tenant del usuario, y el servidor MCP fuerza
  el ``group_id``: el aislamiento entre personas no depende del cliente.

Limitación real: la cola de episodios del servidor MCP es **en memoria**. La
llamada responde cuando el episodio queda encolado, no cuando terminó de
procesarse; si el servidor se reinicia con episodios en vuelo, se pierden. Por
eso ``verificar_procesados`` consulta al final qué llegó de verdad, y el ledger
solo marca lo confirmado.

Solo biblioteca estándar (igual que scripts/healthcheck.py, del que se adapta
el cliente OAuth/MCP).
"""

from __future__ import annotations

import base64
import hashlib
import http.cookiejar
import http.server
import json
import logging
import os
import secrets
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("brain")

MCP_PROTOCOL_VERSION = "2025-06-18"
USER_AGENT = "secondbrain-cli/1.0"
CLIENT_NAME = "secondbrain-cli"


class McpRemoteError(RuntimeError):
    """Falla de autenticación o de la llamada MCP."""


# ---------------------------------------------------------------------------
# HTTP mínimo
# ---------------------------------------------------------------------------


@dataclass
class _Respuesta:
    status: int
    headers: object
    body: bytes
    url: str

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise McpRemoteError(f"respuesta no-JSON de {self.url}: {self.body[:200]!r}") from exc

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class _SinRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _Http:
    def __init__(self, base_url: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), _SinRedirect()
        )

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body=None,
        form_body=None,
        headers: dict | None = None,
        timeout: float | None = None,
        sin_cookies: bool = False,
    ) -> _Respuesta:
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
        # El registro dinámico (DCR) debe viajar SIN la cookie de sesión: Better
        # Auth aplica su chequeo de origen a las peticiones con sesión y el DCR
        # no manda Origin -> 403. Un cliente MCP real registra server-to-server.
        opener = urllib.request.build_opener(_SinRedirect()) if sin_cookies else self._opener
        try:
            with opener.open(req, timeout=timeout or self.timeout) as resp:
                return _Respuesta(resp.status, resp.headers, resp.read(), url)
        except urllib.error.HTTPError as exc:
            return _Respuesta(exc.code, exc.headers, exc.read(), url)
        except urllib.error.URLError as exc:
            raise McpRemoteError(f"no se pudo alcanzar {url}: {exc.reason}") from exc
        except TimeoutError as exc:
            raise McpRemoteError(f"timeout hablando con {url}") from exc


# ---------------------------------------------------------------------------
# OAuth 2.1 + PKCE con redirect a loopback (RFC 8252)
# ---------------------------------------------------------------------------


def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    reto = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).rstrip(b"=").decode()
    return verifier, reto


def _puerto_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _ReceptorCodigo(http.server.BaseHTTPRequestHandler):
    """Recibe el ``code`` que el navegador entrega al redirect de loopback."""

    codigo: str | None = None
    estado: str | None = None
    error: str | None = None

    def do_GET(self):  # noqa: N802 (nombre impuesto por BaseHTTPRequestHandler)
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        cls = type(self)
        cls.error = (params.get("error") or [None])[0]
        cls.codigo = (params.get("code") or [None])[0]
        cls.estado = (params.get("state") or [None])[0]
        cuerpo = (
            "<h2>Listo</h2><p>Ya puedes cerrar esta pestaña y volver a la terminal.</p>"
            if cls.codigo
            else f"<h2>Falló la autorización</h2><p>{cls.error or 'sin código'}</p>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def log_message(self, *_args):
        pass  # sin ruido en la terminal


def _descubrir(http_cli: _Http) -> dict:
    por_defecto = {
        "registration_endpoint": f"{http_cli.base_url}/api/auth/mcp/register",
        "authorization_endpoint": f"{http_cli.base_url}/api/auth/mcp/authorize",
        "token_endpoint": f"{http_cli.base_url}/api/auth/mcp/token",
    }
    resp = http_cli.request("GET", "/.well-known/oauth-authorization-server")
    if resp.status != 200:
        return por_defecto
    datos = resp.json()
    metodos = datos.get("code_challenge_methods_supported") or []
    if metodos and "S256" not in metodos:
        raise McpRemoteError(f"el servidor no ofrece PKCE S256 (dice: {metodos})")
    return {k: datos.get(k) or v for k, v in por_defecto.items()}


def _registrar(http_cli: _Http, endpoint: str, redirect_uri: str) -> str:
    cuerpo = {
        "client_name": CLIENT_NAME,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",  # cliente público: PKCE, sin secreto
    }
    resp = http_cli.request("POST", endpoint, json_body=cuerpo, sin_cookies=True)
    if resp.status == 429:
        raise McpRemoteError(
            "el registro de cliente está limitado por tasa (429). Reintenta en unos minutos."
        )
    if resp.status not in (200, 201):
        raise McpRemoteError(f"registro de cliente falló: HTTP {resp.status} {resp.text[:300]}")
    cid = resp.json().get("client_id")
    if not cid:
        raise McpRemoteError("el registro no devolvió client_id")
    return cid


def _ruta_token(brain_home: Path, tenant: str) -> Path:
    return brain_home / tenant / "mcp-token.json"


def _guardar_token(ruta: Path, datos: dict) -> None:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    tmp = ruta.with_suffix(".tmp")
    tmp.write_text(json.dumps(datos), encoding="utf-8")
    os.chmod(tmp, 0o600)  # es una credencial: nadie más en la máquina debe leerla
    tmp.replace(ruta)


def _refrescar(http_cli: _Http, token_endpoint: str, guardado: dict) -> dict | None:
    refresh = guardado.get("refresh_token")
    if not refresh:
        return None
    resp = http_cli.request(
        "POST",
        token_endpoint,
        form_body={
            "grant_type": "refresh_token",
            "refresh_token": refresh,
            "client_id": guardado.get("client_id", ""),
        },
        sin_cookies=True,
    )
    if resp.status != 200:
        return None
    datos = resp.json()
    if not datos.get("access_token"):
        return None
    return {**guardado, **datos}


def obtener_token(base_url: str, tenant: str, brain_home: Path, forzar_login: bool = False) -> str:
    """Devuelve un access_token, reusando el guardado o abriendo el navegador."""
    http_cli = _Http(base_url)
    meta = _descubrir(http_cli)
    ruta = _ruta_token(brain_home, tenant)

    if not forzar_login and ruta.exists():
        try:
            guardado = json.loads(ruta.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            guardado = {}
        if guardado.get("access_token"):
            # No se valida aquí: el 401 de la primera llamada dispara el refresh.
            return guardado["access_token"]

    puerto = _puerto_libre()
    redirect_uri = f"http://127.0.0.1:{puerto}/callback"
    client_id = _registrar(http_cli, meta["registration_endpoint"], redirect_uri)
    verifier, reto = _pkce()
    estado = secrets.token_urlsafe(24)

    url = meta["authorization_endpoint"] + "?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": estado,
            "code_challenge": reto,
            "code_challenge_method": "S256",
            "prompt": "consent",
        }
    )

    servidor = http.server.HTTPServer(("127.0.0.1", puerto), _ReceptorCodigo)
    hilo = threading.Thread(target=servidor.handle_request, daemon=True)
    hilo.start()
    print(f"Abriendo el navegador para autorizar en {base_url} ...")
    print(f"Si no se abre solo, pega esta URL:\n  {url}")
    webbrowser.open(url)
    hilo.join(timeout=300)
    servidor.server_close()

    if _ReceptorCodigo.error:
        raise McpRemoteError(f"autorización rechazada: {_ReceptorCodigo.error}")
    if not _ReceptorCodigo.codigo:
        raise McpRemoteError("no llegó el código de autorización (¿se agotaron los 5 minutos?)")
    if _ReceptorCodigo.estado != estado:
        # Un state distinto significa que la respuesta no corresponde a esta
        # petición: se aborta en vez de canjear un código de origen desconocido.
        raise McpRemoteError("el 'state' devuelto no coincide; se aborta por seguridad")

    resp = http_cli.request(
        "POST",
        meta["token_endpoint"],
        form_body={
            "grant_type": "authorization_code",
            "code": _ReceptorCodigo.codigo,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
        },
        sin_cookies=True,
    )
    if resp.status != 200:
        raise McpRemoteError(f"canje de token falló: HTTP {resp.status} {resp.text[:300]}")
    datos = resp.json()
    if not datos.get("access_token"):
        raise McpRemoteError(f"la respuesta de token no trae access_token: {datos}")
    _guardar_token(ruta, {**datos, "client_id": client_id})
    return datos["access_token"]


# ---------------------------------------------------------------------------
# Cliente MCP
# ---------------------------------------------------------------------------


def _parse_sse(cuerpo: str):
    for bloque in cuerpo.replace("\r\n", "\n").split("\n\n"):
        payload = "".join(
            linea[5:].lstrip() for linea in bloque.split("\n") if linea.startswith("data:")
        )
        if payload:
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                continue


class ClienteMCP:
    """Cliente JSON-RPC sobre MCP streamable-HTTP."""

    def __init__(self, base_url: str, token: str, path: str = "/mcp", timeout: float = 180.0):
        self.http = _Http(base_url, timeout=timeout)
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

    def _enviar(self, payload: dict, timeout: float | None = None) -> _Respuesta:
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
        resp = self._enviar(payload, timeout=timeout)
        if resp.status == 401:
            raise McpRemoteError("401 del servidor MCP: el token expiró o fue revocado")
        if resp.status >= 400:
            raise McpRemoteError(f"MCP {method}: HTTP {resp.status} {resp.text[:300]}")
        tipo = (resp.headers.get("Content-Type") or "").lower()
        mensajes = list(_parse_sse(resp.text)) if "text/event-stream" in tipo else [resp.json()]
        for m in mensajes:
            if m.get("id") != self._id:
                continue
            if "error" in m:
                raise McpRemoteError(f"MCP {method}: {m['error']}")
            return m.get("result", {})
        raise McpRemoteError(f"MCP {method}: sin respuesta para id={self._id}")

    def inicializar(self) -> dict:
        resultado = self._rpc(
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": "1.0"},
            },
        )
        self._enviar({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return resultado

    def herramientas(self) -> list[str]:
        return [t.get("name", "") for t in self._rpc("tools/list").get("tools", [])]

    def llamar(self, nombre: str, argumentos: dict, timeout: float | None = None) -> str:
        resultado = self._rpc(
            "tools/call", {"name": nombre, "arguments": argumentos}, timeout=timeout
        )
        partes = [
            item.get("text", "")
            for item in (resultado.get("content") or [])
            if item.get("type") == "text"
        ]
        # FastMCP envuelve la salida de la herramienta en structuredContent.result;
        # sin esto, respuestas perfectamente válidas se leen como vacías.
        if resultado.get("structuredContent") is not None:
            partes.append(json.dumps(resultado["structuredContent"], ensure_ascii=False))
        texto = "\n".join(p for p in partes if p)
        if resultado.get("isError"):
            raise McpRemoteError(f"la herramienta {nombre} devolvió error: {texto[:300]}")
        return texto


def conectar(base_url: str, tenant: str, brain_home: Path, path: str = "/mcp") -> ClienteMCP:
    """Autentica (o reusa el token) y deja una sesión MCP lista para usar."""
    token = obtener_token(base_url, tenant, brain_home)
    cliente = ClienteMCP(base_url, token, path=path)
    try:
        cliente.inicializar()
    except McpRemoteError as exc:
        if "401" not in str(exc):
            raise
        # Token vencido: se rehace el login una sola vez.
        log.info("el token guardado ya no sirve; reautenticando")
        token = obtener_token(base_url, tenant, brain_home, forzar_login=True)
        cliente = ClienteMCP(base_url, token, path=path)
        cliente.inicializar()
    return cliente
