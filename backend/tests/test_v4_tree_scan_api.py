"""durable TXT 导入兼容虚拟卷，输入错误不能伪装成后端失联。"""

from __future__ import annotations

import builtins
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import media_v4
from app.main import app
from app.media_v4.sources import input_archive, source_scan_runner
from app.media_v4.sources.input_archive import InputArchiveError, archive_is_intact
from tests.source_disk_guard import guard_source_disk_io


@pytest.fixture
def tree_api(tmp_path, monkeypatch):
    tree = tmp_path / "01动画_文件目录.txt"
    tree.write_text("Show/Season 1/Show.S01E01.mkv\nShow/SP01.mkv\n", encoding="utf-16")
    config = SimpleNamespace(
        pan115_root="", baidu_root=r"Q:\offline-library", openlist_mount_root=r"Q:\offline-library",
        openlist_remote_root="/", openlist_routes=[], openlist_server_url="https://offline.invalid",
    )
    monkeypatch.setattr(media_v4, "load_config", lambda: config)
    monkeypatch.setattr(media_v4, "_select_openlist_config", lambda _: config)
    monkeypatch.setattr(media_v4, "_openlist_credentials", lambda _: ("fixture-account", "", "available"))
    monkeypatch.setattr(media_v4, "_connection_request_guard", lambda _, **_kwargs: {})
    from app.api import openlist_v4

    monkeypatch.setattr(openlist_v4, "_configured_routes", lambda _: [])
    monkeypatch.setattr(media_v4, "provider_for_remote", lambda *_: ("route-fixture", "baidu"))
    database = media_v4.get_database()
    runner = source_scan_runner.SourceScanRunner(database)
    # API 登记和执行分开，测试同步运行同一生产 handler，不留后台线程。
    monkeypatch.setattr(runner, "wake", lambda: None)
    monkeypatch.setattr(source_scan_runner, "get_source_scan_runner", lambda _: runner)
    guard_source_disk_io(monkeypatch, [config.baidu_root])
    monkeypatch.setenv("KUMIPLAYER_API_TOKEN", "offline-fixture-token")
    client = TestClient(app, raise_server_exceptions=False, headers={
        "Origin": "http://tauri.localhost", "X-KumiPlayer-Token": "offline-fixture-token",
    })
    return tree, database, runner, client


def _request(tree, source):
    # 这些归档/恢复用例使用已明确的对应关系，自动歧义另由专门用例覆盖。
    return {"source": source, "tree_file": str(tree), "provider": "baidu", "root_path": "/", "tree_mapping_mode": "direct"}


@pytest.mark.parametrize("source", ["openlist", "hybrid"])
@pytest.mark.parametrize("endpoint", ["/api/v4/sources/scans", "/api/v4/sources/scan"])
def test_invalid_openlist_mapping_is_conflict_before_scan_registration(tree_api, source, endpoint):
    tree, database, _runner, client = tree_api
    media_v4.load_config().openlist_mount_root = "relative/mount"
    response = client.post(endpoint, json=_request(tree, source))
    assert response.status_code == 409, response.text
    _assert_no_scan(database)


def test_mapping_fingerprint_tracks_server_and_account_namespace(tree_api):
    config = media_v4.load_config()
    roots = [config.baidu_root]
    first = media_v4._tree_mapping_fingerprint(config, roots, "baidu")
    config.openlist_server_url = "https://another.invalid"
    second = media_v4._tree_mapping_fingerprint(config, roots, "baidu")
    assert first != second
    config.openlist_username = "another-account"
    assert second != media_v4._tree_mapping_fingerprint(config, roots, "baidu")


def test_sync_mapping_saves_complete_root_configuration_for_confirm(tree_api, monkeypatch):
    tree, database, _runner, client = tree_api
    roots = [media_v4.load_config().baidu_root, "R:/another-mount"]
    monkeypatch.setattr(media_v4, "_tree_roots_for_request", lambda *_: roots)
    request = {**_request(tree, "tree"), "tree_mapping_mode": "auto", "tree_verify_paths": False}
    pending = client.post("/api/v4/sources/scan", json=request).json()
    selected = client.post("/api/v4/sources/scan", json={**request, "tree_mapping_choice": pending["path_validation"]["choices"][0]["id"]})
    assert selected.status_code == 200, selected.text
    body = selected.json()
    with database.connect() as conn:
        row = conn.execute("SELECT request_json FROM source_scan_requests WHERE scan_id=?", (body["scan_id"],)).fetchone()
    assert json.loads(row["request_json"])["configured_roots"] == roots
    media_v4._require_tree_validation(database, body["scan_id"], body["root_id"], require=True)


@pytest.mark.parametrize("endpoint", ["/api/v4/sources/scans", "/api/v4/sources/scan"])
def test_automatic_mapping_requires_confirmation_before_creating_media(tree_api, endpoint):
    tree, database, runner, client = tree_api
    request = {**_request(tree, "tree"), "tree_mapping_mode": "auto", "tree_verify_paths": False}
    pending = client.post(endpoint, json=request)
    assert pending.status_code == 200, pending.text
    assert pending.json()["status"] == "mapping_required"
    choices = pending.json()["path_validation"]["choices"]
    assert choices and pending.json()["evidence_count"] == 2
    _assert_no_scan(database)
    selected = client.post(endpoint, json={**request, "tree_mapping_choice": choices[0]["id"]})
    assert selected.status_code == 200, selected.text
    assert selected.json()["scan_id"]
    if endpoint.endswith("/scans"):
        task = runner.claim_next_scan()
        runner.run_scan(task)
    with database.connect() as conn:
        row = conn.execute("SELECT request_json FROM source_scan_requests WHERE scan_id=?", (selected.json()["scan_id"],)).fetchone()
        evidence = conn.execute("SELECT playback_locator FROM source_evidence WHERE scan_id=?", (selected.json()["scan_id"],)).fetchall()
    assert json.loads(row["request_json"])["tree_mapping_rule"]["version"] == 1
    assert len(evidence) == 2


def test_stale_candidate_after_txt_change_cannot_silently_start_scan(tree_api):
    tree, database, _runner, client = tree_api
    request = {**_request(tree, "tree"), "tree_mapping_mode": "auto", "tree_verify_paths": False}
    choice = client.post("/api/v4/sources/scans", json=request).json()["path_validation"]["choices"][0]["id"]
    tree.write_text("Other/new.mkv\n", encoding="utf-16")
    changed = client.post("/api/v4/sources/scans", json={**request, "tree_mapping_choice": choice})
    assert changed.json()["status"] == "mapping_required"
    _assert_no_scan(database)


def test_confirmed_mapping_reused_for_new_txt_and_config_change_invalidates_it(tree_api):
    tree, database, runner, client = tree_api
    request = {**_request(tree, "tree"), "tree_mapping_mode": "auto", "tree_verify_paths": False}
    pending = client.post("/api/v4/sources/scans", json=request).json()
    selected = client.post("/api/v4/sources/scans", json={**request, "tree_mapping_choice": pending["path_validation"]["choices"][0]["id"]}).json()
    runner.run_scan(runner.claim_next_scan())
    # 本用例只验证映射复用条件，不执行识别/在线资料作业。
    with database.connect() as conn:
        conn.execute("INSERT INTO import_revisions(revision_id, root_id, scan_id, resolver_version, status, created_at, confirmed_at) VALUES ('mapping-fixture', ?, ?, 'fixture', 'confirmed', '2026-10-12', '2026-10-12')", (selected["root_id"], selected["scan_id"]))
    tree.write_text("NewShow/Season 1/NewShow.S01E01.mkv\n", encoding="utf-16")
    replay = client.post("/api/v4/sources/scans", json={**request, "target_root_id": selected["root_id"]})
    assert replay.status_code == 200, replay.text
    assert replay.json()["status"] == "queued"
    assert "保存" in replay.json()["path_validation"]["reason"]
    config = media_v4.load_config()
    config.baidu_root = "R:/different-mount"
    invalidated = client.post("/api/v4/sources/scans", json={**request, "source_root": r"Q:\offline-library", "target_root_id": selected["root_id"]})
    assert invalidated.json()["status"] == "mapping_required"


def test_mapping_configuration_change_before_confirm_is_rejected(tree_api):
    tree, database, runner, client = tree_api
    request = {**_request(tree, "tree"), "tree_mapping_mode": "auto", "tree_verify_paths": False}
    pending = client.post("/api/v4/sources/scans", json=request).json()
    selected = client.post("/api/v4/sources/scans", json={**request, "tree_mapping_choice": pending["path_validation"]["choices"][0]["id"]}).json()
    runner.run_scan(runner.claim_next_scan())
    media_v4._require_tree_validation(database, selected["scan_id"], selected["root_id"], require=True)
    media_v4.load_config().baidu_root = "R:/changed"
    with pytest.raises(media_v4.HTTPException) as error:
        media_v4._require_tree_validation(database, selected["scan_id"], selected["root_id"], require=True)
    assert error.value.status_code == 409


def _assert_no_scan(database):
    with database.connect() as conn:
        for table in ("source_roots", "source_scans", "source_scan_requests"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


@pytest.mark.parametrize("mode, scope, expected", [
    ("mounted_subdir", "动画", r"Z:\Show\e.mkv"),
    ("export_subdir", "01动画", r"Z:\01动画\动画\Show\e.mkv"),
])
def test_explicit_mapping_is_frozen_for_runner_and_source_card(tree_api, mode, scope, expected):
    tree, database, runner, client = tree_api
    tree.write_text("|——根目录\n| |-动画\n| | |-Show\n| | | |-e.mkv\n| |-电影\n| | |-m.mkv\n", encoding="utf-16")
    response = client.post("/api/v4/sources/scans", json={
        **_request(tree, "tree"), "provider": "pan115", "source_root": "Z:\\",
        "tree_mapping_mode": mode, "tree_mapping_scope": scope,
    })
    assert response.status_code == 200, response.text
    scan_id = response.json()["scan_id"]
    assert response.json()["path_validation"]["path_samples"][0] == expected
    # 原 TXT 发生变化不能改变已登记任务；使用归档与冻结映射执行。
    tree.write_text("Other/new.mkv\n", encoding="utf-16")
    task = runner.claim_next_scan()
    assert task.scan_id == scan_id
    runner.run_scan(task)
    with database.connect() as conn:
        rows = conn.execute("SELECT relative_path, playback_locator FROM source_evidence WHERE scan_id=? ORDER BY relative_path", (scan_id,)).fetchall()
        status = conn.execute("SELECT status, error FROM source_scans WHERE scan_id=?", (scan_id,)).fetchone()
    assert status["status"] == "completed", dict(status)
    assert rows[0]["relative_path"] == "动画/Show/e.mkv"
    assert rows[0]["playback_locator"] == expected
    assert len(rows) == (1 if mode == "mounted_subdir" else 2)
    card = client.get("/api/v4/sources/libraries").json()["cards"][0]
    assert card["tree_mapping_mode"] == mode
    assert card["tree_mapping_scope"] == scope
    assert card["tree_source_root"] == "Z:\\"


def test_missing_mount_scope_creates_no_source_or_scan(tree_api):
    tree, database, _runner, client = tree_api
    response = client.post("/api/v4/sources/scans", json={
        **_request(tree, "tree"), "tree_mapping_mode": "mounted_subdir", "tree_mapping_scope": "不存在",
    })
    assert response.status_code == 409, response.text
    _assert_no_scan(database)


@pytest.mark.parametrize("source", ["tree", "hybrid"])
@pytest.mark.parametrize("unsupported", ["resolve", "stat"])
def test_durable_tree_scan_reads_virtual_volume_without_path_probes(tree_api, monkeypatch, source, unsupported):
    tree, database, runner, client = tree_api
    original = getattr(Path, unsupported)

    def volume_error(self, *args, **kwargs):
        if self == tree:
            raise OSError("WinError 1005: virtual volume does not support path probes")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, unsupported, volume_error)
    response = client.post("/api/v4/sources/scans", json=_request(tree, source))

    assert response.status_code == 200, response.text
    assert response.headers["access-control-allow-origin"] == "http://tauri.localhost"
    scan_id = response.json()["scan_id"]
    with database.connect() as conn:
        row = conn.execute("SELECT * FROM source_scan_requests WHERE scan_id=?", (scan_id,)).fetchone()
    assert json.loads(row["request_json"])["tree_file_path"] == os.path.abspath(tree)
    assert archive_is_intact(row["input_archive_path"], row["input_sha256"])
    assert tree.read_text(encoding="utf-16").count(".mkv") == 2

    task = runner.claim_next_scan()
    assert task is not None and task.scan_id == scan_id
    runner.run_scan(task)
    with database.connect() as conn:
        scan = conn.execute("SELECT status, error FROM source_scans WHERE scan_id=?", (scan_id,)).fetchone()
        count = conn.execute("SELECT COUNT(*) FROM source_evidence WHERE scan_id=?", (scan_id,)).fetchone()[0]
    assert scan["status"] == "completed", dict(scan)
    assert count == 2
    assert client.get("/api/health").status_code == 200


@pytest.mark.parametrize("source", ["tree", "hybrid"])
@pytest.mark.parametrize("content, message", [(None, "无法打开"), (b"", "为空"), (b"plain text", "不是可识别")])
def test_durable_tree_input_errors_are_actionable_json(tree_api, source, content, message):
    tree, database, _runner, client = tree_api
    if content is None:
        tree.unlink()
    else:
        tree.write_bytes(content)

    response = client.post("/api/v4/sources/scans", json=_request(tree, source))

    assert response.status_code == 400, response.text
    assert message in response.json()["detail"]
    assert response.headers["access-control-allow-origin"] == "http://tauri.localhost"
    assert client.get("/api/health").status_code == 200
    _assert_no_scan(database)


@pytest.mark.parametrize("error, message", [
    (InputArchiveError("目录树文件过大，请拆分后重新导出"), "过大"),
    (OSError("fixture input disappeared or disk full"), "归档"),
])
def test_durable_tree_archive_failure_creates_no_scan(tree_api, monkeypatch, error, message):
    tree, database, _runner, client = tree_api

    def archive_failure(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(input_archive, "archive_tree_input", archive_failure)
    response = client.post("/api/v4/sources/scans", json=_request(tree, "tree"))

    assert response.status_code == 400, response.text
    assert message in response.json()["detail"]
    assert "fixture input" not in response.json()["detail"]
    assert response.headers["access-control-allow-origin"] == "http://tauri.localhost"
    assert client.get("/api/health").status_code == 200
    _assert_no_scan(database)


def test_application_lifespan_starts_and_stops_on_an_isolated_empty_database():
    with TestClient(app) as client:
        assert client.get("/api/health").json()["status"] == "ok"


@pytest.mark.parametrize("source", ["tree", "hybrid"])
@pytest.mark.parametrize("endpoint", ["/api/v4/sources/scans", "/api/v4/sources/scan"])
def test_selected_txt_is_copied_once_before_parsing_and_original_location_is_preserved(
    tree_api, monkeypatch, source, endpoint,
):
    tree, database, runner, client = tree_api
    # TXT 在来源子目录中，不能改变默认播放根；原位置仍供显示和读取。
    original_root = tree.parent / "offline-mount"
    original = original_root / "我的动画" / tree.name
    original.parent.mkdir(parents=True)
    original.write_bytes(tree.read_bytes())
    original_contents = original.read_bytes()
    monkeypatch.setattr(media_v4, "_configured_tree_roots", lambda *_: [str(original_root)])
    real_open = builtins.open
    real_reader = media_v4.read_directory_tree_text
    reads = []
    parses = []

    def copy_only_open(path, mode="r", *args, **kwargs):
        if Path(path) == original:
            reads.append(mode)
            assert reads == ["rb"], "挂载位置的 TXT 只能为复制打开一次"
        return real_open(path, mode, *args, **kwargs)

    def local_only_reader(path):
        assert Path(path) != original, "必须先复制到本地再解析 TXT"
        assert Path(path).is_relative_to(Path(os.environ["KUMIPLAYER_DATA_DIR"]))
        assert Path(path).is_file()
        assert Path(path).read_bytes() == original_contents
        assert reads == ["rb"]
        parses.append(str(path))
        return real_reader(path)

    monkeypatch.setattr(builtins, "open", copy_only_open)
    monkeypatch.setattr(media_v4, "read_directory_tree_text", local_only_reader)
    request = _request(original, source)
    # 两条入口都按明确来源根映射，不采用原 TXT 或缓存所在目录。
    response = client.post(endpoint, json=request)

    assert response.status_code == 200, response.text
    assert reads == ["rb"] and len(parses) == 1
    if source == "tree":
        assert response.json()["effective_playback_root"].replace("/", "\\") == str(original_root).replace("/", "\\")
    if endpoint.endswith("/scans"):
        scan_id = response.json()["scan_id"]
        with database.connect() as conn:
            row = conn.execute("SELECT * FROM source_scan_requests WHERE scan_id=?", (scan_id,)).fetchone()
        assert json.loads(row["request_json"])["tree_file_path"] == os.path.abspath(original)
        assert row["original_filename"] == original.name
        # 已复制后原文件被移走，后台执行也不得再次依赖原挂载位置。
        original.unlink()
        task = runner.claim_next_scan()
        assert task is not None
        runner.run_scan(task)
        with database.connect() as conn:
            state = conn.execute("SELECT status, error FROM source_scans WHERE scan_id=?", (scan_id,)).fetchone()
        assert state["status"] == "completed", dict(state)
        assert reads == ["rb"]
