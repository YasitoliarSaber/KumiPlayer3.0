"""特别篇排除合同：不改变正片、电影、技术参数或历史不可变事实。"""
from dataclasses import replace

import pytest

from app.media_v4.domain.models import SourceEvidence
from app.media_v4.parsing.parser import V4Parser
from app.media_v4.resolution.resolver import MediaResolver


def pair(path):
    evidence = SourceEvidence(
        evidence_id=path, scan_id="exclusion", root_id="exclusion",
        source_key=path, relative_path=path, entry_kind="video", provider="quark",
        playback_locator="fixture://" + path,
    )
    return evidence, V4Parser().parse(evidence)


@pytest.mark.parametrize("path", [
    "排球少年第二季/[Ygm] Haikyuu!! 2nd Season [OAD][Ma10p_1440p].mkv",
    "Show/Show OVA01.mkv", "Show/Show OAD02.mkv", "Show/Show SP01.mkv",
    "Show/Show [SP].mkv", "Show/Show [14(OVA)].mkv", "Show/Show [14.5].mkv",
    "Show/Show.S01E14.5.mkv", "Show/Show 第8.5集.mkv", "Show/Show.S01E00.mkv",
    "Show/Season 0/Show.S00E02.mkv", "Show/OVA/Unknown.mkv",
    "Independent OVA/Independent.01.mkv", "Independent [OAD]/Independent.01.mkv",
    "Show [SP]/Unknown.mkv", "Show/Specials/Unknown.mkv",
    "Films/Show Movie OVA01.mkv", "Films/Show Movie SP01.mkv",
])
def test_special_sources_never_create_work_episode_or_asset(path):
    entry = pair(path)
    assert not entry[1].is_importable
    graph = MediaResolver().resolve([entry])
    assert not graph.works and not graph.episodes and not graph.work_assets
    assert not graph.issues


@pytest.mark.parametrize("path", [
    "2.5次元的诱惑/2.5次元的诱惑.S01E01.mkv",
    "SPY x FAMILY/SPY x FAMILY.S01E01.mkv",
    "Show.S1-S2+OVA/Season 1/Show.S01E01.mkv",
    "Show/Show.S01E02 [DTS_5.1][FLAC7.1][23.976fps] v1.5.mkv",
    "Films/Tamako Love Story [1080p].mkv",
    "Films/Tokubetsu Hen Hibike! Euphonium Ensemble Contest [1080p].mkv",
])
def test_regular_and_theatrical_releases_are_preserved(path):
    entry = pair(path)
    assert entry[1].is_importable
    graph = MediaResolver().resolve([entry])
    assert len(graph.works) == 1
    assert len(graph.episodes) + len(graph.work_assets) == 1


def test_legacy_playable_special_facts_are_not_readmitted():
    evidence, facts = pair("Show/Show SP01.mkv")
    legacy = replace(facts, is_importable=True, is_auxiliary=False,
                     content_class="playable_special", special_candidate=True, group_type="special")
    graph = MediaResolver().resolve([(evidence, legacy)])
    assert not graph.works and not graph.episodes
    assert legacy.is_importable and legacy.content_class == "playable_special"


@pytest.mark.parametrize("only_special", [False, True])
def test_existing_special_members_disappear_from_projection_and_detail_without_deletion(tmp_path, monkeypatch, only_special):
    from app.api import library_v4
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.projection.library import V4LibraryProjection
    from app.media_v4.revisions.service import V4RevisionService

    database = V4Database(tmp_path / "legacy.db")
    database.initialize()
    service = V4RevisionService(database)
    paths = ["Show/Season 1/Show.S01E01.mkv", "Show/Season 1/Show.S01E02.mkv"]
    service.create_draft("legacy", [pair(path) for path in paths])
    service.confirm("legacy")
    projection = V4LibraryProjection(database)
    projection.rebuild()
    # 只构造历史数据库夹具；不调用新识别器伪造旧解析结果。
    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works").fetchone()[0]
        conn.execute("UPDATE episodes SET episode_kind='special' WHERE local_episode_number=2")
        if only_special:
            conn.execute("UPDATE episodes SET episode_kind='special'")
        conn.execute("DELETE FROM v4_meta WHERE key='library_presentation_policy'")
        before = {
            table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table}")]
            for table in ("parsed_facts", "import_revisions", "episodes", "assets", "revision_bindings")
        }
        conn.commit()
    snapshot = projection.ensure_current()
    monkeypatch.setattr(library_v4, "get_database", lambda: database)
    if only_special:
        from fastapi import HTTPException

        assert not snapshot.cards
        with pytest.raises(HTTPException) as exc:
            library_v4.get_work_detail(work_id)
        assert exc.value.status_code == 404
    else:
        assert len(snapshot.cards) == 1
        assert snapshot.cards[0]["episode_count"] == snapshot.cards[0]["asset_count"] == 1
        detail = library_v4.get_work_detail(work_id)
        assert len(detail["episodes"]) == 1
        assert detail["episodes"][0]["kind"] == "regular"
    with database.connect() as conn:
        after = {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table}")] for table in before}
    assert after == before
