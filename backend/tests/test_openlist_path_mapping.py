"""OpenList 显式挂载映射合同；只做词法转换，不访问挂载盘。"""

from pathlib import Path

import pytest

from app.integrations.openlist.providers import (
    OpenListRouteConfig,
    derive_local_path,
    derive_remote_path,
    match_route,
)


@pytest.mark.parametrize(
    ("mount_root", "remote_root", "remote_path", "expected"),
    [
        ("Z:/Media", "/动画", "/动画/作品/e.mkv", "Z:\\Media\\作品\\e.mkv"),
        ("Z:/动画", "/", "/动画/作品/e.mkv", "Z:\\动画\\动画\\作品\\e.mkv"),
        ("Z:/动画", "/动画", "/动画/动画/作品/e.mkv", "Z:\\动画\\动画\\作品\\e.mkv"),
        ("Z:/Media", "/动画", "/动画", "Z:\\Media"),
        ("Z:/", "/动画", "/动画/作品/e.mkv", "Z:\\作品\\e.mkv"),
        ("Z:", "/动画", "/动画/作品/e.mkv", "Z:\\作品\\e.mkv"),
        ("//server/share/Media", "/动画", "/动画/作品/e.mkv", "\\\\server\\share\\Media\\作品\\e.mkv"),
    ],
)
def test_explicit_mapping_round_trip(mount_root, remote_root, remote_path, expected):
    local = derive_local_path(mount_root, remote_root, remote_path)
    assert local == expected
    assert derive_remote_path(mount_root, remote_root, local) == remote_path


def test_inverse_compares_windows_segments_case_insensitively_and_preserves_remote_names():
    assert derive_remote_path("Z:/Media", "/Anime", "z:/mEDIA/SHOW/E.MKV") == "/Anime/SHOW/E.MKV"


@pytest.mark.parametrize("remote_path", ["/Anime2/e.mkv", "/anime/e.mkv"])
def test_forward_mapping_requires_case_sensitive_complete_remote_prefix(remote_path):
    with pytest.raises(ValueError):
        derive_local_path("Z:/Media", "/Anime", remote_path)


@pytest.mark.parametrize("local_path", ["Z:/Media2/e.mkv", "Y:/Media/e.mkv", "Z:/Media/../e.mkv"])
def test_inverse_rejects_paths_outside_local_boundary(local_path):
    assert derive_remote_path("Z:/Media", "/Anime", local_path) is None


@pytest.mark.parametrize("mount_root", ["", "Media", "Z:Media", "Z:/Media/../Other", "\\\\?\\Z:\\Media"])
def test_forward_rejects_invalid_or_nonabsolute_mount_root(mount_root):
    with pytest.raises(ValueError):
        derive_local_path(mount_root, "/Anime", "/Anime/e.mkv")
    assert derive_remote_path(mount_root, "/Anime", "Z:/Media/e.mkv") is None


def test_mapping_does_not_access_source_filesystem(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("mapping must remain lexical")

    with monkeypatch.context() as scoped:
        scoped.setattr(Path, "stat", forbidden)
        scoped.setattr(Path, "resolve", forbidden)
        local = derive_local_path("Z:/Media", "/Anime", "/Anime/e.mkv")
        remote = derive_remote_path("Z:/Media", "/Anime", "Z:/Media/e.mkv")
    assert local == "Z:\\Media\\e.mkv"
    assert remote == "/Anime/e.mkv"


def test_longest_route_remains_segment_bounded():
    parent = OpenListRouteConfig(route_id="parent", remote_prefix="/Anime")
    nested = OpenListRouteConfig(route_id="nested", remote_prefix="/Anime/Shows")
    disabled = OpenListRouteConfig(route_id="disabled", remote_prefix="/Anime/Shows/Work", enabled=False)
    assert match_route([parent, nested, disabled], "/Anime/Shows/Work/e.mkv") is nested
    assert match_route([parent, nested], "/Anime/Shows2/e.mkv") is parent
    assert match_route([parent, nested], "/Anime2/e.mkv") is None
