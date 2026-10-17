"""备份与恢复 API：.kumibak 导出、下载、恢复预览与按预览确认恢复。

浏览器可直接下载/上传（multipart），不依赖 Electron 文件对话框；
所有文件只落在 <数据目录>/backups/ 内，不开放任意文件系统代理。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.media_v4 import get_database
from app.core.backup import (
    MAX_UPLOAD_BYTES,
    BackupError,
    BackupPreviewError,
    apply_restore,
    auto_backup_status,
    create_backup,
    list_backups,
    preview_restore,
    resolve_backup_file,
    scope_payload,
)

router = APIRouter(prefix="/api/backup", tags=["backup"])


class RestoreConfirmRequest(BaseModel):
    preview_id: str
    digest: str


@router.post("/export")
def export_backup():
    """生成一份手动备份（不参与七份自动备份轮换）。"""

    try:
        file_info = create_backup(get_database(), kind="manual")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"生成备份失败（{type(exc).__name__}）") from exc
    return {"ok": True, "file": file_info, "scope": scope_payload()}


@router.get("/files")
def list_backup_files():
    return {"files": list_backups(), "auto": auto_backup_status(), "scope": scope_payload()}


@router.get("/files/{file_id}/download")
def download_backup_file(file_id: str):
    try:
        path = resolve_backup_file(file_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="备份文件不存在") from None
    return FileResponse(path, media_type="application/zip", filename=path.name)


@router.post("/restore/preview")
def preview_backup_restore(file: Annotated[UploadFile, File()]):
    """只读校验上传的备份并返回影响预览；不修改任何数据。"""

    try:
        raw = file.file.read(MAX_UPLOAD_BYTES + 1)
    except OSError as exc:
        raise HTTPException(status_code=400, detail="备份文件读取失败") from exc
    if raw is None or len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="备份文件超过上传大小上限")
    try:
        return preview_restore(get_database(), raw)
    except BackupError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/restore/confirm")
def confirm_backup_restore(request: RestoreConfirmRequest):
    """按服务端保存的预览身份与摘要确认恢复；失败不修改当前数据。"""

    try:
        return apply_restore(get_database(), request.preview_id, request.digest)
    except BackupPreviewError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except BackupError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"恢复失败，已保持原状（{type(exc).__name__}）") from exc
