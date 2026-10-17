"""可配置看完阈值：50–100%，默认 90，采样/退出/切集共用同一判定。"""

from __future__ import annotations

from types import SimpleNamespace


def _threshold(percent, monkeypatch):
    from app.media_v4.playback import session as playback

    monkeypatch.setattr(playback, "load_config", lambda: SimpleNamespace(completed_threshold_percent=percent))
    return playback._completed_threshold()


def test_default_threshold_is_ninety_percent():
    from app.core.config import AppConfig
    from app.media_v4.playback import session as playback

    assert AppConfig().completed_threshold_percent == 90
    # 配置对象缺少字段时（老夹具）同样回落 90%
    original = playback.load_config
    playback.load_config = lambda: SimpleNamespace()
    try:
        assert playback._completed_threshold() == 0.9
    finally:
        playback.load_config = original


def test_threshold_clamps_out_of_range_and_invalid_values(monkeypatch):
    assert _threshold(50, monkeypatch) == 0.5
    assert _threshold(100, monkeypatch) == 1.0
    # 历史越界值按边界夹取，非法值回落默认 90%
    assert _threshold(10, monkeypatch) == 0.5
    assert _threshold(999, monkeypatch) == 1.0
    assert _threshold("not-a-number", monkeypatch) == 0.9


def _force_checkpoint_completed(percent, position, duration, monkeypatch):
    from app.media_v4.playback import session as playback

    monkeypatch.setattr(playback, "load_config", lambda: SimpleNamespace(completed_threshold_percent=percent))
    manager = object.__new__(playback.V4PlaybackManager)
    captured: dict[str, bool] = {}

    def checkpoint(_session, _episode_id, _asset_id, _position, _duration, completed, **_kwargs):
        captured["completed"] = completed
        return True

    manager._checkpoint_progress = checkpoint
    manager._schedule_completion_sync = lambda *_args, **_kwargs: None
    manager._force_checkpoint({
        "work_id": "work", "episode_id": "ep",
        "playlist": [{"episode_id": "ep", "asset_id": "asset", "preferred_title": "Probe"}],
        "playlist_position": 0, "position": position, "duration": duration,
    })
    return captured["completed"]


def test_exit_and_episode_switch_completion_uses_configured_threshold(monkeypatch):
    # 退出结算与切集结算都走 _force_checkpoint，阈值必须与采样一致。
    assert _force_checkpoint_completed(50, 50.0, 100.0, monkeypatch) is True
    assert _force_checkpoint_completed(50, 49.9, 100.0, monkeypatch) is False
    assert _force_checkpoint_completed(90, 89.9, 100.0, monkeypatch) is False
    assert _force_checkpoint_completed(90, 90.0, 100.0, monkeypatch) is True
    assert _force_checkpoint_completed(100, 99.9, 100.0, monkeypatch) is False
    assert _force_checkpoint_completed(100, 100.0, 100.0, monkeypatch) is True


def _monitor_writes(events, *, percent, monkeypatch):
    """用真实 _monitor 跑一串进度事件；时钟、持久化与同步均为替身。"""

    import threading
    from unittest.mock import patch

    from app.media_v4.playback import session as playback
    from app.playback.mpv_ipc import MpvProgressEvent

    class _Process:
        ended = False

        def poll(self):
            return 0 if self.ended else None

        def wait(self, timeout=None):
            return 0

    process = _Process()
    manager = object.__new__(playback.V4PlaybackManager)
    manager._lock = threading.Lock()
    manager._session_bindings = {}
    manager._process = process
    manager.database = None
    state = {
        "session_id": "probe", "ipc_server": "probe", "episode_id": "ep", "work_id": "work",
        "playlist": [{"episode_id": "ep", "asset_id": "asset", "preferred_title": "Probe"}],
        "playlist_position": 0,
    }
    manager._session = state
    writes: list[bool] = []

    def checkpoint(_session, _episode_id, _asset_id, _position, _duration, completed, **_kwargs):
        writes.append(completed)
        return True

    manager._checkpoint_progress = checkpoint
    manager._force_checkpoint = lambda *_args, **_kwargs: None
    manager._schedule_completion_sync = lambda *_args, **_kwargs: None
    manager._display_title = staticmethod(lambda asset: "Probe")
    clock = {"t": 100.0}

    def generator(_server, *, should_stop=None):
        for position, duration in events:
            yield MpvProgressEvent(position=position, duration=duration, playlist_position=0)
            clock["t"] += 1.0
        process.ended = True

    monkeypatch.setattr(playback, "load_config", lambda: SimpleNamespace(completed_threshold_percent=percent))
    with patch.object(playback, "observe_mpv_progress", generator), \
            patch.object(playback.time, "monotonic", lambda: clock["t"]):
        manager._monitor(process, state)
    return writes


def test_sampling_uses_configured_threshold(monkeypatch):
    from app.media_v4.playback import session as playback

    # 50% 阈值：60% 的采样即判定完成
    assert playback._completed_threshold() in {0.5, 0.9, 1.0}
    low = _monitor_writes([(60.0, 100.0)], percent=50, monkeypatch=monkeypatch)
    assert low == [True]
    # 默认 90% 阈值：60% 不完成，91% 完成
    default = _monitor_writes([(60.0, 100.0)], percent=90, monkeypatch=monkeypatch)
    assert default == [False]
    high = _monitor_writes([(91.0, 100.0)], percent=90, monkeypatch=monkeypatch)
    assert high == [True]
    # 100% 阈值：99% 不完成
    strict = _monitor_writes([(99.0, 100.0)], percent=100, monkeypatch=monkeypatch)
    assert strict == [False]
