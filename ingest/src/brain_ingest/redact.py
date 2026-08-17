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
#: Palabras que anuncian un secreto. Faltaban PIN, CVV y las semillas — o sea
#: justo lo que la regla de oro 2 nombra primero. Verificado: `PIN: 4321` y
#: `Frase semilla: witch collapse...` salian INTACTOS hacia el grafo.
_PALABRAS_SECRETO = (
    r"password|passwd|pwd|contrase[nñ]a|clave|secret|token|"
    r"pin|cvv|cvc|codigo de seguridad|c[oó]digo de seguridad|"
    r"seed|semilla|mnemonic|mnemonica|frase de recuperaci[oó]n|passphrase"
)

#: El VALOR se toma hasta el fin de linea, no solo el primer token.
#: `clave: mi clave secreta de 2019` dejaba "clave secreta de 2019" en claro.
#: `clave: X`, `clave=X` y tambien `mi clave es X` — en prosa la gente no
#: escribe dos puntos.
#:
#: Con `es`/`is` el valor debe ser UN SOLO token: "la clave es abc123" es una
#: contrasena, pero "que es titular del noventa por ciento" es prosa juridica y
#: se redactaba la linea entera.
_PASSWORD_RE = re.compile(
    r"(?i)([A-Za-z0-9_.-]*(?:" + _PALABRAS_SECRETO + r"))"
    # El valor termina en fin de linea O en `|`: dentro de una tabla, la celda
    # acaba en la barra y arrastrarla hacia dentro rompia la deteccion.
    r"(?:\s*[:=]\s*([^\n|]+)|\s+(?:es|is)\s+(\S+))"
)

#: En espanol `clave` es tambien adjetivo: "fechas clave:", "palabra clave:",
#: "punto clave:". Ahi no anuncia ningun secreto y redactar la linea entera
#: destroza el texto.
#:
#: Lo que distingue no es lo que va ANTES sino lo que va DESPUES: una
#: contrasena es un token unico ("phiYaihee1kaoth"); "Empieza el 6 de marzo" es
#: prosa. Asi que con `clave` se exige valor de una sola palabra, salvo que la
#: linea hable de acceso.

#: La misma palabra SOLA en una linea y el valor en la siguiente. Es como se ve
#: un formulario copiado de una web:  "Contraseña\nhunter2patito".
_PASSWORD_MULTILINEA_RE = re.compile(
    r"(?im)^[ \t]*((?:" + _PALABRAS_SECRETO + r")[ \t]*:?)[ \t]*\n[ \t]*(\S[^\n]*)"
)

#: Cabecera de tabla que anuncia una columna de secretos.
#:
#: El caso peligroso de verdad es un gestor de claves exportado: la palabra
#: esta en la CABECERA (`| servicio | usuario | clave |`) y los valores en las
#: filas, donde no hay ninguna palabra que los anuncie. Por eso hay que
#: recordar QUE COLUMNA es y redactar esa celda en las filas siguientes.
_FILA_TABLA_RE = re.compile(r"^[ \t]*\|(.+)\|[ \t]*$")
_PALABRA_SECRETO_RE = re.compile(r"(?i)\b(?:" + _PALABRAS_SECRETO + r")\b")

#: JWT: tres bloques base64url separados por puntos. Llevan dentro lo que sea
#: que autentique al portador.
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")

#: Token que "parece contrasena" por su forma: >=8 caracteres con minuscula,
#: mayuscula, digito Y simbolo.
#:
#: SOLO se aplica en lineas que ademas hablan de acceso (ver
#: `_CONTEXTO_ACCESO_RE`). Sin esa restriccion el patron es inservible: medido
#: sobre el corpus real marcaba el 62,8% de los trozos — rutas de archivo
#: (`Cartolas/CITI BANK/2025/August 29.pdf`), SQL (`o.code,o.schedule_date`),
#: citas legales (`ley No19.799, de 2002`) e ids de transaccion. Sustituir un
#: desastre de falsos positivos por otro mayor no es arreglarlo.
_PARECE_CLAVE_RE = re.compile(
    r"(?<![\w/.-])(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)(?=[^\s]*[^\w\s])[^\s]{8,64}(?![\w/.-])"
)

#: Palabras que indican que la linea habla de ENTRAR a algo. Solo ahi tiene
#: sentido buscar una contrasena por su forma.
_CONTEXTO_ACCESO_RE = re.compile(
    r"(?i)\b(acceso|acceder|login|log in|usuario|user|credencial|portal|"
    r"entrar|ingreso|cuenta de|iniciar sesi[oó]n|sign in)\b"
)

#: Frase semilla suelta: 12 o 24 palabras minusculas seguidas. Es la forma
#: canonica de BIP39 y no se parece a la prosa normal.
_SEMILLA_SUELTA_RE = re.compile(r"\b(?:[a-z]{3,8} ){11}[a-z]{3,8}\b(?:(?: [a-z]{3,8}){12})?")

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

#: Tarjetas: SOLO las dos formas en que se escriben de verdad — 13-19 digitos
#: seguidos, o grupos de 4 con un separador consistente.
#:
#: El patron anterior aceptaba cualquier mezcla de espacios y guiones, y como
#: ~1 de cada 10 secuencias pasa Luhn por azar, borraba datos REALES. Medido
#: sobre el corpus: 1.112 trozos (11,3%) en 46 documentos perdian un numero de
#: cuenta escrow, un trace ACH, un id de orden — y en un caso se comio una
#: fecha y un saldo: '2024 918619959 31'.
_CC_CANDIDATE_RE = re.compile(
    r"\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,4})\b"
)

#: Palabras que confirman que un numero largo ES una tarjeta.
#:
#: Un identificador cualquiera de 13-19 digitos pasa Luhn 1 de cada 10 veces
#: por azar, asi que Luhn SOLO no distingue una tarjeta de un trace ACH o de un
#: id de orden. Un numero suelto sin contexto se deja: perder el numero de
#: cuenta de una escritura es un dano real y frecuente; una tarjeta en el grafo
#: PRIVADO del propio dueno es un riesgo menor — y CLAUDE.md ya dice que los
#: numeros de cuenta son sensibles, no secretos.
_CONTEXTO_TARJETA_RE = re.compile(
    r"(?i)(tarjeta|card|visa|mastercard|amex|american express|cr[eé]dito|d[eé]bito)"
)

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


def _redactar_tablas(text: str, flags: set[str]) -> str:
    """Redacta las columnas de secretos de las tablas markdown.

    Recuerda que columna anuncio la cabecera y redacta esa celda en las filas
    siguientes: en un gestor de claves exportado, la fila con el valor no
    contiene ninguna palabra que lo delate.
    """
    if "|" not in text:
        return text

    salida: list[str] = []
    columnas: set[int] | None = None
    for linea in text.split("\n"):
        fila = _FILA_TABLA_RE.match(linea)
        if not fila:
            columnas = None  # se acabo la tabla
            salida.append(linea)
            continue

        celdas = fila.group(1).split("|")
        # Fila separadora (|---|---|): mantiene la tabla viva sin datos.
        if all(re.fullmatch(r"[ \t:-]*", c) for c in celdas):
            salida.append(linea)
            continue

        marcadas = {i for i, c in enumerate(celdas) if _PALABRA_SECRETO_RE.search(c)}
        if columnas is None:
            # Primera fila con datos: hace de cabecera.
            columnas = marcadas
            salida.append(linea)
            continue

        objetivo = columnas | marcadas
        if objetivo:
            flags.add("password")
            nuevas = [
                REDACTED if i in objetivo and c.strip() else c
                for i, c in enumerate(celdas)
            ]
            salida.append("|" + "|".join(nuevas) + "|")
        else:
            salida.append(linea)
    return "\n".join(salida)


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
        valor = (m.group(2) or m.group(3) or "").strip()
        # Con el conector `es`/`is` (sin dos puntos) el valor tiene que
        # PARECER una credencial: "LA CLAVE ES SER SIMPLE" es un eslogan, no
        # una contrasena. Con `:` no se exige, porque `PIN: 4321` es corto y
        # es un secreto de verdad.
        if m.group(3) and len(valor) < 6 and not any(c.isdigit() for c in valor):
            return m.group(0)
        if keyword.endswith("clave") and " " in valor:
            linea_ini = text.rfind("\n", 0, m.start()) + 1
            linea = text[linea_ini : text.find("\n", m.end()) % (len(text) + 1) or len(text)]
            if not _CONTEXTO_ACCESO_RE.search(linea):
                return m.group(0)
        if keyword.endswith(("secret", "token")):
            flags.add("api_key")
        else:
            flags.add("password")
        return f"{m.group(1)}: {REDACTED}"

    text = _PASSWORD_RE.sub(_password_sub, text)

    def _multilinea_sub(m: re.Match[str]) -> str:
        flags.add("password")
        return f"{m.group(1)}\n{REDACTED}"

    text = _PASSWORD_MULTILINEA_RE.sub(_multilinea_sub, text)

    text = _redactar_tablas(text, flags)

    def _jwt_sub(m: re.Match[str]) -> str:
        flags.add("api_key")
        return REDACTED

    text = _JWT_RE.sub(_jwt_sub, text)

    def _parece_clave_sub(m: re.Match[str]) -> str:
        token = m.group(0)
        # No volver a tocar lo ya redactado (el propio marcador cumple el
        # patron), ni URLs completas: ahi la credencial ya la quito
        # _URL_CREDS_RE y el resto es informacion util (host, base de datos).
        if "REDACTADA" in token or "://" in token:
            return token
        flags.add("password")
        return REDACTED

    # Linea por linea: el patron de forma solo se aplica donde el texto habla
    # de acceder a algo.
    text = "\n".join(
        _PARECE_CLAVE_RE.sub(_parece_clave_sub, linea)
        if _CONTEXTO_ACCESO_RE.search(linea)
        else linea
        for linea in text.split("\n")
    )

    def _semilla_sub(m: re.Match[str]) -> str:
        flags.add("seed_phrase")
        return REDACTED

    text = _SEMILLA_SUELTA_RE.sub(_semilla_sub, text)

    for rx in _API_KEY_RES:
        def _key_sub(m: re.Match[str]) -> str:
            flags.add("api_key")
            groups = m.groups()
            if groups and groups[0] is not None and len(groups) >= 2:
                return f"{groups[0]}: {REDACTED}"
            return REDACTED

        text = rx.sub(_key_sub, text)

    def _cc_sub(m: re.Match[str]) -> str:
        crudo = m.group(0)
        digits = re.sub(r"[ -]", "", crudo)
        # Un separador MEZCLADO (2-834 17765) no es una tarjeta: es un
        # identificador cualquiera que casualmente paso Luhn.
        separadores = set(re.findall(r"[ -]", crudo))
        if len(separadores) > 1:
            return crudo
        # Digitos seguidos y sin contexto de tarjeta: es un identificador.
        if not separadores:
            antes = text[max(0, m.start() - 60) : m.start()]
            if not _CONTEXTO_TARJETA_RE.search(antes):
                return crudo
        if luhn_valid(digits):
            flags.add("credit_card")
            return REDACTED
        return crudo

    text = _CC_CANDIDATE_RE.sub(_cc_sub, text)

    if _RUT_RE.search(text):
        flags.add("rut")

    return RedactionResult(text=text, flags=sorted(flags))
