"""V4 媒体库读模型 API 合同。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch):
    from app.api import library_v4, media_v4
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / "library-api.db")
    database.initialize()
    monkeypatch.setattr(media_v4, "_database", database)
    application = FastAPI()
    application.include_router(media_v4.router)
    application.include_router(library_v4.router)
    return TestClient(application), database


def test_watch_list_exposes_only_local_shaped_status(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    assert client.post("/api/v4/imports/preview", json=_entry()).status_code == 200
    assert client.post("/api/v4/imports/rev-library/confirm").status_code == 200
    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works LIMIT 1").fetchone()[0]
    from app.media_v4.tracking.store import V4TrackingStore
    store = V4TrackingStore(database)
    store.save_state(work_id, "local", provider_id="", last_watched_episode=None, metadata={"favorite": True, "status": "watching", "note": "local"})
    store.save_state(work_id, "bangumi", provider_id="test", last_watched_episode=None, metadata={"favorite": False, "status": "watched"})
    items = client.get("/api/library/watch-status").json()["items"]
    assert items == [client.get(f"/api/library/watch-status/{work_id}").json()]
    assert items[0]["favorite"] is True
    assert "metadata_json" not in items[0]


def _entry(revision_id: str = "rev-library") -> dict:
    fixture_root = Path.cwd() / "backend" / "tests" / "media-fixtures"
    return {
        "revision_id": revision_id,
        "root_id": "root-library",
        "scan_id": f"scan-{revision_id}",
        "entries": [
            {
                "provider": "local",
                "ingest_method": "local_scan",
                "relative_path": "Show/Show.S01E01.mkv",
                "source_locator": "local://show/Show.S01E01.mkv",
                "playback_locator": str(fixture_root / "Show.S01E01.mkv"),
            },
            {
                "provider": "local",
                "ingest_method": "local_scan",
                "relative_path": "Show/Show.S01E01.2160p.mkv",
                "source_locator": "local://show/Show.S01E01.2160p.mkv",
                "playback_locator": str(fixture_root / "Show.S01E01.2160p.mkv"),
            },
        ],
    }


def _publish(database):
    from backend.tests.test_v4_library_projection import _ready_library

    from app.media_v4.projection.library import V4LibraryProjection

    _ready_library(database)
    V4LibraryProjection(database).rebuild()


def _work_id_for_root(conn, root_id: str) -> str:
    """按来源根精确取目标 Work。

    跨来源不复用结构身份，同一作品在不同 root 下会各自成行；用
    ``SELECT work_id FROM works LIMIT 1``（无 ORDER BY）取行会让断言随行序变化，
    因此这里按 root 的已确认 revision 取。
    """

    row = conn.execute(
        "SELECT DISTINCT rb.work_id FROM revision_bindings rb "
        "JOIN import_revisions ir ON ir.revision_id = rb.revision_id "
        "WHERE ir.root_id = ? AND ir.status = 'confirmed'",
        (root_id,),
    ).fetchone()
    assert row is not None, f"{root_id} 没有已确认的 Work"
    return str(row["work_id"])


def test_detail_deduplicates_episode_rows_but_exposes_all_assets(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    assert client.post("/api/v4/imports/preview", json=_entry()).status_code == 200
    assert client.post("/api/v4/imports/rev-library/confirm").status_code == 200
    _publish(database)
    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works LIMIT 1").fetchone()["work_id"]

    response = client.get(f"/api/library/works/{work_id}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["media_type"] == "tv"
    assert body["show_type"] == "anime_series"
    assert len(body["episodes"]) == 1
    assert len(body["episodes"][0]["assets"]) == 2
    assert body["seasons"][0]["episode_count"] == 1


def test_detail_projects_saved_scrape_metadata_without_rewriting_local_identity(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    assert client.post("/api/v4/imports/preview", json=_entry("rev-detail-metadata")).status_code == 200
    assert client.post("/api/v4/imports/rev-detail-metadata/confirm").status_code == 200
    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works LIMIT 1").fetchone()["work_id"]
        episode_id = conn.execute("SELECT episode_id FROM episodes LIMIT 1").fetchone()["episode_id"]
        metadata = {
            "provider": "tmdb",
            "provider_id": "42",
            "title": "在线标题",
            "plot": "完整简介",
            "genres": ["动画", "冒险"],
            "studios": ["Kumi Studio"],
            "cast": [{"name": "角色甲", "role": "声优", "profile_path": "/person.jpg"}],
            "certification": "PG-13",
            "certification_country": "US",
            "clearlogo_url": "/logo.png",
            "local_clearlogo_path": "D:/mirror/Show/clearlogo.png",
            "tags": ["热血"],
            "episode_mappings": [{
                "episode_id": episode_id,
                "title": "刮削后的单集标题",
                "plot": "单集简介",
                "still_url": "/still.jpg",
                "local_thumb_path": "D:/mirror/Show/Season 01/S01E01-thumb.jpg",
                "runtime": 24,
            }],
        }
        conn.execute(
            """
            INSERT INTO scrape_bindings(
                binding_id, revision_id, work_id, provider, provider_id,
                metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "binding-detail-metadata",
                "rev-detail-metadata",
                work_id,
                "tmdb",
                "42",
                json.dumps(metadata, ensure_ascii=False),
                "2026-08-24T00:00:00+00:00",
                "2026-08-24T00:00:00+00:00",
            ),
        )
        conn.commit()

    _publish(database)
    body = client.get(f"/api/library/works/{work_id}").json()
    assert body["title"] == "在线标题"
    assert body["plot"] == "完整简介"
    assert body["cast"][0]["name"] == "角色甲"
    assert body["certification"] == "PG-13"
    assert body["certification_country"] == "US"
    assert body["clearlogo_path"] == ""
    assert body["local_clearlogo_path"] == ""
    assert body["tags"] == ["热血"]
    assert body["episodes"][0]["episode_id"] == episode_id
    assert body["episodes"][0]["episode_number"] == 1
    assert body["episodes"][0]["title"] == "刮削后的单集标题"
    assert body["episodes"][0]["plot"] == ""
    assert body["episodes"][0]["thumb_path"].startswith('/api/assets/artwork/')
    with database.connect() as conn:
        saved = json.loads(conn.execute(
            "SELECT metadata_json FROM scrape_bindings WHERE binding_id='binding-detail-metadata'"
        ).fetchone()[0])
    assert saved == metadata


def test_watch_status_patch_preserves_omitted_fields_and_rescan_is_v4_projection(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    assert client.post("/api/v4/imports/preview", json=_entry("rev-watch")).status_code == 200
    assert client.post("/api/v4/imports/rev-watch/confirm").status_code == 200
    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works LIMIT 1").fetchone()["work_id"]

    first = client.patch(
        f"/api/library/watch-status/{work_id}",
        json={"status": "watching", "note": "keep", "favorite": True},
    )
    assert first.status_code == 200
    second = client.patch(f"/api/library/watch-status/{work_id}", json={"note": "updated"})
    assert second.status_code == 200
    assert second.json()["status"] == "watching"
    assert second.json()["favorite"] is True
    assert second.json()["note"] == "updated"

    rescan = client.post("/api/library/rescan")
    assert rescan.status_code == 200
    assert rescan.json()["status"] == "accepted"
    with database.connect() as conn:
        assert conn.execute(
            "SELECT 1 FROM jobs WHERE job_id=? AND job_type='refresh_projection' AND status='queued'",
            (rescan.json()["task_id"],),
        ).fetchone()
        assert conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_full_dirty'").fetchone()


def test_library_get_reports_unpublished_generation_without_rebuilding(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    from app.media_v4.projection.library import V4LibraryProjection
    rebuild = V4LibraryProjection.rebuild

    def forbidden(*_args, **_kwargs):
        raise AssertionError("GET must only read the published projection")

    monkeypatch.setattr(V4LibraryProjection, "rebuild", forbidden)
    response = client.get("/api/library")
    assert response.status_code == 200
    body = response.json()
    assert body["works"] == []
    assert body["generation_id"] == ""
    assert body["updating"] is True
    assert body["summary"] == {"work_count": 0, "episode_count": 0}
    with database.connect() as conn:
        assert conn.execute("SELECT 1 FROM v4_meta WHERE key='current_library_generation'").fetchone() is None

    monkeypatch.setattr(V4LibraryProjection, "rebuild", rebuild)
    _publish(database)
    from app.media_v4.projection.library import mark_projection_dirty

    with database.connect() as conn:
        mark_projection_dirty(conn)
    published_response = client.get("/api/library")
    assert published_response.status_code == 200
    published_body = published_response.json()
    assert published_body["generation_id"]
    assert published_body["works"] == []
    assert published_body["updating"] is True
    changes = client.get("/api/library/changes?after=0")
    assert changes.status_code == 200
    assert changes.json()["generation_id"] == published_body["generation_id"]
    assert changes.json()["updating"] is True


def test_library_rescan_marks_dirty_and_queues_existing_projection_job(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    assert client.post("/api/v4/imports/preview", json=_entry("rev-rescan-queued")).status_code == 200
    assert client.post("/api/v4/imports/rev-rescan-queued/confirm").status_code == 200
    from app.media_v4.projection.library import V4LibraryProjection

    def forbidden(*_args, **_kwargs):
        raise AssertionError("rescan request must not rebuild synchronously")

    monkeypatch.setattr(V4LibraryProjection, "rebuild", forbidden)
    response = client.post("/api/library/rescan")
    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    with database.connect() as conn:
        job = conn.execute("SELECT job_type,status FROM jobs WHERE job_id=?", (response.json()["task_id"],)).fetchone()
        assert tuple(job) == ("refresh_projection", "queued")
        assert conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_full_dirty'").fetchone()


def test_empty_library_rescan_persists_dirty_request_without_revision(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    from app.media_v4.projection.library import V4LibraryProjection

    rebuild = V4LibraryProjection.rebuild
    monkeypatch.setattr(V4LibraryProjection, "rebuild", lambda *_args, **_kwargs: pytest.fail("must be asynchronous"))
    response = client.post("/api/library/rescan")
    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert response.json()["task_id"].startswith("projection:")
    with database.connect() as conn:
        assert conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_full_dirty'").fetchone()
        assert conn.execute("SELECT 1 FROM jobs WHERE job_type='refresh_projection'").fetchone() is None
    monkeypatch.setattr(V4LibraryProjection, "rebuild", rebuild)


def test_related_works_requires_confirmed_tmdb_movie_identity_and_prepared_poster(tmp_path):
    from dataclasses import replace

    from backend.tests.artwork_fixtures import ready_artwork
    from backend.tests.test_v4_library_projection import _entry

    from app.media_v4.persistence.database import V4Database
    from app.media_v4.projection.collections import related_works
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "related-works.db")
    database.initialize()
    pairs = []
    for index, title in enumerate(("电影甲", "电影乙", "电影丙")):
        evidence, facts = _entry(f"movie-{index}")
        facts = replace(facts, work_title=title, title_candidates=(title,), media_type="movie",
                        group_type="movie", card_type="standalone", show_type="anime_movie",
                        season_candidate=None, episode_candidate=None, series_group="")
        pairs.append((evidence, facts))
    revisions = V4RevisionService(database)
    revisions.create_draft("related-movies", pairs)
    revisions.confirm("related-movies")
    with database.connect() as conn:
        work_ids = {row["preferred_title"]: row["work_id"]
                    for row in conn.execute("SELECT work_id,preferred_title FROM works")}
        for provider_id, title in (("501", "电影甲"), ("502", "电影乙"), ("503", "电影丙")):
            conn.execute("INSERT INTO provider_bindings(work_id,provider,provider_id,media_type) VALUES (?, 'tmdb', ?, 'movie')",
                         (work_ids[title], provider_id))
        for work_id in (work_ids["电影甲"], work_ids["电影乙"]):
            ready_artwork(conn, work_id)

        result = related_works(conn, work_ids["电影甲"], {"related_works": [
            {"provider": "tmdb", "provider_id": "502", "media_type": "movie",
             "relation_type": "tmdb_collection", "poster_url": "https://image.tmdb.org/b.jpg",
             "title": "在线中文标题"},
            {"provider": "tmdb", "provider_id": "999", "media_type": "movie",
             "relation_type": "tmdb_collection", "poster_url": "https://image.tmdb.org/missing.jpg",
             "title": "未入库在线条目"},
            {"provider": "tmdb", "provider_id": "503", "media_type": "movie",
             "relation_type": "tmdb_collection", "poster_url": "https://image.tmdb.org/unprepared.jpg",
             "title": "海报尚未准备"},
            {"provider": "tmdb", "provider_id": "888", "media_type": "movie",
             "relation_type": "same_genre", "poster_url": "https://image.tmdb.org/genre.jpg",
             "title": "同类型"},
        ]})

    assert len(result) == 1
    assert result[0]["work_id"] == work_ids["电影乙"]
    assert result[0]["title"] == "在线中文标题"
    assert result[0]["relation_type"] == "tmdb_collection"
    assert result[0]["poster_path"].startswith("/api/assets/artwork/")
    assert result[0]["poster_path"].endswith("/384")


def test_detail_preserves_already_published_relation_poster_urls(tmp_path, monkeypatch):
    _, database = _client(tmp_path, monkeypatch)
    from app.api import library_v4
    from app.media_v4.assets import catalog

    monkeypatch.setattr(catalog, "get_work_artwork", lambda _conn, _work_id: {})
    monkeypatch.setattr(catalog, "get_episode_artwork_many", lambda _conn, _episode_ids: {})
    monkeypatch.setattr(catalog, "get_metadata_images_many", lambda _conn, sources: {
        source: f"local:{source}" for source in sources
    })
    payload = {
        "work_id": "work-test",
        "cast": [
            {"profile_path": "/person-a.jpg"},
            {"profile_url": "/person-b.jpg"},
            {"profile_path": "/person-a.jpg"},
        ],
        "related_works": [
            {"poster_path": "/api/assets/artwork/related-a/digest-webp-v1/384"},
            {"poster_path": "/api/assets/artwork/related-b/digest-webp-v1/384"},
            {"poster_path": "/api/assets/artwork/related-a/digest-webp-v1/384"},
        ],
        "episodes": [],
        "seasons": [],
    }
    with database.connect() as conn:
        library_v4._published_artwork_payload(conn, payload)

    assert [person["profile_path"] for person in payload["cast"]] == ["local:/person-a.jpg", "local:/person-b.jpg", "local:/person-a.jpg"]
    assert [related["poster_path"] for related in payload["related_works"]] == [
        "/api/assets/artwork/related-a/digest-webp-v1/384",
        "/api/assets/artwork/related-b/digest-webp-v1/384",
        "/api/assets/artwork/related-a/digest-webp-v1/384",
    ]


def test_detail_only_exposes_latest_confirmed_revision_for_same_root(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    first = _entry("rev-old")
    assert client.post("/api/v4/imports/preview", json=first).status_code == 200
    assert client.post("/api/v4/imports/rev-old/confirm").status_code == 200

    second = _entry("rev-new")
    second["entries"] = [{
        "provider": "local",
        "ingest_method": "local_scan",
        "relative_path": "Show/Show.S01E02.mkv",
        "source_locator": "local://show/Show.S01E02.mkv",
        "playback_locator": str(Path.cwd() / "backend" / "tests" / "media-fixtures" / "Show.S01E02.mkv"),
    }]
    assert client.post("/api/v4/imports/preview", json=second).status_code == 200
    assert client.post("/api/v4/imports/rev-new/confirm").status_code == 200
    _publish(database)

    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works LIMIT 1").fetchone()["work_id"]
    detail = client.get(f"/api/library/works/{work_id}")
    assert detail.status_code == 200
    assert [episode["episode_number"] for episode in detail.json()["episodes"]] == [2]
    assert detail.json()["asset_count"] == 1


def test_detail_excludes_assets_from_retired_source_roots(tmp_path, monkeypatch):
    """退役来源的资产与作品都必须从读取路径消失。

    目标 Work 按**活动来源**精确选取：跨来源不做结构身份复用（work_source_bindings
    按 root 过滤），同一作品在两个 root 下会各自成行，因此不能再用
    ``SELECT work_id FROM works LIMIT 1`` 随机取行（那会以约 1/5～1/3 的概率
    取到退役根的行而得到 404，与本次断言无关地变成 flaky）。
    """

    client, database = _client(tmp_path, monkeypatch)
    retired = _entry("rev-retired-root")
    retired["root_id"] = "root-retired"
    retired["entries"] = [retired["entries"][0]]
    assert client.post("/api/v4/imports/preview", json=retired).status_code == 200
    assert client.post("/api/v4/imports/rev-retired-root/confirm").status_code == 200

    active = _entry("rev-active-root")
    active["root_id"] = "root-active"
    active["entries"] = [active["entries"][1]]
    assert client.post("/api/v4/imports/preview", json=active).status_code == 200
    assert client.post("/api/v4/imports/rev-active-root/confirm").status_code == 200
    _publish(database)

    with database.connect() as conn:
        active_work_id = _work_id_for_root(conn, "root-active")
        retired_work_id = _work_id_for_root(conn, "root-retired")
        active_asset_id = conn.execute(
            "SELECT asset_id FROM assets WHERE root_id = 'root-active'"
        ).fetchone()["asset_id"]
        conn.execute(
            "UPDATE source_roots SET retired_at = '2026-09-05T00:00:00+00:00' "
            "WHERE root_id = 'root-retired'"
        )
        conn.commit()
    _publish(database)

    detail = client.get(f"/api/library/works/{active_work_id}")
    assert detail.status_code == 200
    episode = detail.json()["episodes"][0]
    assert episode["asset_id"] == active_asset_id
    assert [asset["asset_id"] for asset in episode["assets"]] == [active_asset_id]
    # 唯一来源已退役的作品必须从媒体库读取路径消失。这里直接改 retired_at、
    # 绕过删除任务，所以这条不可见规则只能由读接口保证。
    assert client.get(f"/api/library/works/{retired_work_id}").status_code == 404


def test_library_sources_come_from_each_evidence_not_the_first_root_entry(tmp_path, monkeypatch):
    client, _database = _client(tmp_path, monkeypatch)
    payload = _entry("rev-mixed-provider")
    payload["entries"][1]["provider"] = "pan115"

    assert client.post("/api/v4/imports/preview", json=payload).status_code == 200
    assert client.post("/api/v4/imports/rev-mixed-provider/confirm").status_code == 200
    _publish(_database)  # 测试应用未启动 lifespan，显式模拟后台发布。
    # 图片和资料准备完毕后，来源信息仍来自每条 evidence。
    response = client.get("/api/library")
    assert response.status_code == 200
    assert len(response.json()["works"]) == 1
    assert response.json()["works"][0]["metadata_state"] == "ready"
    assert response.json()["works"][0]["sources"] == ["local", "pan115"]


def test_empty_scan_can_confirm_source_removal_and_publish_empty_library(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    assert client.post("/api/v4/imports/preview", json=_entry("rev-populated")).status_code == 200
    assert client.post("/api/v4/imports/rev-populated/confirm").status_code == 200

    empty = {
        "revision_id": "rev-empty",
        "root_id": "root-library",
        "scan_id": "scan-empty",
        "entries": [],
    }
    assert client.post("/api/v4/imports/preview", json=empty).status_code == 409
    empty["allow_empty"] = True
    preview = client.post("/api/v4/imports/preview", json=empty)
    assert preview.status_code == 200
    assert preview.json()["works"] == []
    assert client.post("/api/v4/imports/rev-empty/confirm").status_code == 200
    _publish(database)

    with database.connect() as conn:
        projection_job = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE revision_id = 'rev-empty' AND job_type = 'refresh_projection'"
        ).fetchone()[0]
        work_jobs = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE revision_id = 'rev-empty' AND work_id != ''"
        ).fetchone()[0]
    assert projection_job == 1
    assert work_jobs == 0
    assert client.post("/api/library/rescan").status_code == 200
    assert client.get("/api/library").json()["works"] == []
