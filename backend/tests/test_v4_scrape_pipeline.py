"""V4 刮削任务合同。"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest


def _entry(evidence_id: str):
    from app.media_v4.domain.models import ParsedFacts, SourceEvidence

    evidence = SourceEvidence(
        evidence_id=evidence_id,
        scan_id="scan-scrape",
        root_id="root-scrape",
        source_key=evidence_id,
        relative_path=f"Show/{evidence_id}.mkv",
        entry_kind="video",
        provider="local",
        source_locator=rf"C:\\KumiPlayerFixture\\{evidence_id}.mkv",
        playback_locator=rf"C:\\KumiPlayerFixture\\{evidence_id}.mkv",
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
        tmdb_hint_id=42,
        tmdb_hint_type="tv",
    )
    return evidence, facts



def _patch_scrape_env(tmp_path, monkeypatch):
    """完整性必经：测试内显式给出镜像根与 remote artwork 配置，避免触碰真实 data/。"""

    from types import SimpleNamespace

    from app.media_v4.jobs import completeness as completeness_module
    from app.media_v4.jobs import metadata_artifacts as artifacts_module

    monkeypatch.setattr(artifacts_module, "load_config", lambda: SimpleNamespace(
        artwork_storage_mode="remote", tmdb_timeout=5, proxy_url=None,
    ))
    monkeypatch.setattr(completeness_module, "load_config", lambda: SimpleNamespace(
        artwork_storage_mode="remote", tmdb_timeout=5, proxy_url=None,
    ))
    return tmp_path / "mirror"


def _ready_metadata(provider_id="42", target=None):
    result = {
        "provider": "tmdb",
        "provider_id": provider_id,
        "media_type": "tv",
        "title": "Show",
        "metadata_state": "ready",
        "poster_url": "https://image.tmdb.org/t/p/w780/p.jpg",
        "fanart_url": "https://image.tmdb.org/t/p/original/f.jpg",
    }
    if target is not None:
        result['episode_mappings'] = [
            {'episode_id': item['episode_id'], 'provider_episode_id': '9001', 'title': 'Episode',
             'provider_season_number': item['local_season_number'],
             'provider_episode_number': item['local_episode_number'],
             'still_url': 'https://image.tmdb.org/t/p/w500/still.jpg'}
            for item in target['episodes']
        ]
    return result


def test_movie_metadata_snapshots_only_explicit_tmdb_collection_members():
    from app.media_v4.jobs.metadata import _tmdb_collection_related_works

    class Client:
        def __init__(self):
            self.collection_ids = []

        def get_collection_detail(self, collection_id):
            self.collection_ids.append(collection_id)
            return {"parts": [
                {"id": 1, "media_type": "movie", "title": "当前电影", "poster_path": "/self.jpg"},
                {"id": 2, "media_type": "movie", "title": "合集成员", "original_title": "Member", "poster_path": "/member.jpg", "release_date": "2024-05-01"},
                {"id": 3, "media_type": "movie", "title": "缺图电影"},
                {"id": 4, "media_type": "tv", "name": "TV 条目", "poster_path": "/tv.jpg"},
            ]}

        @staticmethod
        def build_image_url(path, size):
            return f"https://image.tmdb.org/t/p/{size}{path}"

    client = Client()
    result = _tmdb_collection_related_works(client, {
        "id": 1, "belongs_to_collection": {"id": 77},
    })
    assert client.collection_ids == [77]
    assert result == [{
        "provider": "tmdb", "provider_id": "2", "media_type": "movie",
        "title": "合集成员", "original_title": "Member", "year": 2024,
        "relation_type": "tmdb_collection",
        "poster_url": "https://image.tmdb.org/t/p/w500/member.jpg",
    }]


def test_movie_metadata_does_not_fetch_relation_without_confirmed_collection_identity():
    from app.media_v4.jobs.metadata import _tmdb_collection_related_works

    class Client:
        def get_collection_detail(self, _collection_id):
            raise AssertionError("movie without belongs_to_collection must not perform a relation lookup")

    assert _tmdb_collection_related_works(Client(), {"id": 1}) == []

def test_scrape_targets_are_grouped_by_work_and_do_not_reparse(tmp_path, monkeypatch):
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "scrape.db")
    database.initialize()
    revision_service = V4RevisionService(database)
    revision_service.create_draft("rev-scrape", [_entry("a"), _entry("b")])
    revision_service.confirm("rev-scrape")
    scrape = V4ScrapeService(database)
    jobs = scrape.enqueue_for_revision("rev-scrape")

    assert len(jobs) == 1
    monkeypatch.setattr(
        "app.recognition.media.recognize_media",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("scrape 不得重新识别")),
    )
    mirror_root = _patch_scrape_env(tmp_path, monkeypatch)
    scrape.process(jobs[0]["job_id"], lambda _work: _ready_metadata("42"), mirror_root=mirror_root)

    bindings = scrape.list_bindings("rev-scrape")
    assert len(bindings) == 1
    assert bindings[0]["provider_id"] == "42"


def test_scrape_metadata_does_not_overwrite_local_episode_number(tmp_path, monkeypatch):
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "scrape-fields.db")
    database.initialize()
    revision_service = V4RevisionService(database)
    revision_service.create_draft("rev-scrape", [_entry("a")])
    revision_service.confirm("rev-scrape")
    scrape = V4ScrapeService(database)
    jobs = scrape.enqueue_for_revision("rev-scrape")
    with database.connect() as conn:
        episode_id = conn.execute("SELECT episode_id FROM episodes").fetchone()[0]
        season_id = conn.execute("SELECT season_id FROM seasons").fetchone()[0]
    scrape.process(
        jobs[0]["job_id"],
        lambda _work: {
            "provider": "tmdb",
            "provider_id": "42",
            "episode_mappings": [{
                "episode_id": episode_id,
                "provider_season_number": 9,
                "provider_episode_number": 99,
            }],
            "season_mappings": [{
                "season_id": season_id,
                "provider_season_number": 9,
            }],
            **_ready_metadata(),
        },
        mirror_root=_patch_scrape_env(tmp_path, monkeypatch),
    )

    with database.connect() as conn:
        row = conn.execute("SELECT local_episode_number FROM episodes").fetchone()
        episode_mapping = conn.execute(
            "SELECT provider_season_number, provider_episode_number FROM episode_provider_mappings"
        ).fetchone()
        season_mapping = conn.execute(
            "SELECT provider_season_number FROM season_provider_mappings"
        ).fetchone()
    assert row["local_episode_number"] == 1
    assert tuple(episode_mapping) == (9, 99)
    assert season_mapping["provider_season_number"] == 9


def test_partial_metadata_keeps_provider_identity_for_retry(tmp_path):
    """季度资料暂不可用时仍保留 TMDB 作品绑定，避免下次重新搜索。"""

    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "partial-metadata.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-partial", [_entry("a")])
    revisions.confirm("rev-partial")
    scrape = V4ScrapeService(database)
    job = scrape.enqueue_for_revision("rev-partial")[0]
    with database.connect() as conn:
        episode_id = str(conn.execute("SELECT episode_id FROM episodes").fetchone()[0])

    scrape.process(
        job["job_id"],
        lambda _target: {
            "provider": "tmdb",
            "provider_id": "42",
            "media_type": "tv",
            "title": "Show",
            "metadata_state": "source_unavailable",
            "reason": "部分剧集资料暂不可用，已保留作品信息，可稍后重试",
            "reason_code": "episode_mapping_incomplete",
            "episode_mappings": [{
                "episode_id": episode_id,
                "provider_season_number": 1,
                "provider_episode_number": 1,
                "provider_episode_id": "9001",
            }],
        },
    )

    with database.connect() as conn:
        binding = conn.execute(
            "SELECT provider, provider_id, status, metadata_json FROM scrape_bindings WHERE revision_id = 'rev-partial'"
        ).fetchone()
        mapping = conn.execute(
            "SELECT provider, provider_episode_id FROM episode_provider_mappings WHERE episode_id = ?",
            (episode_id,),
        ).fetchone()

    assert tuple(binding[:3]) == ("tmdb", "42", "source_unavailable")
    assert json.loads(binding["metadata_json"])["reason_code"] == "episode_mapping_incomplete"
    assert tuple(mapping) == ("tmdb", "9001")


def test_retry_drops_stale_special_mapping_marked_by_metadata_provider():
    from app.media_v4.jobs.scrape import _retain_successful_details

    previous = {
        "provider": "tmdb",
        "provider_id": "42",
        "work_metadata_status": "ready",
        "episode_mappings": [
            {"episode_id": "regular-1", "provider_episode_id": "1001"},
            {"episode_id": "special-1", "provider_episode_id": "9001"},
        ],
    }
    current = {
        "provider": "tmdb",
        "provider_id": "42",
        "metadata_state": "ready",
        "work_metadata_status": "ready",
        "clear_episode_mapping_ids": ["special-1"],
        "episode_mappings": [],
    }

    result = _retain_successful_details(
        previous,
        current,
        {"episodes": [{"episode_id": "regular-1"}, {"episode_id": "special-1"}]},
    )

    assert result["episode_mappings"] == [
        {"episode_id": "regular-1", "provider_episode_id": "1001"},
    ]


def test_scrape_retry_preserves_local_special_mapping_and_only_requests_regular_season(tmp_path, monkeypatch):
    """特别篇不进入在线范围；失败与重试都保留历史映射和本地事实。"""

    from app.media_v4.jobs import metadata
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "stale-special-mapping.db")
    database.initialize()
    regular_evidence, regular_facts = _entry("regular")
    special_evidence, special_facts = _entry("special")
    special_evidence = replace(
        special_evidence,
        relative_path="Show/Specials/Mystery Camp.mkv",
        source_key="Show/Specials/Mystery Camp.mkv",
    )
    special_facts = replace(
        special_facts,
        group_type="special",
        season_candidate=0,
        episode_candidate=None,
        episode_title="Mystery Camp",
        special_candidate=True,
        special_number=1,
    )
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-stale-special", [
        (regular_evidence, regular_facts),
        (special_evidence, special_facts),
    ])
    revisions.confirm("rev-stale-special")
    scrape = V4ScrapeService(database)
    job = scrape.enqueue_for_revision("rev-stale-special")[0]
    with database.connect() as conn:
        # 新准入合同排除特别篇；此测试显式构造旧库绑定，继续验证历史映射不被重试删除。
        assert conn.execute("SELECT COUNT(*) FROM episodes WHERE episode_kind='special'").fetchone()[0] == 0
        legacy_season = "legacy-special-season"
        legacy_episode = "legacy-special-episode"
        conn.execute("INSERT INTO seasons(season_id,work_id,local_season_number,season_kind) VALUES (?, ?, 0, 'special')",
                     (legacy_season, job["work_id"]))
        conn.execute("INSERT INTO episodes(episode_id,work_id,season_id,special_number,episode_kind,display_title) "
                     "VALUES (?, ?, ?, 1, 'special', 'Mystery Camp')",
                     (legacy_episode, job["work_id"], legacy_season))
        conn.execute("INSERT INTO revision_bindings(binding_id,revision_id,evidence_id,work_id,season_id,episode_id) "
                     "VALUES ('legacy-special-binding', 'rev-stale-special', ?, ?, ?, ?)",
                     (special_evidence.evidence_id, job["work_id"], legacy_season, legacy_episode))
        episode_rows = conn.execute(
            "SELECT episode_id, episode_kind FROM episodes ORDER BY episode_id"
        ).fetchall()
        regular_id = str(next(row["episode_id"] for row in episode_rows if row["episode_kind"] == "regular"))
        special_id = str(next(row["episode_id"] for row in episode_rows if row["episode_kind"] == "special"))
        conn.execute(
            "INSERT INTO episode_provider_mappings(episode_id, provider, provider_season_number, provider_episode_number, provider_episode_id) "
            "VALUES (?, 'tmdb', 0, 1, 'stale-special-id')",
            (special_id,),
        )

        original_facts = [tuple(row) for row in conn.execute("SELECT * FROM parsed_facts ORDER BY parsed_fact_id")]
    requested = []
    unavailable = True

    class OfflineProvider:
        def get_tv_season_episodes(self, _provider_id, season):
            requested.append(season)
            assert season != 0
            if unavailable:
                raise metadata.TMDBClientError("fixture unavailable")
            return {"episodes": [{"id": "regular-id", "episode_number": 1,
                                  "name": "Episode", "still_path": "/still.jpg"}]}

        @staticmethod
        def build_image_url(path, size):
            return f"https://image.tmdb.org/t/p/{size}{path}"

    def provider(target):
        assert [episode["episode_id"] for episode in target["episodes"]] == [regular_id]
        diagnostics = metadata._empty_mapping_diagnostics()
        season_results = []
        mappings = metadata._build_tv_episode_mappings(
            OfflineProvider(), 42, target, work_detail={"seasons": [{"season_number": 1}]},
            diagnostics=diagnostics, season_results=season_results,
        )
        return {**_ready_metadata(), "episode_mappings": mappings, "season_results": season_results,
                "_mapping_diagnostics": diagnostics, "metadata_state": "source_unavailable" if unavailable else "ready",
                "work_metadata_status": "ready", "retryable": unavailable}

    mirror = _patch_scrape_env(tmp_path, monkeypatch)
    scrape.process(job["job_id"], provider, mirror_root=mirror)
    with database.connect() as conn:
        first = json.loads(conn.execute("SELECT result_json FROM jobs WHERE job_id=?", (job["job_id"],)).fetchone()[0])
        assert first["outcome"] == "unavailable"
        assert first["retryable"] is True
        assert conn.execute("SELECT provider_episode_id FROM episode_provider_mappings WHERE episode_id=?",
                            (special_id,)).fetchone()[0] == "stale-special-id"
        assert conn.execute("SELECT COUNT(*) FROM episode_provider_mappings WHERE episode_id=?", (regular_id,)).fetchone()[0] == 0
    unavailable = False
    retry = scrape.requeue_work("rev-stale-special", job["work_id"])
    scrape.process(retry["job_id"], provider, mirror_root=mirror)

    with database.connect() as conn:
        regular_mapping = conn.execute(
            "SELECT provider_episode_id FROM episode_provider_mappings WHERE episode_id = ? AND provider = 'tmdb'",
            (regular_id,),
        ).fetchone()
        stale_mapping = conn.execute(
            "SELECT provider_episode_id FROM episode_provider_mappings WHERE episode_id = ? AND provider = 'tmdb'",
            (special_id,),
        ).fetchone()
        assert [tuple(row) for row in conn.execute("SELECT * FROM parsed_facts ORDER BY parsed_fact_id")] == original_facts

    assert regular_mapping["provider_episode_id"] == "regular-id"
    assert stale_mapping["provider_episode_id"] == "stale-special-id"
    assert requested == [1, 1]
    binding = scrape.list_bindings("rev-stale-special")[0]
    assert json.loads(binding["metadata_json"])["metadata_state"] == "ready"


@pytest.mark.parametrize("retry_provider_id", ["42", "43"])
def test_retry_keeps_successful_details_only_for_same_identity(tmp_path, retry_provider_id):
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "retry.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-retry", [_entry("a")])
    revisions.confirm("rev-retry")
    scrape = V4ScrapeService(database)
    job = scrape.enqueue_for_revision("rev-retry")[0]
    with database.connect() as conn:
        episode_id = str(conn.execute("SELECT episode_id FROM episodes").fetchone()[0])
    previous = {
        "provider": "tmdb", "provider_id": "42", "media_type": "tv",
        "title": "Online title", "plot": "Retained plot",
        "work_metadata_status": "ready", "metadata_state": "source_unavailable",
        "episode_mappings": [{"episode_id": episode_id, "provider_episode_id": "9001", "title": "Online episode"}],
    }
    scrape.process(job["job_id"], lambda _target: previous)
    with database.connect() as conn:
        # 模拟用户明确改绑：旧身份资料不能带到新身份。
        conn.execute("UPDATE provider_bindings SET provider_id = ?", (retry_provider_id,))
    scrape.requeue_work("rev-retry", job["work_id"])
    scrape.process(job["job_id"], lambda _target: {
        "provider": "tmdb", "provider_id": retry_provider_id, "media_type": "tv",
        "title": "Show", "work_metadata_status": "unavailable",
        "metadata_state": "source_unavailable", "reason_code": "provider_rate_limited",
        "episode_mappings": [], "retryable": True,
    })
    detail = revisions.get_work_execution_detail("rev-retry", job["work_id"])
    assert detail["work"]["metadata_state"] == "source_unavailable"
    assert detail["work"]["metadata_reason_code"] == "provider_rate_limited"
    if retry_provider_id == "42":
        assert detail["scrape"]["plot"] == "Retained plot"
        assert detail["scrape"]["title"] == "Online title"
        assert detail["episodes"][0]["scraped_title"] == "Online episode"
    else:
        assert detail["scrape"]["plot"] == ""
        assert detail["episodes"][0]["scraped_title"] == ""


def test_missing_episode_artwork_keeps_work_metadata_ready(tmp_path, monkeypatch):
    """缺少 still 不会把在线 metadata 快照改成失败。"""

    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "artifact-degraded.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-artifact", [_entry("a")])
    revisions.confirm("rev-artifact")
    scrape = V4ScrapeService(database)
    job = scrape.enqueue_for_revision("rev-artifact")[0]

    # 在线资料完成但该 episode 没有 still URL；图片准备状态独立于 metadata。
    scrape.process(
        job["job_id"],
        lambda _target: {**_ready_metadata(target=_target), "poster_url": "", "fanart_url": ""},
    )

    detail = revisions.get_work_execution_detail("rev-artifact", job["work_id"])
    assert detail["work"]["metadata_state"] == "ready"
    assert detail["artwork"]["status"] in {"pending", "not_required"}
    with database.connect() as conn:
        binding_status = str(conn.execute(
            "SELECT status FROM scrape_bindings WHERE revision_id = 'rev-artifact' AND work_id = ?",
            (job["work_id"],),
        ).fetchone()[0])
        stored = json.loads(str(conn.execute(
            "SELECT metadata_json FROM scrape_bindings WHERE revision_id = 'rev-artifact' AND work_id = ?",
            (job["work_id"],),
        ).fetchone()[0]))
    assert binding_status == "confirmed"
    assert stored["metadata_state"] == "ready"


def test_legacy_missing_local_thumbnail_preserves_metadata_without_rewriting_data(tmp_path, monkeypatch):
    """资料与图片状态分离；图片降级仍诚实保留，原记录只读。"""

    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "legacy-artifact.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-legacy", [_entry("a")])
    revisions.confirm("rev-legacy")
    with database.connect() as conn:
        work_id = str(conn.execute(
            "SELECT work_id FROM revision_bindings WHERE revision_id = 'rev-legacy' "
            "AND work_id != '' LIMIT 1"
        ).fetchone()[0])
        legacy_metadata = {
            "provider": "tmdb", "provider_id": "42", "media_type": "tv", "title": "Show",
            "metadata_state": "failed", "reason": "海报下载或发布失败",
            "completeness": ["海报下载或发布失败"],
            "episode_mappings": [{
                "episode_id": conn.execute('SELECT episode_id FROM episodes').fetchone()[0],
                "provider_episode_id": "9001", "title": "Episode",
                "still_url": "https://image.tmdb.org/t/p/w500/still.jpg",
            }],
        }
        conn.execute(
            "INSERT INTO scrape_bindings (binding_id, revision_id, work_id, provider, provider_id, "
            "metadata_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                "binding-legacy", "rev-legacy", work_id, "tmdb", "42",
                json.dumps(legacy_metadata, ensure_ascii=False), "failed",
                "2026-09-15T00:00:00", "2026-09-15T00:00:00",
            ),
        )

    detail = revisions.get_work_execution_detail("rev-legacy", work_id)
    assert detail["work"]["metadata_state"] == "ready"
    assert detail["work"]["metadata_reason_code"] != "episode_artwork_incomplete"
    # 资料仍有效，但未提供必需海报/背景，不能冒充无需图片。
    assert detail["work"]["artifact_state"] == "degraded"
    assert all(any(label in reason for reason in detail["work"]["artifact_reasons"])
               for label in ("海报", "背景图", "预览图"))
    # 只读归一：数据库里的历史失败记录保持原样。
    with database.connect() as conn:
        raw = str(conn.execute(
            "SELECT metadata_json FROM scrape_bindings WHERE binding_id = 'binding-legacy'"
        ).fetchone()[0])
    assert json.loads(raw)["metadata_state"] == "failed"


def test_retry_artifacts_requeues_persisted_requirements_without_provider_call(tmp_path):
    """显式重试唤醒失败的 artwork 资源，不重新请求 metadata Provider。"""

    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "artifact-retry.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-retry-artifact", [_entry("a")])
    revisions.confirm("rev-retry-artifact")
    scrape = V4ScrapeService(database)
    job = scrape.enqueue_for_revision("rev-retry-artifact")[0]
    scrape.process(
        job["job_id"],
        lambda _target: _ready_metadata(target=_target),
    )
    with database.connect() as conn:
        before = conn.execute(
            "SELECT metadata_json FROM scrape_bindings WHERE revision_id='rev-retry-artifact'"
        ).fetchone()[0]
        failed = conn.execute(
            "UPDATE artwork_resources SET state='failed',attempts=1,error_kind='network' "
            "WHERE resource_id IN (SELECT candidate_id FROM artwork_bindings WHERE work_id=?)",
            (job["work_id"],),
        ).rowcount
    assert failed > 0

    result = scrape.retry_artifacts("rev-retry-artifact", job["work_id"])

    assert result["requeued"] == failed
    with database.connect() as conn:
        after = conn.execute(
            "SELECT metadata_json FROM scrape_bindings WHERE revision_id='rev-retry-artifact'"
        ).fetchone()[0]
        queued = conn.execute(
            "SELECT COUNT(*) FROM artwork_resources WHERE state='pending'"
        ).fetchone()[0]
    assert after == before
    assert queued >= failed


@pytest.mark.parametrize("candidate_found", [False, True])
def test_confirmed_scrape_receives_regular_alias_but_not_bonus_or_history(tmp_path, monkeypatch, candidate_found):
    """从确认到真实搜索入口检查标题传递，不能只给 provider 手工塞标题。"""

    from types import SimpleNamespace

    from app.media_v4.jobs import metadata
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "confirmed-alias.db")
    database.initialize()
    entries = []
    for key, alias, special in [("regular", "Original Work", False), ("bonus", "Other Show", True)]:
        evidence, facts = _entry(key)
        entries.append((evidence, replace(
            facts, work_title="本地化名称", title_candidates=("本地化名称", alias),
            tmdb_hint_id=None, tmdb_hint_type="", group_type="special" if special else "season",
            special_candidate=special, special_number=1 if special else None,
        )))
    service = V4RevisionService(database)
    service.create_draft("rev-alias-chain", entries)
    service.confirm("rev-alias-chain")
    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works").fetchone()[0]
        conn.execute(
            "INSERT INTO work_aliases(work_id, normalized_title, alias_type) VALUES (?, 'Historical Wrong', 'observed')",
            (work_id,),
        )

    queries = []

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def search_tv(self, query, year):
            queries.append(query)
            return [{
                "id": 91234, "name": "Original Work", "original_name": "Original Work",
                "first_air_date": "2022-01-01", "genre_ids": [16],
            }] if candidate_found and query == "Original Work" else []

        def get_tv_detail(self, provider_id):
            assert provider_id == 91234
            return {
                "name": "Original Work", "original_name": "Original Work",
                "first_air_date": "2022-01-01", "poster_path": "/p.jpg", "backdrop_path": "/f.jpg",
                "genres": [{"id": 16, "name": "Animation"}],
            }

        def get_tv_season_episodes(self, provider_id, season):
            assert provider_id == 91234
            return {"episodes": [{"id": 9000 + season, "episode_number": 1, "name": "Episode", "still_path": "/still.jpg"}]}

        @staticmethod
        def select_best_poster(_images):
            return ""

        select_best_backdrop = select_best_poster
        select_best_logo = select_best_poster

        @staticmethod
        def build_image_url(path, size):
            return f"https://image.tmdb.org/t/p/{size}{path}"

    monkeypatch.setattr(metadata, "load_config", lambda: SimpleNamespace(tmdb_bearer_token="fixture"))
    monkeypatch.setattr(metadata, "TMDBClient", Client)
    scrape = V4ScrapeService(database)
    job = scrape.enqueue_for_revision("rev-alias-chain")[0]
    results = []

    def provider(target):
        result = metadata.default_metadata_provider(target)
        results.append(result)
        return result

    scrape.process(job["job_id"], provider, mirror_root=_patch_scrape_env(tmp_path, monkeypatch))

    assert queries == ["本地化名称", "Original Work"]
    binding = scrape.list_bindings("rev-alias-chain")[0]
    # 服务确实没有返回候选时仍须如实待处理，不能为了零报错伪造成功。
    if candidate_found:
        assert results[0]["candidate_decision"]["decision"] == "auto_adopted"
        assert results[0]["metadata_state"] == "ready"
        assert binding["provider_id"] == "91234"
        assert binding["status"] != "waiting_review"
    else:
        assert binding["status"] == "waiting_review"


def test_scrape_shared_provider_identity_keeps_both_local_works_playable(tmp_path, monkeypatch):
    """不同本地作品共享在线资料时，刮削不应进入人工处理或丢掉映射。"""

    from dataclasses import replace

    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "scrape-provider-conflict.db")
    database.initialize()
    revisions = V4RevisionService(database)

    owner_evidence, owner_facts = _entry("owner")
    owner_evidence = replace(
        owner_evidence,
        relative_path="Owner Show/S01E01.mkv",
        source_key="Owner Show/S01E01.mkv",
    )
    owner_facts = replace(
        owner_facts,
        work_title="Owner Show",
        title_candidates=("Owner Show",),
        tmdb_hint_id=None,
        tmdb_hint_type="",
    )
    revisions.create_draft("rev-owner-scrape", [(owner_evidence, owner_facts)])
    revisions.confirm("rev-owner-scrape")
    owner_job = V4ScrapeService(database).enqueue_for_revision("rev-owner-scrape")[0]
    mirror_root = _patch_scrape_env(tmp_path, monkeypatch)
    V4ScrapeService(database).process(
        owner_job["job_id"],
        lambda _target: {**_ready_metadata("99"), "title": "Owner Show"},
        mirror_root=mirror_root,
    )

    target_evidence, target_facts = _entry("target")
    target_evidence = replace(
        target_evidence,
        root_id="root-target",
        scan_id="scan-target",
        relative_path="Target Show/S01E01.mkv",
        source_key="Target Show/S01E01.mkv",
    )
    target_facts = replace(
        target_facts,
        work_title="Target Show",
        title_candidates=("Target Show",),
        tmdb_hint_id=None,
        tmdb_hint_type="",
    )
    revisions.create_draft("rev-target-scrape", [(target_evidence, target_facts)])
    revisions.confirm("rev-target-scrape")
    target_job = V4ScrapeService(database).enqueue_for_revision("rev-target-scrape")[0]
    with database.connect() as conn:
        target_episode = conn.execute(
            "SELECT episode_id, season_id FROM episodes WHERE work_id = ("
            "SELECT work_id FROM revision_bindings WHERE revision_id = 'rev-target-scrape' LIMIT 1"
            ") LIMIT 1"
        ).fetchone()
        target_episode_id = str(target_episode["episode_id"])
        target_season_id = str(target_episode["season_id"])

    V4ScrapeService(database).process(
        target_job["job_id"],
        lambda _target: {
            **_ready_metadata("99"),
            "title": "Target Show",
            "episode_mappings": [{
                "episode_id": target_episode_id,
                "provider_episode_id": "9901",
                "title": "Episode",
                "still_url": "https://image.tmdb.org/t/p/w500/still.jpg",
            }],
            "season_mappings": [{
                "season_id": target_season_id,
                "provider_season_id": "990",
            }],
        },
        mirror_root=mirror_root,
    )

    with database.connect() as conn:
        job = conn.execute("SELECT status, last_error FROM jobs WHERE job_id = ?", (target_job["job_id"],)).fetchone()
        binding = conn.execute(
            "SELECT provider, status, metadata_json FROM scrape_bindings "
            "WHERE revision_id = 'rev-target-scrape'"
        ).fetchone()
        owners = conn.execute(
            "SELECT work_id FROM provider_bindings WHERE provider = 'tmdb' AND media_type = 'tv' AND provider_id = '99'"
        ).fetchall()
        episode_mappings = conn.execute(
            "SELECT provider_episode_id FROM episode_provider_mappings WHERE episode_id = ? AND provider = 'tmdb'",
            (target_episode_id,),
        ).fetchall()

    assert job["status"] == "succeeded"
    assert job["last_error"] == ""
    assert binding["provider"] == "tmdb"
    assert binding["status"] == "confirmed"
    assert "reason_code" not in json.loads(binding["metadata_json"])
    assert len(owners) == 2
    assert [str(row["provider_episode_id"]) for row in episode_mappings] == ["9901"]


def test_scrape_identity_mismatch_is_discarded_before_artifact_publish(tmp_path, monkeypatch):
    """同 Work 返回不同在线 ID 时局部降级；既不发布错误资料，也不撞 local 唯一键。"""

    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "scrape-local-identity-mismatch.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-mismatch", [_entry("mismatch")])
    revisions.confirm("rev-mismatch")
    scrape = V4ScrapeService(database)
    job = scrape.enqueue_for_revision("rev-mismatch")[0]
    with database.connect() as conn:
        work_id = str(conn.execute(
            "SELECT work_id FROM revision_bindings WHERE revision_id = 'rev-mismatch' LIMIT 1"
        ).fetchone()[0])
        conn.execute(
            "INSERT INTO scrape_bindings(binding_id, revision_id, work_id, provider, provider_id, "
            "metadata_json, status, created_at, updated_at) "
            "VALUES ('existing-local', 'rev-mismatch', ?, 'local', '', '{}', "
            "'waiting_metadata', 'old', 'old')",
            (work_id,),
        )

    scrape.process(
        job["job_id"],
        lambda _target: {**_ready_metadata("99"), "title": "Wrong Show"},
        mirror_root=tmp_path / "mirror",
    )

    with database.connect() as conn:
        job_row = conn.execute(
            "SELECT status, last_error FROM jobs WHERE job_id = ?",
            (job["job_id"],),
        ).fetchone()
        rows = conn.execute(
            "SELECT provider, provider_id, status, metadata_json FROM scrape_bindings "
            "WHERE revision_id = 'rev-mismatch' AND work_id = ? ORDER BY provider",
            (work_id,),
        ).fetchall()
        frozen = conn.execute(
            "SELECT provider_id FROM provider_bindings "
            "WHERE work_id = ? AND provider = 'tmdb' AND media_type = 'tv'",
            (work_id,),
        ).fetchone()

    assert tuple(job_row) == ("succeeded", "")
    assert str(frozen["provider_id"]) == "42"
    assert len(rows) == 1
    assert tuple(rows[0][:3]) == ("local", "", "waiting_metadata")
    assert json.loads(rows[0]["metadata_json"])["reason_code"] == "local_identity_mismatch"
    with database.connect() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM artwork_bindings WHERE work_id=?", (work_id,)
        ).fetchone()[0] == 0


def test_scrape_stores_episode_still_as_pending_artwork_requirement(tmp_path):
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "episode-artwork.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-episode-artwork", [_entry("a")])
    revisions.confirm("rev-episode-artwork")
    scrape = V4ScrapeService(database)
    job = scrape.enqueue_for_revision("rev-episode-artwork")[0]
    with database.connect() as conn:
        episode_id = conn.execute("SELECT episode_id FROM episodes").fetchone()[0]

    scrape.process(
        job["job_id"],
        lambda _target: {
            **_ready_metadata(),
            "episode_mappings": [{
                "episode_id": episode_id,
                "still_url": "https://image.tmdb.org/t/p/w500/still.jpg",
                "provider_episode_id": "9001",
                "title": "Episode",
            }],
        },
    )

    with database.connect() as conn:
        binding = conn.execute(
            "SELECT metadata_json FROM scrape_bindings WHERE revision_id = 'rev-episode-artwork'"
        ).fetchone()
        artwork = conn.execute(
            "SELECT r.source_url,r.state FROM artwork_bindings b "
            "JOIN artwork_resources r ON r.resource_id=b.candidate_id "
            "WHERE b.work_id=? AND b.role='episode_thumb'",
            (job["work_id"],),
        ).fetchone()

    metadata = json.loads(binding["metadata_json"])
    assert "local_thumb_path" not in metadata["episode_mappings"][0]
    assert artwork is not None
    assert artwork["source_url"] == "https://image.tmdb.org/t/p/w500/still.jpg"
    assert artwork["state"] == "pending"


def test_invalid_scrape_mapping_is_rejected_before_metadata_files_are_published(tmp_path):
    import pytest
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "invalid-scrape.db")
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-invalid-scrape", [_entry("a")])
    revisions.confirm("rev-invalid-scrape")
    job = next(item for item in revisions.list_jobs("rev-invalid-scrape") if item["job_type"] == "scrape_work")
    mirror_root = tmp_path / "mirror"

    with pytest.raises(ValueError, match="不属于当前 revision"):
        V4ScrapeService(database).process(
            job["job_id"],
            lambda _target: {
                "provider": "tmdb",
                "provider_id": "42",
                "title": "Show",
                "episode_mappings": [{"episode_id": "foreign-episode"}],
            },
            mirror_root=mirror_root,
        )

    assert not list(mirror_root.rglob("*.nfo"))
    with database.connect() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM artifacts WHERE revision_id = 'rev-invalid-scrape'"
        ).fetchone()[0] == 0


def test_scrape_target_contains_provider_hint_and_episode_mapping(tmp_path):
    from app.media_v4.jobs.scrape import V4ScrapeService
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "scrape-target.db")
    database.initialize()
    revision_service = V4RevisionService(database)
    revision_service.create_draft("rev-scrape", [_entry("a")])
    revision_service.confirm("rev-scrape")
    job = next(item for item in revision_service.list_jobs("rev-scrape") if item["job_type"] == "scrape_work")
    captured = []

    V4ScrapeService(database).process(
        job["job_id"],
        lambda target: captured.append(target) or {
            "provider": "tmdb",
            "provider_id": "42",
            "title": "Show",
        },
    )

    assert captured[0]["provider_bindings"] == [
        {"provider": "tmdb", "media_type": "tv", "provider_id": "42"}
    ]
    assert captured[0]["episodes"][0]["local_season_number"] == 1
    assert captured[0]["episodes"][0]["local_episode_number"] == 1
    assert captured[0]["show_type"] == "anime_series"
    with database.connect() as conn:
        binding = conn.execute(
            "SELECT media_type FROM provider_bindings WHERE provider = 'tmdb'"
        ).fetchone()
        attempts = conn.execute(
            "SELECT attempts FROM jobs WHERE job_id = ?", (job["job_id"],)
        ).fetchone()[0]
    assert binding["media_type"] == "tv"
    assert attempts == 1


def test_metadata_search_requires_unique_exact_title_and_year_match():
    from app.media_v4.jobs.metadata import _select_search_result

    results = [
        {"id": 1, "name": "Show", "first_air_date": "2020-01-01"},
        {"id": 2, "name": "Show", "first_air_date": "2024-01-01"},
        {"id": 3, "name": "Different Show", "first_air_date": "2024-01-01"},
    ]

    assert _select_search_result(results, {"preferred_title": "Show", "year": 2024}, "tv")["id"] == 2
    assert _select_search_result(results, {"preferred_title": "Show"}, "tv") is None
    assert _select_search_result(results, {"preferred_title": "Missing", "year": 2024}, "tv") is None
