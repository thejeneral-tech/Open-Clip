from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models.enums import UserRole


class UserBase(BaseModel):
    email: EmailStr
    full_name: str | None = None
    role: UserRole = UserRole.EDITOR
    is_active: bool = True


class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=128)


class UserUpdate(BaseModel):
    full_name: str | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)
    role: UserRole | None = None
    is_active: bool | None = None


class UserOut(UserBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    is_superuser: bool
    created_at: datetime
