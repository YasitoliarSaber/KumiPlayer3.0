"""原位置 TXT 在整盘、子目录与盘符根挂载下生成相同的媒体相对关系。"""

from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest

from app.api import media_v4
from app.media_v4.sources.scanner import build_directory_tree_evidence, read_directory_tree_text, tree_media_relative_paths

SAMPLES = Path(__file__).resolve().parents[2] / "docs" / "samples"


@pytest.mark.parametrize("provider, filename, folder, count", [
    ("baidu", "01动画_文件目录.txt", "01动画", 908),
    ("pan115", "根目录20260703203700_目录树.txt", "动画", 2472),
])
@pytest.mark.parametrize("prefix", ["Q:/A/B/C", "Q:/B/C", "Q:/C", "Q:/", "//server/share"])
def test_complete_samples_anchor_at_the_selected_txt_parent(provider, filename, folder, count, prefix, monkeypatch):
    text = read_directory_tree_text(SAMPLES / filename)
    parent = PureWindowsPath(prefix) / folder if prefix != "Q:/" else PureWindowsPath(prefix)
    request = media_v4.SourceScanRequest(
        source="tree", provider=provider, tree_file=str(parent / filename),
        # 保存的根可以属于整盘或另一挂载层级，不能覆盖所选 TXT 的实际位置。
        source_root="R:/old-mount",
    )
    config = SimpleNamespace(baidu_root="R:/old-baidu", pan115_root="R:/old-115")
    monkeypatch.setattr(media_v4, "load_config", lambda: config)
    resolution = media_v4._resolve_tree_mapping(
        request, config, media_v4._tree_roots_for_request(request, config, provider), text, provider,
    )
    assert resolution.ok, resolution.reason
    assert PureWindowsPath(resolution.root) == parent
    assert resolution.hits == resolution.total == 0
    _, evidence = build_directory_tree_evidence(
        text, root_id="sample-root", provider=provider, source_root=resolution.root,
        mapping_mode=resolution.mapping_mode, mapping_scope=resolution.mapping_scope,
    )
    original = tree_media_relative_paths(text, provider=provider)
    assert len(evidence) == count
    for item, relative in zip(evidence, original, strict=True):
        below_export = relative.split("/", 1)[1] if provider == "pan115" else relative
        assert PureWindowsPath(item.playback_locator) == parent.joinpath(*below_export.split("/"))
        assert item.relative_path == item.source_key == relative


@pytest.mark.parametrize("provider, text", [
    ("baidu", "├── 动画\n│   ├── 动画\n│   │   ├── e.mkv\n"),
    ("pan115", "|——根目录\n| |-动画\n| | |-动画\n| | | |-e.mkv\n"),
])
def test_real_same_name_directories_survive_root_binding(provider, text):
    request = media_v4.SourceScanRequest(source="tree", provider=provider, tree_file="Q:/动画/tree.txt")
    config = SimpleNamespace()
    result = media_v4._resolve_tree_mapping(request, config, ["Q:/动画"], text, provider)
    assert result.ok, result.reason
    expected = "Q:/动画/动画/动画/e.mkv" if provider == "baidu" else "Q:/动画/动画/e.mkv"
    assert PureWindowsPath(result.path_samples[0]) == PureWindowsPath(expected)


@pytest.mark.parametrize("provider, text", [
    ("baidu", "├── Show\n│   ├── Show.S01E01.mkv\n"),
    ("pan115", "|——根目录\n| |-动画\n| | |-Show\n| | | |-Show.S01E01.mkv\n"),
])
@pytest.mark.parametrize("durable", [False, True])
def test_import_freezes_original_parent_without_configured_mount(tmp_path, monkeypatch, provider, text, durable):
    from app.media_v4.sources.source_scan_runner import SourceScanRunner

    folder = tmp_path / "mount" / "B" / "动画"
    folder.mkdir(parents=True)
    tree = folder / "tree.txt"
    tree.write_text(text, encoding="utf-8")
    config = SimpleNamespace()
    monkeypatch.setattr(media_v4, "load_config", lambda: config)
    database = media_v4.get_database()
    runner = SourceScanRunner(database)
    monkeypatch.setattr(runner, "wake", lambda: None)
    monkeypatch.setattr("app.media_v4.sources.source_scan_runner.get_source_scan_runner", lambda _: runner)
    request = media_v4.SourceScanRequest(source="tree", provider=provider, tree_file=str(tree))
    result = media_v4._start_durable_tree_scan(request) if durable else media_v4.scan_source(request)
    assert result.get("scan_id"), result
    assert PureWindowsPath(result["effective_playback_root"]) == PureWindowsPath(folder)
    if durable:
        # 后台与恢复只消费归档和冻结映射；原 TXT 后续变化不能改写本次输入。
        tree.write_text("changed.txt", encoding="utf-8")
        runner.run_scan(runner.claim_next_scan())
    with database.connect() as conn:
        rows = conn.execute("SELECT playback_locator FROM source_evidence WHERE scan_id=?", (result["scan_id"],)).fetchall()
    assert len(rows) == 1
    assert PureWindowsPath(rows[0]["playback_locator"]) == PureWindowsPath(folder / "Show" / "Show.S01E01.mkv")
    # OpenList 设置变化不影响纯 TXT 映射的确认。
    config.openlist_server_url = "https://irrelevant.invalid"
    config.openlist_mount_root = "R:/irrelevant"
    media_v4._require_tree_validation(database, result["scan_id"], result["root_id"], require=True)


@pytest.mark.parametrize("mount_parts", [("A", "B", "C"), ("B", "C"), ()])
@pytest.mark.parametrize("provider", ["baidu", "pan115"])
def test_scan_preview_confirm_and_playback_store_use_the_real_simulated_mount(tmp_path, monkeypatch, mount_parts, provider):
    from app.media_v4.playback.session import V4PlaybackManager

    parent = tmp_path.joinpath("mount", *mount_parts)
    media = parent / "Show" / "Show.S01E01.mkv"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"fixture-video")
    tree = parent / "tree.txt"
    text = ("├── Show\n│   ├── Show.S01E01.mkv\n" if provider == "baidu"
            else "|——根目录\n| |-动画\n| | |-Show\n| | | |-Show.S01E01.mkv\n")
    tree.write_text(text, encoding="utf-8")
    monkeypatch.setattr(media_v4, "load_config", lambda: SimpleNamespace())
    scan = media_v4.scan_source(media_v4.SourceScanRequest(source="tree", provider=provider, tree_file=str(tree)))
    revision = "rev-anchor"
    media_v4.preview(media_v4.PreviewRequest(
        revision_id=revision, root_id=scan["root_id"], scan_id=scan["scan_id"],
        # 预览客户端提供的旧根不能覆盖后端已保存的定位。
        playback_locator="R:/wrong-root", source_locator="R:/wrong-root",
    ))
    media_v4.confirm(revision)
    database = media_v4.get_database()
    with database.connect() as conn:
        asset = conn.execute("SELECT work_id, episode_id, asset_id FROM revision_bindings LIMIT 1").fetchone()
    assert asset is not None
    manager = V4PlaybackManager(database, session_dir=tmp_path / "sessions")
    playable = manager._resolve_asset(asset["work_id"], asset["episode_id"], asset["asset_id"])
    assert PureWindowsPath(playable["playback_locator"]) == PureWindowsPath(media)
    assert Path(playable["playback_locator"]).is_file()


def test_115_multiple_export_folders_are_rejected_without_silently_dropping_a_branch():
    from app.media_v4.sources.tree_root import resolve_txt_location

    result = resolve_txt_location("Q:/tree.txt", "|——根目录\n| |-A\n| | |-a.mkv\n| |-B\n| | |-b.mkv\n", provider="pan115")
    assert not result.ok and result.state == "invalid"


@pytest.mark.parametrize("provider, body", [
    ("baidu", "└── D:\\挂载\\番剧\n    └── Show\n        └── Show.S01E01.mkv\n"),
])
def test_absolute_body_root_wins_over_the_txt_own_location(tmp_path, provider, body):
    """正文自带本地绝对导出根时，用正文声明的原点，不跟随 TXT 当前所在位置。"""
    from app.media_v4.sources.tree_root import resolve_txt_location

    # TXT 被复制到与正文无关的目录（例如用户另存到其他地方）
    copied = tmp_path / "Downloads" / "copied.txt"
    copied.parent.mkdir(parents=True, exist_ok=True)
    copied.write_text(body, encoding="utf-8")

    result = resolve_txt_location(copied, body, provider=provider)

    assert result.ok, result.reason
    assert PureWindowsPath(result.root) == PureWindowsPath("D:/挂载/番剧")
    assert result.mapping_rule.get("anchor_origin") == "tree_absolute_root"
    assert PureWindowsPath(result.path_samples[0]) == PureWindowsPath("D:/挂载/番剧/Show/Show.S01E01.mkv")


@pytest.mark.parametrize("provider, body", [
    ("baidu", "├── Show\n│   └── Show.S01E01.mkv\n"),
    ("pan115", "|——根目录\n| |-动画\n| | |-Show\n| | | |-Show.S01E01.mkv\n"),
])
def test_relative_body_still_anchors_at_the_txt_parent(tmp_path, provider, body):
    """正文没有绝对根时仍以 TXT 父目录为锚点（两份真实样本的规则）。"""
    from app.media_v4.sources.tree_root import resolve_txt_location

    folder = tmp_path / "挂载" / "B" / "动画"
    folder.mkdir(parents=True)
    tree = folder / "tree.txt"
    tree.write_text(body, encoding="utf-8")

    result = resolve_txt_location(tree, body, provider=provider)

    assert result.ok, result.reason
    assert PureWindowsPath(result.root) == PureWindowsPath(folder)
    assert result.mapping_rule.get("anchor_origin") == "txt_parent"
    assert PureWindowsPath(result.path_samples[0]) == PureWindowsPath(folder / "Show" / "Show.S01E01.mkv")
