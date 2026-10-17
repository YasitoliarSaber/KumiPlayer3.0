"""`GET /api/v4/jobs` 的只读过滤与界限。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch) -> TestClient:
    from app.api import media_v4
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / "jobs-read.db")
    database.initialize()
    monkeypatch.setattr(media_v4, "_database", database)
    application = FastAPI()
    application.include_router(media_v4.router)
    with database.connect() as conn:
        conn.executescript(
            """
            -- 每个来源只允许一个已确认 revision，因此两个 revision 分属两个来源。
            INSERT INTO source_roots(root_id, provider, ingest_method, created_at, updated_at)
            VALUES ('root-a', 'local', 'local_scan', 'now', 'now'),
                   ('root-b', 'local', 'local_scan', 'now', 'now');
            INSERT INTO source_scans(scan_id, root_id, generation, status)
            VALUES ('scan-a', 'root-a', 1, 'completed'), ('scan-b', 'root-b', 1, 'completed');
            INSERT INTO import_revisions(revision_id, root_id, scan_id, resolver_version, status, created_at)
            VALUES ('rev-a', 'root-a', 'scan-a', 'fixture', 'confirmed', 'now'),
                   ('rev-b', 'root-b', 'scan-b', 'fixture', 'confirmed', 'now');
            INSERT INTO jobs(job_id, job_type, revision_id, idempotency_key, status, created_at, updated_at)
            VALUES ('job-1', 'scrape_work', 'rev-a', 'scrape:rev-a', 'succeeded', '2026-01-01', 'now'),
                   ('job-2', 'refresh_projection', 'rev-a', 'refresh:rev-a', 'queued', '2026-01-02', 'now'),
                   ('job-3', 'scrape_work', 'rev-b', 'scrape:rev-b', 'failed', '2026-01-03', 'now'),
                   ('job-4', 'refresh_projection', 'rev-b', 'refresh:rev-b', 'succeeded', '2026-01-04', 'now');
            """
        )
    return TestClient(application)


def test_jobs_read_without_filters_keeps_all_rows(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = client.get("/api/v4/jobs")

    assert response.status_code == 200
    assert [row["job_id"] for row in response.json()["jobs"]] == ["job-1", "job-2", "job-3", "job-4"]


def test_jobs_read_filters_by_revision_and_status(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    by_revision = client.get("/api/v4/jobs?revision_id=rev-a")
    assert by_revision.status_code == 200
    assert [row["job_id"] for row in by_revision.json()["jobs"]] == ["job-1", "job-2"]

    combined = client.get("/api/v4/jobs?revision_id=rev-b&status=failed")
    assert combined.status_code == 200
    assert [row["job_id"] for row in combined.json()["jobs"]] == ["job-3"]


def test_jobs_read_limit_is_bounded_and_ordered(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    limited = client.get("/api/v4/jobs?limit=2")
    assert limited.status_code == 200
    assert [row["job_id"] for row in limited.json()["jobs"]] == ["job-1", "job-2"]

    # limit 越界按 1 的下界夹取，不返回空列表假装"没有任务"。
    clamped = client.get("/api/v4/jobs?limit=0")
    assert clamped.status_code == 200
    assert [row["job_id"] for row in clamped.json()["jobs"]] == ["job-1"]
