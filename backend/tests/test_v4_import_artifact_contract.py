"""确认后的媒体事实以 SQLite snapshots 与 revision bindings 为准。"""

from __future__ import annotations

from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.persistence.database import V4Database
from app.media_v4.revisions.service import V4RevisionService


def _entry(evidence_id: str, locator: str, episode_numbers: tuple[int, ...]):
    evidence = SourceEvidence(
        evidence_id=evidence_id,
        scan_id="scan-snapshot-contract",
        root_id="root-snapshot-contract",
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
        episode_candidate=episode_numbers[0],
        episode_range=(episode_numbers[0], episode_numbers[-1]) if len(episode_numbers) > 1 else None,
    )
    return evidence, facts


def _confirm(database: V4Database, revision_id: str, entries) -> None:
    service = V4RevisionService(database)
    service.create_draft(revision_id, entries)
    service.confirm(revision_id)


def test_multiple_assets_for_one_episode_remain_distinct_sqlite_facts(tmp_path):
    locators = []
    entries = []
    for evidence_id in ("1080p", "2160p"):
        media = tmp_path / f"Show.{evidence_id}.mkv"
        media.write_bytes(b"fixture")
        locators.append(str(media))
        entries.append(_entry(evidence_id, str(media), (1,)))

    database = V4Database(tmp_path / "assets.db")
    database.initialize()
    _confirm(database, "rev-assets", entries)

    with database.connect() as conn:
        rows = conn.execute(
            "SELECT rb.asset_id,rb.episode_id,a.playback_locator "
            "FROM revision_bindings rb JOIN assets a ON a.asset_id=rb.asset_id "
            "WHERE rb.revision_id='rev-assets' ORDER BY a.playback_locator"
        ).fetchall()
        job_types = [row[0] for row in conn.execute(
            "SELECT job_type FROM jobs WHERE revision_id='rev-assets' ORDER BY job_type"
        )]
        artifact_count = conn.execute(
            "SELECT COUNT(*) FROM artifacts WHERE revision_id='rev-assets'"
        ).fetchone()[0]

    assert len(rows) == 2
    assert len({row["asset_id"] for row in rows}) == 2
    assert len({row["episode_id"] for row in rows}) == 1
    assert [row["playback_locator"] for row in rows] == sorted(locators)
    assert job_types == ["refresh_projection", "scrape_work"]
    assert artifact_count == 0


def test_multi_episode_source_is_one_asset_with_two_episode_bindings(tmp_path):
    media = tmp_path / "Show.S01E01-E02.mkv"
    media.write_bytes(b"fixture")
    database = V4Database(tmp_path / "multi-episode.db")
    database.initialize()
    _confirm(database, "rev-multi", [_entry("range", str(media), (1, 2))])

    with database.connect() as conn:
        rows = conn.execute(
            "SELECT rb.asset_id,rb.episode_id,a.playback_locator "
            "FROM revision_bindings rb JOIN assets a ON a.asset_id=rb.asset_id "
            "WHERE rb.revision_id='rev-multi'"
        ).fetchall()

    assert len(rows) == 2
    assert len({row["asset_id"] for row in rows}) == 1
    assert len({row["episode_id"] for row in rows}) == 2
    assert {row["playback_locator"] for row in rows} == {str(media)}
