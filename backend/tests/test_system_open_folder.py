"""Folder actions resolve current V4 local media identities."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.api import system
from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.persistence.database import V4Database
from app.media_v4.revisions.service import V4RevisionService


def _confirmed_asset(database: V4Database, tmp_path, *, movie: bool = False) -> tuple[str, str, Path]:
    playback_file = tmp_path / "mounted-media" / ("Movie.mkv" if movie else "Show.S01E01.mkv")
    playback_file.parent.mkdir()
    playback_file.write_bytes(b"fixture")
    evidence = SourceEvidence(
        evidence_id="evidence-open-folder",
        scan_id="scan-open-folder",
        root_id="root-open-folder",
        source_key=playback_file.name,
        relative_path=playback_file.name,
        entry_kind="video",
        provider="local",
        source_locator=str(playback_file),
        playback_locator=str(playback_file),
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-open-folder",
        evidence_id=evidence.evidence_id,
        parser_version="fixture",
        work_title="Show",
        title_candidates=("Show",),
        media_type="movie" if movie else "tv",
        group_type="movie" if movie else "season",
        season_candidate=None if movie else 1,
        episode_candidate=None if movie else 1,
    )
    revisions = V4RevisionService(database)
    revisions.create_draft("revision-open-folder", [(evidence, facts)])
    revisions.confirm("revision-open-folder")
    with database.connect() as conn:
        row = conn.execute(
            "SELECT work_id, episode_id, asset_id FROM revision_bindings LIMIT 1"
        ).fetchone()
    return str(row["work_id"]), str(row["episode_id"] or ""), playback_file


def test_open_folder_rejects_removed_mirror_option():
    with pytest.raises(ValidationError):
        system.OpenFolderRequest(work_id="work", folder_type="mirror")


def test_open_folder_rejects_arbitrary_path_payload():
    with pytest.raises(ValidationError):
        system.OpenFolderRequest(work_id="work", path="C:/arbitrary")


def test_movie_folder_uses_work_asset_without_episode(tmp_path, monkeypatch):
    database = V4Database(tmp_path / "library.db")
    database.initialize()
    work_id, episode_id, media = _confirmed_asset(database, tmp_path, movie=True)
    assert episode_id == ""
    monkeypatch.setattr(system, "get_database", lambda: database)
    opened = []
    monkeypatch.setattr(system, "_open_folder", opened.append)
    result = system.open_folder(system.OpenFolderRequest(work_id=work_id))
    assert result["opened"] is True
    assert opened == [media.parent]


def test_open_video_folder_keeps_using_asset_playback_directory(tmp_path, monkeypatch):
    database = V4Database(tmp_path / "library.db")
    database.initialize()
    work_id, episode_id, playback_file = _confirmed_asset(database, tmp_path)
    monkeypatch.setattr(system, "get_database", lambda: database)

    result = system.open_folder(system.OpenFolderRequest(
        work_id=work_id,
        episode_id=episode_id,
        folder_type="video",
        open=False,
    ))

    assert result["exists"] is True
    assert result["folder_path"] == str(playback_file.parent)


def test_folder_uses_requested_confirmed_asset_and_rejects_foreign_identity(tmp_path, monkeypatch):
    from fastapi import HTTPException

    database = V4Database(tmp_path / "library.db")
    database.initialize()
    work_id, episode_id, playback_file = _confirmed_asset(database, tmp_path)
    monkeypatch.setattr(system, "get_database", lambda: database)
    with database.connect() as conn:
        asset_id = conn.execute("SELECT asset_id FROM revision_bindings LIMIT 1").fetchone()[0]
    result = system.open_folder(system.OpenFolderRequest(work_id=work_id, episode_id=episode_id, asset_id=asset_id, open=False))
    assert result["source_path"] == str(playback_file)
    with pytest.raises(HTTPException) as error:
        system.open_folder(system.OpenFolderRequest(work_id=work_id, asset_id="foreign", open=False))
    assert error.value.status_code == 404
