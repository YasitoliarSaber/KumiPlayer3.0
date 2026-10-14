"""System-level helpers exposed through V4 media identities."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from app.api.media_v4 import get_database
from app.media_v4.path_validation import validate_playback_locator_syntax

router = APIRouter(prefix="/api/system", tags=["system"])


@router.post("/shutdown", status_code=202)
def request_shutdown(request: Request, background_tasks: BackgroundTasks):
    """Ask the owning desktop server to exit after this response is sent."""
    callback = getattr(request.app.state, "request_shutdown", None)
    if not callable(callback):
        raise HTTPException(status_code=503, detail="当前服务未注册桌面关闭入口")
    background_tasks.add_task(callback)
    return {"accepted": True}


class OpenFolderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    work_id: str
    episode_id: str = ""
    asset_id: str = ""
    folder_type: Literal["video"] = "video"
    open: bool = True


@router.post("/open-folder")
def open_folder(req: OpenFolderRequest):
    """Resolve a folder from a V4 Work/Episode/Asset identity.

    The frontend sends IDs only. No arbitrary filesystem path is accepted and
    only V4 Work/Episode/Asset rows are consulted.
    """

    asset = _find_asset(req.work_id, req.episode_id, req.asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="作品或剧集没有当前已确认的媒体文件")
    locator = str(asset["playback_locator"] or "")
    valid, reason = validate_playback_locator_syntax(locator)
    if not valid:
        raise HTTPException(status_code=400, detail=reason)
    source_path = Path(locator)
    folder = source_path.parent
    exists = folder.is_dir()
    if req.open and not exists:
        raise HTTPException(status_code=404, detail=f"文件夹不存在: {folder}")
    if req.open:
        _open_folder(folder)
    return {
        "ok": True,
        "opened": bool(req.open and exists),
        "exists": exists,
        "folder_path": str(folder),
        "source_path": str(source_path),
    }


def _find_asset(work_id: str, episode_id: str, asset_id: str = "") -> dict | None:
    with get_database().connect() as conn:
        row = conn.execute(
            """
            SELECT se.playback_locator
            FROM revision_bindings rb
            JOIN import_revisions ir ON ir.revision_id = rb.revision_id AND ir.status = 'confirmed'
            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
            JOIN works w ON w.work_id = rb.work_id AND w.status = 'active'
            JOIN assets a ON a.asset_id = rb.asset_id AND a.availability_state = 'available'
            JOIN source_evidence se ON se.evidence_id = rb.evidence_id
            LEFT JOIN episodes e ON e.episode_id = rb.episode_id AND e.work_id = rb.work_id
            LEFT JOIN episode_assets ea ON ea.asset_id = rb.asset_id AND ea.episode_id = rb.episode_id
            LEFT JOIN work_assets wa ON wa.asset_id = rb.asset_id AND wa.work_id = rb.work_id
            WHERE rb.work_id = ? AND (? = '' OR rb.episode_id = ?)
              AND (? = '' OR rb.asset_id = ?)
              AND ((rb.episode_id IS NULL AND wa.asset_id IS NOT NULL)
                   OR (e.episode_id IS NOT NULL AND ea.asset_id IS NOT NULL))
            ORDER BY COALESCE(ea.preference_rank, wa.preference_rank, 0),
                     ir.confirmed_at DESC, rb.binding_id
            LIMIT 1
            """,
            (work_id, episode_id, episode_id, asset_id, asset_id),
        ).fetchone()
    return dict(row) if row is not None else None


def _open_folder(folder: Path) -> None:
    if sys.platform.startswith("win"):
        os.startfile(str(folder))  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(folder)])
        return
    subprocess.Popen(["xdg-open", str(folder)])
