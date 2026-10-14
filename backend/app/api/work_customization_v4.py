"""Local user customization endpoints kept separate from the published detail payload."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.api.media_v4 import get_database
from app.media_v4.customization.work_tags import get_extra_video_overview

router = APIRouter(prefix="/api/v4/work-customization", tags=["work-customization-v4"])


class WorkTag(BaseModel):
    id: str = Field(min_length=1, max_length=48, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=24)
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str) -> str:
        label = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", value).strip()
        if not label:
            raise ValueError("标签名称不能为空")
        return label


class WorkTagsRequest(BaseModel):
    tags: list[WorkTag] = Field(default_factory=list, max_length=16)


def _work_exists(conn, work_id: str) -> bool:
    return conn.execute("SELECT 1 FROM works WHERE work_id = ?", (work_id,)).fetchone() is not None


@router.get("/{work_id}")
def get_work_customization(work_id: str) -> dict:
    with get_database().connect() as conn:
        if not _work_exists(conn, work_id):
            raise HTTPException(status_code=404, detail="作品不存在")
        row = conn.execute("SELECT override_json FROM work_overrides WHERE work_id = ?", (work_id,)).fetchone()
    try:
        override = json.loads(row["override_json"]) if row else {}
    except (TypeError, ValueError):
        override = {}
    tags = override.get("detail_tags", []) if isinstance(override, dict) else []
    if not isinstance(tags, list):
        tags = []
    valid_tags = []
    for raw in tags[:16]:
        try:
            valid_tags.append(WorkTag.model_validate(raw).model_dump())
        except Exception:
            continue
    return {"work_id": work_id, "tags": valid_tags}


@router.put("/{work_id}")
def replace_work_tags(work_id: str, request: WorkTagsRequest) -> dict:
    tags = [tag.model_dump() for tag in request.tags]
    if len({tag["id"] for tag in tags}) != len(tags):
        raise HTTPException(status_code=422, detail="标签标识不能重复")
    now = datetime.now(UTC).isoformat()
    database = get_database()
    with database.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if not _work_exists(conn, work_id):
            raise HTTPException(status_code=404, detail="作品不存在")
        existing = conn.execute("SELECT override_json, created_at FROM work_overrides WHERE work_id = ?", (work_id,)).fetchone()
        try:
            override = json.loads(existing["override_json"]) if existing else {}
        except (TypeError, ValueError):
            override = {}
        if not isinstance(override, dict):
            override = {}
        override["detail_tags"] = tags
        conn.execute(
            """
            INSERT INTO work_overrides(work_id, override_json, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(work_id) DO UPDATE SET override_json = excluded.override_json, updated_at = excluded.updated_at
            """,
            (work_id, json.dumps(override, ensure_ascii=False, separators=(",", ":")),
             str(existing["created_at"]) if existing else now, now),
        )
    return {"work_id": work_id, "tags": tags}


@router.get("/{work_id}/extra-videos")
def get_extra_videos(work_id: str) -> dict:
    with get_database().connect() as conn:
        overview = get_extra_video_overview(conn, work_id)
    if overview is None:
        raise HTTPException(status_code=404, detail="作品不存在")
    return overview
