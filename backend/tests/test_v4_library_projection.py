"""V4 Library Projection 合同。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _remote_episode_artwork(monkeypatch):
    from app.core.config import AppConfig

    monkeypatch.setattr('app.media_v4.jobs.completeness.load_config', lambda: AppConfig(artwork_storage_mode='remote'))


def _entry(evidence_id: str):
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence

    evidence = SourceEvidence(
        evidence_id=evidence_id,
        scan_id="scan-projection",
        root_id="root-projection",
        source_key=evidence_id,
        relative_path=f"Show/{evidence_id}.mkv",
        entry_kind="video",
        provider="local",
        source_locator=f"local://{evidence_id}",
        playback_locator=str(Path.cwd() / "backend" / "tests" / "media-fixtures" / f"{evidence_id}.mkv"),
        fingerprint=f"sha256:{evidence_id}",
    )
    facts = ParsedFacts(
        parsed_fact_id=f"facts-{evidence_id}",
        evidence_id=evidence_id,
        parser_version="fixture",
        work_title="Show",
        title_candidates=("Show",),
        year_candidate=2024,
        media_type="tv",
        group_type="season",
        season_candidate=1,
        episode_candidate=1,
    )
    return evidence, facts


def _ready_library(database):
    """结构/事务用例也需具备真实发布前提：有效资料引用与图片记录。"""
    from backend.tests.artwork_fixtures import ready_artwork

    from app.media_v4.persistence.metadata_lifecycle import attach_snapshot_refs, publish_snapshot

    with database.connect() as conn:
        for row in conn.execute('SELECT DISTINCT revision_id,work_id FROM revision_bindings').fetchall():
            if not conn.execute('SELECT 1 FROM revision_metadata_refs WHERE revision_id=? AND work_id=?', tuple(row)).fetchone():
                existing = conn.execute('SELECT * FROM metadata_snapshots WHERE work_id=? ORDER BY created_at DESC LIMIT 1', (row['work_id'],)).fetchone()
                if existing:
                    attach_snapshot_refs(conn, row['revision_id'], row['work_id'], {**dict(existing), 'artifacts': []})
                    ready_artwork(conn, row['work_id'])
                    continue
                binding = conn.execute('SELECT metadata_json FROM scrape_bindings WHERE revision_id=? AND work_id=?', tuple(row)).fetchone()
                metadata = json.loads(binding[0]) if binding else {}
                title = conn.execute('SELECT preferred_title FROM works WHERE work_id=?', (row['work_id'],)).fetchone()[0]
                metadata = {'provider': 'tmdb', 'provider_id': '42', 'metadata_state': 'ready', 'title': title,
                            'episode_mappings': [{'episode_id': e[0], 'provider_episode_id': '1', 'title': 'Episode'}
                                                 for e in conn.execute('SELECT episode_id FROM episodes WHERE work_id=?', (row['work_id'],))], **metadata}
                for mapping in metadata['episode_mappings']:
                    mapping.setdefault('provider_episode_id', '1')
                publish_snapshot(conn, revision_id=row['revision_id'], work_id=row['work_id'],
                                 snapshot_id=f"fixture-{row['revision_id']}-{row['work_id']}", metadata=metadata, artifact_ids=[])
            ready_artwork(conn, row['work_id'])


def test_projection_exposes_only_explicit_reads_and_background_refresh():
    from app.media_v4.projection.library import V4LibraryProjection

    assert not hasattr(V4LibraryProjection, "ensure_current")
    assert "compact" not in __import__("inspect").signature(V4LibraryProjection.current).parameters


def test_projection_has_one_card_and_counts_all_assets(tmp_path):
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.projection.library import V4LibraryProjection
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "projection.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-1", [_entry("1080p"), _entry("2160p")])
    revisions.confirm("rev-1")

    _ready_library(database)
    snapshot = V4LibraryProjection(database).rebuild()

    assert len(snapshot.cards) == 1
    assert snapshot.cards[0]["title"] == "Show"
    assert snapshot.cards[0]["media_type"] == "tv"
    assert snapshot.cards[0]["episode_count"] == 1
    assert snapshot.cards[0]["asset_count"] == 2


def test_projection_can_be_deleted_and_rebuilt_from_sqlite_authority(tmp_path):
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.projection.library import V4LibraryProjection
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "projection-rebuild.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-1", [_entry("a")])
    revisions.confirm("rev-1")
    projection = V4LibraryProjection(database)
    _ready_library(database)
    first = projection.rebuild()
    with database.connect() as conn:
        conn.execute("DELETE FROM library_cards")
        conn.execute("DELETE FROM library_generations")
        conn.execute("DELETE FROM v4_meta WHERE key = 'current_library_generation'")
    second = projection.rebuild()

    assert second.digest == first.digest
    assert second.cards == first.cards


def test_same_work_across_revisions_reuses_work_episode_and_asset_identity(tmp_path):
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "stable-identities.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-1", [_entry("first")])
    revisions.confirm("rev-1")
    revisions.create_draft("rev-2", [_entry("second")])
    revisions.confirm("rev-2")

    with database.connect() as conn:
        works = conn.execute("SELECT work_id FROM works").fetchall()
        episodes = conn.execute("SELECT episode_id FROM episodes").fetchall()
        assets = conn.execute("SELECT asset_id FROM assets").fetchall()
        card = conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM revision_bindings rb
            JOIN works w ON w.work_id = rb.work_id
            WHERE rb.revision_id IN ('rev-1', 'rev-2')
            """
        ).fetchone()

    assert len(works) == 1
    assert len(episodes) == 1
    assert len(assets) == 2
    assert card["count"] == 2


def test_title_change_on_same_source_lineage_keeps_work_identity(tmp_path):
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "title-change.db")
    database.initialize()
    revisions = V4RevisionService(database)

    def entry(revision: str, title: str):
        evidence = SourceEvidence(
            evidence_id=f"evidence-{revision}",
            scan_id=f"scan-{revision}",
            root_id="root-title-change",
            source_key=f"Show/{revision}.mkv",
            relative_path=f"Show/{revision}.mkv",
            entry_kind="video",
            provider="local",
            playback_locator=str(Path.cwd() / "backend" / "tests" / "media-fixtures" / f"{revision}.mkv"),
        )
        facts = ParsedFacts(
            parsed_fact_id=f"facts-{revision}",
            evidence_id=evidence.evidence_id,
            parser_version="fixture",
            work_title=title,
            title_candidates=(title,),
            year_candidate=2024,
            media_type="tv",
            group_type="season",
            season_candidate=1,
            episode_candidate=1,
        )
        return evidence, facts

    revisions.create_draft("rev-title-1", [entry("one", "Old Title")])
    revisions.confirm("rev-title-1")
    revisions.create_draft("rev-title-2", [entry("two", "New Title")])
    revisions.confirm("rev-title-2")

    with database.connect() as conn:
        works = conn.execute("SELECT work_id, preferred_title FROM works").fetchall()

    assert len(works) == 1
    assert works[0]["preferred_title"] == "New Title"


def test_projection_waits_for_independent_artwork(tmp_path, monkeypatch):
    import base64

    import httpx

    from app.core.config import AppConfig
    from app.media_v4.assets import service as artwork_service
    from app.media_v4.assets.catalog import get_work_artwork
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.projection.library import V4LibraryProjection
    from app.media_v4.revisions.service import V4RevisionService

    config = AppConfig(tmdb_timeout=5)
    monkeypatch.setattr(artwork_service, "load_config", lambda: config)
    image = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="
    )
    requested_images = []

    def artwork_response(request):
        assert request.url.host == "image.tmdb.org"
        requested_images.append(str(request.url))
        return httpx.Response(200, content=image, headers={"content-type": "image/png"})

    monkeypatch.setattr(artwork_service, "_artwork_client", lambda _config: httpx.Client(
        transport=httpx.MockTransport(artwork_response),
    ))
    monkeypatch.setattr("app.core.url_guard.socket.getaddrinfo", lambda *_a, **_k: [
        (None, None, None, None, ("93.184.216.34", 443)),
    ])

    database = V4Database(tmp_path / "projection-metadata.db")
    database.initialize()
    service = V4RevisionService(database)
    service.create_draft("rev-metadata", [_entry("ev-meta")])
    service.confirm("rev-metadata")
    scrape_job = next(job for job in service.list_jobs("rev-metadata") if job["job_type"] == "scrape_work")
    V4ScrapeService(database).process(
        scrape_job["job_id"],
        lambda target: {
            "provider": "tmdb",
            "metadata_state": "ready",
            "provider_id": "42",
            "title": "Online Title",
            "original_title": "Original",
            "plot": "Plot",
            "rating": 8.4,
            "genres": ["Animation"],
            "poster_url": "https://image.tmdb.org/t/p/w780/poster.jpg",
            "fanart_url": "https://image.tmdb.org/t/p/original/fanart.jpg",
            "episode_mappings": [{
                "episode_id": episode["episode_id"],
                "provider_episode_id": "9001",
                "provider_season_number": episode["local_season_number"],
                "provider_episode_number": episode["local_episode_number"],
                "title": "Online Episode",
                "still_url": "https://image.tmdb.org/t/p/w500/still.jpg",
            } for episode in target["episodes"]],
        },
        mirror_root=tmp_path / "mirror",
    )

    assert V4LibraryProjection(database).rebuild().cards == ()
    assert requested_images == [], "资料发布与投影维护不下载图片"
    with database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM artifacts').fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM artwork_resources WHERE state='pending'").fetchone()[0] == 3
    generation_id = V4LibraryProjection(database).current().generation_id
    assert artwork_service.ArtworkService(database, tmp_path / 'image-store').process_available() == 3
    card = V4LibraryProjection(database).refresh_if_needed().cards[0]
    assert card["title"] == "Online Title"
    assert card["metadata"]["title"] == "Online Title"
    assert card["metadata"]["original_title"] == "Original"
    assert card["metadata"]["sources"] == ["local"]
    assert card["metadata"]["metadata_state"] == "ready"
    assert card["metadata"]["episode_mapping_status"] == "complete"
    assert card["metadata"]["episode_mappings"][0]["title"] == "Online Episode"
    assert set(requested_images) == {
        "https://image.tmdb.org/t/p/w780/poster.jpg",
        "https://image.tmdb.org/t/p/original/fanart.jpg",
        "https://image.tmdb.org/t/p/w500/still.jpg",
    }
    with database.connect() as conn:
        artwork = get_work_artwork(conn, card['work_id'])
        assert set(artwork) >= {'poster', 'fanart'}
        assert all(resource['state'] == 'ready' for resource in artwork.values())
        assert conn.execute('SELECT COUNT(*) FROM artifacts').fetchone()[0] == 0
    assert list((tmp_path / 'image-store').rglob('*.webp'))
    assert not (tmp_path / 'mirror').exists()
    assert V4LibraryProjection(database).current().generation_id == generation_id


def test_projection_does_not_check_files_for_selected_scrape_revision(tmp_path, monkeypatch):
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.projection.library import V4LibraryProjection
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "projection-revision-pair.db")
    database.initialize()
    revisions = V4RevisionService(database)

    def entry(root_id: str, scan_id: str, suffix: str):
        evidence = SourceEvidence(
            evidence_id=f"ev-{suffix}",
            scan_id=scan_id,
            root_id=root_id,
            source_key=f"Show/{suffix}.mkv",
            relative_path=f"Show/{suffix}.mkv",
            entry_kind="video",
            provider="local",
            source_locator=f"local://{suffix}",
            playback_locator=str(Path.cwd() / "backend" / "tests" / "media-fixtures" / f"{suffix}.mkv"),
        )
        facts = ParsedFacts(
            parsed_fact_id=f"facts-{suffix}",
            evidence_id=evidence.evidence_id,
            parser_version="fixture",
            work_title="Show",
            title_candidates=("Show",),
            year_candidate=2024,
            media_type="tv",
            group_type="season",
            season_candidate=1,
            episode_candidate=1,
            tmdb_hint_id=1,
            tmdb_hint_type='tv',
        )
        return evidence, facts

    revisions.create_draft("rev-a", [entry("root-a", "scan-a", "a")])
    revisions.confirm("rev-a")
    revisions.create_draft("rev-b", [entry("root-b", "scan-b", "b")])
    revisions.confirm("rev-b")
    with database.connect() as conn:
        work_id = str(conn.execute("SELECT work_id FROM works").fetchone()[0])
        conn.execute(
            """
            INSERT INTO scrape_bindings(
                binding_id, revision_id, work_id, provider, provider_id,
                metadata_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, 'tmdb', ?, ?, 'confirmed', ?, ?)
            """,
            (
                "binding-a",
                "rev-a",
                work_id,
                "1",
                '{"title":"A","metadata_state":"ready"}',
                "2026-09-09T00:00:00+00:00",
                "2026-09-09T02:00:00+00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO scrape_bindings(
                binding_id, revision_id, work_id, provider, provider_id,
                metadata_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, 'tmdb', ?, ?, 'failed', ?, ?)
            """,
            (
                "binding-b",
                "rev-b",
                work_id,
                "2",
                '{"title":"B","metadata_state":"failed"}',
                "2026-09-09T01:00:00+00:00",
                "2026-09-09T01:00:00+00:00",
            ),
        )

    with database.connect() as conn:
        from app.media_v4.persistence.metadata_lifecycle import publish_snapshot

        publish_snapshot(conn, revision_id='rev-a', work_id=work_id, snapshot_id='selected-a',
                         metadata={'provider': 'tmdb', 'provider_id': '1', 'title': 'A', 'metadata_state': 'ready',
                                   'episode_mappings': [{'episode_id': e[0], 'provider_episode_id': '1', 'title': 'Episode'}
                                                        for e in conn.execute('SELECT episode_id FROM episodes WHERE work_id=?', (work_id,))]},
                         artifact_ids=[])

    _ready_library(database)

    checked: list[str] = []

    def capture(_database, *, revision_id, work_id, metadata):
        del work_id, metadata
        checked.append(revision_id)
        return True, []

    monkeypatch.setattr(
        "app.media_v4.jobs.completeness.assess_persisted_completeness",
        capture,
    )

    card = V4LibraryProjection(database).rebuild().cards[0]

    assert card["metadata"]["title"] == "A"
    assert checked == []


def test_transient_refresh_failure_keeps_the_last_published_result(tmp_path, monkeypatch):
    """瞬时刷新失败保留身份适用的已发布 SQLite 快照。"""

    from app.media_v4.projection.library import V4LibraryProjection

    database = _two_bindings(tmp_path, failure_newer=True)
    checked: list[str] = []

    def capture(_database, *, revision_id, work_id, metadata):
        del work_id, metadata
        checked.append(revision_id)
        return True, []

    monkeypatch.setattr(
        "app.media_v4.jobs.completeness.assess_persisted_completeness",
        capture,
    )

    card = V4LibraryProjection(database).rebuild().cards[0]

    assert card["metadata"]["metadata_state"] == "ready", "刷新失败不应把已发布作品移出媒体墙"
    assert card["metadata"]["title"] == "A", "应显示上一次成功结果的资料"
    assert card["metadata"]["metadata_refresh_error"], "必须标注当前显示的是上一次成功结果"
    assert checked == [], "保留有效快照不检查镜像/NFO/图片"


def test_refresh_failure_keeps_metadata_when_previous_files_are_broken(tmp_path, monkeypatch):
    """图片或历史 NFO 故障不能反向废弃已确认且有效的资料。"""

    from app.media_v4.projection.library import V4LibraryProjection

    database = _two_bindings(tmp_path, failure_newer=True)
    monkeypatch.setattr(
        "app.media_v4.jobs.completeness.assess_persisted_completeness",
        lambda *_args, **_kwargs: pytest.fail('投影不得检查历史文件'),
    )

    card = V4LibraryProjection(database).rebuild().cards[0]

    assert card["metadata"]["metadata_state"] == "ready"
    assert card['metadata']['title'] == 'A'
    assert card['metadata']['metadata_refresh_error']


def test_older_failure_does_not_override_a_newer_success(tmp_path, monkeypatch):
    """反向顺序：失败行更旧时，最新成功结果照常生效（既有语义不变）。"""

    from app.media_v4.projection.library import V4LibraryProjection

    database = _two_bindings(tmp_path, failure_newer=False)
    monkeypatch.setattr(
        "app.media_v4.jobs.completeness.assess_persisted_completeness",
        lambda *_args, **_kwargs: (True, []),
    )

    card = V4LibraryProjection(database).rebuild().cards[0]

    assert card["metadata"]["metadata_state"] == "ready"
    assert card["metadata"]["title"] == "A"
    assert "metadata_refresh_error" not in card["metadata"]


def _two_bindings(tmp_path, *, failure_newer: bool):
    """同一来源连续确认后的真实旧成功快照与当前刷新状态。"""

    from app.media_v4.domain.models import ParsedFacts, SourceEvidence
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / ("refresh-newer-failure.db" if failure_newer else "refresh-older-failure.db"))
    database.initialize()
    revisions = V4RevisionService(database)

    def entry(root_id: str, scan_id: str, suffix: str):
        evidence = SourceEvidence(
            evidence_id=f"ev-{suffix}",
            scan_id=scan_id,
            root_id='root-refresh',
            source_key='Show/Show.S01E01.mkv',
            relative_path='Show/Show.S01E01.mkv',
            entry_kind="video",
            provider="local",
            source_locator='Z:/fixture/Show/Show.S01E01.mkv',
            playback_locator='Z:/fixture/Show/Show.S01E01.mkv',
            fingerprint='sha256:fixture-same-content',
        )
        facts = ParsedFacts(
            parsed_fact_id=f"facts-{suffix}",
            evidence_id=evidence.evidence_id,
            parser_version="fixture",
            work_title="Show",
            title_candidates=("Show",),
            year_candidate=2024,
            media_type="tv",
            group_type="season",
            season_candidate=1,
            episode_candidate=1,
            tmdb_hint_id=1,
            tmdb_hint_type='tv',
        )
        return evidence, facts

    revisions.create_draft("rev-a", [entry("root-a", "scan-a", "a")])
    revisions.confirm("rev-a")
    revisions.create_draft("rev-b", [entry("root-b", "scan-b", "b")])
    revisions.confirm("rev-b")

    if failure_newer:
        ready_at, failed_at = "2026-09-09T03:00:00+00:00", "2026-09-09T04:00:00+00:00"
    else:
        ready_at, failed_at = "2026-09-09T04:00:00+00:00", "2026-09-09T03:00:00+00:00"
    with database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM works').fetchone()[0] == 1
        work_id = str(conn.execute("SELECT work_id FROM works").fetchone()[0])
        conn.execute(
            """
            INSERT INTO scrape_bindings(
                binding_id, revision_id, work_id, provider, provider_id,
                metadata_json, status, created_at, updated_at
            ) VALUES ('binding-a', 'rev-a', ?, 'tmdb', '1', ?, 'confirmed', ?, ?)
            """,
            (
                work_id,
                json.dumps({
                    'title': 'A', 'metadata_state': 'ready',
                    'poster_url': 'https://image.tmdb.org/t/p/w500/a.jpg',
                    'episode_mappings': [
                        {'episode_id': row['episode_id'], 'provider_episode_id': '9001', 'title': 'Episode',
                         'still_url': 'https://image.tmdb.org/t/p/w500/still.jpg'}
                        for row in conn.execute('SELECT episode_id FROM episodes')
                    ],
                }),
                "2026-09-09T00:00:00+00:00",
                ready_at,
            ),
        )
        conn.execute(
            """
            INSERT INTO scrape_bindings(
                binding_id, revision_id, work_id, provider, provider_id,
                metadata_json, status, created_at, updated_at
            ) VALUES ('binding-b', 'rev-b', ?, 'tmdb', '2', ?, 'failed', ?, ?)
            """,
            (
                work_id,
                '{"metadata_state":"failed","reason":"在线资料服务暂不可用，请稍后重试","reason_code":"source_unavailable"}',
                "2026-09-09T00:30:00+00:00",
                failed_at,
            ),
        )
        from app.media_v4.persistence.metadata_lifecycle import attach_snapshot_refs, publish_snapshot

        metadata = json.loads(conn.execute("SELECT metadata_json FROM scrape_bindings WHERE binding_id='binding-a'").fetchone()[0])
        metadata.update(provider='tmdb', provider_id='1', media_type='tv')
        snapshot = publish_snapshot(conn, revision_id='rev-a', work_id=work_id, snapshot_id='snapshot-ready-a',
                                    metadata=metadata, artifact_ids=[])
        attach_snapshot_refs(conn, 'rev-b', work_id, snapshot)
        conn.execute("UPDATE revision_metadata_refs SET created_at=? WHERE revision_id='rev-a'", (ready_at,))
        conn.execute("UPDATE revision_metadata_refs SET created_at=? WHERE revision_id='rev-b'", (failed_at,))
        conn.execute("UPDATE jobs SET status=?,last_error=?,updated_at=? WHERE revision_id='rev-b' AND job_type='scrape_work'",
                     ('failed' if failure_newer else 'succeeded', 'fixture temporary failure' if failure_newer else '', failed_at))
    _ready_library(database)
    return database


def test_current_reads_generation_and_cards_from_one_snapshot(tmp_path, monkeypatch):
    """读 generation 与读 cards 之间发生并发 rebuild 时，不能返回空媒体墙。

    并发 rebuild 的收尾是 `DELETE FROM library_generations WHERE generation_id != ?`，
    而 `library_cards` 是 ON DELETE CASCADE。没有读事务时（sqlite3 默认 autocommit，
    每条 SELECT 各看一次最新提交），cards 查询会落在旧 generation 已被删除之后，
    返回空集 —— `/api/library` 的 works 直接来自 cards，于是媒体墙在一切正常的情况下
    瞬间清空；读接口始终只读取已发布代次。
    """

    from app.media_v4.persistence.database import V4Database
    from app.media_v4.projection.library import V4LibraryProjection
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "snapshot.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-1", [_entry("1080p")])
    revisions.confirm("rev-1")
    projection = V4LibraryProjection(database)
    _ready_library(database)
    assert projection.rebuild().cards, "前置条件：至少有一张已发布的卡"
    assert projection.current().cards

    real_open_connection = V4Database.open_connection
    state = {"armed": True}

    class _RacingConnection:
        """读到 cards 之前先让另一个连接提交一次 rebuild（模拟并发收尾）。"""

        def __init__(self, real):
            self._real = real

        def execute(self, sql, *args, **kwargs):
            if state["armed"] and "FROM library_cards" in str(sql):
                state["armed"] = False
                V4LibraryProjection(database).rebuild()
            return self._real.execute(sql, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self._real, name)

    monkeypatch.setattr(
        V4Database,
        "open_connection",
        lambda self: _RacingConnection(real_open_connection(self)),
    )

    snapshot = projection.current()

    assert snapshot is not None
    assert snapshot.cards, "读事务必须保证 generation 与 cards 来自同一快照"

    # 反证：同样的竞态下**不**包读事务会返回空 cards——说明本用例确实在检验该修复，
    # 而不是靠运气通过。
    state["armed"] = True
    with database.connect() as conn:
        bare = V4LibraryProjection._read_current(conn)

    assert bare is not None
    assert bare.cards == ()
