"""confirmed 合集成员的只读展示，线上元数据不能改写本地层级。"""

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
    groups = defaultdict(list)
    memberships = defaultdict(list)
    for row in rows:
        groups[row["collection_id"]].append(row)
        memberships[row["work_id"]].append(row)
    result = {}
    for work_id, parents in memberships.items():
        parent_ids = {row["parent_collection_id"] for row in parents if row["parent_collection_id"]}
        related = {}
        for row in parents:
            if row["collection_id"] in parent_ids:
                continue
            for sibling in groups[row["collection_id"]]:
                if sibling["work_id"] == work_id:
                    continue
                related[sibling["work_id"]] = {
                    "work_id": sibling["work_id"], "title": sibling["preferred_title"],
                    "year": sibling["year"], "card_type": sibling["card_type"],
                    "show_type": sibling["show_type"], "relation_type": "collection_member",
                    "poster_path": "", "fanart_path": "",
                }
        result[work_id] = {
            "collections": [{"collection_id": row["collection_id"], "title": row["collection_title"],
                             "parent_collection_id": row["parent_collection_id"]} for row in parents],
            "collection_related_works": list(related.values()),
        }
    return result


def related_works(metadata: dict) -> list[dict]:
    values = {}
    for row in [*(metadata.get("related_works") or []), *(metadata.get("collection_related_works") or [])]:
        if isinstance(row, dict):
            values.setdefault(row.get("work_id") or row.get("title"), row)
    return list(values.values())
