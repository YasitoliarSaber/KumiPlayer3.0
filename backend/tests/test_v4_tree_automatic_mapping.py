"""自动目录边界只能由证据或明确确认确定，弱提示不能裁剪真实目录。"""

from pathlib import PureWindowsPath

from app.media_v4.sources.tree_root import TreePlaybackRootResolver

TREE = "|——根目录\n| |-动画\n| | |-甲\n| | | |-e.mkv\n| | |-乙\n| | | |-e.mkv\n"


def resolve(text=TREE, **kwargs):
    return TreePlaybackRootResolver(
        "J:/115open/动画/根目录_目录树.txt", configured_roots=["J:/115open"],
        mapping_mode="auto", **kwargs,
    ).resolve(text)


def test_txt_parent_is_only_a_hint_and_never_duplicates_animation():
    result = resolve()
    assert not result.ok
    assert result.state in {"ambiguous", "unverifiable"}
    assert all("动画\\动画" not in p for c in result.choices for p in c["path_samples"])
    assert any(PureWindowsPath(c["path_samples"][0]) == PureWindowsPath("J:/115open/动画/甲/e.mkv") for c in result.choices)


def test_explicit_two_remote_boundaries_map_subdirectory_mount_without_io():
    result = resolve(mount_remote_root="/动画", export_remote_root="/")
    assert result.ok and result.state == "confirmed"
    assert result.mapping_mode == "mounted_subdir" and result.mapping_scope == "动画"
    assert PureWindowsPath(result.path_samples[0]) == PureWindowsPath("J:/115open/甲/e.mkv")


def test_absolute_export_root_is_distinct_from_mount_root():
    text = "|——/动画\n| |-甲\n| | |-e.mkv\n"
    result = resolve(text, mount_remote_root="/")
    assert result.ok
    assert result.export_scope == "/动画"
    assert PureWindowsPath(result.root) == PureWindowsPath("J:/115open/动画")


def test_same_name_in_nested_real_directories_is_preserved():
    text = "|——根目录\n| |-动画\n| | |-动画\n| | | |-e.mkv\n"
    result = resolve(text, mount_remote_root="/", export_remote_root="/")
    assert result.ok
    assert PureWindowsPath(result.path_samples[0]) == PureWindowsPath("J:/115open/动画/动画/e.mkv")


def test_unique_readonly_evidence_can_support_a_candidate():
    def probe(path):
        return {"status": "file" if "\\动画\\" in str(PureWindowsPath(path)) else "missing"}
    text = TREE.replace("| | | |-e.mkv", "| | | |-e.mkv\n| | | |-e2.mkv")
    result = resolve(text, probe=probe)
    assert result.ok and result.state == "supported"
    assert result.hits == 3
    assert result.mapping_mode == "direct"


def test_two_candidates_with_hits_require_confirmation():
    result = resolve(probe=lambda _path: {"status": "file"})
    assert not result.ok and result.state == "ambiguous"


def test_access_failure_never_counts_as_a_missing_file():
    result = resolve(probe=lambda _path: {"status": "unavailable", "error_kind": "unsupported"})
    assert not result.ok and result.state == "unverifiable"
    assert result.hits == 0


def test_one_missing_file_does_not_reject_a_supported_mapping():
    text = TREE.replace("| | | |-e.mkv", "| | | |-e.mkv\n| | | |-e2.mkv") + "| | |-丙\n| | | |-gone.mkv\n| | | |-gone2.mkv\n"
    def probe(path):
        value = str(PureWindowsPath(path))
        return {"status": "file" if "\\动画\\" in value and "gone.mkv" not in value else "missing"}
    result = resolve(text, probe=probe)
    assert result.ok and result.state == "supported" and result.hits == 2


def test_user_choice_is_bound_to_text_and_current_configuration():
    pending = resolve()
    choice = next(c for c in pending.choices if c["mapping_mode"] == "direct")
    accepted = resolve(choice_id=choice["id"])
    assert accepted.ok and accepted.state == "confirmed"
    changed = resolve(TREE.replace("甲", "丁"), choice_id=choice["id"])
    assert not changed.ok


def test_saved_rule_requires_matching_configuration_and_export_context():
    pending = resolve(config_fingerprint="old")
    choice = next(c for c in pending.choices if c["mapping_mode"] == "direct")
    accepted = resolve(choice_id=choice["id"], config_fingerprint="old")
    reused = resolve(saved_rule=accepted.mapping_rule, config_fingerprint="old")
    assert reused.ok and "保存" in reused.reason
    stale = resolve(saved_rule=accepted.mapping_rule, config_fingerprint="new")
    assert not stale.ok


def test_unknown_export_origin_is_not_silently_confirmed_for_a_single_candidate():
    result = TreePlaybackRootResolver(
        "D:/清单/tree.txt", configured_roots=["Z:/Media"], mapping_mode="auto",
    ).resolve("甲/e.mkv")
    assert not result.ok and result.choices


def test_files_in_one_directory_do_not_count_as_distributed_evidence():
    text = "甲/S1/1.mkv\n甲/S1/2.mkv\n甲/S1/3.mkv\n"
    result = TreePlaybackRootResolver(
        "D:/清单/tree.txt", configured_roots=["Z:/Media"], mapping_mode="auto",
        probe=lambda p: {"status": "file" if "\\甲\\" in str(PureWindowsPath(p)) else "missing"},
    ).resolve(text)
    assert not result.ok


def test_known_export_origin_alone_offers_full_mount_and_subdirectory_mount():
    result = TreePlaybackRootResolver(
        "D:/清单/tree.txt", configured_roots=["Z:/Media"], mapping_mode="auto",
    ).resolve("|——/动画\n| |-甲\n| | |-e.mkv\n")
    assert not result.ok
    assert any(PureWindowsPath(c["path_samples"][0]) == PureWindowsPath("Z:/Media/动画/甲/e.mkv") for c in result.choices)


def test_unc_mount_metadata_is_used_only_in_the_same_namespace():
    result = TreePlaybackRootResolver(
        "D:/清单/tree.txt", configured_roots=["Z:/Media"], mapping_mode="auto",
        mount_relationships=[{"namespace": "unc", "local_root": "Z:/", "remote_root": "//server/share"}],
    ).resolve("├── \\\\server\\share\\Media\\动画\n│   ├── 甲\n│   │   ├── e.mkv\n")
    assert result.ok
    assert PureWindowsPath(result.path_samples[0]) == PureWindowsPath("Z:/Media/动画/甲/e.mkv")


def test_posix_scope_comparison_is_case_sensitive():
    result = resolve(mount_remote_root="/Animation", export_remote_root="/animation")
    assert not result.ok


def test_remote_boundary_allows_trailing_separator_and_non_windows_mount_name():
    result = resolve(mount_remote_root="/云盘:账号/", export_remote_root="/云盘:账号/")
    assert result.ok


def test_unsafe_absolute_header_is_rejected_before_it_can_be_normalized():
    result = resolve("|——/动画/../其他\n| |-甲\n| | |-e.mkv\n")
    assert not result.ok and result.state == "invalid"


def test_nested_mount_boundary_offers_whole_segment_candidates():
    text = TREE.replace("| |-动画\n", "| |-动画\n| | |-TV\n").replace("| | |-甲", "| | | |-甲").replace("| | |-乙", "| | | |-乙").replace("| | | |-e.mkv", "| | | | |-e.mkv")
    result = resolve(text)
    assert any(c["mapping_scope"] == "动画/TV" for c in result.choices)


def test_mount_candidates_cover_later_and_non_common_subdirectories():
    result = resolve("A/e.mkv\nB/e.mkv\nC/e.mkv\nD/e.mkv\nE/e.mkv\n")
    assert any(c["mapping_scope"] == "E" for c in result.choices)
    result = resolve("Animation/A/S1/e.mkv\nAnimation/B/S1/e.mkv\n")
    assert any(c["mapping_scope"] == "Animation/A" for c in result.choices)
    assert any(c["mapping_scope"] == "Animation/B/S1" for c in result.choices)
