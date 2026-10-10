"""回归验证后端 jobs 合同修复，不访问真实媒体目录或在线 Provider。"""

from __future__ import annotations

import importlib.util
import json
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _set_valid_asset_locators(database, tmp_path):
    with database.connect() as conn:
        asset_ids = [str(row[0]) for row in conn.execute("SELECT asset_id FROM assets")]
        conn.executemany(
            "UPDATE assets SET playback_locator=? WHERE asset_id=?",
            [(str(tmp_path / f"{asset_id}.mkv"), asset_id) for asset_id in asset_ids],
        )


def test_identity_repair_registers_only_current_jobs_with_scrape_policy(tmp_path):
    from app.media_v4.maintenance.identity_repair import (
        apply_identity_repair,
        build_identity_repair_preview,
    )
    from app.media_v4.persistence.database import V4Database
    fixture_path = Path(__file__).with_name("test_v4_identity_repair.py")
    spec = importlib.util.spec_from_file_location("identity_repair_fixtures", fixture_path)
    assert spec is not None and spec.loader is not None
    fixtures = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixtures)

    database = V4Database(tmp_path / "identity-repair.db")
    database.initialize()
    work_id = fixtures._seed_polluted_media(database)
    _set_valid_asset_locators(database, tmp_path)
    preview = build_identity_repair_preview(database, work_id=work_id)

    result = apply_identity_repair(
        database,
        preview_id=preview["preview_id"],
        digest=preview["digest"],
    )

    with database.connect() as conn:
        jobs = conn.execute(
            f"SELECT job_type, result_json FROM jobs WHERE revision_id IN "
            f"({','.join('?' for _ in result['new_revision_ids'])})",
            tuple(result["new_revision_ids"]),
        ).fetchall()
    assert jobs
    assert all(row["job_type"] != "materialize_mirror" for row in jobs)
    for row in jobs:
        if row["job_type"] == "scrape_work":
            assert json.loads(row["result_json"])["runtime_policy"] == "sqlite-artwork-v1"

    from app.media_v4.jobs.runner import V4JobRunner

    results = V4JobRunner(database, metadata_provider=lambda target: {
        "provider": "local",
        "provider_id": "",
        "media_type": "tv",
        "metadata_state": "waiting_review",
        "reason": "isolated test provider",
    }).process_available()
    assert any(result.job_type == "scrape_work" and result.status == "succeeded" for result in results)
    assert any(result.job_type == "refresh_projection" and result.status == "succeeded" for result in results)


def test_identity_repair_preserves_manual_artwork_without_overwriting_target_manual(tmp_path):
    from app.media_v4.assets.catalog import enqueue_manual
    from app.media_v4.maintenance.identity_repair import (
        _ensure_work,
        apply_identity_repair,
        build_identity_repair_preview,
    )
    from app.media_v4.persistence.database import V4Database

    fixture_path = Path(__file__).with_name("test_v4_identity_repair.py")
    spec = importlib.util.spec_from_file_location("identity_repair_artwork_fixtures", fixture_path)
    assert spec is not None and spec.loader is not None
    fixtures = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixtures)

    database = V4Database(tmp_path / "identity-repair-artwork.db")
    database.initialize()
    work_id = fixtures._seed_polluted_media(database)
    _set_valid_asset_locators(database, tmp_path)
    preview = build_identity_repair_preview(database, work_id=work_id)
    primary_target = preview["target_works"][0]
    old_cover = str(tmp_path / "old-manual-cover.png")
    target_cover = str(tmp_path / "target-manual-cover.png")
    with database.connect() as conn:
        target_work_id = _ensure_work(conn, primary_target, work_id, "2026-10-09T00:00:00+00:00")
        old_resource = enqueue_manual(conn, work_id=work_id, role="poster", local_path=old_cover)
        target_resource = enqueue_manual(conn, work_id=target_work_id, role="poster", local_path=target_cover)
        conn.execute(
            "UPDATE artwork_resources SET state='ready',content_digest=? WHERE resource_id IN (?,?)",
            ("manual-digest", old_resource, target_resource),
        )
        conn.execute(
            "UPDATE artwork_bindings SET published_id=candidate_id WHERE subject_type='work' AND subject_id IN (?,?) AND role='poster'",
            (work_id, target_work_id),
        )

    result = apply_identity_repair(
        database,
        preview_id=preview["preview_id"],
        digest=preview["digest"],
    )

    with database.connect() as conn:
        bindings = {
            str(row["subject_id"]): dict(row)
            for row in conn.execute(
                "SELECT subject_id,candidate_id,published_id,priority FROM artwork_bindings "
                "WHERE subject_type='work' AND role='poster' AND subject_id IN "
                f"({','.join('?' for _ in result['target_work_ids'].values())})",
                tuple(result["target_work_ids"].values()),
            )
        }
    assert len(bindings) == len(set(result["target_work_ids"].values()))
    assert all(row["priority"] == 100 for row in bindings.values())
    assert bindings[target_work_id]["candidate_id"] == target_resource
    assert bindings[target_work_id]["published_id"] == target_resource
    assert any(
        row["candidate_id"] == old_resource and row["published_id"] == old_resource
        for work, row in bindings.items() if work != target_work_id
    )


def test_identity_repair_rejects_invalid_asset_locator_before_any_migration(tmp_path):
    from app.media_v4.maintenance.identity_repair import (
        IdentityRepairBlockedError,
        apply_identity_repair,
        build_identity_repair_preview,
    )
    from app.media_v4.persistence.database import V4Database

    fixture_path = Path(__file__).with_name("test_v4_identity_repair.py")
    spec = importlib.util.spec_from_file_location("identity_repair_path_fixtures", fixture_path)
    assert spec is not None and spec.loader is not None
    fixtures = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixtures)

    database = V4Database(tmp_path / "identity-repair-invalid-path.db")
    database.initialize()
    work_id = fixtures._seed_polluted_media(database)
    _set_valid_asset_locators(database, tmp_path)
    with database.connect() as conn:
        conn.execute("UPDATE assets SET playback_locator='local://invalid' WHERE asset_id='asset-0'")
    preview = build_identity_repair_preview(database, work_id=work_id)

    with pytest.raises(IdentityRepairBlockedError, match="播放"):
        apply_identity_repair(
            database,
            preview_id=preview["preview_id"],
            digest=preview["digest"],
        )

    with database.connect() as conn:
        work = conn.execute("SELECT identity_key,status FROM works WHERE work_id=?", (work_id,)).fetchone()
        old_revision = conn.execute(
            "SELECT status FROM import_revisions WHERE revision_id='revision-repair-old'"
        ).fetchone()
        progress = conn.execute(
            "SELECT episode_id,work_id,position FROM playback_progress WHERE asset_id='asset-1'"
        ).fetchone()
    assert work["status"] == "active"
    assert not str(work["identity_key"]).startswith("legacy:")
    assert old_revision["status"] == "confirmed"
    assert progress["episode_id"] == "old-episode"
    assert progress["work_id"] == work_id
    assert progress["position"] == 42


def test_idle_job_poll_performs_no_database_writes(tmp_path, monkeypatch):
    from app.media_v4.jobs.runner import V4JobRunner
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / "idle-runner.db")
    database.initialize()
    statements: list[str] = []
    original_connect = database.connect

    @contextmanager
    def traced_connect():
        with original_connect() as conn:
            conn.set_trace_callback(statements.append)
            yield conn

    monkeypatch.setattr(database, "connect", traced_connect)

    assert V4JobRunner(database).process_available() == []

    writes = [
        statement for statement in statements
        if statement.lstrip().upper().startswith(("UPDATE ", "INSERT ", "DELETE ", "REPLACE "))
    ]
    assert writes == []


def test_run_job_http_response_uses_current_job_result_contract(tmp_path, monkeypatch):
    from app.api import media_v4
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "run-job-api.db")
    database.initialize()
    monkeypatch.setattr(media_v4, "_database", database)
    media = tmp_path / "Show.S01E01.mkv"
    media.write_bytes(b"video")
    evidence = SourceEvidence(
        evidence_id="run-api-evidence", scan_id="run-api-scan", root_id="run-api-root",
        source_key="run-api", relative_path="Show/Show.S01E01.mkv", entry_kind="video",
        source_locator=str(media),
        playback_locator=str(media),
    )
    facts = ParsedFacts(
        parsed_fact_id="run-api-facts", evidence_id=evidence.evidence_id,
        parser_version="fixture", work_title="Show", title_candidates=("Show",),
        media_type="tv", group_type="season", season_candidate=1, episode_candidate=1,
    )
    revisions = V4RevisionService(database)
    revisions.create_draft("run-api-revision", [(evidence, facts)])
    revisions.confirm("run-api-revision")
    with database.connect() as conn:
        conn.execute(
            "UPDATE jobs SET status='succeeded',result_json=? "
            "WHERE revision_id=? AND job_type='scrape_work'",
            (json.dumps({"runtime_policy": "sqlite-artwork-v1"}), "run-api-revision"),
        )
        job_id = conn.execute(
            "SELECT job_id FROM jobs WHERE revision_id=? AND job_type='refresh_projection'",
            ("run-api-revision",),
        ).fetchone()["job_id"]
    application = FastAPI()
    application.include_router(media_v4.router)

    response = TestClient(application).post(f"/api/v4/jobs/{job_id}/run")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["job_id"] == job_id
    assert payload["job_type"] == "refresh_projection"
    assert payload["status"] == "succeeded"
    assert payload["generation_id"]
    assert "artifact_paths" not in payload
    assert "warnings" not in payload


def test_metadata_confirm_registers_background_refresh_without_provider_call(tmp_path, monkeypatch):
    from app.api import media_v4
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "metadata-confirm-api.db")
    database.initialize()
    monkeypatch.setattr(media_v4, "_database", database)
    media = tmp_path / "Show.S01E01.mkv"
    media.write_bytes(b"video")
    evidence = SourceEvidence(
        evidence_id="manual-evidence", scan_id="manual-scan", root_id="manual-root",
        source_key="manual", relative_path="Show/Show.S01E01.mkv", entry_kind="video",
        source_locator=str(media),
        playback_locator=str(media),
    )
    facts = ParsedFacts(
        parsed_fact_id="manual-facts", evidence_id=evidence.evidence_id,
        parser_version="fixture", work_title="Show", title_candidates=("Show",),
        media_type="tv", group_type="season", season_candidate=1, episode_candidate=1,
    )
    revisions = V4RevisionService(database)
    revisions.create_draft("manual-revision", [(evidence, facts)])
    revisions.confirm("manual-revision")
    with database.connect() as conn:
        work_id = conn.execute(
            "SELECT work_id FROM revision_bindings WHERE revision_id='manual-revision' LIMIT 1"
        ).fetchone()["work_id"]
        conn.execute(
            """INSERT INTO revision_work_candidates(
                candidate_id, revision_id, work_id, draft_work_key, provider, provider_id,
                media_type, title, confidence, status, created_at, updated_at
            ) VALUES ('manual-candidate', 'manual-revision', ?, 'show', 'tmdb', '12345',
                      'tv', 'Show', 'high', 'proposed', ?, ?)""",
            (work_id, datetime.now(UTC).isoformat(), datetime.now(UTC).isoformat()),
        )
    monkeypatch.setattr(
        "app.media_v4.jobs.metadata.default_metadata_provider",
        lambda _target: (_ for _ in ()).throw(AssertionError("Provider must run in background")),
    )
    from app.media_v4.jobs.scrape import V4ScrapeService

    original_requeue = V4ScrapeService.requeue_work

    def observed_requeue(service, *args, **kwargs):
        job = original_requeue(service, *args, **kwargs)
        # A worker may claim immediately once registration commits. The queued
        # job must already carry the confirmed selection, without a second write.
        assert json.loads(job['result_json'])['selected_provider']['provider_id'] == '12345'
        return job

    monkeypatch.setattr(V4ScrapeService, 'requeue_work', observed_requeue)
    application = FastAPI()
    application.include_router(media_v4.router)

    with database.connect() as conn:
        conn.execute("UPDATE jobs SET status='running' WHERE job_type='scrape_work'")
    rejected = TestClient(application).post('/api/v4/metadata/confirm', json={
        'work_id': work_id, 'candidate_id': 'manual-candidate',
    })
    assert rejected.status_code == 409
    with database.connect() as conn:
        assert conn.execute('SELECT 1 FROM provider_bindings WHERE work_id=?', (work_id,)).fetchone() is None
        assert conn.execute("SELECT status FROM revision_work_candidates WHERE candidate_id='manual-candidate'").fetchone()[0] == 'proposed'
        conn.execute("UPDATE jobs SET status='queued' WHERE job_type='scrape_work'")

    response = TestClient(application).post("/api/v4/metadata/confirm", json={
        "work_id": work_id,
        "candidate_id": "manual-candidate",
    })

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "accepted"
    assert payload["refresh_status"] == "queued"
    assert payload["job_ids"]
    with database.connect() as conn:
        binding = conn.execute(
            "SELECT provider_id FROM provider_bindings WHERE work_id=? AND provider='tmdb' AND media_type='tv'",
            (work_id,),
        ).fetchone()
        job = conn.execute(
            "SELECT status, result_json FROM jobs WHERE job_id=?", (payload["job_ids"][0],)
        ).fetchone()
    assert binding["provider_id"] == "12345"
    assert job["status"] == "queued"
    assert json.loads(job["result_json"])["runtime_policy"] == "sqlite-artwork-v1"

    # The job's confirmed selection is authoritative even if the shared binding
    # changes before a delayed worker claims this job.
    with database.connect() as conn:
        conn.execute(
            "UPDATE provider_bindings SET provider_id='99999' WHERE work_id=? AND provider='tmdb' AND media_type='tv'",
            (work_id,),
        )
    season_response = TestClient(application).post('/api/v4/metadata/confirm', json={
        'work_id': work_id, 'candidate_id': 'manual-candidate', 'scope': 'season', 'season_number': 1,
    })
    assert season_response.status_code == 409
    with database.connect() as conn:
        assert conn.execute('SELECT provider_id FROM provider_bindings WHERE work_id=?', (work_id,)).fetchone()[0] == '99999'
    observed: list[dict] = []

    def fake_provider(target):
        observed.append(target)
        return {
            "provider": "local",
            "provider_id": "",
            "media_type": "tv",
            "metadata_state": "waiting_metadata",
        }

    from app.media_v4.jobs.runner import V4JobRunner

    V4JobRunner(database, metadata_provider=fake_provider).process_job(payload["job_ids"][0])
    assert observed[0]["provider_bindings"] == [{
        "provider": "tmdb",
        "media_type": "tv",
        "provider_id": "12345",
    }]
