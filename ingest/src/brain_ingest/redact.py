"""Sensitivity detection and redaction.

Secrets (passwords, API keys/tokens, credit card numbers validated with Luhn)
are replaced with ``[CREDENCIAL-REDACTADA ver archivo original]`` before any
text leaves the machine toward the knowledge graph. Chilean RUTs are NOT
sensitive — they are flagged (``rut``) but left intact.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

REDACTED = "[CREDENCIAL-REDACTADA ver archivo original]"

# password: hunter2 / password=..., also contraseña/clave (Spanish) and
# env-style variables (POSTGRES_PASSWORD=x, DB_PWD=y, MY_SECRET=..., *_TOKEN=...).
# No leading \b: an optional identifier prefix may be glued to the keyword.
_PASSWORD_RE = re.compile(
    r"(?i)([A-Za-z0-9_.-]*(?:password|passwd|pwd|contrase[nñ]a|clave|secret|token))"
    r"\s*[:=]\s*(\S+)"
)

# Connection strings with inline credentials: scheme://user:pass@host,
# redis://:pass@host, mongodb+srv://user:pass@cluster... Only the password
# portion is redacted (user and host stay legible).
_URL_CREDS_RE = re.compile(
    r"\b([A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]*:)([^@\s]+)@"
)

# Well-known API key/token shapes.
_API_KEY_RES = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),            # OpenAI / Anthropic style
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                  # AWS access key id
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),        # GitHub tokens
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),      # Slack tokens
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),            # Google API key
    re.compile(r"(?i)\b(api[_-]?key|api[_-]?token|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*(\S+)"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
]

# Candidate card numbers: 13-19 digits, allowing space/dash separators.
_CC_CANDIDATE_RE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")

# Chilean RUT: 12.345.678-5 or 12345678-K (flagged, never redacted).
_RUT_RE = re.compile(r"\b\d{1,2}(?:\.\d{3}){2}-[\dkK]\b|\b\d{7,8}-[\dkK]\b")


def luhn_valid(digits: str) -> bool:
    if not digits.isdigit() or not 13 <= len(digits) <= 19:
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


@dataclass
class RedactionResult:
    text: str
    flags: list[str] = field(default_factory=list)

    @property
    def is_sensitive(self) -> bool:
        return any(f != "rut" for f in self.flags)


def redact(text: str) -> RedactionResult:
    """Redact secrets in ``text``; return redacted text plus sensitivity flags.

    Flags: ``password``, ``api_key``, ``credit_card``, ``rut`` (informational
    only — RUTs are not redacted).
    """
    flags: set[str] = set()

    def _url_creds_sub(m: re.Match[str]) -> str:
        flags.add("password")
        return f"{m.group(1)}{REDACTED}@"

    text = _URL_CREDS_RE.sub(_url_creds_sub, text)

    def _password_sub(m: re.Match[str]) -> str:
        keyword = m.group(1).lower()
        if keyword.endswith(("secret", "token")):
            flags.add("api_key")
        else:
            flags.add("password")
        return f"{m.group(1)}: {REDACTED}"

    text = _PASSWORD_RE.sub(_password_sub, text)

    for rx in _API_KEY_RES:
        def _key_sub(m: re.Match[str]) -> str:
            flags.add("api_key")
            groups = m.groups()
            if groups and groups[0] is not None and len(groups) >= 2:
                return f"{groups[0]}: {REDACTED}"
            return REDACTED

        text = rx.sub(_key_sub, text)

    def _cc_sub(m: re.Match[str]) -> str:
        digits = re.sub(r"[ -]", "", m.group(0))
        # Skip RUT-shaped or non-Luhn numbers.
        if luhn_valid(digits):
            flags.add("credit_card")
            return REDACTED
        return m.group(0)

    text = _CC_CANDIDATE_RE.sub(_cc_sub, text)

    if _RUT_RE.search(text):
        flags.add("rut")

    return RedactionResult(text=text, flags=sorted(flags))
