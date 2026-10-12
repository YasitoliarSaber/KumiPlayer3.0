"""TXT import honors the selected mount without changing saved configuration."""

from types import SimpleNamespace

import pytest
from app.api import media_v4
from app.media_v4.persistence.database import V4Database
from fastapi import HTTPException


@pytest.mark.parametrize("durable", [False, True])
def test_selected_tree_mount_overrides_saved_root(tmp_path, monkeypatch, durable):
    database = V4Database(tmp_path / "api.db")
    database.initialize()
    monkeypatch.setattr(media_v4, "_database", database)
    monkeypatch.setattr(media_v4, "load_config", lambda: SimpleNamespace(
        baidu_root=str(tmp_path / "saved"), openlist_mount_root="",
    ))
    from app.media_v4.sources import source_scan_runner

    monkeypatch.setattr(source_scan_runner, "get_source_scan_runner", lambda db: SimpleNamespace(wake=lambda: None))
    tree = tmp_path / "tree.txt"
    selected = tmp_path / "selected"
    tree.write_text(f"|——{selected}\nShow/Show.S01E01.mkv\n", encoding="utf-8")
    request = media_v4.SourceScanRequest(
        source="tree", provider="baidu", tree_file=str(tree), source_root=str(selected),
    )

    result = media_v4._start_durable_tree_scan(request) if durable else media_v4.scan_source(request)

    assert result["effective_playback_root"] == str(selected)
    if not durable:
        assert result["entries"][0]["playback_locator"] == str(selected / "Show" / "Show.S01E01.mkv")


@pytest.mark.parametrize("durable", [False, True])
@pytest.mark.parametrize("root", ["relative/mount", "https://media.invalid/root", "C:\\mount\\..\\other"])
def test_selected_tree_mount_must_be_a_local_absolute_root(tmp_path, monkeypatch, durable, root):
    monkeypatch.setattr(media_v4, "load_config", lambda: SimpleNamespace(
        baidu_root=str(tmp_path / "saved"), openlist_mount_root="",
    ))
    tree = tmp_path / "tree.txt"
    tree.write_text("Show/Show.S01E01.mkv\n", encoding="utf-8")
    request = media_v4.SourceScanRequest(
        source="tree", provider="baidu", tree_file=str(tree), source_root=root,
    )

    with pytest.raises(HTTPException) as error:
        if durable:
            media_v4._start_durable_tree_scan(request)
        else:
            media_v4.scan_source(request)
    assert error.value.status_code == 400


def test_configured_drive_mount_keeps_absolute_anchor():
    roots = media_v4._configured_tree_roots(SimpleNamespace(
        baidu_root="K:\\", openlist_mount_root="",
    ), "baidu")

    assert roots == ["K:\\"]
