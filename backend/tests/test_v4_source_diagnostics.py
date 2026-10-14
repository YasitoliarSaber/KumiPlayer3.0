"""Bounded source directory checks and explicit diagnostic export contracts."""

from __future__ import annotations

import json


def _database(tmp_path):
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / "source-diagnostics.db")
    database.initialize()
    return database


def test_directory_check_probes_only_distinct_parent_directories(tmp_path, monkeypatch):
    from app.media_v4.diagnostics import source_diagnostics

    database = _database(tmp_path)
    with database.connect() as conn:
        conn.execute("INSERT INTO source_roots(root_id, provider, ingest_method, created_at, updated_at) VALUES ('root-check', 'local', 'local_scan', 'now', 'now')")
        conn.execute("INSERT INTO source_scans(scan_id, root_id, generation, status, started_at) VALUES ('scan-check', 'root-check', 1, 'completed', 'now')")
        conn.executemany(
            "INSERT INTO source_evidence(evidence_id, scan_id, root_id, source_key, relative_path, entry_kind, playback_locator) VALUES (?, 'scan-check', 'root-check', ?, ?, 'video', ?)",
            [
                ("ev-1", "A/Season 1/E01.mkv", "A/Season 1/E01.mkv", "C:/media/A/Season 1/E01.mkv"),
                ("ev-2", "A/Season 1/E02.mkv", "A/Season 1/E02.mkv", "C:/media/A/Season 1/E02.mkv"),
                ("ev-3", "B/Season 2/E01.mkv", "B/Season 2/E01.mkv", "C:/media/B/Season 2/E01.mkv"),
                ("ev-4", "C/Season 3/E01.mkv", "C/Season 3/E01.mkv", "C:/media/C/Season 3/E01.mkv"),
                ("ev-5", "D/Season 4/E01.mkv", "D/Season 4/E01.mkv", "C:/media/D/Season 4/E01.mkv"),
            ],
        )

    probed = []
    monkeypatch.setattr(source_diagnostics, "inspect_metadata", lambda path: probed.append(path) or {"status": "directory"})
    result = source_diagnostics.check_scan_directories(database, "scan-check")

    assert result["state"] == "reachable"
    assert result["sampled_directories"] == 3
    assert result["reachable_directories"] == 3
    assert len(probed) == 3
    assert len({path.casefold() for path in probed}) == 3
    assert all(not path.casefold().endswith(".mkv") for path in probed)
    assert "不能据此" in result["scope"] or "不能认定" in result["scope"]
    assert "path" not in result


def test_directory_check_reports_timeout_as_unavailable(tmp_path, monkeypatch):
    from app.media_v4.diagnostics import source_diagnostics

    database = _database(tmp_path)
    with database.connect() as conn:
        conn.execute("INSERT INTO source_roots(root_id, provider, ingest_method, created_at, updated_at) VALUES ('root-timeout', 'local', 'local_scan', 'now', 'now')")
        conn.execute("INSERT INTO source_scans(scan_id, root_id, generation, status, started_at) VALUES ('scan-timeout', 'root-timeout', 1, 'completed', 'now')")
        conn.execute("INSERT INTO source_evidence(evidence_id, scan_id, root_id, source_key, relative_path, entry_kind, playback_locator) VALUES ('ev-timeout', 'scan-timeout', 'root-timeout', 'A/E01.mkv', 'A/E01.mkv', 'video', 'C:/offline/A/E01.mkv')")
    monkeypatch.setattr(source_diagnostics, "bounded_call", lambda *_args, **_kwargs: None)

    result = source_diagnostics.check_scan_directories(database, "scan-timeout")

    assert result["state"] == "unavailable"
    assert result["sampled_directories"] == 1
    assert "超时" in result["message"]


def test_directory_check_does_not_treat_remote_locator_as_current_directory(tmp_path, monkeypatch):
    from app.media_v4.diagnostics import source_diagnostics

    database = _database(tmp_path)
    with database.connect() as conn:
        conn.execute("INSERT INTO source_roots(root_id, provider, ingest_method, created_at, updated_at) VALUES ('root-remote', 'openlist', 'openlist_scan', 'now', 'now')")
        conn.execute("INSERT INTO source_scans(scan_id, root_id, generation, status, started_at) VALUES ('scan-remote', 'root-remote', 1, 'completed', 'now')")
        conn.execute("INSERT INTO source_evidence(evidence_id, scan_id, root_id, source_key, relative_path, entry_kind, playback_locator) VALUES ('ev-remote', 'scan-remote', 'root-remote', 'A/E01.mkv', 'A/E01.mkv', 'video', 'https://media.example/A/E01.mkv')")
    probed = []
    monkeypatch.setattr(source_diagnostics, "inspect_metadata", lambda path: probed.append(path) or {"status": "directory"})

    result = source_diagnostics.check_scan_directories(database, "scan-remote")

    assert result["state"] == "unavailable"
    assert result["sampled_directories"] == 0
    assert not probed
    assert "网盘定位符" in result["scope"]


def test_export_contains_source_issues_and_jobs_but_excludes_connection_secrets(tmp_path):
    from app.media_v4.diagnostics.source_diagnostics import export_source_diagnostics
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.revisions.service import V4RevisionService

    database = _database(tmp_path)
    evidence = SourceEvidence(
        evidence_id="ev-report", scan_id="scan-report", root_id="root-report",
        source_key="Show/E01.mkv", relative_path="Show/E01.mkv", entry_kind="video",
        source_locator="C:/media/Show/E01.mkv", playback_locator="C:/media/Show/E01.mkv",
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-report", evidence_id=evidence.evidence_id,
        parser_version="fixture", work_title="Show", title_candidates=("Show",),
        media_type="tv", group_type="season", season_candidate=1, episode_candidate=None,
    )
    V4RevisionService(database).create_draft("rev-report", [(evidence, facts)], root_id="root-report", scan_id="scan-report")
    with database.connect() as conn:
        conn.execute("INSERT INTO source_scan_requests(scan_id, scan_kind, source_mode, request_json, created_at, updated_at) VALUES ('scan-report', 'local', 'local', ?, 'now', 'now')", (json.dumps({"root_path": "C:/media", "connection_password": "do-not-export", "access_token": "token=secret"}),))
        conn.execute("INSERT INTO revision_issues(revision_id, issue_id, code, evidence_id, message) VALUES ('rev-report', 'issue-1', 'episode_number_unresolved', 'ev-report', '集号未定')")
        conn.execute("INSERT INTO jobs(job_id, job_type, revision_id, work_id, idempotency_key, status, last_error, created_at, updated_at) VALUES ('job-report', 'scrape_work', 'rev-report', '', 'key-report', 'failed', 'provider temporarily unavailable', 'now', 'now')")

    report = export_source_diagnostics(database, "root-report")
    serialized = json.dumps(report, ensure_ascii=False)

    fact_uncertainty = next(item for item in report["identification_uncertainties"] if item["layer"] == "parsed_fact")
    assert fact_uncertainty["code"] == "episode_number_unresolved"
    assert fact_uncertainty["hierarchy"]["work"] == "Show"
    assert report["unfinished_or_failed_jobs"][0]["status"] == "failed"
    assert report["unfinished_or_failed_jobs"][0]["layer"] == "job"
    assert report["source"]["locations"]["root_path"] == "C:/media"
    assert "connection_password" not in serialized
    assert "do-not-export" not in serialized
    assert "secret" not in serialized


def test_source_card_counts_actual_unique_artwork_resources(tmp_path):
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.projection.source_libraries import list_source_cards
    from app.media_v4.revisions.service import V4RevisionService

    database = _database(tmp_path)
    evidence = SourceEvidence(
        evidence_id="ev-art", scan_id="scan-art", root_id="root-art",
        source_key="Show/E01.mkv", relative_path="Show/E01.mkv", entry_kind="video",
        source_locator="C:/media/Show/E01.mkv", playback_locator="C:/media/Show/E01.mkv",
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-art", evidence_id=evidence.evidence_id,
        parser_version="fixture", work_title="Show", title_candidates=("Show",),
        media_type="tv", group_type="season", season_candidate=1, episode_candidate=1,
    )
    service = V4RevisionService(database)
    service.create_draft("rev-art", [(evidence, facts)], root_id="root-art", scan_id="scan-art")
    service.confirm("rev-art")
    with database.connect() as conn:
        work_id = str(conn.execute("SELECT work_id FROM revision_bindings WHERE revision_id='rev-art' LIMIT 1").fetchone()[0])
        conn.execute("INSERT INTO artwork_resources(resource_id, state, created_at) VALUES ('art-ready', 'ready', 'now'), ('art-pending', 'pending', 'now')")
        conn.execute("INSERT INTO artwork_bindings(subject_type, subject_id, work_id, role, candidate_id, revision_id) VALUES ('work', ?, ?, 'poster', 'art-ready', 'rev-art'), ('work', ?, ?, 'fanart', 'art-pending', 'rev-art')", (work_id, work_id, work_id, work_id))

    card = list_source_cards(database)[0]
    assert card["artwork_ready_count"] == 1
    assert card["artwork_total_count"] == 2


def test_export_includes_latest_metadata_problem_hierarchy_without_provider_payload(tmp_path):
    from app.media_v4.diagnostics.source_diagnostics import export_source_diagnostics
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.revisions.service import V4RevisionService

    database = _database(tmp_path)
    evidence = SourceEvidence(
        evidence_id="ev-metadata", scan_id="scan-metadata", root_id="root-metadata",
        source_key="Show/Season 2/E03.mkv", relative_path="Show/Season 2/E03.mkv", entry_kind="video",
        source_locator="C:/media/Show/Season 2/E03.mkv", playback_locator="C:/media/Show/Season 2/E03.mkv",
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-metadata", evidence_id=evidence.evidence_id,
        parser_version="fixture", work_title="Show", title_candidates=("Show",),
        media_type="tv", group_type="season", season_candidate=2, episode_candidate=3,
    )
    service = V4RevisionService(database)
    service.create_draft("rev-metadata", [(evidence, facts)], root_id="root-metadata", scan_id="scan-metadata")
    service.confirm("rev-metadata")
    with database.connect() as conn:
        work_id = str(conn.execute("SELECT work_id FROM revision_bindings WHERE revision_id='rev-metadata' LIMIT 1").fetchone()[0])
        conn.execute(
            "INSERT INTO scrape_bindings(binding_id, revision_id, work_id, provider, provider_id, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("scrape-metadata", "rev-metadata", work_id, "tmdb", "42", json.dumps({
                "metadata_state": "not_found", "reason_code": "provider_not_found",
                "reason": "No matching online work was found.",
                "poster_url": "https://image.example/private?api_key=must-not-export",
                "access_token": "binding secret with spaces",
            }), "not_found", "now", "2026-10-14T10:00:00Z"),
        )
        conn.execute(
            "INSERT INTO jobs(job_id, job_type, revision_id, work_id, idempotency_key, status, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("scrape-job-metadata", "scrape_work", "rev-metadata", work_id, "scrape-job-metadata-key", "succeeded",
             json.dumps({"outcome": "needs_attention", "work_metadata_status": "not_found", "reason_codes": ["provider_not_found"]}), "now", "2026-10-14T10:00:00Z"),
        )

    report = export_source_diagnostics(database, "root-metadata")
    problem = report["metadata_problems"][0]
    serialized = json.dumps(report, ensure_ascii=False)

    assert problem["source"] == "scrape_job"
    assert problem["job_status"] == "succeeded"
    assert problem["metadata_state"] == "not_found"
    assert problem["reason_code"] == "provider_not_found"
    assert problem["hierarchy"]["title"] == "Show"
    assert problem["hierarchy"]["seasons"][0]["number"] == 2
    assert problem["hierarchy"]["seasons"][0]["episodes"][0]["number"] == 3
    assert "poster_url" not in serialized
    assert "must-not-export" not in serialized
    assert "binding secret with spaces" not in serialized


def test_export_includes_all_unfinished_artwork_candidates_and_full_reasons(tmp_path):
    from app.media_v4.diagnostics.source_diagnostics import export_source_diagnostics
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.revisions.service import V4RevisionService

    database = _database(tmp_path)
    evidence = SourceEvidence(
        evidence_id="ev-art-report", scan_id="scan-art-report", root_id="root-art-report",
        source_key="Show/E01.mkv", relative_path="Show/E01.mkv", entry_kind="video",
        source_locator="C:/media/Show/E01.mkv", playback_locator="C:/media/Show/E01.mkv",
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-art-report", evidence_id=evidence.evidence_id,
        parser_version="fixture", work_title="Show", title_candidates=("Show",),
        media_type="tv", group_type="season", season_candidate=1, episode_candidate=1,
    )
    service = V4RevisionService(database)
    service.create_draft("rev-art-report", [(evidence, facts)], root_id="root-art-report", scan_id="scan-art-report")
    service.confirm("rev-art-report")
    long_reason = "failure detail " + ("x" * 700)
    with database.connect() as conn:
        work_id = str(conn.execute("SELECT work_id FROM revision_bindings WHERE revision_id='rev-art-report' LIMIT 1").fetchone()[0])
        states = [("failed", "network_error"), ("pending", ""), ("running", ""), ("retry", "rate_limited"), ("ready", "")]
        roles = [("work", "poster"), ("work", "fanart"), ("work", "clearlogo"), ("work", "profile"), ("episode", "episode_thumb")]
        for index, ((state, error_kind), (subject_type, role)) in enumerate(zip(states, roles, strict=True)):
            resource_id = f"resource-art-report-{index}"
            conn.execute(
                "INSERT INTO artwork_resources(resource_id, source_url, state, attempts, error_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (resource_id, "https://private.example/image?token=must-not-export", state, index, long_reason if state == "failed" else error_kind, "now"),
            )
            conn.execute(
                "INSERT INTO artwork_bindings(subject_type, subject_id, work_id, role, candidate_id, revision_id) VALUES (?, ?, ?, ?, ?, ?)",
                (subject_type, work_id if subject_type == "work" else "episode-art-report", work_id, role, resource_id, "rev-art-report"),
            )

    report = export_source_diagnostics(database, "root-art-report")
    artwork = report["unfinished_artwork"]

    assert {item["state"] for item in artwork} == {"failed", "pending", "running", "retry"}
    assert all(item["hierarchy"]["title"] == "Show" for item in artwork)
    failed = next(item for item in artwork if item["state"] == "failed")
    assert failed["reason"] == long_reason
    assert all("must-not-export" not in json.dumps(item) for item in artwork)


def test_safe_text_redacts_quoted_secrets_userinfo_query_and_headers_without_truncating():
    from app.media_v4.diagnostics.source_diagnostics import _safe_text

    long_error = "failure " + ("x" * 800)
    text = (
        '{"password": "quoted password with spaces", "access_token": "quoted token"}; '
        "password=plain password with spaces, "
        "https://private-user:private-pass@example.test/path?api_key=query key with spaces&next=ok; "
        "Authorization: Bearer header-secret; Bearer loose-secret; " + long_error
    )
    safe = _safe_text(text, limit=None)

    for secret in ("quoted password with spaces", "quoted token", "plain password with spaces", "private-user", "private-pass", "query key with spaces", "header-secret", "loose-secret"):
        assert secret not in safe
    assert long_error in safe


def test_unfinished_artwork_reuses_full_work_hierarchy_without_nested_growth(tmp_path):
    from app.media_v4.diagnostics.source_diagnostics import export_source_diagnostics
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.revisions.service import V4RevisionService

    database = _database(tmp_path)
    episode_count = 12
    evidence_facts = []
    for episode in range(1, episode_count + 1):
        evidence = SourceEvidence(
            evidence_id=f"ev-art-tree-{episode}", scan_id="scan-art-tree", root_id="root-art-tree",
            source_key=f"Show/S01E{episode:02}.mkv", relative_path=f"Show/S01E{episode:02}.mkv", entry_kind="video",
            source_locator=f"C:/media/Show/S01E{episode:02}.mkv", playback_locator=f"C:/media/Show/S01E{episode:02}.mkv",
        )
        facts = ParsedFacts(
            parsed_fact_id=f"facts-art-tree-{episode}", evidence_id=evidence.evidence_id,
            parser_version="fixture", work_title="Show", title_candidates=("Show",),
            media_type="tv", group_type="season", season_candidate=1, episode_candidate=episode,
        )
        evidence_facts.append((evidence, facts))

    service = V4RevisionService(database)
    service.create_draft("rev-art-tree", evidence_facts, root_id="root-art-tree", scan_id="scan-art-tree")
    service.confirm("rev-art-tree")
    with database.connect() as conn:
        work_id = str(conn.execute("SELECT work_id FROM revision_bindings WHERE revision_id='rev-art-tree' LIMIT 1").fetchone()[0])
        episode_ids = [str(row[0]) for row in conn.execute("SELECT DISTINCT episode_id FROM revision_bindings WHERE revision_id='rev-art-tree' AND episode_id IS NOT NULL")]
        for index, episode_id in enumerate(episode_ids):
            resource_id = f"resource-art-tree-{index}"
            conn.execute("INSERT INTO artwork_resources(resource_id, state, created_at) VALUES (?, 'pending', 'now')", (resource_id,))
            conn.execute(
                "INSERT INTO artwork_bindings(subject_type, subject_id, work_id, role, candidate_id, revision_id) VALUES ('episode', ?, ?, 'episode_thumb', ?, 'rev-art-tree')",
                (episode_id, work_id, resource_id),
            )

    report = export_source_diagnostics(database, "root-art-tree")
    artwork = report["unfinished_artwork"]
    full_hierarchy = report["work_hierarchies"][0]
    repeated_episode_count = sum(
        len(season["episodes"])
        for item in artwork
        for season in item["hierarchy"]["seasons"]
    )

    assert len(artwork) == episode_count
    assert len(full_hierarchy["seasons"][0]["episodes"]) == episode_count
    assert repeated_episode_count == episode_count
    assert all(len(item["hierarchy"]["seasons"][0]["episodes"]) == 1 for item in artwork)
