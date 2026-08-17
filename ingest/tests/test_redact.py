from brain_ingest.redact import REDACTED, luhn_valid, redact


def test_password_redacted():
    r = redact("mi cuenta\npassword: hunter2\nfin")
    assert "hunter2" not in r.text
    assert REDACTED in r.text
    assert "password" in r.flags
    assert r.is_sensitive


def test_spanish_password_redacted():
    r = redact("contraseña=SuperSecreta123")
    assert "SuperSecreta123" not in r.text
    assert "password" in r.flags


def test_openai_style_key_redacted():
    fake_key = "sk-" + "abcdefghijklmnopqrstuv1234"  # partida: no es una key real
    r = redact(f"usa la key {fake_key} para la API")
    assert "sk-abcdefghijklmnop" not in r.text
    assert "api_key" in r.flags


def test_aws_and_generic_keys():
    r = redact("AKIAIOSFODNN7EXAMPLE y api_key = 12345secret")
    assert "AKIAIOSFODNN7EXAMPLE" not in r.text
    assert "12345secret" not in r.text
    assert r.flags == ["api_key"]


def test_credit_card_luhn_redacted():
    r = redact("pagar con 4111 1111 1111 1111 antes del viernes")
    assert "4111" not in r.text
    assert REDACTED in r.text
    assert "credit_card" in r.flags


def test_non_luhn_number_kept():
    r = redact("expediente 1234 5678 9012 3456")  # fails Luhn
    assert "1234 5678 9012 3456" in r.text
    assert "credit_card" not in r.flags


def test_rut_flagged_but_not_redacted():
    r = redact("Mi RUT es 12.345.678-5 y el otro 7654321-K")
    assert "12.345.678-5" in r.text
    assert "7654321-K" in r.text
    assert r.flags == ["rut"]
    assert not r.is_sensitive  # RUT alone is not sensitive


def test_clean_text_untouched():
    text = "Notas de la reunión del lunes. Nada especial."
    r = redact(text)
    assert r.text == text
    assert r.flags == []


def test_env_style_password_vars_redacted():
    """Fix 2: prefixed keywords (POSTGRES_PASSWORD=, DB_PWD=) are redacted."""
    r = redact("POSTGRES_PASSWORD=s3cr3t\nDB_PWD=hunter2\nMY_CLAVE=abc")
    assert "s3cr3t" not in r.text
    assert "hunter2" not in r.text
    assert "abc" not in r.text.replace("[CREDENCIAL", "")
    assert "password" in r.flags
    assert r.is_sensitive


def test_env_style_secret_and_token_redacted():
    r = redact("SESSION_SECRET=deadbeef y GITLAB_TOKEN: tok123")
    assert "deadbeef" not in r.text
    assert "tok123" not in r.text
    assert "api_key" in r.flags


def test_connection_string_password_redacted():
    """Fix 2: URL credentials — only the password portion is redacted."""
    fake_pw = "SuperPass" + "1"  # ficticia, sobre dominio reservado (RFC 2606)
    r = redact(f"db en postgres://admin:{fake_pw}@db.example.com:5432/app")
    assert fake_pw not in r.text
    assert REDACTED in r.text
    assert "postgres://admin:" in r.text  # user and scheme survive
    assert "@db.example.com" in r.text
    assert "password" in r.flags


def test_redis_and_mongodb_srv_credentials_redacted():
    # Credenciales ficticias sobre dominios reservados (RFC 2606 / RFC 6761):
    # ".invalid" y ".example" no existen ni pueden registrarse, para que los
    # escaneres de secretos no las confundan con credenciales reales.
    fake_pw_redis = "c4ch3" + "pw"
    fake_pw_mongo = "m0ng0" + "pw"
    r = redact(
        f"cache redis://:{fake_pw_redis}@redis.invalid:6379/0 y "
        f"mongodb+srv://user1:{fake_pw_mongo}@cluster0.example/db"
    )
    assert fake_pw_redis not in r.text
    assert fake_pw_mongo not in r.text
    assert "redis://:" in r.text
    assert "mongodb+srv://user1:" in r.text
    assert "password" in r.flags


def test_plain_url_without_credentials_untouched():
    text = "ver https://example.com/path y http://localhost:8080/salud"
    r = redact(text)
    assert r.text == text
    assert r.flags == []


def test_luhn():
    assert luhn_valid("4111111111111111")
    assert not luhn_valid("4111111111111112")
    assert not luhn_valid("123")


# ---------------------------------------------------------------------------
# Fugas que la revision encontro: salian INTACTAS hacia el grafo
# ---------------------------------------------------------------------------


def _redactado(texto: str) -> bool:
    return "REDACTADA" in redact(texto).text


def test_pin_y_cvv_se_redactan():
    """La regla de oro 2 los nombra, y no estaban en la lista de palabras."""
    assert _redactado("PIN: 4321")
    assert _redactado("CVV: 371")
    assert _redactado("codigo de seguridad: 918")


def test_frase_semilla_se_redacta():
    """Una semilla es dinero al portador; es el peor secreto que se puede filtrar."""
    assert _redactado(
        "Frase semilla: witch collapse practice feed shame open despair creek road again ice least"
    )
    # Y tambien suelta, sin que nadie la anuncie: 12 palabras seguidas es la
    # forma canonica de BIP39.
    assert _redactado(
        "witch collapse practice feed shame open despair creek road again ice least"
    )


def test_formulario_en_dos_lineas():
    """Copiar de una web deja la etiqueta y el valor en lineas distintas; el
    patron exigia los dos puntos pegados."""
    assert _redactado("Usuario: jp\nContraseña\nhunter2patito")


def test_fila_de_tabla_con_clave():
    assert _redactado("| gmail | jp | clave: hunter2patito |")


def test_jwt_se_redacta():
    assert _redactado(
        "authorization eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"
    )


def test_password_en_prosa_sin_dos_puntos():
    assert _redactado("mi password es hunter2patito")


def test_par_usuario_clave_sin_palabra_que_lo_anuncie():
    """`acceso portal: jpreyest / Tr0ub4dor&3` no dice "contraseña" en ningun
    lado; se reconoce por la FORMA del token, pero solo en lineas que hablan
    de acceder a algo."""
    assert _redactado("acceso portal: jpreyest / Tr0ub4dor&3")


# ---------------------------------------------------------------------------
# Falsos positivos que DESTRUIAN datos reales (1.112 trozos medidos)
# ---------------------------------------------------------------------------


def test_no_se_borran_identificadores_que_pasan_luhn_por_azar():
    """~1 de cada 10 secuencias de 13-19 digitos pasa Luhn por casualidad.

    Medido sobre el corpus real: 1.112 trozos (11,3%) en 46 documentos perdian
    un numero de cuenta escrow, un trace ACH o un id de orden. En un caso la
    redaccion se comio una fecha y un saldo.
    """
    for texto in [
        "Cuenta escrow 2-834-17765-0001310-001",
        "ACH Trace 091000013137922",
        "cartola 2024 918619959 31",
        "orden Shopify 5958696435985",
    ]:
        assert not _redactado(texto), f"se borro un dato real: {texto}"


def test_una_tarjeta_de_verdad_si_se_borra():
    """El arreglo no puede dejar pasar lo que si es una tarjeta."""
    assert _redactado("tarjeta de credito 4111 1111 1111 1111")
    assert _redactado("Tarjeta Visa terminada en 4111111111111111")


def test_clave_como_adjetivo_no_es_una_contrasena():
    """En espanol `clave` tambien es adjetivo, y redactar la linea entera
    destroza el texto."""
    assert not _redactado("fechas clave: Empieza oficialmente el 6 de marzo")
    assert not _redactado("palabra clave: turismo aventura")
    assert not _redactado("LA CLAVE ES SER SIMPLE")


def test_la_clave_como_sustantivo_si_lo_es():
    assert _redactado("la clave: phiYaihee1kaoth")
    assert _redactado("Usuario: jpreyest Clave: phiYaihee1kaoth")


def test_no_se_tocan_rutas_ni_sql_ni_prosa_juridica():
    """El detector por FORMA marcaba el 62,8% del corpus antes de acotarlo a
    lineas que hablan de acceso."""
    for texto in [
        "Carpeta: sociedades/Andes USA/Cartolas/CITI BANK/2025/August 29.pdf",
        'select o.discount,o.code,o.schedule_date,"CLP" as CLP1 from orders',
        "operativa en Chile, que es titular del noventa coma cero por ciento",
        "conforme a la ley No19.799, de 2002, sobre firma electronica",
    ]:
        assert not _redactado(texto), f"se redacto texto normal: {texto[:50]}"


def test_el_rut_se_marca_pero_no_se_borra():
    """Es dato del propio dueno sobre si mismo, no un secreto."""
    r = redact("El RUT es 12.345.678-5")
    assert "12.345.678-5" in r.text
    assert "rut" in r.flags
