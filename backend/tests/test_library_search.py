"""全局搜索轻量索引：有界、字段范围明确、不读作品详情。"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import invalidate_config_cache
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.api import media_v4
    from app.media_v4.persistence.database import V4Database

    monkeypatch.setattr("app.core.config.CONFIG_FILE", tmp_path / "config.json")
    invalidate_config_cache()
    database = V4Database(tmp_path / "search.db")
    database.initialize()
    monkeypatch.setattr(media_v4, "_database", database)
    yield TestClient(app), database
    invalidate_config_cache()


def publish(database, work_id: str, *, title: str, metadata: dict | None = None,
            original_title: str = "", year: int = 2018, hidden: bool = False) -> None:
    with database.connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO library_generations(generation_id, digest, status, created_at) "
            "VALUES ('gen-1', 'digest', 'published', 'now')"
        )
        conn.execute(
            "INSERT OR REPLACE INTO v4_meta(key, value) VALUES ('current_library_generation', 'gen-1')"
        )
        conn.execute(
            "INSERT OR REPLACE INTO library_cards(generation_id, work_id, title, year, media_type, "
            "episode_count, asset_count, metadata_json) VALUES ('gen-1', ?, ?, ?, 'tv', 1, 1, ?)",
            (work_id, title, year, json.dumps(metadata or {}, ensure_ascii=False)),
        )
        if original_title:
            conn.execute(
                "INSERT OR REPLACE INTO works(work_id, identity_key, work_type, preferred_title, "
                "original_title, year, status, created_at, updated_at) "
                "VALUES (?, ?, 'series', ?, ?, ?, 'active', 'now', 'now')",
                (work_id, f"identity-{work_id}", title, original_title, year),
            )
        if hidden:
            conn.execute(
                "INSERT OR REPLACE INTO work_overrides(work_id, override_json, created_at, updated_at) "
                "VALUES (?, '{\"hidden\": true}', 'now', 'now')",
                (work_id,),
            )


def test_search_matches_title_original_aliases_tags_and_studios(client):
    client, database = client
    publish(database, "work-1", title="摇曳露营", original_title="ゆるキャン△",
            metadata={"original_title": "ゆるキャン△", "tags": ["日常", "露营"], "studios": ["C-Station"]})
    with database.connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO work_aliases(work_id, normalized_title, language, alias_type) "
            "VALUES ('work-1', 'Yuru Camp', '', 'alternate')"
        )

    by_title = client.get("/api/library/search", params={"q": "摇曳"}).json()
    assert [item["work_id"] for item in by_title["items"]] == ["work-1"]
    assert "title" in by_title["items"][0]["matched_fields"]

    by_original = client.get("/api/library/search", params={"q": "ゆる"}).json()
    assert "original_title" in by_original["items"][0]["matched_fields"]

    by_alias = client.get("/api/library/search", params={"q": "Yuru Camp"}).json()
    assert "aliases" in by_alias["items"][0]["matched_fields"]
    assert by_alias["items"][0]["aliases"] == ["Yuru Camp"]

    by_tag = client.get("/api/library/search", params={"q": "日常"}).json()
    assert "tags" in by_tag["items"][0]["matched_fields"]
    assert by_tag["items"][0]["tags"] == ["日常", "露营"]

    by_studio = client.get("/api/library/search", params={"q": "C-Station"}).json()
    assert "studios" in by_studio["items"][0]["matched_fields"]

    assert client.get("/api/library/search", params={"q": "不存在"}).json()["items"] == []


def test_search_excludes_hidden_works_and_rejects_empty_query(client):
    client, database = client
    publish(database, "work-visible", title="露营物语")
    publish(database, "work-hidden", title="露营隐藏", hidden=True)
    hits = client.get("/api/library/search", params={"q": "露营"}).json()["items"]
    assert [item["work_id"] for item in hits] == ["work-visible"]
    assert client.get("/api/library/search", params={"q": "   "}).status_code == 400
    assert client.get("/api/library/search", params={"q": "x" * 65}).status_code == 400


def test_search_escapes_like_wildcards(client):
    client, database = client
    publish(database, "work-1", title="100% 露营")
    all_rows = client.get("/api/library/search", params={"q": "%"}).json()
    assert [item["work_id"] for item in all_rows["items"]] == ["work-1"]
    assert client.get("/api/library/search", params={"q": "_"}).json()["items"] == []


def test_search_is_bounded_and_reports_truncation(client):
    client, database = client
    for index in range(5):
        publish(database, f"work-{index}", title=f"露营 {index}")
    limited = client.get("/api/library/search", params={"q": "露营", "limit": 2}).json()
    assert limited["limit"] == 2
    assert limited["truncated"] is True
    assert len(limited["items"]) == 2
    clamped = client.get("/api/library/search", params={"q": "露营", "limit": 10_000}).json()
    assert clamped["limit"] == 100
    assert clamped["truncated"] is False
    assert len(clamped["items"]) == 5
