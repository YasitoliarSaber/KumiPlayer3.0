"""资料快照只依赖确认身份与成员签名，图片/NFO 不是资料有效性条件。"""

from dataclasses import replace
from uuid import uuid4

import pytest
from backend.tests.test_v4_revision_confirmation import _entry

from app.media_v4.jobs.metadata_quality import require_regular_episode_metadata
from app.media_v4.persistence import metadata_lifecycle
from app.media_v4.persistence.database import V4Database
from app.media_v4.revisions.service import V4RevisionService


def _snapshot(tmp_path):
    database = V4Database(tmp_path / "snapshots.db")
    database.initialize()
    revisions = V4RevisionService(database)
    evidence, facts = _entry(evidence_id="resource-independent")
    revisions.create_draft("r1", [(evidence, facts)])
    revisions.confirm("r1")
    with database.connect() as conn:
        binding = dict(conn.execute("SELECT work_id,episode_id FROM revision_bindings LIMIT 1").fetchone())
        metadata = {"provider": "tmdb", "provider_id": "123", "media_type": "tv", "title": "Online title",
                    "metadata_state": "ready", "episode_mappings": [{"episode_id": binding["episode_id"],
                    "provider_episode_id": "456", "title": "Episode title"}]}
        metadata_lifecycle.publish_snapshot(conn, revision_id="r1", work_id=binding["work_id"],
                                            snapshot_id="snapshot", metadata=metadata, artifact_ids=[])
        conn.commit()
    return database, revisions, evidence, facts, binding


def test_snapshot_reads_and_rescan_reuse_need_no_resource_files(tmp_path, monkeypatch):
    database, revisions, evidence, facts, binding = _snapshot(tmp_path)
    monkeypatch.setattr(metadata_lifecycle, "artifacts_valid", lambda *_args: pytest.fail("metadata inspected files"))
    monkeypatch.setattr("app.media_v4.jobs.metadata_quality.missing_episode_artwork",
                        lambda *_args: pytest.fail("metadata inspected episode artwork"))
    with database.connect() as conn:
        stored = metadata_lifecycle.referenced_metadata(conn, binding["work_id"])
    assert stored is not None
    assert stored["metadata_state"] == "ready"
    assert stored["mapped_count"] == 1
    assert stored["episode_metadata_status"] == "complete"

    updated = replace(evidence, evidence_id="resource-independent-r2", scan_id="scan-r2")
    updated_facts = replace(facts, parsed_fact_id="facts-r2", evidence_id=updated.evidence_id)
    revisions.create_draft("r2", [(updated, updated_facts)])
    revisions.confirm("r2")
    with database.connect() as conn:
        retained = metadata_lifecycle.select_applicable_snapshot(conn, "r2", binding["work_id"])
        assert retained is not None and retained["covers_members"] is True
        assert conn.execute("SELECT snapshot_id FROM revision_metadata_refs WHERE revision_id='r2'").fetchone()[0] == "snapshot"


def test_missing_still_source_is_separate_from_episode_metadata_quality():
    metadata = {"metadata_state": "ready", "provider_id": "123", "episode_mappings": [
        {"episode_id": "e1", "provider_episode_id": "456", "title": "Episode title"}]}
    result = require_regular_episode_metadata(
        [{"episode_id": "e1", "local_episode_number": 1, "local_season_number": 1}], metadata)
    assert result["metadata_state"] == "ready"
    assert result["episode_metadata_status"] == "complete"
    assert result["missing_episode_still_count"] == 1
    assert result["episode_artwork_status"] != "complete"


def test_valid_movie_metadata_does_not_report_missing_work_images_as_complete(tmp_path, monkeypatch):
    from app.core.config import AppConfig
    from app.media_v4.jobs.completeness import assess_metadata_completeness
    from app.media_v4.jobs.metadata_artifacts import publish_metadata_artifacts

    config = AppConfig(artwork_storage_mode="local")
    monkeypatch.setattr("app.media_v4.jobs.metadata_artifacts.load_config", lambda: config)
    monkeypatch.setattr("app.media_v4.jobs.completeness.load_config", lambda: config)
    monkeypatch.setattr("app.media_v4.jobs.metadata_artifacts._download_artwork",
                        lambda *_args, **_kwargs: pytest.fail("empty image sources must not download"))
    database = V4Database(tmp_path / "movie.db")
    database.initialize()
    revisions = V4RevisionService(database)
    evidence, facts = _entry(evidence_id="movie-resource-independent")
    facts = replace(facts, media_type="movie", group_type="movie", season_candidate=None, episode_candidate=None)
    revisions.create_draft("r1", [(evidence, facts)])
    revisions.confirm("r1")
    with database.connect() as conn:
        work = dict(conn.execute("SELECT * FROM works").fetchone())
    metadata = {"provider": "tmdb", "provider_id": "123", "title": "Movie title", "metadata_state": "ready",
                "media_type": "movie", "metadata_snapshot_id": str(uuid4())}
    target = {**work, "episodes": []}
    publish_metadata_artifacts(database, revision_id="r1", work_id=work["work_id"], target=target,
                               metadata=metadata, mirror_root=tmp_path / "mirror",
                               snapshot_id=metadata["metadata_snapshot_id"])
    assert metadata_lifecycle.snapshot_requirements_valid(metadata)
    complete, reasons = assess_metadata_completeness(
        database, revision_id="r1", work_id=work["work_id"], target=target, metadata=metadata,
        mirror_root=tmp_path / "mirror")
    assert complete is False
    assert reasons == ["本次海报或背景图产物不完整"]


@pytest.mark.parametrize("change", ["work_identity", "episode_signature"])
def test_resource_independence_does_not_bypass_identity_or_member_signatures(tmp_path, change):
    database, _revisions, _evidence, _facts, binding = _snapshot(tmp_path)
    with database.connect() as conn:
        if change == "work_identity":
            conn.execute("UPDATE works SET year=2026 WHERE work_id=?", (binding["work_id"],))
        else:
            conn.execute("UPDATE episodes SET local_episode_number=2 WHERE episode_id=?", (binding["episode_id"],))
        stored = metadata_lifecycle.referenced_metadata(conn, binding["work_id"])
    if change == "work_identity":
        assert stored is None
    else:
        assert stored is not None
        assert stored["episode_mappings"] == []
        assert stored["mapped_count"] == 0
