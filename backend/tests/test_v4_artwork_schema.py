from __future__ import annotations

import sqlite3
from pathlib import Path

from app.media_v4.persistence.database import V4Database


def test_v26_fixture_upgrades_without_media_or_override_loss(tmp_path):
    path = tmp_path / 'v26.db'
    fixtures = Path(__file__).parent / 'fixtures'
    with sqlite3.connect(path) as conn:
        conn.executescript((fixtures / 'v4_schema_v25_structure.sql').read_text(encoding='utf-8'))
        conn.executescript((fixtures / 'v4_schema_v26_artwork_baseline.sql').read_text(encoding='utf-8'))
        conn.execute("INSERT INTO works(work_id,identity_key,work_type,created_at,updated_at) "
                     "VALUES ('keep','identity','movie','now','now')")
        conn.execute("INSERT INTO work_overrides VALUES ('keep','{\"title\":\"Manual\"}','now','now')")
    database = V4Database(path)
    database.initialize()
    with database.connect() as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 27
        assert conn.execute("SELECT identity_key FROM works WHERE work_id='keep'").fetchone()[0] == 'identity'
        assert 'Manual' in conn.execute('SELECT override_json FROM work_overrides').fetchone()[0]
        for table in ('artwork_resources', 'artwork_variants', 'artwork_bindings', 'library_changes', 'library_details'):
            assert conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0


def test_fresh_v27_contains_artwork_tables_and_query_indices(tmp_path):
    database = V4Database(tmp_path / 'fresh.db')
    database.initialize()
    with database.connect() as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 27
        names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert {'idx_artwork_resources_queue', 'idx_artwork_bindings_work', 'idx_library_changes_work'} <= names
        assert conn.execute('SELECT count(*) FROM library_details').fetchone()[0] == 0
