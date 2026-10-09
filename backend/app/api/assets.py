"""已发布图片资源 GET；文件路径、NFO、远程代理及准备端点均已退役。"""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.get("/artwork/{resource_id}/{content_version}/{width}")
def get_published_artwork(request: Request, resource_id: str, content_version: str, width: int):
    """只读取已发布的派生索引和对应文件；不扫描、解码或准备图片。"""
    from app.api.media_v4 import get_database
    from app.core.paths import get_data_dir
    from app.media_v4.assets.catalog import ALL_WIDTHS, RECIPE_VERSION

    if width not in ALL_WIDTHS or len(resource_id) != 64 or any(c not in "0123456789abcdef" for c in resource_id):
        raise HTTPException(status_code=404, detail="图片资源未发布")
    with get_database().connect() as conn:
        row = conn.execute(
            """SELECT v.relative_path,v.byte_size,v.etag,r.content_digest FROM artwork_resources r
            JOIN artwork_variants v ON v.content_digest=r.content_digest
            WHERE r.resource_id=? AND v.recipe_version=? AND v.width=?
            AND EXISTS (SELECT 1 FROM artwork_bindings b WHERE b.published_id=r.resource_id)""",
            (resource_id, RECIPE_VERSION, width),
        ).fetchone()
    if row is None or content_version != f'{row["content_digest"]}-{RECIPE_VERSION}':
        raise HTTPException(status_code=404, detail="图片资源未发布")

    # 路径由后台配方生成，重新约束受管派生目录，绝不接受客户端文件路径。
    relative = Path(row["relative_path"])
    if relative.is_absolute() or ".." in relative.parts or relative.parts[:2] != ("cache", "artwork_variants"):
        raise HTTPException(status_code=404, detail="图片资源未发布")
    if not isinstance(row["byte_size"], int) or not 0 < row["byte_size"] <= 32 * 1024 * 1024:
        raise HTTPException(status_code=404, detail="图片资源未发布")

    etag = f'"{row["etag"]}"'
    headers = {
        "Cache-Control": "private, max-age=31536000, immutable",
        "ETag": etag,
        "Content-Length": str(row["byte_size"]),
    }
    # 打开文件后检查已发布索引对应的大小，避免条件请求绕过缺失/失配检查。
    try:
        data_root = Path(get_data_dir()).resolve()
        variant_root = (data_root / "cache" / "artwork_variants").resolve()
        variant_root.relative_to(data_root)
        image_path = (data_root / relative).resolve()
        image_path.relative_to(variant_root)
        with image_path.open("rb") as image_file:
            if os.fstat(image_file.fileno()).st_size != row["byte_size"]:
                raise HTTPException(status_code=404, detail="图片文件不可用")
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            payload = image_file.read(row["byte_size"] + 1)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=404, detail="图片文件不可用") from error
    if len(payload) != row["byte_size"]:
        raise HTTPException(status_code=404, detail="图片文件不可用")

    return Response(content=payload, status_code=200, media_type="image/webp", headers=headers)
