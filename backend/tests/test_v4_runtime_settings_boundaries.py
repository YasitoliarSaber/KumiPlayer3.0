"""Setup and folder actions consume saved local media, without a mirror."""

from pathlib import Path

import pytest
from app.api import config, system
from app.core.config import AppConfig, load_config, save_config
from app.media_v4.persistence.database import V4Database
from fastapi import HTTPException

from .test_system_open_folder import _confirmed_asset


def test_setup_without_mirror_preserves_existing_player_and_storage(monkeypatch, tmp_path):
    current = AppConfig(mirror_dir="historical-value", mpv_anime4k_mode="b")
    save_config(current)
    monkeypatch.setattr(config, "check_mpv_runtime", lambda **_: {
        "available": True, "manifest_valid": True, "files_valid": True,
        "configuration_available": True,
    })
    monkeypatch.setattr(config, "_probe_media_path_states", lambda *args: ([True], False))
    result = config.complete_setup(config.SetupCompleteRequest(local_root=str(tmp_path)))
    assert result["setup_completed"] is True
    assert load_config().mirror_dir == "historical-value"
    assert load_config().mpv_anime4k_mode == "b"


def test_setup_never_creates_requested_historical_mirror(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "load_config", AppConfig)
    monkeypatch.setattr(config, "check_mpv_runtime", lambda **_: {
        "available": True, "manifest_valid": True, "files_valid": True,
        "configuration_available": True,
    })
    monkeypatch.setattr(config, "_probe_media_path_states", lambda *args: ([True], False))
    monkeypatch.setattr(config, "save_config", lambda _: None)
    destination = tmp_path / "unused-mirror"
    config.complete_setup(config.SetupCompleteRequest(
        local_root=str(tmp_path), mirror_dir=str(destination),
    ))
    assert not destination.exists()


def test_folder_uses_current_confirmed_observation_instead_of_asset_cache(tmp_path, monkeypatch):
    database = V4Database(tmp_path / "library.db")
    database.initialize()
    work_id, episode_id, media = _confirmed_asset(database, tmp_path)
    with database.connect() as conn:
        conn.execute("UPDATE assets SET playback_locator='https://invalid.example/video', source_locator='stale'")
    monkeypatch.setattr(system, "get_database", lambda: database)
    result = system.open_folder(system.OpenFolderRequest(work_id=work_id, episode_id=episode_id, open=False))
    assert result["folder_path"] == str(media.parent)


def test_retired_source_cannot_open_folder(tmp_path, monkeypatch):
    database = V4Database(tmp_path / "library.db")
    database.initialize()
    work_id, episode_id, _ = _confirmed_asset(database, tmp_path)
    with database.connect() as conn:
        conn.execute("UPDATE source_roots SET retired_at='retired'")
    monkeypatch.setattr(system, "get_database", lambda: database)
    with pytest.raises(HTTPException) as error:
        system.open_folder(system.OpenFolderRequest(work_id=work_id, episode_id=episode_id, open=False))
    assert error.value.status_code == 404


@pytest.mark.parametrize("locator", ["", "relative/video.mkv", "https://invalid.example/video", "C:/video.strm"])
def test_folder_never_falls_back_to_source_locator(tmp_path, monkeypatch, locator):
    monkeypatch.setattr(system, "_find_asset", lambda *_: {
        "playback_locator": locator, "source_locator": str(tmp_path / "video.mkv"),
    })
    monkeypatch.setattr(Path, "is_dir", lambda _: pytest.fail("Invalid locator must not probe filesystem"))
    with pytest.raises(HTTPException) as error:
        system.open_folder(system.OpenFolderRequest(work_id="work", episode_id="episode", open=False))
    assert error.value.status_code == 400
