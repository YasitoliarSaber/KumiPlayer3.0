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


def test_library_cards_use_one_deduplicated_related_image_lookup(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    from app.api import library_v4
    from app.media_v4.assets import catalog
    from app.media_v4.projection.library import LibrarySnapshot, V4LibraryProjection

    metadata = {"related_works": [
        {"work_id": "related-a", "title": "A", "poster_path": "/a.jpg"},
        {"work_id": "related-b", "title": "B", "poster_path": "/b.jpg"},
        {"work_id": "related-c", "title": "C", "poster_path": "/a.jpg"},
    ]}
    snapshot = LibrarySnapshot("generation-test", "digest-test", ({
        "work_id": "work-test", "title": "Show", "year": 2024, "media_type": "tv",
        "episode_count": 1, "asset_count": 1, "metadata": metadata,
    },), 3)
    monkeypatch.setattr(library_v4, "_library_snapshot", lambda **_kwargs: snapshot)
    monkeypatch.setattr(V4LibraryProjection, "summary", lambda self: {
        "generation_id": "generation-test", "digest": "digest-test", "work_count": 1, "updating": False,
    })
    monkeypatch.setattr(catalog, "get_work_artwork_many", lambda _conn, _ids: {})

    calls = []

    def batch_lookup(_conn, sources, width=384):
        calls.append((sources, width))
        return {source: f"local:{source}" for source in sources}

    monkeypatch.setattr(catalog, "get_metadata_images_many", batch_lookup)
    response = client.get("/api/library")
    assert response.status_code == 200
    body = response.json()
    assert body["updating"] is False
    assert body["generation_id"]
    assert len(calls) == 1
    assert set(calls[0][0]) == {"/a.jpg", "/b.jpg"}
    assert [item["poster_path"] for item in body["works"][0]["related_works"]] == ["local:/a.jpg", "local:/b.jpg", "local:/a.jpg"]
    assert "studios" not in body["works"][0] and "tags" not in body["works"][0]


def test_detail_batches_cast_and_related_image_lookups(tmp_path, monkeypatch):
    _, database = _client(tmp_path, monkeypatch)
    from app.api import library_v4
    from app.media_v4.assets import catalog

    calls = []

    def batch_lookup(_conn, sources, width=384):
        calls.append((sources, width))
        return {source: f"local:{source}" for source in sources}

    monkeypatch.setattr(catalog, "get_work_artwork", lambda _conn, _work_id: {})
    monkeypatch.setattr(catalog, "get_episode_artwork_many", lambda _conn, _episode_ids: {})
    monkeypatch.setattr(catalog, "get_metadata_images_many", batch_lookup)
    payload = {
        "work_id": "work-test",
        "cast": [
            {"profile_path": "/person-a.jpg"},
            {"profile_url": "/person-b.jpg"},
            {"profile_path": "/person-a.jpg"},
        ],
        "related_works": [
            {"poster_path": "/related-a.jpg"},
            {"poster_url": "/related-b.jpg"},
            {"poster_path": "/related-a.jpg"},
        ],
        "episodes": [],
        "seasons": [],
    }
    with database.connect() as conn:
        library_v4._published_artwork_payload(conn, payload)

    assert len(calls) == 1
    assert set(calls[0][0]) == {"/person-a.jpg", "/person-b.jpg", "/related-a.jpg", "/related-b.jpg"}
    assert [person["profile_path"] for person in payload["cast"]] == ["local:/person-a.jpg", "local:/person-b.jpg", "local:/person-a.jpg"]
    assert [related["poster_path"] for related in payload["related_works"]] == ["local:/related-a.jpg", "local:/related-b.jpg", "local:/related-a.jpg"]


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
