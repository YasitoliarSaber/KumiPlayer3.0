"""结构目录不能成为刮削标题，也不能把不同作品的同名季度混在一起。"""

from dataclasses import asdict

import pytest

from app.media_v4.generic_container import is_generic_container_name
from app.media_v4.parsing.parser import V4Parser, normalize_batch_parsed_facts
from app.media_v4.resolution.resolver import MediaResolver
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence
from app.recognition.title_cleaner import clean_work_title_container


def _resolve(paths, provider="pan115", method="directory_tree"):
    parser = V4Parser()
    pairs = []
    for path in paths:
        evidence = to_source_evidence(SourceEntry(
            root_id="fixture", scan_id="fixture", provider=provider,
            ingest_method=method, relative_path=path,
        ))
        pairs.append((evidence, parser.parse(evidence)))
    pairs = normalize_batch_parsed_facts(pairs)
    before = [asdict(f) for _, f in pairs]
    graph = MediaResolver().resolve(pairs)
    assert [asdict(f) for _, f in pairs] == before
    return graph, pairs


@pytest.mark.parametrize("name", [
    "S1.2017", "[S2].2022", "Season 3 (2024)", "第2季.2020", "TV版", "TV版.2020",
])
def test_decorated_season_and_release_form_are_generic(name):
    assert is_generic_container_name(name)


@pytest.mark.parametrize("provider,method", [
    ("pan115", "directory_tree"), ("baidu", "directory_tree"),
    ("quark", "openlist_scan"), ("local", "local_scan"),
])
def test_year_decorated_seasons_keep_named_parent_and_never_mix_series(provider, method):
    paths = [
        "动画/星空教室.S1-S3/S1.2017/Sky Classroom [01].mkv",
        "动画/星空教室.S1-S3/S2.2022/Classroom2 [01].mkv",
        "动画/药师少女.S1-S2/S1.2023/药师少女.2023.S01E01.mkv",
        "动画/药师少女.S1-S2/S2.2025/药师少女.2025.S02E01.mkv",
    ]
    graph, pairs = _resolve(paths, provider, method)
    assert {w.preferred_title for w in graph.works} == {"星空教室", "药师少女"}
    for work in graph.works:
        assert len(work.source_evidence_ids) == 2
        assert {e.relative_path.split('/')[1] for e, _ in pairs
                if e.evidence_id in work.source_evidence_ids} == {
                    "星空教室.S1-S3" if work.preferred_title == "星空教室" else "药师少女.S1-S2"
                }
        assert {e.local_season_number for e in graph.episodes if e.work_key == work.work_key} == {1, 2}


def test_tv_form_directory_keeps_specific_title_and_movie_separate():
    graph, _ = _resolve([
        "动画/作品系列/列车篇.[S2].2020/TV版/Train Arc [01].mkv",
        "动画/作品系列/列车篇.[S2].2020/剧场版/Train Arc Movie.mkv",
    ])
    assert len(graph.works) == 2
    assert not any(w.preferred_title == "TV版" for w in graph.works)
    assert {w.media_type for w in graph.works} == {"tv", "movie"}


def test_bracketed_episode_revision_is_regular_number_not_title_or_unknown():
    graph, pairs = _resolve([
        "动画/[Group] Original Title [01-13 Fin]/[Group] Original Title [01v2][1080p].mkv",
        "动画/[Group] Original Title [01-13 Fin]/[Group] Original Title [02v3][1080p].mkv",
    ])
    assert all(f.episode_candidate in {1, 2} and f.content_class == "regular" for _, f in pairs)
    assert len(graph.works) == 1
    assert graph.works[0].preferred_title == "Original Title"
    assert graph.works[0].media_type == "tv"


def test_named_titles_and_year_remakes_are_not_structure():
    for title in ("86-不存在的战区", "2.5 Dimensional Seduction", "S1 Alien", "TV动画作品"):
        assert not is_generic_container_name(title)
    graph, _ = _resolve([
        "动画/同名作品 (2000)/同名作品 S01E01.mkv",
        "动画/同名作品 (2020)/同名作品 S01E01.mkv",
    ])
    assert len(graph.works) == 2


def test_season_chapter_uses_complete_file_title_without_inventing_parent_identity():
    graph, _ = _resolve([
        "动画/星空冒险系列/1.立志篇.[S1].2019/Sky Adventures [01].mkv",
        "动画/星空冒险系列/2.列车篇.[S2].2021/Sky Adventures Train Arc [01].mkv",
        "动画/作者作品合集/3.列车篇.[S1].2020/Train Arc [01].mkv",
    ])
    assert {w.preferred_title for w in graph.works} == {
        "Sky Adventures", "Sky Adventures Train Arc", "Train Arc"
    }
    graph, _ = _resolve(["动画/京阿尼系列/日常篇.[S1].2011/Nichijou [01].mkv"])
    assert graph.works[0].preferred_title == "Nichijou"


def test_decorated_season_year_is_not_lost_with_structure_filter():
    graph, pairs = _resolve([
        "动画/星空教室.S1-S2/S1.2017/Sky Classroom [01].mkv",
        "动画/星空教室.S1-S2/S2.2022/Classroom2 [01].mkv",
    ])
    assert len(graph.works) == 1
    assert graph.works[0].year == 2017
    assert {f.year_candidate for _, f in pairs} == {2017, 2022}


def test_bracketed_numeric_title_is_not_newly_discarded():
    assert not is_generic_container_name("[86]")
    graph, pairs = _resolve(["[86]/E01.mkv"])
    assert pairs[0][1].work_title == "86"
    assert graph.works[0].preferred_title == "86"


@pytest.mark.parametrize("title", ["[Group] D.C.", "D.C..2003", "[Group] P.A."])
def test_real_title_punctuation_survives_metadata_cleaning(title):
    assert clean_work_title_container(title).title in {"D.C.", "P.A."}


@pytest.mark.parametrize("suffix", ["NCOP", "NCED", "NCEDEP16", "NCOPEP24"])
def test_episode_specific_creditless_auxiliary_is_excluded(suffix):
    graph, pairs = _resolve([f"动画/Show/Show [{suffix}][1080p].mkv"])
    assert not graph.works
    assert pairs[0][1].is_auxiliary


def test_end_and_non_trimming_versions_keep_same_regular_episode():
    graph, pairs = _resolve([
        "动画/Show/S1/【Show】【06 END】【BDrip】【HEVC 2160p FLAC】.mkv",
        "动画/Show/S1/【Show】【06 Non Trimming Ver.】【BDrip】【HEVC 2160p FLAC】.mkv",
    ])
    assert all(f.episode_candidate == 6 and f.content_class == "regular" for _, f in pairs)
    assert len({episode.episode_key for episode in graph.episodes}) == 1
    assert len({i for episode in graph.episodes for i in episode.asset_evidence_ids}) == 2
    assert {episode.edition_key for episode in graph.episodes} == {"default", "non_trimming"}
    assert "non_trimming" in pairs[1][1].edition_tags


def test_explicit_named_bonus_directory_does_not_admit_special_only_work():
    graph, pairs = _resolve([
        "动画/Show/Show番外：Bonus Story.2014/Bonus Story(1).mkv",
        "动画/Show/Show番外：Bonus Story.2014/Bonus Story.mkv",
        "动画/Show/Show.S01E01.mkv",
    ])
    assert all(not f.is_importable for _, f in pairs[:2])
    assert len(graph.episodes) == 1
