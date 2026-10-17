"""`.kumibak` 备份/恢复：范围、凭据保留、归档攻击与失败回滚。"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.config import AppConfig, invalidate_config_cache, load_config, save_config
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("app.core.config.CONFIG_FILE", tmp_path / "config.json")
    invalidate_config_cache()
    yield TestClient(app)
    invalidate_config_cache()


def _json_bytes(payload) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _manifest(members: dict[str, bytes], *, format_version: int = 1, schema_version: int | None = None,
              format_name: str = "kumibak") -> dict:
    from app.media_v4.persistence.schema_v4 import V4_SCHEMA_VERSION

    return {
        "format": format_name,
        "format_version": format_version,
        "created_at": "2026-10-17T00:00:00+00:00",
        "app_version": "2.0.0",
        "schema_version": V4_SCHEMA_VERSION if schema_version is None else schema_version,
        "scope": ["config", "sources", "watch_records"],
        "excludes": ["credentials", "media_files", "artwork", "full_database"],
        "members": [
            {"name": name, "size_bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            for name, payload in sorted(members.items())
        ],
    }


def _archive(members: dict[str, bytes], *, manifest: dict | None = None, extra: dict[str, bytes] | None = None,
             format_version: int = 1, schema_version: int | None = None,
             format_name: str = "kumibak") -> bytes:
    if manifest is None:
        manifest = _manifest(members, format_version=format_version, schema_version=schema_version,
                             format_name=format_name)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        for name, payload in members.items():
            archive.writestr(name, payload)
        for name, payload in (extra or {}).items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def _watch_payload(*, progress=(), history=(), watch_status=(), overrides=()) -> dict:
    return {
        "format": "kumibak-watch-records",
        "format_version": 1,
        "exported_at": "2026-10-17T00:00:00+00:00",
        "progress": list(progress),
        "history": list(history),
        "watch_status": list(watch_status),
        "overrides": list(overrides),
    }


def _confirm_one_episode(tmp_path) -> dict:
    """用应用实际使用的隔离数据库建立一条已确认的剧集身份。"""

    from app.api.media_v4 import get_database
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.revisions.service import V4RevisionService

    database = get_database()
    media = tmp_path / "Yuru.Camp.S01E01.mkv"
    media.write_bytes(b"fixture")
    evidence = SourceEvidence(
        evidence_id="ev-backup", scan_id="scan-backup", root_id="root-backup",
        source_key=media.name, relative_path=media.name, entry_kind="video", provider="local",
        source_locator=str(media), playback_locator=str(media),
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-backup", evidence_id=evidence.evidence_id,
        parser_version="fixture", work_title="Yuru Camp", title_candidates=("Yuru Camp",),
        media_type="tv", group_type="season", season_candidate=1, episode_candidate=1,
    )
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-backup", [(evidence, facts)])
    revisions.confirm("rev-backup")
    with database.connect() as conn:
        row = conn.execute(
            "SELECT work_id, episode_id, asset_id FROM revision_bindings "
            "WHERE revision_id = 'rev-backup' AND episode_id IS NOT NULL LIMIT 1"
        ).fetchone()
    return {"database": database, "work_id": row["work_id"], "episode_id": row["episode_id"],
            "asset_id": row["asset_id"]}


def _write_progress(database, identity, position: float, completed: bool) -> None:
    with database.connect() as conn:
        conn.execute(
            "INSERT INTO playback_progress(episode_id, asset_id, work_id, position, duration, completed, updated_at) "
            "VALUES (?,?,?,?,?,?,?) ON CONFLICT(episode_id, asset_id) DO UPDATE SET "
            "position = excluded.position, completed = excluded.completed, updated_at = excluded.updated_at",
            (identity["episode_id"], identity["asset_id"], identity["work_id"], position, 1440.0,
             int(completed), "2026-10-16T00:00:00+00:00"),
        )


def _progress_row(database, identity) -> dict:
    with database.connect() as conn:
        row = conn.execute(
            "SELECT * FROM playback_progress WHERE episode_id = ? AND asset_id = ?",
            (identity["episode_id"], identity["asset_id"]),
        ).fetchone()
    return dict(row) if row else {}


def _export_bytes(client) -> bytes:
    exported = client.post("/api/backup/export").json()
    download = client.get(exported["file"]["download_url"])
    assert download.status_code == 200
    return download.content


def _upload_preview(client, raw: bytes):
    return client.post(
        "/api/backup/restore/preview",
        files={"file": ("backup.kumibak", raw, "application/zip")},
    )


def test_export_writes_bounded_archive_without_credentials(client, tmp_path):
    from app.core.paths import get_data_dir

    save_config(AppConfig(tmdb_bearer_token="fixture-tmdb-token", bangumi_access_token="fixture-bgm-token",
                          pan115_root="K:/115", local_root=str(tmp_path / "media")))
    _confirm_one_episode(tmp_path)
    exported = client.post("/api/backup/export")
    assert exported.status_code == 200
    body = exported.json()
    assert body["file"]["kind"] == "manual"
    assert body["scope"]["includes"] == ["config", "sources", "watch_records"]
    assert body["scope"]["excludes"] == ["credentials", "media_files", "artwork", "full_database"]
    path = get_data_dir() / "backups" / "manual" / body["file"]["file_name"]
    assert path.is_file()
    with zipfile.ZipFile(path) as archive:
        assert sorted(archive.namelist()) == ["config.json", "manifest.json", "watch_records.json"]
        config_payload = json.loads(archive.read("config.json").decode("utf-8"))
        assert config_payload["tmdb_bearer_token"] == ""
        assert config_payload["bangumi_access_token"] == ""
        assert config_payload["pan115_root"] == "K:/115"
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        assert manifest["format"] == "kumibak"
        assert manifest["scope"] == ["config", "sources", "watch_records"]


def test_restore_round_trip_applies_watch_records_and_keeps_credentials(client, tmp_path):
    save_config(AppConfig(tmdb_bearer_token="fixture-tmdb-token", pan115_root="K:/115"))
    identity = _confirm_one_episode(tmp_path)
    _write_progress(identity["database"], identity, 600.0, False)
    raw = _export_bytes(client)

    # 备份之后发生的变化：进度改变、来源根改变。
    _write_progress(identity["database"], identity, 10.0, False)
    save_config(AppConfig(tmdb_bearer_token="fixture-tmdb-token", pan115_root="J:/other"))

    preview = _upload_preview(client, raw)
    assert preview.status_code == 200
    preview_body = preview.json()
    assert preview_body["watch_records"]["progress"] == 1
    assert preview_body["watch_records"]["orphans"] == 0
    assert "pan115_root" in preview_body["config"]["changed_fields"]
    assert preview_body["credentials"]["included"] is False

    confirmed = client.post("/api/backup/restore/confirm", json={
        "preview_id": preview_body["preview_id"], "digest": preview_body["digest"],
    })
    assert confirmed.status_code == 200, confirmed.text
    assert _progress_row(identity["database"], identity)["position"] == 600.0
    invalidate_config_cache()
    current = load_config()
    assert current.pan115_root == "K:/115"
    # 凭据不在包内，恢复不得清除本机现有凭据。
    assert current.tmdb_bearer_token == "fixture-tmdb-token"


def test_preview_rejects_unexpected_and_traversal_members(client):
    payload = _watch_payload()
    members = {"config.json": _json_bytes({}), "watch_records.json": _json_bytes(payload)}
    assert _upload_preview(client, _archive(members, extra={"evil.exe": b"x"})).status_code == 400
    assert _upload_preview(client, _archive(members, extra={"../config.json": b"x"})).status_code == 400
    assert _upload_preview(client, _archive(members, extra={"C:/config.json": b"x"})).status_code == 400
    # 非 ZIP 内容
    assert _upload_preview(client, b"not-a-zip").status_code == 400


def test_preview_rejects_tampered_member_digest(client):
    payload = _watch_payload(progress=[{
        "work_id": "work-1", "episode_id": "ep", "asset_id": "asset",
        "position": 1.0, "duration": 10.0, "completed": False, "updated_at": "",
    }])
    members = {"config.json": _json_bytes({}), "watch_records.json": _json_bytes(payload)}
    manifest = _manifest(members)
    tampered = dict(members)
    tampered["watch_records.json"] = _json_bytes({**payload, "progress": []})
    response = _upload_preview(client, _archive(tampered, manifest=manifest))
    assert response.status_code == 400
    assert "摘要" in response.json()["detail"]


def test_preview_rejects_future_format_and_schema_versions(client):
    payload = _watch_payload()
    members = {"config.json": _json_bytes({}), "watch_records.json": _json_bytes(payload)}
    assert _upload_preview(client, _archive(members, format_version=99)).status_code == 400
    assert _upload_preview(client, _archive(members, schema_version=99_999)).status_code == 400
    assert _upload_preview(client, _archive(members, format_name="something-else")).status_code == 400


def test_preview_rejects_oversized_member(client):
    payload = _watch_payload()
    members = {"config.json": _json_bytes({}), "watch_records.json": _json_bytes(payload)}
    bomb = b"\0" * (33 * 1024 * 1024)
    manifest = _manifest({**members, "watch_records.json": bomb})
    response = _upload_preview(client, _archive(
        {**members, "watch_records.json": bomb}, manifest=manifest,
    ))
    assert response.status_code == 400


def test_preview_rejects_malformed_watch_records(client):
    bad_progress = _watch_payload(progress=[{
        "work_id": "w", "episode_id": "e", "asset_id": "a",
        "position": "abc", "duration": 1.0, "completed": False, "updated_at": "",
    }])
    members = {"config.json": _json_bytes({}), "watch_records.json": _json_bytes(bad_progress)}
    assert _upload_preview(client, _archive(members)).status_code == 400
    bad_format = {"format": "something-else", "progress": []}
    members = {"config.json": _json_bytes({}), "watch_records.json": _json_bytes(bad_format)}
    assert _upload_preview(client, _archive(members)).status_code == 400


def test_orphan_identities_are_reported_not_merged(client, tmp_path):
    identity = _confirm_one_episode(tmp_path)
    payload = _watch_payload(progress=[
        {"work_id": "work-missing", "episode_id": "ep-missing", "asset_id": "asset-missing",
         "position": 5.0, "duration": 10.0, "completed": True, "updated_at": ""},
        {"work_id": identity["work_id"], "episode_id": identity["episode_id"], "asset_id": identity["asset_id"],
         "position": 300.0, "duration": 1440.0, "completed": False, "updated_at": ""},
    ], history=[{
        "event_id": "hist-orphan", "work_id": "work-missing", "episode_id": "", "asset_id": "",
        "played_at": "", "title_snapshot": "", "season_snapshot": "", "episode_snapshot": "",
        "source_provider": "",
    }])
    members = {"config.json": _json_bytes({}), "watch_records.json": _json_bytes(payload)}
    response = _upload_preview(client, _archive(members))
    assert response.status_code == 200
    body = response.json()
    assert body["watch_records"]["matched"] == 1
    assert body["watch_records"]["orphans"] == 2
    kinds = {item["kind"] for item in body["orphans"]}
    assert kinds == {"progress", "history"}

    confirmed = client.post("/api/backup/restore/confirm", json={
        "preview_id": body["preview_id"], "digest": body["digest"],
    })
    assert confirmed.status_code == 200
    # 孤立身份不得被猜测合并成任何新行
    with identity["database"].connect() as conn:
        assert conn.execute(
            "SELECT 1 FROM playback_progress WHERE work_id = 'work-missing'"
        ).fetchone() is None
        assert conn.execute(
            "SELECT 1 FROM playback_history WHERE event_id = 'hist-orphan'"
        ).fetchone() is None


def test_confirm_requires_matching_preview_digest(client, tmp_path):
    _confirm_one_episode(tmp_path)
    raw = _export_bytes(client)
    preview = _upload_preview(client, raw).json()
    bad = client.post("/api/backup/restore/confirm", json={
        "preview_id": preview["preview_id"], "digest": "0" * 64,
    })
    assert bad.status_code == 409
    missing = client.post("/api/backup/restore/confirm", json={
        "preview_id": "prev_deadbeef", "digest": preview["digest"],
    })
    assert missing.status_code == 409


def test_restore_failure_keeps_data_and_config(client, tmp_path, monkeypatch):
    save_config(AppConfig(pan115_root="K:/115"))
    identity = _confirm_one_episode(tmp_path)
    _write_progress(identity["database"], identity, 100.0, False)
    raw = _export_bytes(client)
    _write_progress(identity["database"], identity, 20.0, False)
    save_config(AppConfig(pan115_root="J:/other"))

    preview = _upload_preview(client, raw).json()
    import app.core.backup as backup_module

    def boom(*_args, **_kwargs):
        raise RuntimeError("fixture failure")

    monkeypatch.setattr(backup_module, "_apply_watch_records", boom)
    response = client.post("/api/backup/restore/confirm", json={
        "preview_id": preview["preview_id"], "digest": preview["digest"],
    })
    assert response.status_code == 500
    # 观看记录未被改动
    assert _progress_row(identity["database"], identity)["position"] == 20.0
    # 配置回滚到失败前状态
    invalidate_config_cache()
    assert load_config().pan115_root == "J:/other"


def test_backup_listing_and_download_bounds(client, tmp_path):
    _confirm_one_episode(tmp_path)
    exported = client.post("/api/backup/export").json()
    listing = client.get("/api/backup/files").json()
    assert [item["file_id"] for item in listing["files"]] == [exported["file"]["file_id"]]
    assert listing["auto"]["keep"] == 7
    assert listing["auto"]["enabled"] is False
    assert client.get("/api/backup/files/bkp_" + "0" * 24 + "/download").status_code == 404
    assert client.get("/api/backup/files/not-a-file-id/download").status_code == 404


def test_auto_backup_rotation_keeps_seven_and_preserves_manual(client, tmp_path):
    from app.core import backup as backup_module

    database = _confirm_one_episode(tmp_path)["database"]
    manual = backup_module.create_backup(database, kind="manual")
    stamp = datetime(2026, 10, 1, tzinfo=UTC)
    for index in range(10):
        backup_module.create_backup(database, kind="auto", created_at=stamp + timedelta(days=index))
    listing = backup_module.list_backups()
    auto_files = [item for item in listing if item["kind"] == "auto"]
    manual_files = [item for item in listing if item["kind"] == "manual"]
    assert len(auto_files) == 7
    assert len(manual_files) == 1
    assert manual_files[0]["file_id"] == manual["file_id"]
    # 最新 7 份保留：最旧的 3 份被轮换掉
    assert min(item["created_at"] for item in auto_files) >= (stamp + timedelta(days=3)).isoformat()


def test_auto_backup_scheduler_runs_once_per_day(client, tmp_path):
    from app.core import backup as backup_module

    _confirm_one_episode(tmp_path)
    save_config(AppConfig(backup_auto_daily_enabled=True, backup_auto_daily_time="03:00"))
    local_evening = datetime(2026, 10, 17, 20, 0).astimezone()
    first = backup_module.run_due_auto_backup(now=local_evening)
    assert first is not None and first["last_status"] == "ok"
    assert backup_module.run_due_auto_backup(now=local_evening + timedelta(minutes=5)) is None
    status = backup_module.auto_backup_status(now=local_evening)
    assert status["enabled"] is True and status["last_status"] == "ok"
    assert backup_module.run_due_auto_backup(now=local_evening + timedelta(days=1)) is not None


def test_auto_backup_disabled_by_default(client, tmp_path):
    from app.core import backup as backup_module

    _confirm_one_episode(tmp_path)
    assert backup_module.run_due_auto_backup(now=datetime(2026, 10, 17, 23, 0).astimezone()) is None
    assert backup_module.auto_backup_status()["enabled"] is False
