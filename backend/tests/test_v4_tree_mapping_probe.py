"""路径验证有硬预算，访问错误与文件缺失分开。"""

import threading

from app.media_v4.sources.tree_mapping_probe import BoundedMetadataProbe, inspect_metadata


def test_metadata_does_not_open_media_and_distinguishes_missing(tmp_path):
    media = tmp_path / "e.mkv"
    media.write_bytes(b"")
    assert inspect_metadata(str(media))["status"] == "file"
    assert inspect_metadata(str(tmp_path))["status"] == "directory"
    assert inspect_metadata(str(tmp_path / "missing.mkv"))["status"] == "missing"


def test_timeout_returns_unknown_and_prevents_further_calls():
    gate = threading.Event()
    calls = []
    def inspect(path):
        calls.append(path)
        gate.wait(1)
        return {"status": "file"}
    probe = BoundedMetadataProbe(timeout=0.02, max_requests=3, inspect=inspect)
    try:
        assert probe("one")["status"] == "unavailable"
        assert probe("two")["status"] == "unavailable"
        assert len(calls) == 1
    finally:
        gate.set()


def test_request_budget_includes_parent_checks():
    calls = []
    def inspect(path):
        calls.append(path)
        return {"status": "directory" if path.endswith("Show") else "file"}
    probe = BoundedMetadataProbe(max_requests=2, inspect=inspect)
    assert probe("Z:/Show/1.mkv")["status"] == "file"
    assert probe("Z:/Show/2.mkv")["status"] == "unavailable"
    assert len(calls) == 2


def test_file_parent_never_proves_a_child_file_exists():
    probe = BoundedMetadataProbe(inspect=lambda _: {'status': 'file'})
    assert probe('Z:/not-a-directory/1.mkv')['status'] == 'missing'
