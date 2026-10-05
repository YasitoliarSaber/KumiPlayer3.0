"""第三方复核的最小复现及防止过度合并的反例；全程离线。"""

from dataclasses import asdict, replace

import pytest

from app.media_v4.parsing.parser import V4Parser
from app.media_v4.parsing.structure import structure_decision
from app.media_v4.resolution.resolver import MediaResolver
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence


def resolve(paths, *, prefix="", method="openlist_scan", locator_prefix="/mount/", root=""):
    pairs = []
    for path in paths:
        evidence = to_source_evidence(SourceEntry(
            root_id="review", scan_id="review", provider="local", ingest_method=method,
            relative_path=path.removeprefix(prefix), source_key=path.removeprefix(prefix),
            source_locator=locator_prefix + path,
        ))
        pairs.append((evidence, V4Parser().parse(evidence, root_container=root)))
    original = [asdict(facts) for _, facts in pairs]
    graph = MediaResolver().resolve(pairs)
    assert [asdict(facts) for _, facts in pairs] == original
    return graph, pairs


@pytest.mark.parametrize("prefix", ["", "动画/", "动画/星空的炼金师/"])
def test_season_subtitle_boundary_survives_root_change(prefix):
    graph, pairs = resolve([
        "动画/星空的炼金师/星空的炼金师 第1季/星空的炼金师 [01].mkv",
        "动画/星空的炼金师/星空的炼金师 第3季 银月篇/星空的炼金师 第3季 银月篇 [01].mkv",
    ], prefix=prefix)
    assert len(graph.works) == 1
    assert graph.works[0].preferred_title == "星空的炼金师"
    assert pairs[1][1].work_title == "星空的炼金师 第3季 银月篇"
    assert pairs[1][1].series_group == "星空的炼金师"
    assert {episode.local_season_number for episode in graph.episodes} == {1, 3}
    assert {episode.local_episode_number for episode in graph.episodes} == {1}


@pytest.mark.parametrize("prefix", ["", "动画/鬼灭之刃系列/"])
def test_named_series_with_shared_file_title_is_one_multiseason_work(prefix):
    graph, _ = resolve([
        "动画/鬼灭之刃系列/1.立志篇.[S1].2019/Kimetsu no Yaiba [01].mkv",
        "动画/鬼灭之刃系列/3.游郭篇.[S2].2021/Kimetsu no Yaiba [34].mkv",
    ], prefix=prefix)
    assert len(graph.works) == 1
    assert {episode.local_season_number for episode in graph.episodes} == {1, 2}
    assert not graph.collections


def test_collection_season_markers_and_shared_provider_hint_do_not_merge_distinct_children():
    graph, _ = resolve([
        "动画/物语系列/化物语 [S1] {tmdbid-46195}/化物语 S01E01.mkv",
        "动画/物语系列/伪物语 [S2] {tmdbid-46195}/伪物语 S02E01.mkv",
    ])
    assert len(graph.works) == 2
    assert len(graph.collections) == 1
    assert {work.preferred_title for work in graph.works} == {"化物语", "伪物语"}


@pytest.mark.parametrize("prefix", ["动画/", "Archive/Foo/"])
def test_title_prefix_without_word_boundary_is_not_a_named_season(prefix):
    graph, _ = resolve([
        f"{prefix}Foo/Foo S01E01.mkv",
        f"{prefix}Foo/Foobar Season 2/Foobar S02E01.mkv",
    ])
    assert len(graph.works) == 2
    assert {work.preferred_title for work in graph.works} == {"Foo", "Foobar Season 2"}


@pytest.mark.parametrize("prefix", ["", "Archive/Foo/Foo/"])
def test_leading_season_label_and_unicode_subtitle_keep_repeated_parent(prefix):
    graph, _ = resolve([
        "Archive/Foo/Foo/S1 Foo～A Subtitle～（2019）/Foo～A Subtitle～ S01E01.mkv",
        "Archive/Foo/Foo/S2 Foo？～Another Subtitle～（2020）/Foo？～Another Subtitle～ S02E01.mkv",
    ], prefix=prefix)
    assert len(graph.works) == 1
    assert graph.works[0].preferred_title == "Foo"
    assert {episode.local_season_number for episode in graph.episodes} == {1, 2}


def test_shared_hint_cannot_absorb_release_group_spinoff():
    graph, _ = resolve([
        "动画/[Group] Show/Show (2020) {tmdbid-1234}/Show S01E01.mkv",
        "动画/[Group] Show/Heya (2020) {tmdbid-1234}/Heya S01E01.mkv",
    ])
    assert len(graph.works) == 2
    child = next(work for work in graph.works if work.preferred_title == "Heya")
    assert child.card_type == "standalone"
    assert len(graph.relations) == 1


def test_season_label_does_not_absorb_unnumbered_subtitle_release():
    graph, _ = resolve([
        "动画/Show/Show S1/Show S01E01.mkv",
        "动画/Show/Show S2 ~Separate Release~/Different Release [BDRip][1080p].mkv",
    ])
    assert len(graph.works) == 2
    assert any("Separate Release" in work.preferred_title for work in graph.works)


@pytest.mark.parametrize("field,value", [("work_title", "Explicit Identity"), ("season_candidate", 9)])
def test_batch_structure_derivation_respects_manual_facts(field, value):
    _, pairs = resolve([
        "动画/鬼灭之刃系列/1.立志篇.[S1].2019/Kimetsu no Yaiba [01].mkv",
        "动画/鬼灭之刃系列/3.游郭篇.[S2].2021/Kimetsu no Yaiba [34].mkv",
    ])
    evidence, facts = pairs[1]
    pairs[1] = evidence, replace(facts, **{field: value})
    original = [asdict(facts) for _, facts in pairs]
    graph = MediaResolver().resolve(pairs)
    assert len(graph.works) == 2
    assert [asdict(facts) for _, facts in pairs] == original
    if field == "work_title":
        assert any(work.preferred_title == value for work in graph.works)
    else:
        assert any(episode.local_season_number == value for episode in graph.episodes)


@pytest.mark.parametrize("container", ["京阿尼合集", "KyoAni Collection", "KyoAni Series"])
def test_collection_direct_season_children_keep_actual_shared_work_title(container):
    graph, _ = resolve([
        f"动画/{container}/Clannad Season 1/Clannad S01E01.mkv",
        f"动画/{container}/Clannad Season 2/Clannad S02E01.mkv",
    ])
    assert len(graph.works) == len(graph.collections) == 1
    assert graph.works[0].preferred_title == "Clannad"
    assert graph.collections[0].preferred_title == container
    assert {episode.local_season_number for episode in graph.episodes} == {1, 2}


@pytest.mark.parametrize("tag", ["OVA", "OAD"])
@pytest.mark.parametrize("locator_prefix", ["C:/not-media/错误系列/", "//server/not-media/错误系列/"])
def test_physical_scan_does_not_inherit_disk_ancestors_and_keeps_release_special(tag, locator_prefix):
    graph, pairs = resolve([f"Independent [{tag}]/Independent.01.mkv"],
                           method="local_scan", locator_prefix=locator_prefix)
    facts = pairs[0][1]
    assert facts.is_importable
    assert facts.content_class == "playable_special"
    assert facts.series_group == "Independent"
    assert not (structure_decision(facts) or {}).get("collections")
    assert len(graph.works) == len(graph.episodes) == 1
    assert graph.episodes[0].episode_kind == "special"


def test_auxiliary_in_branded_release_directory_is_still_excluded():
    graph, pairs = resolve(["Independent [OVA]/Independent SP01 Menu.mkv"], method="local_scan")
    assert pairs[0][1].content_class == "auxiliary"
    assert not graph.works


@pytest.mark.parametrize("prefix", ["", "动画/Show.S1-S2+Movie/"])
def test_movie_directory_special_attaches_to_explicit_tv_series(prefix):
    graph, _ = resolve([
        "动画/Show.S1-S2+Movie/Show S1/Show S01E01.mkv",
        "动画/Show.S1-S2+Movie/Show Movie (2018)/Show Movie.mkv",
        "动画/Show.S1-S2+Movie/Show Movie (2018)/Show SP02.mkv",
    ], prefix=prefix)
    assert len(graph.works) == 2
    main = next(work for work in graph.works if work.media_type == "tv")
    assert main.preferred_title == "Show"
    assert {episode.episode_kind for episode in graph.episodes} == {"regular", "special"}
    assert {episode.work_key for episode in graph.episodes} == {main.work_key}
    assert len(graph.work_assets) == 1


@pytest.mark.parametrize("scope", ["Show.S1-S2+SP+OVA", "Show.S1-S2 [OVA]"])
def test_multiseason_scope_suffix_ova_does_not_reclassify_regular_episodes(scope):
    graph, pairs = resolve([f"{scope}/Show [S1]/Show [01].mkv"])
    assert pairs[0][1].content_class == "regular"
    assert graph.episodes[0].episode_kind == "regular"


def test_same_boundary_provider_hint_unites_regular_and_playable_ova():
    graph, _ = resolve([
        "Angel Beats! (2010) {tmdbid-42942}/Season 1/Angel Beats! S01E01.mkv",
        "Angel Beats! (2010) {tmdbid-42942}/Specials/Angel Beats! S00E05 OVA2.mkv",
    ])
    assert len(graph.works) == 1
    assert {episode.episode_kind for episode in graph.episodes} == {"regular", "special"}


def test_low_confidence_hint_cannot_bridge_unrelated_boundaries():
    graph, _ = resolve([
        "Show (2010) {tmdbid-42942}/Season 1/Show S01E01.mkv",
        "Unrelated (2010) {tmdbid-42942}/Specials/Unrelated OVA01.mkv",
    ])
    assert len(graph.works) == 2
    assert {work.preferred_title for work in graph.works} == {"Show", "Unrelated"}


def test_trailing_number_coalesces_only_with_same_parent_base_title():
    graph, _ = resolve([
        "动画/[Group] Short Alias/[Group] Long Series Title/Long Series Title [01].mkv",
        "动画/[Group] Short Alias/[Group] Long Series Title 2/Long Series Title 2 [01].mkv",
        "动画/Other/Long Series Title 2/Long Series Title 2 [01].mkv",
        "动画/[Group] Short Alias/[Group] Long Series Title Movie/Long Series Title Movie.mkv",
        "动画/[Group] Short Alias/[Group] Apollo 13/Apollo 13 [01].mkv",
    ])
    assert len(graph.works) == 4
    main = next(work for work in graph.works if work.preferred_title == "Long Series Title")
    assert {episode.local_season_number for episode in graph.episodes if episode.work_key == main.work_key} == {1, 2}
    assert any(work.preferred_title == "Apollo 13" for work in graph.works)
    assert any(work.preferred_title == "Long Series Title 2" for work in graph.works)


def test_movie_release_child_keeps_parent_title_year_and_series_relation():
    graph, _ = resolve([
        "动画/刀剑神域.S1-S3+剧场版/刀剑神域 [S1]/刀剑神域 S01E01.mkv",
        "动画/刀剑神域.S1-S3+剧场版/4.剧场版：序列之争.2017/"
        "[VCB-Studio] 剧场版 刀剑神域 序列之争 10-bit 1080p HEVC BDRip/"
        "[VCB-Studio] Sword Art Online -Ordinal Scale- [Ma10p_1080p][x265_flac].mkv",
    ])
    movie = next(work for work in graph.works if work.media_type == "movie")
    assert movie.preferred_title == "刀剑神域 剧场版：序列之争"
    assert movie.year == 2017
    assert len(graph.works) == 2
    assert any(relation.child_work_key == movie.work_key for relation in graph.relations)


@pytest.mark.parametrize("prefix", ["", "动画/4k 京阿尼合集/"])
@pytest.mark.parametrize("marker", ["Gekijouban", "Gekijoban", "Gekijōban"])
def test_romanized_movie_marker_wins_over_s2_directory_without_inventing_episode(prefix, marker):
    graph, pairs = resolve([
        "动画/4k 京阿尼合集/C 4k 吹响吧！上低音号/吹响吧! 上低音号 S2 ~誓言的终章~/"
        f"[Ygm] {marker} Hibike! Euphonium Chikai no Finale [Ma10p_2160p][x265_flac7.1_DTS-HD_ass].mkv",
        "动画/4k 京阿尼合集/C 4k 吹响吧！上低音号/吹响吧! 上低音号 S2 ~想要传达的旋律~/"
        f"[Ygm] {marker} Hibike! Euphonium Todoketai Melody [Ma10p_2160p][x265_aac_flac_DTS5.1].mkv",
    ], prefix=prefix)
    assert all(facts.content_class == "movie" and facts.media_type == "movie" for _, facts in pairs)
    assert all(facts.episode_candidate is None for _, facts in pairs)
    assert len(graph.works) == len(graph.work_assets) == 2
    assert not graph.episodes
    assert not any(issue.code == "episode_number_unresolved" for issue in graph.issues)


@pytest.mark.parametrize("number,label,edition", [
    (21, "Director's Cut", "director-cut"),
    (22, "Director’s Cut", "director-cut"),
    (23, "Director‘s Cut", "director-cut"),
    (24, "Directorʼs Cut", "director-cut"),
    (21, "Director's  Cut", "director-cut"),
    (21, "Director’s__Cut", "director-cut"),
    (21, "Director---Cut", "director-cut"),
    (6, "(On-Air)", "on-air"),
])
@pytest.mark.parametrize("prefix", ["", "动画/"])
def test_annotated_episode_editions_keep_number_and_same_work_without_overwriting_base(prefix, number, label, edition):
    token = f"[{number:02d}{'' if label.startswith('(') else ' '}{label}]"
    graph, pairs = resolve([
        f"动画/作品/Season 1/[Group] Series [{number:02d}][1080p][x265_FLAC7.1].mkv",
        f"动画/作品/Season 1/[Group] Series {token}[1080p][x265_FLAC7.1].mkv",
    ], prefix=prefix)
    annotated = pairs[1][1]
    assert annotated.content_class == "regular"
    assert annotated.episode_candidate == number
    assert annotated.episode_token_raw == token
    assert annotated.edition_tags == (edition,)
    assert len(graph.works) == 1
    assert len(graph.episodes) == 2
    assert {episode.local_episode_number for episode in graph.episodes} == {number}
    assert len({episode.identity_key for episode in graph.episodes}) == 1
    assert len({episode.edition_key for episode in graph.episodes}) == 2
    assert not graph.issues


@pytest.mark.parametrize("token", ["[DTS_5.1]", "[FLAC7.1]", "[2160p]", "[21 Unknown Cut]", "[06(Whatever)]"])
def test_release_parameters_and_unknown_annotations_do_not_create_episode(token):
    _, pairs = resolve([f"动画/作品/[Group] Unnumbered {token}.mkv"])
    assert pairs[0][1].episode_candidate is None


@pytest.mark.parametrize("suffix", ["SP01 Menu", "SP02 PV", "NCOP", "NCED"])
def test_romanized_movie_name_cannot_override_auxiliary_exclusion(suffix):
    graph, pairs = resolve([f"动画/作品/Gekijouban Series {suffix}.mkv"])
    assert pairs[0][1].content_class == "auxiliary"
    assert not graph.works


@pytest.mark.parametrize("suffix", ["SP01", "OVA01", "OAD01"])
def test_romanized_movie_title_keeps_explicit_local_special_playable(suffix):
    graph, pairs = resolve([f"动画/作品/Season 2/Gekijouban Series {suffix}.mkv"])
    assert pairs[0][1].content_class == "playable_special"
    assert pairs[0][1].is_importable
    assert len(graph.episodes) == 1
    assert not graph.work_assets


def test_unnumbered_same_name_release_and_nijiyon_s4_do_not_gain_guessed_coordinates():
    graph, pairs = resolve([
        "动画/赛马娘/巅峰之路/Uma Musume Pretty Derby - Road to the Top [01].mkv",
        "动画/赛马娘/巅峰之路/Uma Musume Pretty Derby Road to the Top [x265_FLAC].mkv",
        "动画/虹四格 S4/Nijiyon S4 [1080p].mkv",
    ])
    assert pairs[1][1].content_class == "unknown"
    assert pairs[1][1].episode_candidate is None
    assert pairs[2][1].season_candidate == 4
    assert pairs[2][1].episode_candidate is None
    assert any(issue.code == "episode_number_unresolved" for issue in graph.issues)
