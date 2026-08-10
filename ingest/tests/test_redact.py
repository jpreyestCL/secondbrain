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
