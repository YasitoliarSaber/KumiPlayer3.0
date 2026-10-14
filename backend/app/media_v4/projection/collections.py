"""confirmed 合集成员的只读展示，线上元数据不能改写本地层级。"""

import json
from collections import defaultdict


def title_identity_guards(conn) -> tuple[set[str], set[str]]:
    """确认的父子关系或共享 TV 身份存在歧义时，保留本地作品区别。"""
    rows = conn.execute("""
        WITH active_works AS (
            SELECT w.work_id,w.preferred_title FROM works w
            WHERE EXISTS (
                SELECT 1 FROM revision_bindings rb
                JOIN import_revisions ir ON ir.revision_id=rb.revision_id AND ir.status='confirmed'
                JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.retired_at=''
                WHERE rb.work_id=w.work_id
            )
        )
        SELECT wr.child_work_id AS work_id, 'relation' AS reason FROM work_relations wr
        JOIN active_works child ON child.work_id=wr.child_work_id
        JOIN active_works parent ON parent.work_id=wr.parent_work_id
        WHERE wr.child_work_id != wr.parent_work_id
        UNION
        SELECT local.work_id, 'shared_tv' AS reason FROM provider_bindings pb
        JOIN active_works local ON local.work_id=pb.work_id
        JOIN provider_bindings other ON other.provider=pb.provider
            AND other.media_type=pb.media_type AND other.provider_id=pb.provider_id
            AND other.work_id != pb.work_id
        JOIN active_works remote ON remote.work_id=other.work_id
        WHERE pb.media_type='tv' AND pb.provider_id != ''
          AND lower(trim(local.preferred_title)) != lower(trim(remote.preferred_title))
    """).fetchall()
    return ({str(row["work_id"]) for row in rows},
            {str(row["work_id"]) for row in rows if row["reason"] == "shared_tv"})


def identity_title_work_ids(conn) -> set[str]:
    return title_identity_guards(conn)[0]


def collection_metadata(conn) -> dict[str, dict]:
    rows = conn.execute("""
        SELECT DISTINCT c.collection_id,c.preferred_title AS collection_title,c.parent_collection_id,
               w.work_id,w.preferred_title,w.year,w.card_type,w.show_type
        FROM revision_collection_members m
        JOIN media_collections c ON c.collection_id=m.collection_id
        JOIN import_revisions ir ON ir.revision_id=m.revision_id AND ir.status='confirmed'
        JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.retired_at=''
        JOIN works w ON w.work_id=m.work_id
        WHERE EXISTS (SELECT 1 FROM revision_bindings rb
                      WHERE rb.revision_id=m.revision_id AND rb.work_id=m.work_id)
          AND NOT EXISTS (SELECT 1 FROM work_overrides wo WHERE wo.work_id=w.work_id
                          AND CASE WHEN json_valid(wo.override_json)
                              THEN json_extract(wo.override_json,'$.hidden') ELSE 0 END = 1)
        ORDER BY c.preferred_title,w.preferred_title,w.work_id
    """).fetchall()
    memberships = defaultdict(list)
    for row in rows:
        memberships[row["work_id"]].append(row)
    result = {}
    for work_id, parents in memberships.items():
        result[work_id] = {
            "collections": [{"collection_id": row["collection_id"], "title": row["collection_title"],
                             "parent_collection_id": row["parent_collection_id"]} for row in parents],
        }
    return result


def related_works(conn, work_id: str, metadata: dict) -> list[dict]:
    """把在线关系快照解析到唯一的已入库作品，并要求其海报已发布。"""
    candidates = {}
    for row in metadata.get("related_works") or []:
        if not isinstance(row, dict):
            continue
        provider_id = str(row.get("provider_id") or "").strip()
        poster_url = str(row.get("poster_url") or "").strip()
        if (row.get("provider") != "tmdb" or row.get("media_type") != "movie"
                or row.get("relation_type") != "tmdb_collection"
                or not provider_id.isdigit() or not poster_url):
            continue
        candidates.setdefault(provider_id, row)
    if not candidates:
        return []

    placeholders = ",".join("?" for _ in candidates)
    rows = conn.execute(f"""
        SELECT pb.provider_id,w.work_id,w.preferred_title,w.year,w.card_type,w.show_type,
               wo.override_json
        FROM provider_bindings pb JOIN works w ON w.work_id=pb.work_id
        LEFT JOIN work_overrides wo ON wo.work_id=w.work_id
        WHERE pb.provider='tmdb' AND pb.media_type='movie' AND pb.provider_id IN ({placeholders})
          AND w.work_id<>?
          AND EXISTS (
              SELECT 1 FROM revision_bindings rb
              JOIN import_revisions ir ON ir.revision_id=rb.revision_id AND ir.status='confirmed'
              JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.retired_at=''
              JOIN assets a ON a.asset_id=rb.asset_id AND a.availability_state='available'
              WHERE rb.work_id=w.work_id AND rb.asset_id IS NOT NULL
                AND ir.revision_id=(SELECT latest.revision_id FROM import_revisions latest
                    WHERE latest.root_id=ir.root_id AND latest.status='confirmed'
                    ORDER BY latest.confirmed_at DESC, latest.revision_id DESC LIMIT 1)
          )
          AND NOT EXISTS (
              SELECT 1 FROM work_overrides hidden WHERE hidden.work_id=w.work_id
                AND CASE WHEN json_valid(hidden.override_json)
                    THEN json_extract(hidden.override_json,'$.hidden') ELSE 0 END=1
          )
        ORDER BY pb.provider_id,w.work_id
    """, (*candidates.keys(), work_id)).fetchall()
    matches = defaultdict(list)
    for row in rows:
        matches[str(row["provider_id"])].append(dict(row))
    unique_matches = [items[0] for provider_id, items in matches.items() if len(items) == 1]
    if not unique_matches:
        return []

    from app.media_v4.assets.catalog import get_work_artwork_many

    artwork = get_work_artwork_many(conn, [str(row["work_id"]) for row in unique_matches])
    related = []
    for local in unique_matches:
        provider_id = str(local["provider_id"])
        poster_variants = artwork.get(str(local["work_id"]), {}).get("poster", {}).get("variants", {})
        poster_path = poster_variants.get("384") or poster_variants.get("512") or ""
        if not poster_path:
            continue
        candidate = candidates[provider_id]
        try:
            override = json.loads(local.get("override_json") or "{}")
        except (TypeError, ValueError):
            override = {}
        related.append({
            "work_id": str(local["work_id"]),
            "title": str(override.get("title") or candidate.get("title")
                         or local.get("preferred_title") or ""),
            "year": candidate.get("year") or local.get("year"),
            "card_type": str(local.get("card_type") or ""),
            "show_type": str(local.get("show_type") or ""),
            "relation_type": "tmdb_collection",
            "poster_path": poster_path,
            "local_poster_path": poster_path,
        })
    return related
