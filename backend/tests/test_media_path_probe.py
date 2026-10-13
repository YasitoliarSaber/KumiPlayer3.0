"""Exercise actual spawn IPC instead of assuming the executable accepts Python -c."""

from app.core import media_path_probe


def test_unicode_and_spaces_are_preserved_through_spawn_ipc(tmp_path):
    directory = tmp_path / "动画库 中文 spaces"
    directory.mkdir()
    video = directory / "第一集.mkv"
    video.write_bytes(b"fixture")
    states, timed_out = media_path_probe.probe_media_path_states(directory, [video, directory / "missing.mkv"])
    assert states == [True, True, False]
    assert timed_out is False


def test_missing_directory_and_regular_file_are_not_media_roots(tmp_path):
    regular_file = tmp_path / "directory.txt"
    regular_file.write_text("fixture", encoding="utf-8")
    assert media_path_probe.probe_media_path_states(regular_file, []) == ([False], False)
    assert media_path_probe.probe_media_path_states(tmp_path / "missing", []) == ([False], False)


def test_unresponsive_probe_is_bounded_and_reaps_only_its_worker(tmp_path, monkeypatch):
    from unittest.mock import MagicMock

    context = MagicMock()
    receiver, sender, worker = MagicMock(), MagicMock(), MagicMock()
    receiver.poll.return_value = False
    worker.is_alive.side_effect = [True, False]
    context.Pipe.return_value = receiver, sender
    context.Process.return_value = worker
    monkeypatch.setattr(media_path_probe.multiprocessing, "get_context", lambda method: context)
    assert media_path_probe.probe_media_path_states(tmp_path, [], timeout=0.25) == ([False], True)
    receiver.poll.assert_called_once_with(0.25)
    worker.terminate.assert_called_once()
    worker.close.assert_called_once()
    receiver.close.assert_called_once()


def test_broken_worker_does_not_report_success(tmp_path, monkeypatch):
    from unittest.mock import MagicMock

    context = MagicMock()
    receiver, sender, worker = MagicMock(), MagicMock(), MagicMock()
    receiver.poll.return_value = True
    receiver.recv.side_effect = EOFError
    worker.is_alive.return_value = False
    context.Pipe.return_value = receiver, sender
    context.Process.return_value = worker
    monkeypatch.setattr(media_path_probe.multiprocessing, "get_context", lambda method: context)
    assert media_path_probe.probe_media_path_states(tmp_path, []) == ([False], False)
