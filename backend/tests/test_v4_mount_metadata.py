from __future__ import annotations

import importlib
import json
from pathlib import Path


def _module():
    return importlib.import_module("app.media_v4.sources.mount_metadata")


def _windows(monkeypatch, commands=(), connection=None):
    module = _module()
    monkeypatch.setattr(module, "_is_windows", lambda: True)
    monkeypatch.setattr(module, "_rclone_commands", lambda: iter(commands))
    monkeypatch.setattr(module, "_network_connection", lambda drive: connection)
    monkeypatch.setattr(module, "_config_volume_is_local", lambda path: True, raising=False)
    return module


def test_non_windows_does_not_inspect_mounts(monkeypatch):
    module = _module()
    monkeypatch.setattr(module, "_is_windows", lambda: False)
    monkeypatch.setattr(module, "_network_connection", lambda _: 1 / 0)
    assert module.discover_mount_relationships(["Z:/Media"]) == []


def test_network_connection_is_scoped_to_requested_drive(monkeypatch):
    module = _windows(monkeypatch)
    drives = []

    def connection(drive):
        drives.append(drive)
        return r"\\host\share"

    monkeypatch.setattr(module, "_network_connection", connection)
    result = module.discover_mount_relationships(["Z:/Media", "Z:/Other", "relative"])
    assert drives == ["Z:"]
    assert result[0]["local_root"] == "Z:\\"
    assert result[0]["remote_root"] == r"\\host\share"
    assert result[0]["namespace"] == "unc"
    assert "provider" not in result[0]


def _config(tmp_path: Path, text: str, name="rclone.conf"):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_rclone_webdav_subdirectory_is_separate_namespace_and_redacted(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype = webdav\nurl = https://user:secret@example.org/dav/?token=private#fragment\npass = secret\n")
    module = _windows(monkeypatch, [["rclone.exe", "mount", "cloud:动画/作品", "Z:", "--config", config]])
    result = module.discover_mount_relationships(["Z:/Media"])
    assert len(result) == 1
    assert result[0]["local_root"] == "Z:\\"
    assert result[0]["remote_root"] == "https://example.org/dav/动画/作品"
    assert result[0]["namespace"] == "webdav_endpoint"
    assert all(value not in json.dumps(result) for value in ("secret", "private", "user:", "fragment"))


def test_rclone_does_not_read_unrelated_mount_config(tmp_path, monkeypatch):
    module = _windows(monkeypatch, [["rclone.exe", "mount", "cloud:", "Y:", "--config", str(tmp_path / "missing")]])
    monkeypatch.setattr(module, "_webdav_url", lambda *args: 1 / 0)
    assert module.discover_mount_relationships(["Z:/Media"]) == []


def test_rclone_requires_explicit_config_and_webdav_type(tmp_path, monkeypatch):
    config = _config(tmp_path, "[115]\ntype = crypt\nremote = personal:\n")
    module = _windows(monkeypatch, [
        ["rclone.exe", "mount", "cloud:", "Z:"],
        ["rclone.exe", "mount", "115:", "Z:", "--config=" + config],
    ])
    assert module.discover_mount_relationships(["Z:/Media"]) == []


def test_bad_config_and_traversal_subpath_do_not_create_evidence(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype = webdav\nurl = http://localhost/dav/\n")
    bad = _config(tmp_path, "not an ini config", "bad.conf")
    module = _windows(monkeypatch, [
        ["rclone.exe", "mount", "cloud:../outside", "Z:", "--config", config],
        ["rclone.exe", "mount", "cloud:", "Z:", "--config", bad],
    ])
    assert module.discover_mount_relationships(["Z:/Media"]) == []


def test_local_directory_mount_uses_directory_segment_boundary(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype=webdav\nurl=http://localhost/dav/\n")
    module = _windows(monkeypatch, [["rclone.exe", "mount", "cloud:动画", "Z:/Media", "--config", config]])
    assert module.discover_mount_relationships(["Z:/Media2"]) == []
    result = module.discover_mount_relationships(["Z:/Media/作品"])
    assert result[0]["local_root"] == "Z:\\Media"
    assert result[0]["remote_root"] == "http://localhost/dav/动画"


def test_cli_webdav_url_override_does_not_claim_config_url(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype=webdav\nurl=http://localhost/dav/\n")
    module = _windows(monkeypatch, [[
        "rclone.exe", "mount", "cloud:", "Z:", "--config", config,
        "--webdav-url", "http://other.example/dav/",
    ]])
    assert module.discover_mount_relationships(["Z:/Media"]) == []


def test_encoded_traversal_and_url_controls_are_not_evidence(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype=webdav\nurl=http://localhost/dav/\n")
    module = _windows(monkeypatch, [
        ["rclone.exe", "mount", "cloud:%2e%2e%2foutside", "Z:", "--config", config],
        ["rclone.exe", "mount", "cloud:folder?token=private", "Z:", "--config", config],
    ])
    assert module.discover_mount_relationships(["Z:/Media"]) == []


def test_flags_before_mount_operands_are_parsed_without_exposing_values(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype=webdav\nurl=http://localhost/dav/\n")
    module = _windows(monkeypatch, [[
        "rclone.exe", "mount", "--config", config, "--vfs-cache-mode", "full",
        "--vfs-cache-max-size", "10G", "--dir-cache-time", "1h", "--network-mode",
        "--volname", "cloud:should-not-be-an-operand", "cloud:/动画", "Z:",
    ]])
    result = module.discover_mount_relationships(["Z:/Media"])
    assert result[0]["remote_root"] == "http://localhost/dav/动画"
    assert "should-not" not in json.dumps(result)


def test_global_config_before_command_and_boolean_equals_flags(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype=webdav\nurl=http://localhost/dav/\n")
    module = _windows(monkeypatch, [[
        "rclone.exe", "--config=" + config, "mount", "--network-mode=true", "cloud:", "Z:",
    ]])
    assert len(module.discover_mount_relationships(["Z:/Media"])) == 1


def test_unknown_or_extra_cli_operands_are_not_guessed(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype=webdav\nurl=http://localhost/dav/\n")
    module = _windows(monkeypatch, [
        ["rclone.exe", "mount", "--unknown-option", "value", "cloud:", "Z:", "--config", config],
        ["rclone.exe", "mount", "cloud:", "Z:", "third-operand", "--config", config],
    ])
    assert module.discover_mount_relationships(["Z:/Media"]) == []


def test_config_on_any_requested_mount_is_not_read(monkeypatch):
    module = _windows(monkeypatch, [["rclone.exe", "mount", "cloud:", "Z:", "--config", "Y:/rclone.conf"]])
    monkeypatch.setattr(module, "_webdav_url", lambda *args: 1 / 0)
    assert module.discover_mount_relationships(["Z:/Media", "Y:/Other"]) == []


def test_config_on_unsupported_filesystem_is_not_opened(tmp_path, monkeypatch):
    config = _config(tmp_path, "[cloud]\ntype=webdav\nurl=http://localhost/dav/\n")
    module = _windows(monkeypatch, [["rclone.exe", "mount", "cloud:", "Z:", "--config", config]])
    monkeypatch.setattr(module, "_config_volume_is_local", lambda path: False)
    assert module.discover_mount_relationships(["Z:/Media"]) == []
