from __future__ import annotations

import sqlite3

from app.media_v4.customization.work_tags import classify_saved_video, get_extra_video_overview


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE works(work_id TEXT PRIMARY KEY, preferred_title TEXT, original_title TEXT);
        CREATE TABLE work_aliases(work_id TEXT, normalized_title TEXT);
        CREATE TABLE source_roots(root_id TEXT PRIMARY KEY, retired_at TEXT);
        CREATE TABLE import_revisions(revision_id TEXT PRIMARY KEY, root_id TEXT, status TEXT, confirmed_at TEXT);
        CREATE TABLE seasons(season_id TEXT PRIMARY KEY, work_id TEXT, local_season_number INTEGER);
        CREATE TABLE episodes(
            episode_id TEXT PRIMARY KEY, work_id TEXT, season_id TEXT,
            local_episode_number INTEGER, episode_kind TEXT
        );
        CREATE TABLE assets(asset_id TEXT PRIMARY KEY, availability_state TEXT);
        CREATE TABLE source_evidence(
            evidence_id TEXT PRIMARY KEY, root_id TEXT, relative_path TEXT, fingerprint TEXT,
            presence_state TEXT, entry_kind TEXT
        );
        CREATE TABLE revision_bindings(
            revision_id TEXT, evidence_id TEXT, work_id TEXT, episode_id TEXT, asset_id TEXT
        );
        CREATE TABLE revision_evidence(revision_id TEXT, evidence_id TEXT, parsed_fact_id TEXT);
        CREATE TABLE parsed_facts(
            parsed_fact_id TEXT PRIMARY KEY, resource_type TEXT, content_class TEXT,
            classification_state TEXT, is_importable INTEGER, is_auxiliary INTEGER,
            special_candidate INTEGER, special_number INTEGER, season_candidate INTEGER,
            season_token_raw TEXT, episode_token_raw TEXT, episode_candidate INTEGER,
            episode_title TEXT, work_title TEXT, reasons_json TEXT
        );
        """
    )
    conn.execute("INSERT INTO works VALUES ('w1', 'Example Show', '')")
    conn.execute("INSERT INTO source_roots VALUES ('r1', '')")
    conn.execute("INSERT INTO import_revisions VALUES ('rev1', 'r1', 'confirmed', '2026-10-14T10:00:00Z')")
    conn.execute("INSERT INTO seasons VALUES ('s1', 'w1', 1)")
    conn.execute("INSERT INTO episodes VALUES ('ep1', 'w1', 's1', 1, 'regular')")
    conn.execute("INSERT INTO assets VALUES ('a1', 'available')")
    conn.execute("INSERT INTO source_evidence VALUES ('regular', 'r1', 'Example Show/S01/E01.mkv', 'regular-fp', 'present', 'video')")
    conn.execute("INSERT INTO revision_bindings VALUES ('rev1', 'regular', 'w1', 'ep1', 'a1')")
    return conn


def _add_fact(
    conn: sqlite3.Connection,
    evidence_id: str,
    relative_path: str,
    *,
    work_title: str = "Example Show",
    content_class: str = "unknown",
    is_importable: int = 0,
    is_auxiliary: int = 0,
    special_candidate: int = 0,
    special_number: int | None = None,
    season_candidate: int | None = None,
    season_token_raw: str = "",
    episode_token_raw: str = "",
    episode_candidate: int | None = None,
    episode_title: str = "",
    fingerprint: str = "",
) -> None:
    conn.execute(
        "INSERT INTO source_evidence VALUES (?, 'r1', ?, ?, 'present', 'video')",
        (evidence_id, relative_path, fingerprint),
    )
    fact_id = f"pf-{evidence_id}"
    conn.execute(
        """INSERT INTO parsed_facts VALUES (?, 'video', ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')""",
        (fact_id, content_class, is_importable, is_auxiliary, special_candidate,
         special_number, season_candidate, season_token_raw, episode_token_raw,
         episode_candidate, episode_title, work_title),
    )
    conn.execute("INSERT INTO revision_evidence VALUES ('rev1', ?, ?)", (evidence_id, fact_id))


def test_sp_folder_does_not_turn_pv_or_cm_into_substantive_specials() -> None:
    conn = _db()
    _add_fact(conn, "special", "Example Show/SPs/Example Show - SP 01.mkv",
              content_class="attached_special", special_candidate=1,
              special_number=1, season_token_raw="SP", episode_token_raw="1")
    _add_fact(conn, "pv", "Example Show/SPs/Example Show - PV.mkv",
              content_class="auxiliary", is_auxiliary=1)
    _add_fact(conn, "cm", "Example Show/SPs/Example Show - CM.mkv",
              content_class="auxiliary", is_auxiliary=1)

    result = get_extra_video_overview(conn, "w1")

    assert result is not None
    assert result["substantive_special_count"] == 1
    assert result["auxiliary_count"] == 2
    assert result["unmatched_count"] == 0


def test_extra_video_overview_uses_exact_saved_title_and_collapses_duplicate_episodes() -> None:
    conn = _db()
    _add_fact(conn, "special-a", "Example Show/SPs/Example Show SP 01.mkv",
              content_class="attached_special", special_number=1,
              season_token_raw="SP", episode_token_raw="1", fingerprint="sp-720p")
    _add_fact(conn, "special-b", "Example Show/Bonus/Example Show SP 01 1080p.mkv",
              content_class="attached_special", special_number=1,
              season_token_raw="SP", episode_token_raw="1", fingerprint="sp-1080p")
    _add_fact(conn, "unmatched", "Example Show/Season 2/Example Show S02E01.mkv",
              is_importable=1, season_token_raw="S02", episode_token_raw="E01",
              episode_candidate=1)
    _add_fact(conn, "other-work", "Other Show/SPs/Other Show SP 01.mkv",
              work_title="Other Show", content_class="attached_special", special_number=1)
    _add_fact(conn, "root-video", "Root Video.mkv", content_class="attached_special", special_number=2)

    result = get_extra_video_overview(conn, "w1")

    assert result is not None
    assert result["substantive_special_count"] == 1
    assert result["unmatched_count"] == 1
    assert "已省略根目录直放视频：不足以确认属于该作品" in result["reasons"]


def test_classification_prefers_explicit_auxiliary_facts_over_special_folder_names() -> None:
    category, reason = classify_saved_video(
        {"content_class": "auxiliary", "is_auxiliary": 1, "is_importable": 0},
        "Show/SPs/Show - PV.mkv",
    )

    assert category == "auxiliary"
    assert "辅助" in reason


def test_auxiliary_number_suffixes_and_playable_special_facts_are_classified() -> None:
    auxiliary, _ = classify_saved_video(
        {"content_class": "unknown", "is_importable": 0},
        "Show/SPs/Show - PV01.mkv",
    )
    special, _ = classify_saved_video(
        {"content_class": "playable_special", "is_importable": 1},
        "Show/Season 0/Show - episode.mkv",
    )

    assert auxiliary == "auxiliary"
    assert special == "substantive_special"


def test_only_the_latest_confirmed_revision_can_anchor_extra_video_hints() -> None:
    conn = _db()
    _add_fact(conn, "special", "Example Show/SPs/Example Show SP 01.mkv",
              content_class="attached_special", special_number=1)
    conn.execute("INSERT INTO import_revisions VALUES ('rev2', 'r1', 'confirmed', '2026-10-14T11:00:00Z')")

    result = get_extra_video_overview(conn, "w1")

    assert result is not None
    assert result["substantive_special_count"] == 0
    assert "没有仍可用的已确认正片资产，无法建立额外视频关联" in result["reasons"]


def test_bound_regular_episode_other_editions_are_suppressed_but_new_episode_remains() -> None:
    conn = _db()
    _add_fact(conn, "regular-alt", "Example Show/S01/E01 1080p.mkv",
              content_class="regular", is_importable=1, season_candidate=1,
              season_token_raw="S01", episode_token_raw="E01", episode_candidate=1,
              fingerprint="regular-1080p")
    _add_fact(conn, "episode-2", "Example Show/S01/E02.mkv",
              content_class="regular", is_importable=1, season_candidate=1,
              season_token_raw="S01", episode_token_raw="E02", episode_candidate=2,
              fingerprint="regular-e02")

    result = get_extra_video_overview(conn, "w1")

    assert result is not None
    assert result["unmatched_count"] == 1
    assert "已省略与当前已匹配正片季集号相同的另一版本" in result["reasons"]


def test_special_and_auxiliary_numbered_markers_keep_separate_identity_spaces() -> None:
    conn = _db()
    _add_fact(conn, "pv", "Example Show/SPs/Example Show PV1.mkv",
              fingerprint="pv-one")
    _add_fact(conn, "sp", "Example Show/SPs/Example Show SP1.mkv",
              special_candidate=1, special_number=1, episode_token_raw="1",
              fingerprint="sp-one")

    result = get_extra_video_overview(conn, "w1")

    assert result is not None
    assert result["auxiliary_count"] == 1
    assert result["substantive_special_count"] == 1
