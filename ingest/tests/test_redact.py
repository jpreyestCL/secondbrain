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
    r = redact("usa la key sk-abcdefghijklmnopqrstuv1234 para la API")
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


def test_luhn():
    assert luhn_valid("4111111111111111")
    assert not luhn_valid("4111111111111112")
    assert not luhn_valid("123")
