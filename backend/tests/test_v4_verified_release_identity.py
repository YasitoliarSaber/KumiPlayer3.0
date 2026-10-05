"""官方发行知识只解释精确本篇标题，不替代编号、附属内容或实际文件证据。"""

from dataclasses import asdict, replace

import pytest

from app.media_v4.parsing.parser import V4Parser
from app.media_v4.resolution.resolver import MediaResolver
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence

RELEASE_CASES = (
    ("Y 4k 玉子市场&爱情故事", "Tamako love story", "玉子爱情故事", 2014),
    ("吹响吧! 上低音号 S2 ~誓言的终章~", "Gekijouban Hibike! Euphonium Chikai no Finale", "吹响吧！上低音号 誓言的终章", 2019),
    ("中二病也要谈恋爱！-Take On Me-", "Chuunibyou demo Koi ga Shitai! -Take On Me-", "中二病也要谈恋爱！Take On Me", 2018),
    ("紫罗兰永恒花园 外传 永远与自动手记人偶", "Violet Evergarden Eien to Jidou Shuki Ningyou", "紫罗兰永恒花园 外传 永远与自动手记人偶", 2019),
    ("吹响吧! 上低音号 S2 ~合奏比赛~", "Tokubetsu Hen Hibike! Euphonium ~Ensamble Contest~", "吹响吧！上低音号 合奏比赛", 2023),
    ("吹响吧! 上低音号 S2 ~想要传达的旋律~", "Gekijouban Hibike! Euphonium Todoketai Melody", "吹响吧！上低音号 想要传达的旋律", 2017),
    ("吹响吧! 上低音号 S2 外传 ~利兹与青鸟~", "Liz to Aoi Tori", "利兹与青鸟", 2018),
    ("小林家的龙女仆 怕寂寞的龙", "Kobayashi-san Chi no Maid Dragon ~Samishigariya no Ryuu~", "小林家的龙女仆 怕寂寞的龙", 2025),
    ("弦音 -起始的一箭-", "Tsurune Hajimari no Issha", "弦音 起始的一箭", 2022),
    ("声之形", "Koe no Katachi", "声之形", 2016),
)


def resolve(paths, *, prefix=""):
    pairs = []
    for path in paths:
        evidence = to_source_evidence(SourceEntry(
            root_id="release", scan_id="scan", provider="local", ingest_method="openlist_scan",
            relative_path=path.removeprefix(prefix), source_key=path.removeprefix(prefix),
            source_locator="/mount/" + path,
        ))
        pairs.append((evidence, V4Parser().parse(evidence)))
    before = [(asdict(evidence), asdict(facts)) for evidence, facts in pairs]
    graph = MediaResolver().resolve(pairs)
    assert before == [(asdict(evidence), asdict(facts)) for evidence, facts in pairs]
    return graph, pairs


@pytest.mark.parametrize("container,filename,title,year", RELEASE_CASES)
@pytest.mark.parametrize("prefix", ["", "动画/", "动画/4k 京阿尼合集/"])
def test_verified_feature_is_independent_asset_with_year_and_no_inherited_s2(container, filename, title, year, prefix):
    graph, pairs = resolve([
        f"动画/4k 京阿尼合集/{container}/[Ygm] {filename} [Ma10p_2160p][x265_FLAC7.1_DTS5.1_ass].mkv",
    ], prefix=prefix)
    work = graph.works[0]
    facts = pairs[0][1]
    assert (work.preferred_title, work.media_type, work.year) == (title, "movie", year)
    assert facts.content_class == "movie"
    assert facts.season_candidate is facts.episode_candidate is facts.absolute_episode_candidate is None
    assert not facts.season_token_raw
    assert facts.numbering.season_origin == "unknown"
    adopted_numbering = next(trace.value for trace in facts.decision_trace if trace.field == "numbering")
    assert adopted_numbering["season"] is adopted_numbering["episode"] is adopted_numbering["absolute"] is None
    assert facts.tmdb_hint_id is None
    assert len(graph.work_assets) == 1 and not graph.episodes and not graph.issues
    trace = next(trace for trace in facts.decision_trace if trace.field == "verified_release_identity")
    assert trace.value["source_urls"] and trace.value["matched_title"]
    if year == 2023:
        assert trace.value["release_form"] == "theatrical_special"


def test_movie_numbering_trace_preserves_s2_only_as_rejected_candidate():
    _, pairs = resolve(["动画/Show S2/Hibike! Euphonium Chikai no Finale [1080p].mkv"])
    facts = pairs[0][1]
    assert facts.season_candidate is None
    assert facts.numbering.season_origin == "unknown"
    assert next(trace.value for trace in facts.decision_trace if trace.field == "numbering_candidate")["season"] == 2
    assert next(trace.value for trace in facts.decision_trace if trace.field == "numbering")["season"] is None


def test_known_aliases_merge_film_versions_but_do_not_absorb_parent_tv():
    graph, _ = resolve([
        "动画/玉子市场与电影/Tamako Market [01].mkv",
        "动画/玉子市场与电影/Tamako Market [02].mkv",
        "动画/玉子市场与电影/Tamako Love Story [1080p].mkv",
        "动画/玉子市场与电影/玉子爱情故事 [2160p].mkv",
    ])
    assert len(graph.works) == 2
    movie = next(work for work in graph.works if work.media_type == "movie")
    assert movie.preferred_title == "玉子爱情故事" and len(movie.source_evidence_ids) == 2
    assert len(graph.episodes) == 2
    assert {asset.work_key for asset in graph.work_assets} == {movie.work_key}
    assert not graph.issues


def test_already_recognized_clean_movie_title_is_preserved():
    graph, pairs = resolve([
        "动画/中二病也要谈恋爱.S1-S2+剧场版/4.剧场版：Take On Me.2018/"
        "[VCB-Studio] Chuunibyou demo Koi ga Shitai! Movie Take On Me [1080p].mkv",
    ])
    assert graph.works[0].preferred_title == "中二病也要谈恋爱 剧场版：Take On Me"
    assert graph.works[0].media_type == "movie"
    assert pairs[0][1].year_candidate == 2018


def test_verified_identity_unifies_existing_display_aliases_and_manual_correction_wins():
    graph, pairs = resolve([
        "动画/中二病也要谈恋爱.S1-S2+剧场版/4.剧场版：Take On Me.2018/"
        "Chuunibyou demo Koi ga Shitai! Movie Take On Me [1080p].mkv",
        "动画/Other/Chuunibyou demo Koi ga Shitai! -Take On Me- [2160p].mkv",
    ])
    assert len(graph.works) == 1
    assert len(graph.works[0].source_evidence_ids) == 2
    assert {eid for asset in graph.work_assets for eid in asset.asset_evidence_ids} == {
        evidence.evidence_id for evidence, _ in pairs
    }
    evidence, facts = pairs[1]
    corrected = replace(facts, work_title="User Corrected Identity", year_candidate=2030)
    corrected_graph = MediaResolver().resolve([(evidence, corrected)])
    assert corrected_graph.works[0].preferred_title == "User Corrected Identity"
    assert corrected_graph.works[0].year == 2030


def test_explicit_provider_type_correction_keeps_work_key_and_member_type_consistent():
    _, pairs = resolve(["Films/Tamako Love Story [1080p].mkv"])
    evidence, facts = pairs[0]
    corrected = replace(facts, tmdb_hint_id=42, tmdb_hint_type="tv")
    graph = MediaResolver().resolve([(evidence, corrected)])
    assert graph.works[0].media_type == "tv" and graph.works[0].work_key.endswith(":tv")
    assert len(graph.episodes) == 1 and not graph.work_assets


@pytest.mark.parametrize("ids", [(42, 99), (99, 42), (42, 42)])
def test_conflicting_alias_provider_hints_do_not_freeze_arbitrary_binding(tmp_path, monkeypatch, ids):
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    _, pairs = resolve(["Films/Tamako Love Story [1080p].mkv", "Films/玉子爱情故事 [2160p].mkv"])
    pairs = [(evidence, replace(facts, tmdb_hint_id=hint_id, tmdb_hint_type="movie"))
             for (evidence, facts), hint_id in zip(pairs, ids, strict=True)]
    database = V4Database(tmp_path / "hint-conflict.db")
    database.initialize()
    service = V4RevisionService(database)
    graph = service.create_draft("aliases", pairs)
    assert len(graph.works) == 1
    service.confirm("aliases")
    assert service.get_status("aliases") == "confirmed"
    with database.connect() as conn:
        bindings = conn.execute("SELECT provider_id FROM provider_bindings").fetchall()
        assert conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0] == 2
    if len(set(ids)) == 1:
        assert [row[0] for row in bindings] == [str(ids[0])]
    else:
        assert any(issue.code == "candidate_ambiguous" for issue in graph.issues)
        assert not bindings
        from types import SimpleNamespace

        from app.media_v4.jobs import metadata
        from app.media_v4.jobs.scrape import V4ScrapeService

        class ForbiddenClient:
            def __init__(self, **_kwargs):
                raise AssertionError("Conflicting file hints must not query a provider")

        monkeypatch.setattr(metadata, "TMDBClient", ForbiddenClient)
        monkeypatch.setattr(metadata, "load_config", lambda: SimpleNamespace(tmdb_bearer_token="fixture"))
        outcomes = []

        def provider(target):
            assert target["provider_hint_conflict"] is True
            result = metadata.default_metadata_provider(target)
            outcomes.append(result)
            return result

        scrape = V4ScrapeService(database)
        job = next(item for item in scrape.enqueue_for_revision("aliases") if item["job_type"] == "scrape_work")
        scrape.process(job["job_id"], provider, mirror_root=tmp_path / "mirror")
        assert outcomes[0]["metadata_state"] == "waiting_review"
        assert outcomes[0]["reason_code"] == "provider_hint_conflict"


@pytest.mark.parametrize("suffix", ["SP01", "OVA01", "OAD01", "[00]", "[04.5]", "S01E01", "[01]", "[21 Director’s Cut]"])
def test_verified_title_cannot_override_local_special_or_regular_numbering(suffix):
    graph, pairs = resolve([f"动画/作品/Season 1/Tamako Love Story {suffix}.mkv"])
    assert pairs[0][1].content_class != "movie"
    assert pairs[0][1].is_importable
    assert len(graph.episodes) == 1 and not graph.work_assets
    assert not any(trace.field == "verified_release_identity" for trace in pairs[0][1].decision_trace)


@pytest.mark.parametrize("suffix", ["SP01 Menu", "SP02 PV", "Trailer", "NCOP", "NCED", "OP", "ED"])
def test_verified_title_does_not_admit_auxiliary_content(suffix):
    graph, pairs = resolve([f"动画/玉子爱情故事/Tamako Love Story {suffix}.mkv"])
    assert pairs[0][1].content_class == "auxiliary"
    assert not graph.works


@pytest.mark.parametrize("path", [
    "动画/玉子爱情故事/Unknown Film [1080p].mkv",
    "动画/作品/Tamako Love Story Sequel [1080p].mkv",
    "动画/作品/Take On Me [1080p].mkv",
    "动画/作品/Tokubetsu Hen Unknown Show [1080p].mkv",
    "动画/作品/Tamako Love Story (2030) [1080p].mkv",
    "动画/作品/Tamako Love Story S02 [1080p].mkv",
    "动画/玉子爱情故事 (2030)/Tamako Love Story [1080p].mkv",
])
def test_partial_title_parent_or_conflicting_release_year_cannot_supply_identity(path):
    _, pairs = resolve([path])
    assert not any(trace.field == "verified_release_identity" for trace in pairs[0][1].decision_trace)


def test_rttt_and_nijiyon_unnumbered_files_keep_content_uncertainty():
    graph, pairs = resolve([
        "动画/巅峰之路/Uma Musume Pretty Derby Road to the Top [01].mkv",
        "动画/巅峰之路/Uma Musume Pretty Derby Road to the Top [x265_flac_DTS5.1].mkv",
        "动画/巅峰之路/Uma Musume Pretty Derby Road to the Top [x265_flac].mkv",
        "动画/虹四格 S4/Nijiyon S4 [2160p].mkv",
    ])
    assert not graph.work_assets
    assert all(pairs[index][1].episode_candidate is None for index in (1, 2, 3))
    assert not any(trace.field == "verified_release_identity" for _, facts in pairs for trace in facts.decision_trace)
    assert graph.issues


def test_catalog_alias_collision_never_uses_first_match():
    from app.media_v4.parsing.release_catalog import VerifiedRelease
    from app.media_v4.parsing.release_identity import match_verified_release

    web = VerifiedRelease("web", "Network Release", 2023, ("Same Title",), ("https://example.invalid/web",))
    movie = VerifiedRelease("film", "Theatrical Release", 2024, ("Same Title",), ("https://example.invalid/movie",))
    assert match_verified_release("same title", (web, movie)) is None
    assert match_verified_release("same title", (movie, web)) is None
    assert match_verified_release("Same Title Sequel", (movie,)) is None


@pytest.mark.parametrize("family,hint_type", [("live", ""), ("anime", "tv")])
def test_anime_release_knowledge_does_not_override_family_or_explicit_provider_type(family, hint_type):
    evidence = to_source_evidence(SourceEntry(
        root_id="release", scan_id="scan", provider="local", ingest_method="local_scan",
        relative_path="Films/Tamako Love Story.mkv", source_key="film",
        import_family=family, tmdb_hint_type=hint_type, tmdb_hint_id="42" if hint_type else "",
    ))
    facts = V4Parser().parse(evidence)
    assert not any(trace.field == "verified_release_identity" for trace in facts.decision_trace)


def test_new_release_knowledge_preserves_persisted_old_facts_and_confirmed_revision(tmp_path):
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.persistence.repositories import V4Repository
    from app.media_v4.revisions.service import V4RevisionService

    _, pairs = resolve(["动画/玉子市场与电影/Tamako Love Story [1080p].mkv"])
    evidence, current = pairs[0]
    old = replace(
        current, parsed_fact_id=f"facts_{evidence.evidence_id}_v4-parser-14", parser_version="v4-parser-14",
        work_title="Tamako Love Story", original_title="Tamako Love Story", series_group="",
        media_type="unknown", content_class="unknown", group_type="unknown", year_candidate=None,
        title_candidates=("Tamako Love Story",), decision_trace=(), card_type="", relation_type="",
    )
    database = V4Database(tmp_path / "release-facts.db")
    database.initialize()
    service = V4RevisionService(database)
    service.create_draft("old", [(evidence, old)])
    service.confirm("old")
    with database.connect() as conn:
        before = tuple(conn.execute("SELECT * FROM import_revisions WHERE revision_id='old'").fetchone())
    service.create_draft("new", [(evidence, current)])
    repository = V4Repository(database)
    assert current.parsed_fact_id != old.parsed_fact_id
    assert repository.get_parsed_facts(old.parsed_fact_id) == old
    assert repository.get_parsed_facts(current.parsed_fact_id) == current
    assert repository.get_source_evidence(evidence.evidence_id) == evidence
    with database.connect() as conn:
        assert before == tuple(conn.execute("SELECT * FROM import_revisions WHERE revision_id='old'").fetchone())
    assert service.get_status("old") == "confirmed"
