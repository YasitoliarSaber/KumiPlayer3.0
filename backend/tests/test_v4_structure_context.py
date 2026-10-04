"""相同来源树改变扫描根时，作品、季度和版本成员必须保持一致。"""

from dataclasses import asdict

import pytest

from app.media_v4.parsing.parser import V4Parser
from app.media_v4.resolution.resolver import MediaResolver
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence


def resolve(paths, *, prefix="", provider="quark", root_container=""):
    pairs = []
    for path in paths:
        relative = path.removeprefix(prefix)
        evidence = to_source_evidence(SourceEntry(
            root_id="root", scan_id="scan", provider=provider,
            ingest_method="openlist_scan", relative_path=relative,
            source_key=path, source_locator="/mount/" + path,
        ))
        pairs.append((evidence, V4Parser().parse(evidence, root_container=root_container)))
    before = [asdict(facts) for _, facts in pairs]
    graph = MediaResolver().resolve(pairs)
    assert [asdict(facts) for _, facts in pairs] == before
    return graph, pairs


def semantics(graph):
    return sorted((work.preferred_title, work.media_type,
                   sorted([(episode.local_season_number, episode.local_episode_number,
                            episode.episode_kind, episode.asset_evidence_ids)
                           for episode in graph.episodes if episode.work_key == work.work_key], key=repr))
                   for work in graph.works)


@pytest.mark.parametrize("provider", ["quark", "pan115", "baidu", "local"])
def test_root_neutral_multiseason_identity_and_member_partition(provider):
    paths = [
        "动画/京阿尼合集/Clannad/Clannad S1 (2007)/Clannad S01E01.mkv",
        "动画/京阿尼合集/Clannad/Clannad After Story S2 (2008)/Clannad S02E01.mkv",
        "动画/京阿尼合集/Clannad/Clannad After Story S2 (2008)/SP/Clannad SP01.mkv",
    ]
    graphs = [resolve(paths, prefix=prefix, provider=provider, root_container=root)[0]
              for prefix, root in [("", ""), ("动画/", "动画"),
                                   ("动画/京阿尼合集/Clannad/", "Clannad")]]
    assert all(len(graph.works) == 1 for graph in graphs)
    assert all(graph.works[0].preferred_title == "Clannad" for graph in graphs)
    assert semantics(graphs[0]) == semantics(graphs[1]) == semantics(graphs[2])
    assert sorted(episode.local_season_number for episode in graphs[0].episodes
                  if episode.episode_kind == "regular") == [1, 2]


def test_named_season_specials_do_not_create_year_specific_work():
    graph, _ = resolve([
        "动画/辉夜大小姐想让我告白/S1 辉夜大小姐想让我告白 (2019)/辉夜 S01E01.mkv",
        "动画/辉夜大小姐想让我告白/S2 辉夜大小姐想让我告白 (2020)/辉夜 S02E01.mkv",
        "动画/辉夜大小姐想让我告白/S2 辉夜大小姐想让我告白 (2020)/SP/辉夜 SP01.mkv",
        "动画/辉夜大小姐想让我告白/S3 辉夜大小姐想让我告白 (2022)/SP/辉夜 SP01.mkv",
    ])
    assert len(graph.works) == 1
    assert len(graph.episodes) == 4
    assert sum(episode.episode_kind != "regular" for episode in graph.episodes) == 2


def test_remakes_keep_year_identity_and_special_only_sources_survive():
    graph, _ = resolve([
        "动画/同名作品 (2000)/同名作品 S01E01.mkv",
        "动画/同名作品 (2020)/同名作品 S01E01.mkv",
        "动画/独立特典来源/独立特典来源 OVA01.mkv",
    ])
    assert len(graph.works) == 3
    assert sorted(work.year for work in graph.works if work.preferred_title == "同名作品") == [2000, 2020]
    assert any(work.preferred_title == "独立特典来源" for work in graph.works)


def test_family_children_keep_own_identity_and_order_is_not_season():
    graph, _ = resolve([
        "动画/物语系列/01. 化物语/化物语 [01].mkv",
        "动画/物语系列/02. 伪物语/伪物语 [01].mkv",
        "动画/物语系列/13.5 伤物语 剧场版/伤物语 Movie.mkv",
    ])
    assert len(graph.works) == 3
    assert not any(work.preferred_title == "物语系列" for work in graph.works)
    assert all(episode.local_season_number in (None, 1) for episode in graph.episodes)
    assert not any("13.5" in work.preferred_title for work in graph.works)
    assert {work.preferred_title for work in graph.works} >= {"化物语", "伪物语"}


def test_unmarked_different_movie_candidate_is_not_absorbed_into_tv():
    graph, _ = resolve([
        "动画/玉子市场/玉子市场 S01E01.mkv",
        "动画/玉子市场/玉子爱情故事 [1080p][DTS_5.1].mkv",
    ])
    assert len(graph.works) == 2
    candidate = next(work for work in graph.works if work.preferred_title == "玉子爱情故事")
    assert candidate.media_type == "unknown"


def test_generic_movie_container_does_not_pollute_work_title():
    graph, _ = resolve(["动画/排球少年/剧场版合集/排球少年 Movie 胜者与败者.mkv"])
    assert len(graph.works) == 1
    assert "合集" not in graph.works[0].preferred_title


def test_decimal_order_uses_sibling_evidence_and_preserves_real_decimal_titles():
    graph, _ = resolve([
        "动画/作品合集/13. 历物语/历物语 S01E01.mkv",
        "动画/作品合集/13.5 伤物语/Other Language Title [1080p].mkv",
        "动画/作品合集/14. 续终物语/续终物语 S01E01.mkv",
        "动画/作品合集/02. 正常作品/正常作品 S01E01.mkv",
        "动画/作品合集/2.5 Dimensional Seduction/2.5 Dimensional Seduction S01E01.mkv",
        "动画/作品合集/03. 下一作品/下一作品 S01E01.mkv",
    ])
    assert any(work.preferred_title == "伤物语" for work in graph.works)
    assert not any(work.preferred_title.startswith("13.5") for work in graph.works)
    assert any(work.preferred_title == "2.5 Dimensional Seduction" for work in graph.works)
