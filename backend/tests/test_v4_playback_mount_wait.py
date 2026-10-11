"""挂载冷启动等待与断网时的有界文件探测。"""

import threading
import time
from pathlib import Path
from types import SimpleNamespace

from app.media_v4.path_validation import validate_playback_locator
from app.media_v4.playback import session as session_module
from app.media_v4.playback.session import V4PlaybackManager

from backend.tests.test_v4_local_path_playback import _confirmed_media


def test_first_play_waits_for_mount_warmup_without_a_second_click(tmp_path, monkeypatch):
    database, media, binding = _confirmed_media(tmp_path)
    original_is_file = Path.is_file
    events = []
    calls = []
    finished = threading.Event()

    def slow_mounted_file(path):
        if path == media:
            calls.append(path)
            try:
                # 复现旧的 2 秒超时后，用户立即再点就能播放的时序。
                time.sleep(2.2)
                events.append("ready")
                return True
            finally:
                finished.set()
        return original_is_file(path)

    def launch(path, **kwargs):
        assert path == str(media)
        assert kwargs["media_path_validated"] is True
        events.append("launch")
        return SimpleNamespace(pid=123)

    monkeypatch.setattr(Path, "is_file", slow_mounted_file)
    monkeypatch.setattr(session_module, "start_mpv", launch)
    monkeypatch.setattr(V4PlaybackManager, "_monitor", lambda *_args: None)
    manager = V4PlaybackManager(database, session_dir=tmp_path / "sessions")
    monkeypatch.setattr(manager, "stop", lambda: events.append("stop"))

    try:
        result = manager.play(**binding)
        assert result["status"] == "playing"
        assert events == ["ready", "stop", "launch"]
        assert calls == [media]
    finally:
        assert finished.wait(3)


def test_unresponsive_mount_times_out_without_naming_a_provider(tmp_path, monkeypatch):
    release = threading.Event()
    finished = threading.Event()

    def blocked_file(_path):
        try:
            release.wait(3)
            return True
        finally:
            finished.set()

    monkeypatch.setattr(Path, "is_file", blocked_file)
    started = time.monotonic()
    try:
        ok, reason = validate_playback_locator(str(tmp_path / "offline.mkv"), timeout=0.02)
        assert not ok
        assert "超时" in reason
        assert "OpenList" not in reason
        assert time.monotonic() - started < 1
    finally:
        release.set()
        assert finished.wait(1)


def test_retry_reuses_the_pending_probe_instead_of_starting_more_io(tmp_path, monkeypatch):
    release = threading.Event()
    finished = threading.Event()
    calls = []

    def blocked_file(path):
        calls.append(path)
        try:
            release.wait(3)
            return True
        finally:
            finished.set()

    monkeypatch.setattr(Path, "is_file", blocked_file)
    locator = str(tmp_path / "pending.mkv")
    try:
        assert not validate_playback_locator(locator, timeout=0.02)[0]
        assert not validate_playback_locator(locator, timeout=0.02)[0]
        assert calls == [Path(locator)]
    finally:
        release.set()
        assert finished.wait(1)


def test_missing_file_is_rejected_without_waiting_for_the_mount_budget(tmp_path):
    started = time.monotonic()
    ok, reason = validate_playback_locator(str(tmp_path / "missing.mkv"))
    assert not ok
    assert "不可访问" in reason
    assert time.monotonic() - started < 1
