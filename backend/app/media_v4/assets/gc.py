"""显式预览并回收过期、无引用的自动 artwork 原图与派生缓存。"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

_MAX_DIGESTS_PER_PLAN = 500


def _eligible_digests(conn: sqlite3.Connection, *, cutoff: str, now_epoch: float) -> list[str]:
    rows = conn.execute("""SELECT DISTINCT r.content_digest FROM artwork_resources r
        WHERE r.content_digest<>'' AND r.created_at<?
        AND (
            EXISTS (SELECT 1 FROM artwork_variants v WHERE v.content_digest=r.content_digest)
            OR (r.local_source='' AND r.source_url<>''
                AND r.original_path LIKE 'artwork/originals/%' AND instr(r.original_path,'..')=0
                AND NOT EXISTS (SELECT 1 FROM artwork_resources manual
                    WHERE manual.content_digest=r.content_digest AND manual.local_source<>''))
        )
        AND NOT (r.lease_token<>'' AND r.lease_until>=?)
        AND NOT EXISTS (SELECT 1 FROM artwork_bindings b
            WHERE b.candidate_id=r.resource_id OR b.published_id=r.resource_id
               OR b.automatic_id=r.resource_id)
        AND NOT EXISTS (SELECT 1 FROM artwork_resources shared
            WHERE shared.content_digest=r.content_digest
            AND shared.resource_id<>r.resource_id
            AND (shared.local_source<>'' OR shared.created_at>=?
                 OR (shared.lease_token<>'' AND shared.lease_until>=?)
                 OR EXISTS (SELECT 1 FROM artwork_bindings b
                    WHERE b.candidate_id=shared.resource_id OR b.published_id=shared.resource_id
                       OR b.automatic_id=shared.resource_id)))
        ORDER BY r.content_digest LIMIT ?""",
        (cutoff, now_epoch, cutoff, now_epoch, _MAX_DIGESTS_PER_PLAN)).fetchall()
    return [str(row[0]) for row in rows]


def _managed_variant_path(data_root: Path, relative_path: str) -> Path | None:
    relative = Path(relative_path)
    if (relative.is_absolute() or '..' in relative.parts
            or relative.parts[:2] != ('cache', 'artwork_variants')):
        return None
    managed_root = (data_root / 'cache' / 'artwork_variants').resolve()
    target = (data_root / relative).resolve()
    try:
        managed_root.relative_to(data_root.resolve())
        target.relative_to(managed_root)
    except ValueError:
        return None
    return target


def _managed_original_path(data_root: Path, relative_path: str) -> Path | None:
    relative = Path(relative_path)
    if (relative.is_absolute() or '..' in relative.parts
            or relative.parts[:2] != ('artwork', 'originals')):
        return None
    managed_root = (data_root / 'artwork' / 'originals').resolve()
    target = (data_root / relative).resolve()
    try:
        managed_root.relative_to(data_root.resolve())
        target.relative_to(managed_root)
    except ValueError:
        return None
    return target


def preview_artwork_gc(database, data_root: str | Path, *, retention_days: int = 30,
                       now: datetime | None = None) -> dict:
    """只读列出可清理的自动原图和派生图，不触碰文件系统内容。"""
    if retention_days < 1:
        raise ValueError('Artwork retention must be at least one day')
    current = now.astimezone(UTC) if now else datetime.now(UTC)
    cutoff = (current - timedelta(days=retention_days)).isoformat()
    root = Path(data_root)
    with database.connect() as conn:
        digests = _eligible_digests(conn, cutoff=cutoff, now_epoch=current.timestamp())
        variants: list[dict] = []
        originals: list[dict] = []
        if digests:
            placeholders = ','.join('?' for _ in digests)
            rows = conn.execute(
                f'SELECT content_digest,recipe_version,width,relative_path,byte_size FROM artwork_variants '
                f'WHERE content_digest IN ({placeholders}) ORDER BY content_digest,recipe_version,width', digests
            ).fetchall()
            variants = []
            for row in rows:
                path = _managed_variant_path(root, str(row['relative_path']))
                if path is not None:
                    variants.append({
                        'content_digest': row['content_digest'],
                        'recipe_version': row['recipe_version'],
                        'width': row['width'],
                        'relative_path': row['relative_path'],
                        'byte_size': row['byte_size'],
                    })
            rows = conn.execute(
                f"SELECT DISTINCT content_digest,original_path FROM artwork_resources "
                f"WHERE content_digest IN ({placeholders}) AND local_source='' AND source_url<>'' "
                "AND original_path<>'' AND created_at<? AND NOT EXISTS ("
                "SELECT 1 FROM artwork_resources manual WHERE manual.content_digest=artwork_resources.content_digest "
                "AND manual.local_source<>'') ORDER BY content_digest,resource_id",
                (*digests, cutoff),
            ).fetchall()
            originals = []
            for row in rows:
                path = _managed_original_path(root, str(row['original_path']))
                if path is not None:
                    try:
                        byte_size = path.stat().st_size if path.is_file() else 0
                    except OSError:
                        byte_size = 0
                    originals.append({
                        'content_digest': row['content_digest'],
                        'relative_path': row['original_path'],
                        'byte_size': byte_size,
                    })
    return {
        'created_at': current.isoformat(),
        'retention_days': retention_days,
        'content_digests': digests,
        'variants': variants,
        'originals': originals,
        'variant_count': len(variants),
        'original_count': len(originals),
        'bytes': sum(int(item['byte_size']) for item in variants + originals),
    }


def execute_artwork_gc(database, data_root: str | Path, plan: dict, *, confirm: bool = False,
                       now: datetime | None = None) -> dict:
    """执行已预览计划；确认后仍在写事务中复查引用、共享 digest 和租约。"""
    if confirm is not True:
        raise ValueError('Artwork GC execution requires explicit confirmation')
    current = now.astimezone(UTC) if now else datetime.now(UTC)
    retention_days = int(plan.get('retention_days') or 0)
    if retention_days < 1:
        raise ValueError('Artwork retention must be at least one day')
    cutoff = (current - timedelta(days=retention_days)).isoformat()
    requested = set(str(item) for item in plan.get('content_digests', []))
    if len(requested) > _MAX_DIGESTS_PER_PLAN:
        raise ValueError('Artwork GC plan exceeds the digest limit')
    requested_paths = {
        (str(item['content_digest']), str(item['recipe_version']), int(item['width']), str(item['relative_path']))
        for item in plan.get('variants', [])
    }
    requested_originals = {
        (str(item['content_digest']), str(item['relative_path']))
        for item in plan.get('originals', [])
    }
    if len(requested_paths) + len(requested_originals) > _MAX_DIGESTS_PER_PLAN * 10:
        raise ValueError('Artwork GC plan exceeds the resource limit')
    if not requested:
        return {'removed': 0, 'bytes': 0, 'skipped': 0, 'originals_deleted': 0}

    removed = 0
    removed_bytes = 0
    skipped = 0
    originals_deleted = 0
    root = Path(data_root)
    with database.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        eligible = set(_eligible_digests(conn, cutoff=cutoff, now_epoch=current.timestamp()))
        eligible &= requested
        if eligible and requested_paths:
            placeholders = ','.join('?' for _ in eligible)
            rows = conn.execute(
                f'SELECT content_digest,recipe_version,width,relative_path,byte_size FROM artwork_variants '
                f'WHERE content_digest IN ({placeholders})', tuple(eligible)
            ).fetchall()
            for row in rows:
                identity = (str(row['content_digest']), str(row['recipe_version']),
                            int(row['width']), str(row['relative_path']))
                if identity not in requested_paths:
                    continue
                path = _managed_variant_path(root, identity[3])
                if path is None:
                    skipped += 1
                    continue
                try:
                    size = path.stat().st_size if path.exists() else 0
                    path.unlink(missing_ok=True)
                except OSError:
                    skipped += 1
                    continue
                conn.execute('DELETE FROM artwork_variants WHERE content_digest=? AND recipe_version=? '
                             'AND width=? AND relative_path=?', identity)
                removed += 1
                removed_bytes += size
        if eligible and requested_originals:
            placeholders = ','.join('?' for _ in eligible)
            rows = conn.execute(
                f"SELECT DISTINCT content_digest,original_path FROM artwork_resources "
                f"WHERE content_digest IN ({placeholders}) AND local_source='' AND source_url<>'' "
                "AND original_path<>'' AND created_at<? AND NOT EXISTS ("
                "SELECT 1 FROM artwork_resources manual WHERE manual.content_digest=artwork_resources.content_digest "
                "AND manual.local_source<>'')",
                (*eligible, cutoff),
            ).fetchall()
            for row in rows:
                original_identity = (str(row['content_digest']), str(row['original_path']))
                if original_identity not in requested_originals:
                    continue
                path = _managed_original_path(root, original_identity[1])
                if path is None:
                    skipped += 1
                    continue
                try:
                    size = path.stat().st_size if path.exists() else 0
                    path.unlink(missing_ok=True)
                except OSError:
                    skipped += 1
                    continue
                originals_deleted += 1
                removed_bytes += size
                conn.execute("UPDATE artwork_resources SET original_path='' WHERE content_digest=? "
                             "AND original_path=? AND local_source=''", original_identity)
        skipped = len(requested_paths) + len(requested_originals) - removed - originals_deleted
    return {'removed': removed, 'bytes': removed_bytes, 'skipped': skipped,
            'originals_deleted': originals_deleted}
