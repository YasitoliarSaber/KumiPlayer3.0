"""Exercise persistence after reordered requests, not just screen callbacks."""

import copy
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.api import bangumi as bangumi_routes
from app.api import config as routes
from app.core import config as core
from app.core.media_path_probe import MediaPathProbeError
from app.integrations.bangumi import (
    AUTH_INVALID,
    BangumiAccountSnapshot,
    BangumiError,
    load_account_snapshot,
    save_account_snapshot,
)
from app.main import app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(routes, "check_mpv_runtime", lambda **kwargs: {
        "available": True, "manifest_valid": True, "files_valid": True,
        "configuration_available": True,
    })
    monkeypatch.setattr(routes, "_probe_media_path_states", lambda *args: ([True], False))
    return TestClient(app)


def during_validation(monkeypatch, request, newer_action):
    entered, release = threading.Event(), threading.Event()
    original = routes._validate_setup_sources

    def paused(req):
        if not entered.is_set():
            entered.set()
            assert release.wait(5)
        return original(req)

    monkeypatch.setattr(routes, "_validate_setup_sources", paused)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(request)
        assert entered.wait(5)
        try:
            newer = newer_action()
        finally:
            release.set()
        older = pending.result(timeout=5)
    return older, newer


@pytest.mark.parametrize("old_token", ["fixture:old-token", ""])
def test_complete_preserves_independently_saved_credentials(client, monkeypatch, tmp_path, old_token):
    core.save_config(core.AppConfig(local_root=str(tmp_path), tmdb_bearer_token=old_token))
    monkeypatch.setattr(routes, "_validate_tmdb_credential", lambda token: None)
    older, newer = during_validation(
        monkeypatch,
        lambda: client.post("/api/config/setup/complete", json={"local_root": str(tmp_path)}),
        lambda: client.post("/api/config/setup/credentials/tmdb", json={"tmdb_bearer_token": "fixture:new-token"}),
    )
    assert older.status_code == newer.status_code == 200
    assert core.load_config().tmdb_bearer_token == "fixture:new-token"
    assert client.get("/api/config").json()["tmdb_configured"] is True
    core.invalidate_config_cache()
    assert core.load_config().tmdb_bearer_token == "fixture:new-token"


@pytest.mark.parametrize("old_endpoint", ["complete", "sources"])
def test_new_directory_supersedes_older_validation(client, monkeypatch, tmp_path, old_endpoint):
    old, new = str(tmp_path / "old"), str(tmp_path / "new")
    core.save_config(core.AppConfig(local_root=old))
    older, newer = during_validation(
        monkeypatch,
        lambda: client.post(f"/api/config/setup/{old_endpoint}", json={"local_root": old}),
        lambda: client.post("/api/config/setup/sources", json={"local_root": new}),
    )
    assert newer.status_code == 200
    assert older.status_code == 409
    assert core.load_config().local_root == new
    assert core.load_config().setup_completed is False
    core.invalidate_config_cache()
    assert core.load_config().local_root == new


@pytest.mark.parametrize("already_deferred", [False, True])
def test_defer_supersedes_inflight_completion_even_if_already_deferred(client, monkeypatch, tmp_path, already_deferred):
    core.save_config(core.AppConfig(local_root=str(tmp_path), setup_deferred=already_deferred))
    older, newer = during_validation(
        monkeypatch,
        lambda: client.post("/api/config/setup/complete", json={}),
        lambda: client.post("/api/config/setup/defer"),
    )
    assert newer.status_code == 200
    assert older.status_code == 409
    assert core.load_config().setup_deferred is True
    assert core.load_config().setup_completed is False


def test_saved_external_player_survives_defer_and_restart(client, monkeypatch, tmp_path):
    monkeypatch.setattr(routes, "inspect_external_mpv", lambda path: {"ok": True})
    path = str(tmp_path / "Player" / "mpv.exe")
    response = client.post("/api/config/setup/player", json={"player_mode": "external", "external_mpv_path": path})
    assert response.status_code == 200
    assert client.post("/api/config/setup/defer").status_code == 200
    core.invalidate_config_cache()
    assert core.load_config().player_mode == "external"
    assert core.load_config().external_mpv_path == path


def test_completion_reads_saved_checkpoints_without_replacing_other_preferences(client, tmp_path):
    core.save_config(core.AppConfig(local_root=str(tmp_path), tmdb_bearer_token="fixture:token", tmdb_language="ja-JP"))
    response = client.post("/api/config/setup/complete", json={})
    assert response.status_code == 200
    assert response.json()["setup_completed"] is True
    assert core.load_config().local_root == str(tmp_path)
    assert core.load_config().tmdb_language == "ja-JP"
    assert core.load_config().tmdb_bearer_token == "fixture:token"


def test_unrelated_patch_and_credential_save_do_not_overwrite_each_other(client, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = core._persist_config_payload

    def slow_persist(config, **kwargs):
        if config.tmdb_language == "ja-JP" and not entered.is_set():
            entered.set()
            assert release.wait(5)
        return original(config, **kwargs)

    monkeypatch.setattr(core, "_persist_config_payload", slow_persist)
    monkeypatch.setattr(routes, "_validate_tmdb_credential", lambda token: None)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(client.patch, "/api/config", json={"tmdb_language": "ja-JP"})
        assert entered.wait(5)
        second = executor.submit(client.post, "/api/config/setup/credentials/tmdb", json={"tmdb_bearer_token": "fixture:new"})
        release.set()
        assert first.result(timeout=5).status_code == second.result(timeout=5).status_code == 200
    assert core.load_config().tmdb_language == "ja-JP"
    assert core.load_config().tmdb_bearer_token == "fixture:new"


def test_saved_heartbeat_preferences_survive_desktop_defaults(monkeypatch):
    monkeypatch.setenv("KUMIPLAYER_AUTO_SHUTDOWN_ON_HEARTBEAT_TIMEOUT", "1")
    monkeypatch.setenv("KUMIPLAYER_HEARTBEAT_TIMEOUT", "120")
    assert core.load_config().heartbeat_timeout == 120  # new-profile default
    core.save_config(core.AppConfig(auto_shutdown_on_heartbeat_timeout=False, heartbeat_timeout=45))
    core.invalidate_config_cache()
    current = core.load_config()
    assert current.auto_shutdown_on_heartbeat_timeout is False
    assert current.heartbeat_timeout == 45


def test_probe_fault_is_not_reported_as_a_missing_directory(client, monkeypatch, tmp_path):
    def broken(*args):
        raise MediaPathProbeError("fixture worker fault")

    monkeypatch.setattr(routes, "_probe_media_path_states", broken)
    response = client.post("/api/config/setup/sources", json={"local_root": str(tmp_path)})
    assert response.status_code == 503
    assert "目录检测程序" in response.json()["detail"]
    assert "不存在或不可访问" not in response.json()["detail"]
    core.save_config(core.AppConfig(local_root=str(tmp_path)))
    response = client.post("/api/config/test/media-paths")
    assert response.status_code == 200
    assert response.json()["ok"] is False
    local = next(item for item in response.json()["sources"] if item["source"] == "local")
    assert "目录检测程序" in local["message"]


def test_logout_failure_does_not_publish_unsaved_empty_token(client, monkeypatch):
    core.save_config(core.AppConfig(bangumi_access_token="fixture:saved"))
    before = copy.deepcopy(core.load_config())
    disk_before = core.get_config_file().read_bytes()

    def failed(*args, **kwargs):
        raise OSError("fixture write failed")

    monkeypatch.setattr(core, "_persist_config_payload", failed)
    with pytest.raises(OSError, match="fixture write failed"):
        bangumi_routes.clear_token()
    assert core.load_config() == before
    assert core.get_config_file().read_bytes() == disk_before


def test_logout_supersedes_pending_login(client, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    core.save_config(core.AppConfig(bangumi_access_token="fixture:old"))

    def slow_me(self, **kwargs):
        entered.set()
        assert release.wait(5)
        return {"id": 1, "username": "fixture"}

    monkeypatch.setattr(bangumi_routes.BangumiClient, "get_me", slow_me)
    monkeypatch.setattr(bangumi_routes, "clear_account_snapshot", lambda: None)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(client.post, "/api/integrations/bangumi/token", json={"access_token": "fixture:new"})
        assert entered.wait(5)
        try:
            assert client.delete("/api/integrations/bangumi/token").status_code == 200
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 409
    assert core.load_config().bangumi_access_token == ""
    assert json.loads(core.get_config_file().read_text(encoding="utf-8"))["bangumi_access_token"] == ""


@pytest.mark.parametrize("old_result", ["success", "expired", "logout"])
def test_old_account_verification_cannot_replace_new_account_state(client, monkeypatch, old_result):
    entered, release = threading.Event(), threading.Event()
    core.save_config(core.AppConfig(bangumi_access_token="fixture:old"))
    save_account_snapshot(BangumiAccountSnapshot(user_id=1, username="old", auth_status="valid"))

    def get_me(self, **kwargs):
        if self.access_token == "fixture:old":
            entered.set()
            assert release.wait(5)
            if old_result == "expired":
                raise BangumiError("fixture expired", status_code=401, error_code=AUTH_INVALID)
            return {"id": 1, "username": "old"}
        return {"id": 2, "username": "new"}

    monkeypatch.setattr(bangumi_routes.BangumiClient, "get_me", get_me)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(client.post, "/api/integrations/bangumi/session/verify")
        assert entered.wait(5)
        try:
            if old_result == "logout":
                assert client.delete("/api/integrations/bangumi/token").status_code == 200
            else:
                assert client.post("/api/integrations/bangumi/token", json={"access_token": "fixture:new"}).status_code == 200
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 200
    if old_result == "logout":
        assert load_account_snapshot().user_id is None
    else:
        assert core.load_config().bangumi_access_token == "fixture:new"
        assert load_account_snapshot().user_id == 2
        assert load_account_snapshot().auth_status == "valid"
