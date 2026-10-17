"""原型新增配置字段：看完阈值、Bangumi 名称辅助、自动备份、按来源调度。"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import AppConfig, invalidate_config_cache, load_config
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("app.core.config.CONFIG_FILE", tmp_path / "config.json")
    invalidate_config_cache()
    yield TestClient(app)
    invalidate_config_cache()


def test_config_defaults_expose_new_fields(client):
    payload = client.get("/api/config").json()
    assert payload["completed_threshold_percent"] == 90
    assert payload["bangumi_alias_enabled"] is True
    assert payload["anilist_enabled"] is True
    assert payload["backup_auto_daily_enabled"] is False
    assert payload["backup_auto_daily_time"] == "03:00"
    assert payload["source_scan_schedules"] == []


def test_completed_threshold_patch_bounds(client):
    assert client.patch("/api/config", json={"completed_threshold_percent": 50}).status_code == 200
    assert client.get("/api/config").json()["completed_threshold_percent"] == 50
    assert client.patch("/api/config", json={"completed_threshold_percent": 100}).status_code == 200
    for invalid in (49, 101, 0, -5):
        assert client.patch("/api/config", json={"completed_threshold_percent": invalid}).status_code == 422
    assert client.get("/api/config").json()["completed_threshold_percent"] == 100


def test_legacy_out_of_range_threshold_is_clamped_on_read(tmp_path, monkeypatch):
    config_file = tmp_path / "config.json"
    config_file.write_text(json.dumps({"setup_completed": True, "completed_threshold_percent": 20}), encoding="utf-8")
    monkeypatch.setattr("app.core.config.CONFIG_FILE", config_file)
    invalidate_config_cache()
    try:
        assert load_config().completed_threshold_percent == 50
    finally:
        invalidate_config_cache()


def test_bangumi_alias_switch_round_trip(client):
    assert client.get("/api/config").json()["bangumi_alias_enabled"] is True
    assert client.patch("/api/config", json={"bangumi_alias_enabled": False}).status_code == 200
    assert client.get("/api/config").json()["bangumi_alias_enabled"] is False


def test_backup_time_validation(client):
    assert client.patch("/api/config", json={"backup_auto_daily_enabled": True}).status_code == 200
    assert client.get("/api/config").json()["backup_auto_daily_enabled"] is True
    assert client.patch("/api/config", json={"backup_auto_daily_time": "23:59"}).status_code == 200
    for invalid in ("24:00", "9:30", "99:99", "noon"):
        assert client.patch("/api/config", json={"backup_auto_daily_time": invalid}).status_code == 422
    assert client.get("/api/config").json()["backup_auto_daily_time"] == "23:59"


def test_source_scan_schedules_validation_and_dedup(client):
    ok = client.patch("/api/config", json={"source_scan_schedules": [
        {"root_id": "root-b", "enabled": True, "interval_minutes": 720},
        {"root_id": "root-a", "enabled": False, "interval_minutes": 15},
        {"root_id": "root-a", "enabled": True, "interval_minutes": 60, "extra": "ignored"},
    ]})
    assert ok.status_code == 200
    records = client.get("/api/config").json()["source_scan_schedules"]
    assert records == [
        {"root_id": "root-a", "enabled": True, "interval_minutes": 60},
        {"root_id": "root-b", "enabled": True, "interval_minutes": 720},
    ]
    for invalid in (
        [{"root_id": "root-a", "enabled": True, "interval_minutes": 5}],
        [{"root_id": "", "enabled": True, "interval_minutes": 60}],
        [{"enabled": True, "interval_minutes": 60}],
        [{"root_id": "root-a", "enabled": True, "interval_minutes": "soon"}],
    ):
        assert client.patch("/api/config", json={"source_scan_schedules": invalid}).status_code == 400
    # 类型本身非法由请求模型拒绝
    assert client.patch("/api/config", json={"source_scan_schedules": "not-a-list"}).status_code == 422


def test_source_scan_schedules_helper_rejects_and_normalizes():
    from app.core.config import normalize_source_scan_schedules, validate_source_scan_schedules

    with pytest.raises(ValueError):
        validate_source_scan_schedules([{"root_id": "root-a", "interval_minutes": 1}])
    # 读取路径容错：非法记录被丢弃，合法记录保留
    assert normalize_source_scan_schedules([
        {"root_id": "root-a", "interval_minutes": 1},
        {"root_id": "root-b", "interval_minutes": 60},
        "garbage",
    ]) == [{"root_id": "root-b", "enabled": True, "interval_minutes": 60}]


def test_app_config_defaults_are_stable():
    config = AppConfig()
    assert config.completed_threshold_percent == 90
    assert config.bangumi_alias_enabled is True
    assert config.backup_auto_daily_enabled is False
    assert config.backup_auto_daily_time == "03:00"
    assert config.source_scan_schedules == []
