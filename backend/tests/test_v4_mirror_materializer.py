"""已退役镜像物化链不再参与 V4 确认后的 SQLite 执行。"""

from __future__ import annotations

from dataclasses import replace

from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.persistence.database import V4Database
from app.media_v4.revisions.service import V4RevisionService


def _entry(evidence_id: str, locator: str):
    evidence = SourceEvidence(
        evidence_id=evidence_id,
        scan_id="scan-snapshot",
        root_id="root-snapshot",
        source_key=evidence_id,
        relative_path=f"Show/{evidence_id}.mkv",
        entry_kind="video",
        provider="local",
        ingest_method="local_scan",
        source_locator=locator,
        playback_locator=locator,
        fingerprint=f"sha256:{evidence_id}",
    )
    facts = ParsedFacts(
        parsed_fact_id=f"facts-{evidence_id}",
        evidence_id=evidence_id,
        parser_version="fixture",
        work_title="Show",
        title_candidates=("Show",),
        media_type="tv",
        group_type="season",
        season_candidate=1,
        episode_candidate=1,
        quality_tags=(evidence_id,),
    )
    return evidence, facts


def test_confirmation_keeps_distinct_assets_in_sqlite_without_legacy_materialization(tmp_path):
    media = []
    for name in ("show-1080p.mkv", "show-2160p.mkv"):
        path = tmp_path / name
        path.write_bytes(b"video fixture")
        media.append(path)

    database = V4Database(tmp_path / "snapshot.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-snapshot", [
        _entry("1080p", str(media[0])),
        _entry("2160p", str(media[1])),
    ])
    revisions.confirm("rev-snapshot")

    with database.connect() as conn:
        rows = conn.execute(
            "SELECT rb.asset_id,rb.episode_id,se.playback_locator "
            "FROM revision_bindings rb JOIN source_evidence se ON se.evidence_id=rb.evidence_id "
            "WHERE rb.revision_id='rev-snapshot' ORDER BY se.playback_locator"
        ).fetchall()
        jobs = conn.execute(
            "SELECT job_type FROM jobs WHERE revision_id='rev-snapshot' ORDER BY job_type"
        ).fetchall()
        artifacts = conn.execute(
            "SELECT COUNT(*) FROM artifacts WHERE revision_id='rev-snapshot'"
        ).fetchone()[0]

    assert len(rows) == 2
    assert len({row["asset_id"] for row in rows}) == 2
    assert len({row["episode_id"] for row in rows}) == 1
    assert {row["playback_locator"] for row in rows} == {str(path) for path in media}
    assert [row["job_type"] for row in jobs] == ["refresh_projection", "scrape_work"]
    assert artifacts == 0


def test_confirmed_snapshot_does_not_probe_source_files(tmp_path, monkeypatch):
    database = V4Database(tmp_path / "no-probe.db")
    database.initialize()
    evidence, facts = _entry("openlist", str(tmp_path / "not-mounted" / "Show.S01E01.mkv"))
    evidence = replace(evidence, provider="openlist", ingest_method="openlist_api",
                       source_locator="/Anime/Show/Show.S01E01.mkv")
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-no-probe", [(evidence, facts)])

    def fail_probe(_self, *args, **kwargs):
        raise AssertionError("confirm must persist the source snapshot without probing mounted files")

    monkeypatch.setattr("pathlib.Path.is_file", fail_probe)
    revisions.confirm("rev-no-probe")

    with database.connect() as conn:
        locator = conn.execute(
            "SELECT playback_locator FROM assets WHERE root_id='root-snapshot'"
        ).fetchone()[0]
    assert locator == str(tmp_path / "not-mounted" / "Show.S01E01.mkv")
