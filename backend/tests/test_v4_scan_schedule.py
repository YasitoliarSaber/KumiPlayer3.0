"""按稳定来源标识的扫描调度：复用持久扫描、隔离、去重、不假刷新。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.config import AppConfig, invalidate_config_cache, save_config
from app.main import app
from app.media_v4.persistence.database import V4Database


@pytest.fixture
def database(tmp_path, monkeypatch):
    from app.api import media_v4

    instance = V4Database(tmp_path / "schedule.db")
    instance.initialize()
    monkeypatch.setattr(media_v4, "_database", instance)
    return instance


@pytest.fixture
def client(tmp_path, monkeypatch, database):
    monkeypatch.setattr("app.core.config.CONFIG_FILE", tmp_path / "config.json")
    invalidate_config_cache()
    yield TestClient(app)
    invalidate_config_cache()


def seed_source(database, root_id, *, mode="local", scope="ongoing", enabled=1, baseline=True):
    with database.connect() as conn:
        conn.execute(
            "INSERT INTO source_roots(root_id, provider, ingest_method, source_locator, playback_locator, "
            "display_name, source_mode, content_scope, enabled, retired_at, created_at, updated_at) "
            "VALUES (?, 'local', 'fixture', ?, ?, ?, ?, ?, ?, '', 'now', 'now')",
            (root_id, f"/{root_id}", f"/{root_id}", root_id, mode, scope, enabled),
        )
        conn.execute(
            "INSERT INTO source_scans(scan_id, root_id, generation, status) VALUES (?, ?, 1, 'completed')",
            (f"scan-{root_id}", root_id),
        )
        if baseline:
            conn.execute(
                "INSERT INTO import_revisions(revision_id, root_id, scan_id, resolver_version, status, "
                "graph_digest, created_at, confirmed_at) VALUES (?, ?, ?, 'v4', 'confirmed', '', 'now', 'now')",
                (f"rev-{root_id}", root_id, f"scan-{root_id}"),
            )


def test_schedule_list_keeps_models_separate(client, database):
    seed_source(database, "root-a", mode="openlist_full")
    response = client.get("/api/v4/sources/scan-schedules")
    assert response.status_code == 200
    items = {item["root_id"]: item for item in response.json()["sources"]}
    item = items["root-a"]
    assert set(item) >= {"root_id", "schedule", "scan", "revision", "jobs", "status", "reason"}
    assert item["schedule"] == {"enabled": False, "interval_minutes": 0, "last_run_at": "", "next_run_at": ""}
    assert item["scan"]["scan_id"] == "scan-root-a"
    assert item["scan"]["status"] == "completed"
    # 扫描子对象只报告真实计数，不合成百分比
    assert "percent" not in item["scan"]
    assert item["revision"]["latest_revision_id"] == "rev-root-a"
    assert item["jobs"]["queued"] == 0


def test_put_schedule_validates_and_persists(client, database):
    seed_source(database, "root-a")
    ok = client.put("/api/v4/sources/root-a/scan-schedule", json={"enabled": True, "interval_minutes": 720})
    assert ok.status_code == 200, ok.text
    assert ok.json()["schedule"]["enabled"] is True
    assert ok.json()["schedule"]["interval_minutes"] == 720
    saved = client.get("/api/config").json()["source_scan_schedules"]
    assert saved == [{"root_id": "root-a", "enabled": True, "interval_minutes": 720}]
    assert client.put("/api/v4/sources/missing/scan-schedule",
                      json={"enabled": True, "interval_minutes": 60}).status_code == 404
    assert client.put("/api/v4/sources/root-a/scan-schedule",
                      json={"enabled": True, "interval_minutes": 5}).status_code == 422
    # 关闭后保留记录但不调度
    off = client.put("/api/v4/sources/root-a/scan-schedule", json={"enabled": False, "interval_minutes": 720})
    assert off.status_code == 200
    assert off.json()["schedule"]["enabled"] is False


def test_due_schedules_are_isolated_and_deduped(database, monkeypatch):
    from app.media_v4.sources import scan_schedule

    seed_source(database, "root-a")
    seed_source(database, "root-b")
    seed_source(database, "root-c")
    config = type("Config", (), {
        "source_scan_schedules": [
            {"root_id": "root-a", "enabled": True, "interval_minutes": 60},
            {"root_id": "root-b", "enabled": False, "interval_minutes": 60},
            {"root_id": "root-missing", "enabled": True, "interval_minutes": 60},
        ],
    })()
    monkeypatch.setattr(scan_schedule, "load_config", lambda: config)
    calls: list[tuple] = []
    monkeypatch.setattr(
        scan_schedule, "refresh_all_sources",
        lambda database, **kwargs: calls.append(kwargs) or [],
    )
    now = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)
    scan_schedule.run_due_scan_schedules(database, now=now)
    assert len(calls) == 1
    assert calls[0]["root_ids"] == ("root-a",)
    # 同一窗口内重复触发被去重
    scan_schedule.run_due_scan_schedules(database, now=now + timedelta(minutes=30))
    assert len(calls) == 1
    # 超过间隔后再次触发
    scan_schedule.run_due_scan_schedules(database, now=now + timedelta(minutes=61))
    assert len(calls) == 2
    # 关闭的调度从不触发
    assert all(call["root_ids"] == ("root-a",) for call in calls)
    # 运行时间持久化，重启后不重复同一窗口
    assert scan_schedule.last_run_at(database, "root-a") == (now + timedelta(minutes=61)).isoformat()
    scan_schedule.run_due_scan_schedules(database, now=now + timedelta(minutes=90))
    assert len(calls) == 2


def test_tree_snapshot_source_is_never_fake_refreshed(database, monkeypatch):
    from app.media_v4.sources import scan_schedule

    seed_source(database, "root-txt", mode="tree_snapshot")
    config = type("Config", (), {
        "source_scan_schedules": [{"root_id": "root-txt", "enabled": True, "interval_minutes": 60}],
    })()
    monkeypatch.setattr(scan_schedule, "load_config", lambda: config)
    with database.connect() as conn:
        before = conn.execute("SELECT COUNT(*) FROM source_scans WHERE root_id = 'root-txt'").fetchone()[0]
    results = scan_schedule.run_due_scan_schedules(database, now=datetime(2026, 10, 17, 12, 0, tzinfo=UTC))
    assert [item["status"] for item in results] == ["needs_new_txt"]
    assert "TXT" in results[0]["reason"]
    with database.connect() as conn:
        after = conn.execute("SELECT COUNT(*) FROM source_scans WHERE root_id = 'root-txt'").fetchone()[0]
    assert after == before, "纯 TXT 来源不得伪造新扫描"


def test_completed_scope_schedule_does_not_auto_confirm(database, monkeypatch):
    """普通（completed）来源的调度扫描必须产生待确认草稿，而不是自动入库。"""

    from app.media_v4.sources import scan_schedule

    seed_source(database, "root-completed", mode="local", scope="completed")
    config = type("Config", (), {
        "source_scan_schedules": [{"root_id": "root-completed", "enabled": True, "interval_minutes": 60}],
    })()
    monkeypatch.setattr(scan_schedule, "load_config", lambda: config)
    captured: list = []

    def fake_local(request):
        captured.append(request)
        return {"scan_id": "scan-new", "status": "queued"}

    from app.api import media_v4

    monkeypatch.setattr(media_v4, "_start_durable_local_scan", fake_local)
    results = scan_schedule.run_due_scan_schedules(database, now=datetime(2026, 10, 17, 12, 0, tzinfo=UTC))
    assert [item["status"] for item in results] == ["queued"]
    assert len(captured) == 1
    assert captured[0].content_scope == "completed"
    assert captured[0].auto_update is False


def test_schedule_status_survives_read_only_config(client, database):
    save_config(AppConfig(
        source_scan_schedules=[{"root_id": "root-a", "enabled": True, "interval_minutes": 1440}],
    ))
    seed_source(database, "root-a")
    listing = client.get("/api/v4/sources/scan-schedules").json()["sources"]
    assert listing[0]["schedule"]["enabled"] is True
    assert listing[0]["schedule"]["interval_minutes"] == 1440
