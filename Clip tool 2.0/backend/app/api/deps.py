"""FastAPI dependencies: DB session, auth, and role-based access control."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import jwt
from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_token
from app.models.enums import UserRole
from app.models.user import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/v1/auth/token", auto_error=True)

_CREDENTIALS_EXC = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async for session in get_db():
        yield session


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_session),
) -> User:
    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            raise _CREDENTIALS_EXC
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise _CREDENTIALS_EXC from None

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise _CREDENTIALS_EXC
    return user


async def _user_from_raw_token(raw: str | None, db: AsyncSession) -> User:
    if not raw:
        raise _CREDENTIALS_EXC
    try:
        payload = decode_token(raw)
        if payload.get("type") != "access":
            raise _CREDENTIALS_EXC
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise _CREDENTIALS_EXC from None
    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise _CREDENTIALS_EXC
    return user


async def get_current_user_flexible(
    request: Request,
    token: str | None = Query(default=None),
    db: AsyncSession = Depends(get_session),
) -> User:
    """Authenticate from an ``Authorization: Bearer`` header *or* a ``?token=``
    query param. Used by endpoints opened as plain browser links/downloads,
    where no custom header can be set (mirrors the WebSocket auth)."""
    raw = token
    if not raw:
        header = request.headers.get("Authorization", "")
        if header.lower().startswith("bearer "):
            raw = header[7:].strip()
    return await _user_from_raw_token(raw, db)


async def get_current_active_superuser(
    current_user: User = Depends(get_current_user),
) -> User:
    if not (current_user.is_superuser or current_user.role == UserRole.ADMIN.value):
        raise HTTPException(status_code=403, detail="Insufficient privileges")
    return current_user


def require_role(*roles: UserRole):
    """Dependency factory enforcing that the user has one of ``roles``
    (superusers always pass)."""
    allowed = {r.value for r in roles}

    async def _dep(current_user: User = Depends(get_current_user)) -> User:
        if current_user.is_superuser or current_user.role in allowed:
            return current_user
        raise HTTPException(status_code=403, detail="Insufficient privileges")

    return _dep
