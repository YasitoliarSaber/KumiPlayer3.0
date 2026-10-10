"""为纯 SQLite 投影测试登记已准备的图片记录，不绕过发布门槛。"""
from app.media_v4.assets.catalog import RECIPE_VERSION, ROLE_WIDTHS


def ready_artwork(conn, work_id: str):
    required = [('work', work_id, 'poster'), ('work', work_id, 'fanart')]
    required.extend(('episode', row[0], 'episode_thumb') for row in conn.execute(
        "SELECT episode_id FROM episodes WHERE work_id=? AND episode_kind='regular'", (work_id,)))
    for subject_type, subject_id, role in required:
        resource_id = f'fixture:{subject_id}:{role}'
        conn.execute("INSERT OR IGNORE INTO artwork_resources(resource_id,state,content_digest,created_at) "
                     "VALUES (?,'ready',?,'now')", (resource_id, resource_id))
        conn.execute("INSERT OR REPLACE INTO artwork_bindings(subject_type,subject_id,work_id,role,candidate_id,published_id) "
                     "VALUES (?,?,?,?,?,?)", (subject_type, subject_id, work_id, role, resource_id, resource_id))
        for width in ROLE_WIDTHS[role]:
            conn.execute("INSERT OR IGNORE INTO artwork_variants(content_digest,recipe_version,width,relative_path,pixel_width,pixel_height,byte_size,etag) "
                         "VALUES (?,?,?,?,?,1,1,'fixture')", (resource_id, RECIPE_VERSION, width, f'fixture/{width}.webp', width))


def published_card(conn, work_id: str, title: str = 'Fixture'):
    conn.execute("INSERT OR IGNORE INTO library_generations(generation_id,digest,status,created_at) "
                 "VALUES ('fixture-generation','fixture','published','now')")
    conn.execute("INSERT OR REPLACE INTO v4_meta(key,value) VALUES ('current_library_generation','fixture-generation')")
    conn.execute("INSERT OR IGNORE INTO library_cards(generation_id,work_id,title,media_type,episode_count,asset_count) "
                 "VALUES ('fixture-generation',?,?,'tv',1,1)", (work_id, title))
