"""Shared Pydantic field types."""
from __future__ import annotations

from typing import Annotated

from email_validator import EmailNotValidError, validate_email
from pydantic import BeforeValidator


def _validate_email(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("email must be a string")
    try:
        return validate_email(value, check_deliverability=False).normalized
    except EmailNotValidError as exc:
        # email-validator rejects reserved/special-use domains (.local, .test, …).
        # The default admin account (admin@openclip.local) uses one, and it's a
        # perfectly good local login identifier, so accept those while still
        # rejecting genuinely malformed addresses.
        if "special-use or reserved" in str(exc):
            return value.strip().lower()
        raise ValueError(str(exc)) from exc


# Drop-in replacement for pydantic's EmailStr that tolerates special-use domains.
Email = Annotated[str, BeforeValidator(_validate_email)]
