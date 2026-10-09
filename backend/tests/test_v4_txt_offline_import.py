"""TXT 离线导入合同：词法证据写入 SQLite，绝不读取来源媒体。"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence
from app.media_v4.sources.scanner import build_directory_tree_evidence


def _tree_evidence(relative: str, *, provider: str = "baidu", source_root: str = ""):
    return to_source_evidence(SourceEntry(
        root_id="root-txt", scan_id="scan-txt", provider=provider,
        ingest_method="directory_tree", relative_path=relative, source_key=relative,
        source_locator=f"{source_root}\\{relative}" if source_root else relative,
        playback_locator=f"{source_root}\\{relative}" if source_root else relative,
    ))


def _tree_evidence_with(relative: str, locator: str):
    evidence = _tree_evidence(relative, source_root=r"Q:\offline-library")
    return replace(
        evidence,
        evidence_id="ev_" + relative.replace("/", "_").replace(" ", ""),
        relative_path=relative,
        source_key=relative,
        source_locator=locator,
        playback_locator=locator,
    )


def _facts_for(relative: str, *, group_type: str = "season", season: int = 1,
               episode: int | None = 1, special: int | None = None):
    from app.media_v4.domain.models import ParsedFacts

    return ParsedFacts(
        parsed_fact_id="facts_" + relative.replace("/", "_").replace(" ", ""),
        evidence_id="ev_" + relative.replace("/", "_").replace(" ", ""),
        parser_version="fixture",
        work_title="离线测试作品",
        title_candidates=("离线测试作品",),
        media_type="tv",
        group_type=group_type,
        season_candidate=season,
        episode_candidate=episode,
        special_candidate=special is not None,
        special_number=special,
        confidence="high",
    )


def _confirm_tree_revision(database, revision_id: str, pairs: list):
    from app.media_v4.revisions.service import V4RevisionService

    revisions = V4RevisionService(database)
    revisions.create_draft(revision_id, pairs, source_mode="tree_snapshot")
    revisions.confirm(revision_id)
    return revisions


def test_txt_nfo_never_reaches_source_disk_or_identity():
    text = "Show/Season 1/Show.S01E01.mkv\nShow/tvshow.nfo\n"
    with patch("app.media_v4.parsing.parser.Path.is_file",
               side_effect=AssertionError("TXT must not probe source files")):
        _, entries = build_directory_tree_evidence(
            text, root_id="offline-root", provider="baidu", source_root=r"Q:\offline-library",
        )
        assert len(entries) == 1
        assert entries[0].entry_kind == "video"
        from app.media_v4.parsing.parser import V4Parser

        assert V4Parser().parse(entries[0]).is_importable


def test_legacy_txt_metadata_evidence_does_not_read_nfo():
    from app.media_v4.parsing.parser import V4Parser

    video = _tree_evidence("Show/Season 1/Show.S01E01.mkv", source_root=r"Q:\offline-library")
    metadata = replace(
        video, evidence_id="ev_legacy_nfo", relative_path="Show/tvshow.nfo",
        source_key="Show/tvshow.nfo", source_locator=r"Q:\offline-library\Show\tvshow.nfo",
        playback_locator=r"Q:\offline-library\Show\tvshow.nfo", entry_kind="metadata",
    )
    with patch("app.media_v4.parsing.parser._parse_sidecar_nfo",
               side_effect=AssertionError("TXT NFO must not be read")):
        facts = V4Parser().parse(metadata)
    assert facts.resource_type == "metadata"
    assert facts.is_importable is False and facts.is_auxiliary is True
    assert facts.title_candidates == () and facts.work_title == ""
    assert facts.original_title == "" and facts.tmdb_hint_id is None
    assert facts.tmdb_hint_type == ""


def test_tree_nfo_filtered_in_both_branches():
    tree_text = (
        "Show/\n├── Season 1/\n│   ├── Show.S01E01.mkv\n"
        "│   └── Show.S01E02.mkv\n└── tvshow.nfo\n"
    )
    flat_text = "Show/Season 1/Show.S01E01.mkv\nShow/tvshow.nfo\n"
    for text in (tree_text, flat_text):
        _, entries = build_directory_tree_evidence(text, root_id="offline-root", provider="baidu")
        assert entries
        assert all(entry.entry_kind == "video" for entry in entries)
        assert all(".nfo" not in entry.relative_path.casefold() for entry in entries)


def test_txt_confirm_persists_locator_without_source_access(tmp_path, monkeypatch):
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / "txt-snapshot.db")
    database.initialize()
    locator = r"Q:\offline-library\Show\Season 1\Show.S01E01.mkv"
    pairs = [(_tree_evidence_with("Show/Season 1/Show.S01E01.mkv", locator),
              _facts_for("Show/Season 1/Show.S01E01.mkv"))]

    original_is_file = Path.is_file
    original_open = Path.open

    def guarded_is_file(self, *args, **kwargs):
        if str(self).casefold().startswith(r"Q:\offline-library".casefold()):
            raise AssertionError("TXT confirmation must not probe source media")
        return original_is_file(self, *args, **kwargs)

    def guarded_open(self, *args, **kwargs):
        if str(self).casefold().startswith(r"Q:\offline-library".casefold()):
            raise AssertionError("TXT confirmation must not read source media")
        return original_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "is_file", guarded_is_file)
    monkeypatch.setattr(Path, "open", guarded_open)
    revisions = _confirm_tree_revision(database, "rev-txt-snapshot", pairs)

    with database.connect() as conn:
        fact = conn.execute(
            "SELECT se.playback_locator,a.playback_locator AS asset_locator "
            "FROM revision_bindings rb JOIN source_evidence se ON se.evidence_id=rb.evidence_id "
            "JOIN assets a ON a.asset_id=rb.asset_id WHERE rb.revision_id='rev-txt-snapshot'"
        ).fetchone()
        job_types = {row[0] for row in conn.execute(
            "SELECT job_type FROM jobs WHERE revision_id='rev-txt-snapshot'"
        )}
        artifacts = conn.execute(
            "SELECT COUNT(*) FROM artifacts WHERE revision_id='rev-txt-snapshot'"
        ).fetchone()[0]
    assert revisions.get_execution_progress("rev-txt-snapshot")["revision_status"] == "confirmed"
    assert fact["playback_locator"] == fact["asset_locator"] == locator
    assert job_types == {"scrape_work", "refresh_projection"}
    assert artifacts == 0


def test_txt_chinese_locator_and_special_exclusion_are_persisted_as_facts(tmp_path, monkeypatch):
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / "txt-special.db")
    database.initialize()
    regular = "摇曳露营/Season 1/摇曳露营 S01E01.mkv"
    locator = r"Q:\offline-library\摇曳露营\Season 1\摇曳露营 S01E01.mkv"
    special = "摇曳露营/Specials/SP01.mkv"
    pairs = [
        (_tree_evidence_with(regular, locator), _facts_for(regular)),
        (_tree_evidence_with(special, r"Q:\offline-library\摇曳露营\Specials\SP01.mkv"),
         _facts_for(special, group_type="special", season=0, episode=None, special=1)),
    ]
    original_is_file = Path.is_file

    def guarded_is_file(self, *args, **kwargs):
        if str(self).casefold().startswith(r"Q:\offline-library".casefold()):
            raise AssertionError("TXT confirmation must not probe source media")
        return original_is_file(self, *args, **kwargs)

    monkeypatch.setattr(Path, "is_file", guarded_is_file)
    _confirm_tree_revision(database, "rev-txt-special", pairs)
    with database.connect() as conn:
        bindings = conn.execute(
            "SELECT se.relative_path,se.playback_locator,e.episode_kind,s.season_kind "
            "FROM revision_bindings rb JOIN source_evidence se ON se.evidence_id=rb.evidence_id "
            "LEFT JOIN episodes e ON e.episode_id=rb.episode_id "
            "LEFT JOIN seasons s ON s.season_id=rb.season_id WHERE rb.revision_id='rev-txt-special'"
        ).fetchall()
        evidence = conn.execute(
            "SELECT relative_path FROM source_evidence WHERE scan_id='scan-txt' ORDER BY relative_path"
        ).fetchall()
    assert len(bindings) == 1
    assert bindings[0]["relative_path"] == regular
    assert bindings[0]["playback_locator"] == locator
    assert bindings[0]["episode_kind"] == bindings[0]["season_kind"] == "regular"
    assert {row[0] for row in evidence} == {regular, special}


def test_newline_locator_is_rejected_before_confirmed_rows_are_written(tmp_path):
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "txt-invalid-locator.db")
    database.initialize()
    relative = "Show/Season 1/E02.mkv"
    evidence = _tree_evidence_with(relative, r"Q:\offline-library\E02.mkv" + "\n" + r"C:\evil.mkv")
    service = V4RevisionService(database)
    service.create_draft("rev-txt-invalid", [(evidence, _facts_for(relative, episode=2))],
                         source_mode="tree_snapshot")
    with pytest.raises(ValueError, match="控制字符"):
        service.confirm("rev-txt-invalid")
    with database.connect() as conn:
        assert conn.execute("SELECT status FROM import_revisions WHERE revision_id='rev-txt-invalid'").fetchone()[0] == "draft"
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE revision_id='rev-txt-invalid'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM revision_bindings WHERE revision_id='rev-txt-invalid'").fetchone()[0] == 0


def test_confirmation_does_not_modify_a_source_fixture(tmp_path):
    from app.media_v4.persistence.database import V4Database

    source = tmp_path / "source" / "Show.S01E01.mkv"
    source.parent.mkdir()
    source.write_bytes(b"original media bytes")
    relative = "Show/Season 1/Show.S01E01.mkv"
    evidence = _tree_evidence_with(relative, str(source))
    database = V4Database(tmp_path / "source-preserved.db")
    database.initialize()
    _confirm_tree_revision(database, "rev-source-preserved", [(evidence, _facts_for(relative))])
    assert source.read_bytes() == b"original media bytes"


def test_txt_offline_scan_preview_confirm_persists_final_locators(tmp_path, monkeypatch):
    """TXT 全链路离线：扫描、preview、confirm 只写 SQLite final locators。"""

    import time
    from types import SimpleNamespace

    from app.api import media_v4
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.sources.durable_scan import get_durable_scan
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    database = V4Database(tmp_path / "txt-e2e.db")
    database.initialize()
    monkeypatch.setattr(media_v4, "_database", database)
    source_root = r"Q:\百度网盘"
    tree = tmp_path / "01动画_文件目录.txt"
    tree.write_text(
        "Show/Season 1/Show.S01E01.mkv\nShow/Season 1/Show.S01E02.mkv\n"
        "Show/tvshow.nfo\nShow/OP1.mkv\nShow/Specials/Show.SP01.mkv\nMovie/Movie.mkv\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(media_v4, "load_config", lambda: SimpleNamespace(
        pan115_root="", baidu_root=source_root, openlist_mount_root="",
        openlist_remote_root="/", openlist_routes=[],
    ))
    from tests.source_disk_guard import guard_source_disk_io
    guard_source_disk_io(monkeypatch, [source_root])

    application = FastAPI()
    application.include_router(media_v4.router)
    client = TestClient(application)
    scan = client.post("/api/v4/sources/scans", json={
        "source": "tree", "tree_file": str(tree), "provider": "baidu", "revision_id": "rev-txt-e2e",
    })
    assert scan.status_code == 200, scan.text
    scan_id, root_id = scan.json()["scan_id"], scan.json()["root_id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        state = get_durable_scan(database, scan_id, include_entries=False)
        if state["status"] in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.05)
    state = get_durable_scan(database, scan_id, include_entries=False)
    assert state["status"] == "completed", state
    assert state["evidence_count"] == state["total_count"] == 5

    preview = client.post("/api/v4/imports/preview", json={
        "revision_id": "rev-txt-e2e", "root_id": root_id, "scan_id": scan_id, "entries": [],
    })
    assert preview.status_code == 200, preview.text
    assert preview.json()["status"] == "draft"
    assert preview.json()["works"]
    from app.media_v4.sources.scan_validation import load_tree_scan_validation
    validation = load_tree_scan_validation(database, scan_id)
    assert validation and validation["ok"] is True
    assert validation["hits"] == validation["total"] == 0
    assert validation["effective_root"].casefold().startswith(source_root.casefold())

    confirmed = client.post("/api/v4/imports/rev-txt-e2e/confirm")
    assert confirmed.status_code == 200, confirmed.text
    job_types = {item["job_type"] for item in confirmed.json()["jobs"]}
    assert job_types <= {"scrape_work", "refresh_projection"}
    assert "scrape_work" in job_types
    with database.connect() as conn:
        revision = conn.execute(
            "SELECT status FROM import_revisions WHERE revision_id='rev-txt-e2e'"
        ).fetchone()[0]
        locators = {row[0] for row in conn.execute(
            "SELECT se.playback_locator FROM revision_bindings rb "
            "JOIN source_evidence se ON se.evidence_id=rb.evidence_id "
            "WHERE rb.revision_id='rev-txt-e2e' AND rb.episode_id IS NOT NULL"
        )}
        artifact_count = conn.execute(
            "SELECT COUNT(*) FROM artifacts WHERE revision_id='rev-txt-e2e'"
        ).fetchone()[0]
    assert revision == "confirmed"
    assert locators == {
        rf"{source_root}\01动画\Show\Season 1\Show.S01E01.mkv",
        rf"{source_root}\01动画\Show\Season 1\Show.S01E02.mkv",
    }
    assert artifact_count == 0
