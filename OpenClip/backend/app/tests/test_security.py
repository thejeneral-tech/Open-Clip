import jwt
import pytest

from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)


def test_password_hash_roundtrip():
    hashed = hash_password("supersecret")
    assert hashed != "supersecret"
    assert verify_password("supersecret", hashed)
    assert not verify_password("wrong", hashed)


def test_access_token_carries_role():
    token = create_access_token(42, role="admin")
    payload = decode_token(token)
    assert payload["sub"] == "42"
    assert payload["type"] == "access"
    assert payload["role"] == "admin"


def test_refresh_token_type():
    payload = decode_token(create_refresh_token(7))
    assert payload["type"] == "refresh"
    assert payload["sub"] == "7"


def test_tampered_token_rejected():
    token = create_access_token(1)
    with pytest.raises(jwt.PyJWTError):
        decode_token(token + "tamper")
