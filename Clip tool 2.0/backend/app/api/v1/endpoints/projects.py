"""Project CRUD."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.models.clip import Clip
from app.models.project import Project
from app.models.user import User
from app.models.video import Video
from app.schemas.common import Message
from app.schemas.project import ProjectCreate, ProjectOut, ProjectUpdate

router = APIRouter()


async def _get_owned_project(db: AsyncSession, project_id: int, user: User) -> Project:
    project = await db.get(Project, project_id)
    if not project or project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _to_out(db: AsyncSession, project: Project) -> ProjectOut:
    video_count = (
        await db.execute(select(func.count(Video.id)).where(Video.project_id == project.id))
    ).scalar_one()
    clip_count = (
        await db.execute(
            select(func.count(Clip.id))
            .select_from(Clip)
            .join(Video, Clip.video_id == Video.id)
            .where(Video.project_id == project.id)
        )
    ).scalar_one()
    out = ProjectOut.model_validate(project)
    out.video_count = video_count
    out.clip_count = clip_count
    return out


@router.get("", response_model=list[ProjectOut])
async def list_projects(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[ProjectOut]:
    result = await db.execute(
        select(Project).where(Project.owner_id == current_user.id).order_by(Project.created_at.desc())
    )
    projects = list(result.scalars().all())
    return [await _to_out(db, p) for p in projects]


@router.post("", response_model=ProjectOut, status_code=201)
async def create_project(
    payload: ProjectCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ProjectOut:
    project = Project(owner_id=current_user.id, name=payload.name, description=payload.description)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return await _to_out(db, project)


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ProjectOut:
    project = await _get_owned_project(db, project_id, current_user)
    return await _to_out(db, project)


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: int,
    payload: ProjectUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> ProjectOut:
    project = await _get_owned_project(db, project_id, current_user)
    if payload.name is not None:
        project.name = payload.name
    if payload.description is not None:
        project.description = payload.description
    await db.commit()
    await db.refresh(project)
    return await _to_out(db, project)


@router.delete("/{project_id}", response_model=Message)
async def delete_project(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> Message:
    project = await _get_owned_project(db, project_id, current_user)
    await db.delete(project)
    await db.commit()
    return Message(detail="Project deleted")
