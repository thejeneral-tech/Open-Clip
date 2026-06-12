"""Authentication: register, login, refresh, current user."""
from __future__ import annotations

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.core.logging import get_logger
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models.enums import UserRole
from app.models.settings import UserSettings
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    Token,
)
from app.schemas.user import UserOut
from app.services.storyvault.voice_presets import ensure_voice_presets

logger = get_logger(__name__)
router = APIRouter()


async def _authenticate(db: AsyncSession, email: str, password: str) -> User:
    result = await db.execute(select(User).where(User.email == email.lower()))
    user = result.scalar_one_or_none()
    if not user or not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect email or password")
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return user


def _issue_tokens(user: User) -> Token:
    return Token(
        access_token=create_access_token(user.id, role=user.role),
        refresh_token=create_refresh_token(user.id),
    )


@router.post("/register", response_model=Token, status_code=201)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_session)) -> Token:
    existing = await db.execute(select(User).where(User.email == payload.email.lower()))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    # First ever user becomes an admin superuser.
    count = (await db.execute(select(func.count(User.id)))).scalar_one()
    is_first = count == 0

    user = User(
        email=payload.email.lower(),
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
        role=UserRole.ADMIN.value if is_first else UserRole.EDITOR.value,
        is_superuser=is_first,
    )
    db.add(user)
    await db.flush()
    db.add(UserSettings(user_id=user.id))
    await db.commit()
    await db.refresh(user)
    # Give the brand-new account the built-in TikTok voice presets right away
    # (non-fatal: startup + Voice Lab seeding are backups if this ever fails).
    try:
        await run_in_threadpool(ensure_voice_presets, user.id)
    except Exception as exc:  # pragma: no cover
        logger.warning("Voice-preset seeding skipped for new user %s: %s", user.id, exc)
    return _issue_tokens(user)


@router.post("/login", response_model=Token)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_session)) -> Token:
    user = await _authenticate(db, payload.email, payload.password)
    return _issue_tokens(user)


@router.post("/token", response_model=Token, include_in_schema=True)
async def login_form(
    form: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_session),
) -> Token:
    """OAuth2 password flow — used by the Swagger 'Authorize' button."""
    user = await _authenticate(db, form.username, form.password)
    return _issue_tokens(user)


@router.post("/refresh", response_model=Token)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_session)) -> Token:
    try:
        decoded = decode_token(payload.refresh_token)
        if decoded.get("type") != "refresh":
            raise ValueError("wrong token type")
        user_id = int(decoded["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    return _issue_tokens(user)


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)) -> User:
    return current_user
