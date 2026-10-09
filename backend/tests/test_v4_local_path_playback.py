"""播放只消费当前确认观察中的本地路径，不需要镜像或源盘全量检查。"""

import json
from types import SimpleNamespace

import pytest

from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.path_validation import validate_playback_locator_syntax
from app.media_v4.persistence.database import V4Database
from app.media_v4.playback import session as session_module
from app.media_v4.playback.session import V4PlaybackManager, _resolve_event_playlist_position
from app.media_v4.playback.store import V4PlaybackStore
from app.media_v4.revisions.service import V4RevisionService


def _confirmed_media(tmp_path, *, playback=None, source=None):
    media = tmp_path / "Show.S01E01.mkv"
    media.write_bytes(b"fixture")
    evidence = SourceEvidence(
        evidence_id="local-play", scan_id="scan-local-play", root_id="root-local-play",
        source_key=media.name, relative_path=media.name, entry_kind="video", provider="local",
        source_locator=str(media) if source is None else source,
        playback_locator=str(media) if playback is None else playback,
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-local-play", evidence_id=evidence.evidence_id, parser_version="fixture",
        work_title="Show", title_candidates=("Show",), media_type="tv", group_type="season",
        season_candidate=1, episode_candidate=1,
    )
    database = V4Database(tmp_path / "local-play.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-local-play", [(evidence, facts)])
    revisions.confirm("rev-local-play")
    with database.connect() as conn:
        binding = dict(conn.execute("SELECT work_id,episode_id,asset_id FROM revision_bindings LIMIT 1").fetchone())
    return database, media, binding


def test_direct_playback_does_not_create_strm_and_retains_resume_identity(tmp_path, monkeypatch):
    database, media, binding = _confirmed_media(tmp_path)
    store = V4PlaybackStore(database)
    store.save_progress(**binding, position=42, duration=600, completed=False)
    calls = []
    monkeypatch.setattr(session_module, "start_mpv", lambda path, **kwargs: calls.append((path, kwargs)) or SimpleNamespace(pid=123))
    monkeypatch.setattr(V4PlaybackManager, "_monitor", lambda *_args: None)
    manager = V4PlaybackManager(database, session_dir=tmp_path / "sessions")

    result = manager.play(**binding)

    assert calls[0][0] == str(media)
    assert calls[0][1]["playlist_paths"] == [str(media)]
    assert calls[0][1]["start_position"] == 42
    assert result["asset_id"] == binding["asset_id"]
    assert result["playback_locator"] == str(media)
    assert not (tmp_path / "sessions").exists()
    assert store.get_progress(binding["episode_id"], binding["asset_id"])["position"] == 42


@pytest.mark.parametrize("locator", ["", "https://media.invalid/video.mkv", "file:///C:/video.mkv"])
def test_invalid_saved_playback_never_falls_back_or_stops_active_session(tmp_path, monkeypatch, locator):
    database, _media, binding = _confirmed_media(tmp_path, playback=locator)
    manager = V4PlaybackManager(database, session_dir=tmp_path / "sessions")
    actions = []
    monkeypatch.setattr(manager, "stop", lambda: actions.append("stop"))
    monkeypatch.setattr(session_module, "start_mpv", lambda *_args, **_kwargs: actions.append("launch") or SimpleNamespace(pid=123))
    monkeypatch.setattr(V4PlaybackManager, "_monitor", lambda *_args: None)

    with pytest.raises(ValueError):
        manager.play(**binding)

    assert actions == []
    assert not (tmp_path / "sessions").exists()


@pytest.mark.parametrize("locator", [
    "https://media.invalid/video.mkv", "ftp://media.invalid/video.mkv", "file:///C:/video.mkv",
    r"C:\library\..\video.mkv", r"C:\library\.\video.mkv", r"C:\library\CON.mkv",
    r"C:\library\video.mkv:stream", r"\\.\PhysicalDrive0", r"\\?\C:\video.mkv",
    r"C:\library\video.strm", r"C:\library\playlist.m3u8",
    r"C:\library\video.strm.", r"C:\library\playlist.m3u8. ",
    "C:/library/video.mkv\n", " C:/library/video.mkv", "C:/library/video.mkv ",
])
def test_import_path_syntax_rejects_urls_escape_devices_and_streams(locator):
    ok, reason = validate_playback_locator_syntax(locator)
    assert not ok
    assert reason
    assert locator not in reason


@pytest.mark.parametrize("locator", [r"C:\Mounted Media\Show.mkv", r"\\server\share\Show.mkv"])
def test_local_and_mounted_unc_paths_are_accepted_without_io(locator):
    assert validate_playback_locator_syntax(locator) == (True, "")


def test_playlist_does_not_probe_future_media_files(tmp_path, monkeypatch):
    from backend.tests.test_v4_playback_recovery import _confirmed_three_episode_work

    database = _confirmed_three_episode_work(tmp_path)
    monkeypatch.setattr(session_module, "load_config", lambda: SimpleNamespace(auto_play_next_episode=True))
    manager = V4PlaybackManager(database, session_dir=tmp_path / "sessions")
    with database.connect() as conn:
        first = dict(conn.execute(
            "SELECT rb.work_id,rb.episode_id,rb.asset_id FROM revision_bindings rb "
            "JOIN episodes e ON e.episode_id=rb.episode_id ORDER BY e.local_episode_number LIMIT 1"
        ).fetchone())
    current = manager._resolve_asset(**first)
    monkeypatch.setattr(session_module, "validate_playback_locator", lambda _path: pytest.fail("playlist probed source disk"))

    playlist = manager._build_playlist(first["work_id"], current)

    assert [item["local_episode_number"] for item in playlist] == [1, 2, 3]


def test_remote_source_alias_cannot_claim_a_playback_progress_event(tmp_path):
    local = str(tmp_path / "video.mkv")
    remote = "https://media.invalid/video.mkv"
    playlist = [{"playback_locator": local, "source_locator": remote}]
    assert _resolve_event_playlist_position(SimpleNamespace(media_path=remote, playlist_position=0), playlist) is None
    assert _resolve_event_playlist_position(SimpleNamespace(media_path=local, playlist_position=0), playlist) == 0


def test_player_entry_rejects_remote_playlist_without_launching_process(tmp_path, monkeypatch):
    from app.playback import mpv

    media = tmp_path / "video.mkv"
    media.write_bytes(b"fixture")
    monkeypatch.setattr(mpv.subprocess, "Popen", lambda *_args, **_kwargs: pytest.fail("invalid playlist launched mpv"))
    with pytest.raises(ValueError):
        mpv.start_mpv(str(media), mpv_path=str(tmp_path / "mpv.exe"),
                      playlist_paths=[str(media), "https://media.invalid/next.mkv"])


@pytest.mark.parametrize("invalidation", ["work_identity", "episode_signature", "retired_source"])
def test_playback_titles_read_snapshot_without_nfo_or_artwork_checks(tmp_path, monkeypatch, invalidation):
    from app.media_v4.persistence import metadata_lifecycle

    database, _media, binding = _confirmed_media(tmp_path)
    with database.connect() as conn:
        metadata_lifecycle.publish_snapshot(
            conn, revision_id="rev-local-play", work_id=binding["work_id"], snapshot_id="title-snapshot",
            metadata={"provider": "tmdb", "provider_id": "123", "media_type": "tv",
                      "title": "Snapshot title", "metadata_state": "ready",
                      "episode_mappings": [{"episode_id": binding["episode_id"], "title": "Episode title",
                                            "provider_episode_id": "456"}]}, artifact_ids=[],
        )
        conn.execute(
            "INSERT INTO scrape_bindings(binding_id,revision_id,work_id,provider,provider_id,metadata_json,"
            "status,created_at,updated_at) VALUES ('title-binding','rev-local-play',?,'tmdb','123',?,'confirmed','now','now')",
            (binding["work_id"], json.dumps({"metadata_snapshot_id": "title-snapshot", "title": "Snapshot title",
                                           "episode_mappings": [{"episode_id": binding["episode_id"], "title": "Episode title"}]})),
        )
        conn.commit()
    monkeypatch.setattr(metadata_lifecycle, "snapshot_requirements_valid",
                        lambda *_args: pytest.fail("playback checked metadata artifacts"))
    monkeypatch.setattr("app.media_v4.jobs.metadata_quality.current_episode_metadata",
                        lambda *_args: pytest.fail("playback checked episode artwork"))
    manager = V4PlaybackManager(database)

    asset = manager._resolve_asset(**binding)

    assert asset["preferred_title"] == "Snapshot title"
    assert asset["scraped_display_title"] == "Episode title"

    with database.connect() as conn:
        if invalidation == "work_identity":
            conn.execute("UPDATE works SET year=2026 WHERE work_id=?", (binding["work_id"],))
        elif invalidation == "episode_signature":
            conn.execute("UPDATE episodes SET local_episode_number=2 WHERE episode_id=?", (binding["episode_id"],))
        else:
            conn.execute("UPDATE source_roots SET retired_at='now'")
        conn.commit()
        expected = "Snapshot title" if invalidation == "episode_signature" else "Show"
        assert manager._playback_work_title(conn, binding["work_id"], "Show") == expected
        assert manager._playback_episode_title(conn, binding["work_id"], binding["episode_id"]) == ""
