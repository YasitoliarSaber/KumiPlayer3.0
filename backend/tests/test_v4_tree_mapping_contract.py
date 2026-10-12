"""TXT 映射基于明确目录边界，不依赖清单保存位置或同名目录猜测。"""

from pathlib import PureWindowsPath

import pytest

from app.media_v4.sources.scanner import (
    DirectoryTreeReadError,
    build_directory_tree_evidence,
    tree_media_relative_paths,
)
from app.media_v4.sources.tree_root import TreePlaybackRootResolver, tree_scan_root_id

TREE = "|——根目录\n| |-动画\n| | |-Show\n| | | |-e.mkv\n| |-电影\n| | |-movie.mkv\n"


@pytest.mark.parametrize("location", [
    "J:/115open/动画/根目录20260821180700_目录树.txt",
    "J:/115open/清单/backup.txt",
    "D:/清单/backup.txt",
])
def test_original_txt_location_never_changes_the_mapping(location):
    resolution = TreePlaybackRootResolver(location, configured_roots=["J:/115open"]).resolve(TREE)
    assert resolution.ok
    assert PureWindowsPath(resolution.root) == PureWindowsPath("J:/115open")
    _, entries = build_directory_tree_evidence(
        TREE, root_id="root", provider="pan115", source_root=resolution.root,
    )
    assert PureWindowsPath(entries[0].playback_locator) == PureWindowsPath("J:/115open/动画/Show/e.mkv")


def test_mounting_only_animation_filters_other_branches_and_keeps_evidence_paths():
    resolution = TreePlaybackRootResolver(
        "D:/清单/tree.txt", configured_roots=["Z:/"],
        mapping_mode="mounted_subdir", mapping_scope="动画",
    ).resolve(TREE)
    assert resolution.ok
    _, entries = build_directory_tree_evidence(
        TREE, root_id="root", provider="pan115", source_root=resolution.root,
        mapping_mode="mounted_subdir", mapping_scope="动画",
    )
    assert [item.relative_path for item in entries] == ["动画/Show/e.mkv"]
    assert PureWindowsPath(entries[0].playback_locator) == PureWindowsPath("Z:/Show/e.mkv")


def test_selected_scope_does_not_deduplicate_real_nested_names():
    text = "|——根目录\n| |-动画\n| | |-动画\n| | | |-e.mkv\n"
    _, entries = build_directory_tree_evidence(
        text, root_id="root", provider="pan115", source_root="Z:/",
        mapping_mode="mounted_subdir", mapping_scope="动画",
    )
    assert PureWindowsPath(entries[0].playback_locator) == PureWindowsPath("Z:/动画/e.mkv")
    _, direct = build_directory_tree_evidence(text, root_id="root", provider="pan115", source_root="Z:/")
    assert PureWindowsPath(direct[0].playback_locator) == PureWindowsPath("Z:/动画/动画/e.mkv")


def test_baidu_export_without_parent_layer_uses_explicit_export_subdirectory():
    text = "├── 刮削好的动画\n│   ├── Show\n│   │   ├── e.mkv\n"
    resolution = TreePlaybackRootResolver(
        "D:/清单/01动画_文件目录.txt", configured_roots=["Q:/百度网盘"],
        mapping_mode="export_subdir", mapping_scope="01动画",
    ).resolve(text)
    assert resolution.ok
    assert PureWindowsPath(resolution.root) == PureWindowsPath("Q:/百度网盘/01动画")
    _, entries = build_directory_tree_evidence(text, root_id="root", provider="baidu", source_root=resolution.root)
    assert PureWindowsPath(entries[0].playback_locator) == PureWindowsPath("Q:/百度网盘/01动画/刮削好的动画/Show/e.mkv")


def test_synthetic_root_is_stripped_once_and_real_root_name_survives():
    text = "|——根目录\n| |-根目录\n| | |-Show\n| | | |-e.mkv\n"
    _, entries = build_directory_tree_evidence(text, root_id="root", provider="pan115", source_root="J:/115open")
    assert entries[0].relative_path == "根目录/Show/e.mkv"


def test_absolute_export_header_is_removed_before_mapping_validation():
    text = "├── Q:\\动画\n│   ├── Show\n│   │   ├── e.mkv\n"
    resolution = TreePlaybackRootResolver("D:/清单/tree.txt", configured_roots=["Z:/"]).resolve(text)
    assert resolution.ok
    assert tree_media_relative_paths(text) == ["Show/e.mkv"]


@pytest.mark.parametrize("mode, scope, expected", [
    ("mounted_subdir", "动画", "Show/e.mkv"),
    ("export_subdir", "01动画", "01动画/动画/Show/e.mkv"),
])
def test_hybrid_relative_paths_match_openlist_scope_while_retaining_txt_key(mode, scope, expected):
    _, entries = build_directory_tree_evidence(
        TREE, root_id="root", provider="pan115", source_root="Z:/",
        mapping_mode=mode, mapping_scope=scope, relative_from_mapping=True,
    )
    assert entries[0].relative_path == expected
    assert entries[0].source_key == "动画/Show/e.mkv"


@pytest.mark.parametrize("scope", ["..", "动画/../电影", "Z:/动画", "/动画", "CON.txt"])
def test_invalid_mapping_scope_is_rejected(scope):
    resolution = TreePlaybackRootResolver(
        "D:/清单/tree.txt", configured_roots=["Z:/"],
        mapping_mode="mounted_subdir", mapping_scope=scope,
    ).resolve(TREE)
    assert not resolution.ok


def test_unmatched_scope_is_not_a_successful_empty_import():
    resolution = TreePlaybackRootResolver(
        "D:/清单/tree.txt", configured_roots=["Z:/"],
        mapping_mode="mounted_subdir", mapping_scope="不存在",
    ).resolve(TREE)
    assert not resolution.ok


@pytest.mark.parametrize("value", ["/Other/e.mkv", "动画\\..\\Other/e.mkv", "NUL.txt/e.mkv"])
def test_every_entry_point_rejects_unsafe_paths_before_normalization(value):
    with pytest.raises(DirectoryTreeReadError):
        build_directory_tree_evidence(value, root_id="root", provider="pan115", source_root="Z:/")


def test_multiple_roots_stay_ambiguous_and_explicit_scope_affects_identity():
    assert not TreePlaybackRootResolver("tree.txt", configured_roots=["Z:/", "Z:/动画"]).resolve(TREE).ok
    ids = []
    for scope in ("动画", "电影"):
        resolution = TreePlaybackRootResolver(
            "tree.txt", configured_roots=["Z:/"], mapping_mode="mounted_subdir", mapping_scope=scope,
        ).resolve(TREE)
        ids.append(tree_scan_root_id(provider="pan115", configured_roots=["Z:/"], resolution=resolution, tree_file="tree.txt"))
    assert ids[0] != ids[1]
