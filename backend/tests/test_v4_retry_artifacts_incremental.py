"""异步图片准备按资源增量执行，资料发布只写入 SQLite 快照。"""

from __future__ import annotations


def _artwork_fixture(tmp_path, monkeypatch):
    from app.media_v4.assets.service import ArtworkService

    from backend.tests.test_v4_artwork_catalog import _database, _image

    database = _database(tmp_path)
    image = _image(tmp_path)
    calls: list[str] = []
    service = ArtworkService(database, data_root=tmp_path)
    monkeypatch.setattr(service, "_download", lambda url: (calls.append(url), image.read_bytes())[-1])
    return database, image, service, calls


def test_repeated_published_source_is_not_downloaded_again(tmp_path, monkeypatch):
    from app.media_v4.assets.catalog import get_work_artwork

    from backend.tests.test_v4_artwork_catalog import enqueue_metadata

    database, _image, service, calls = _artwork_fixture(tmp_path, monkeypatch)
    poster_url = "https://image.tmdb.org/t/p/original/shared-poster.jpg"
    with database.connect() as conn:
        for work_id in ("one", "two"):
            enqueue_metadata(
                conn, revision_id="r", work_id=work_id, snapshot_id="shared",
                metadata={"poster_url": poster_url},
            )

    assert service.process_available() == 1
    assert calls == [poster_url]
    with database.connect() as conn:
        assert get_work_artwork(conn, "one")["poster"]["state"] == "ready"
        assert get_work_artwork(conn, "two")["poster"]["state"] == "ready"
        assert conn.execute("SELECT COUNT(*) FROM artwork_resources").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM artwork_variants").fetchone()[0] == 3

    assert service.process_available() == 0
    assert calls == [poster_url]


def test_incremental_snapshot_prepares_only_new_artwork_resource(tmp_path, monkeypatch):
    from app.media_v4.assets.catalog import get_work_artwork

    from backend.tests.test_v4_artwork_catalog import enqueue_metadata

    database, _image, service, calls = _artwork_fixture(tmp_path, monkeypatch)
    poster_url = "https://image.tmdb.org/t/p/original/poster.jpg"
    first_fanart = "https://image.tmdb.org/t/p/original/fanart-old.jpg"
    next_fanart = "https://image.tmdb.org/t/p/original/fanart-new.jpg"
    with database.connect() as conn:
        enqueue_metadata(conn, revision_id="r", work_id="one", snapshot_id="first",
                         metadata={"poster_url": poster_url, "fanart_url": first_fanart})
    assert service.process_available() == 2
    assert set(calls) == {poster_url, first_fanart}
    with database.connect() as conn:
        first_ids = {
            row["role"]: row["candidate_id"]
            for row in conn.execute("SELECT role,candidate_id FROM artwork_bindings WHERE work_id='one'")
        }

    calls.clear()
    with database.connect() as conn:
        enqueue_metadata(conn, revision_id="r", work_id="one", snapshot_id="next",
                         metadata={"poster_url": poster_url, "fanart_url": next_fanart})
    assert service.process_available() == 1
    assert calls == [next_fanart]
    with database.connect() as conn:
        artwork = get_work_artwork(conn, "one")
        next_ids = {
            row["role"]: row["candidate_id"]
            for row in conn.execute("SELECT role,candidate_id FROM artwork_bindings WHERE work_id='one'")
        }
        assert artwork["poster"]["state"] == "ready"
        assert artwork["fanart"]["state"] == "ready"
    assert next_ids["poster"] == first_ids["poster"]
    assert next_ids["fanart"] != first_ids["fanart"]


def test_scrape_publishes_sqlite_snapshot_and_queues_artwork_without_files(tmp_path):
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "retry.db")
    database.initialize()
    evidence = SourceEvidence(
        evidence_id="evidence-movie",
        scan_id="scan-movie",
        root_id="root-movie",
        source_key="movie-source",
        relative_path="Show/Show.mkv",
        entry_kind="video",
        provider="local",
        source_locator=str(tmp_path / "source" / "Show.mkv"),
        playback_locator=str(tmp_path / "source" / "Show.mkv"),
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-movie",
        evidence_id=evidence.evidence_id,
        parser_version="fixture",
        work_title="Show",
        title_candidates=("Show",),
        media_type="movie",
        group_type="movie",
        confidence="high",
    )
    revisions = V4RevisionService(database)
    revisions.create_draft("revision-movie", [(evidence, facts)])
    revisions.confirm("revision-movie")
    job = next(
        item for item in revisions.list_jobs("revision-movie")
        if item["job_type"] == "scrape_work"
    )
    result = {
        "provider": "tmdb",
        "provider_id": "1",
        "media_type": "movie",
        "title": "Show",
        "metadata_state": "ready",
        "poster_url": "https://image.tmdb.org/t/p/w500/poster.jpg",
        "fanart_url": "https://image.tmdb.org/t/p/w500/fanart.jpg",
        "clearlogo_url": "https://image.tmdb.org/t/p/w500/logo.png",
    }
    V4ScrapeService(database).process(job["job_id"], lambda _target: result)

    with database.connect() as conn:
        binding = conn.execute(
            "SELECT metadata_json,status FROM scrape_bindings WHERE work_id=?",
            (job["work_id"],),
        ).fetchone()
        import json

        payload = json.loads(binding["metadata_json"])
        snapshot = conn.execute(
            "SELECT metadata_json FROM metadata_snapshots WHERE snapshot_id=?",
            (payload["metadata_snapshot_id"],),
        ).fetchone()
        resources = conn.execute(
            "SELECT b.role,r.state FROM artwork_bindings b JOIN artwork_resources r "
            "ON r.resource_id=b.candidate_id WHERE b.snapshot_id=?",
            (payload["metadata_snapshot_id"],),
        ).fetchall()
        assert conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0] == 0

    assert binding["status"] == "confirmed"
    assert json.loads(snapshot["metadata_json"])["metadata_state"] == "ready"
    assert {row["role"] for row in resources} == {"poster", "fanart", "clearlogo"}
    assert all(row["state"] == "pending" for row in resources)
    assert list(tmp_path.rglob("*.nfo")) == []
