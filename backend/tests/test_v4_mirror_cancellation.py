"""取消仅影响 SQLite V4 jobs；当前执行链不发布镜像文件。"""

from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.jobs.runner import V4JobRunner
from app.media_v4.persistence.database import V4Database
from app.media_v4.revisions.service import V4RevisionService


def test_cancelled_revision_stops_current_jobs_without_legacy_artifacts(tmp_path):
    media = tmp_path / "Show.S01E01.mkv"
    media.write_bytes(b"video fixture")
    evidence = SourceEvidence(
        evidence_id="ev-current",
        scan_id="scan-current",
        root_id="root-current",
        source_key="Show.S01E01.mkv",
        relative_path="Show.S01E01.mkv",
        entry_kind="video",
        provider="local",
        ingest_method="local_scan",
        source_locator=str(media),
        playback_locator=str(media),
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-current",
        evidence_id=evidence.evidence_id,
        parser_version="fixture",
        work_title="Show",
        title_candidates=("Show",),
        media_type="tv",
        group_type="season",
        season_candidate=1,
        episode_candidate=1,
    )
    database = V4Database(tmp_path / "cancel.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-current", [(evidence, facts)])
    revisions.confirm("rev-current")

    result = V4JobRunner(database).cancel_revision("rev-current")

    assert result["cancelled"] >= 1
    with database.connect() as conn:
        statuses = conn.execute(
            "SELECT job_type,status FROM jobs WHERE revision_id='rev-current' ORDER BY job_type"
        ).fetchall()
        artifact_count = conn.execute(
            "SELECT COUNT(*) FROM artifacts WHERE revision_id='rev-current'"
        ).fetchone()[0]
    assert {row["job_type"] for row in statuses} == {"scrape_work", "refresh_projection"}
    assert all(row["status"] == "cancelled" for row in statuses)
    assert artifact_count == 0
