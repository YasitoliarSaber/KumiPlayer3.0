"""副标题季度的官方关系只用于新解析，电影与未知副标题保持隔离。"""
from dataclasses import asdict, replace

import pytest
from app.media_v4.parsing.parser import V4Parser
from app.media_v4.resolution.resolver import MediaResolver
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence


def resolve(paths, prefix=""):
    entries = []
    for path in paths:
        evidence = to_source_evidence(SourceEntry(root_id="verified-season", scan_id="scan", provider="quark", ingest_method="openlist_scan",
            relative_path=path.removeprefix(prefix), source_key=path, source_locator="/offline/" + path))
        entries.append((evidence, V4Parser().parse(evidence)))
    before = [asdict(facts) for _, facts in entries]
    graph = MediaResolver().resolve(entries)
    assert before == [asdict(facts) for _, facts in entries]
    return graph, entries


@pytest.mark.parametrize("prefix", ["", "动画/", "动画/来自深渊 烈日的黄金乡/"])
def test_subtitled_second_season_does_not_become_another_season_one(prefix):
    graph, entries = resolve([
        "动画/来自深渊 烈日的黄金乡/[TUDO&Ygm] Made in Abyss Retsujitsu no Ougonkyou [01][2160p].mkv",
    ], prefix)
    assert graph.works[0].preferred_title == "来自深渊"
    assert graph.episodes[0].local_season_number == 2
    assert graph.episodes[0].local_episode_number == 1
    assert entries[0][1].tmdb_hint_id is None
    assert next(t.value for t in entries[0][1].decision_trace if t.field == "numbering")["season"] == 2


def test_main_and_subtitled_season_share_work_but_movies_stay_separate():
    graph, _ = resolve([
        "动画/来自深渊/[TUDO&Ygm] Made in Abyss [01][2160p].mkv",
        "动画/来自深渊 烈日的黄金乡/[TUDO&Ygm] Made in Abyss Retsujitsu no Ougonkyou [01][2160p].mkv",
        "动画/来自深渊剧场版/Made in Abyss Movie 3 Fukaki Tamashii no Reimei [2160p].mkv",
    ])
    tv = [work for work in graph.works if work.media_type == "tv"]
    assert len(tv) == 1 and len(tv[0].source_evidence_ids) == 2
    assert {episode.local_season_number for episode in graph.episodes} == {1, 2}
    assert len(graph.work_assets) == 1


@pytest.mark.parametrize("suffix", ["OVA", "SP01", "[04.5]", "S01E01", "Movie", "Unknown Subtitle [01]"])
def test_special_movie_conflicting_season_or_unknown_subtitle_does_not_use_season_knowledge(suffix):
    _, entries = resolve([f"动画/Other/Made in Abyss Retsujitsu no Ougonkyou {suffix}.mkv"])
    assert not any(t.field == "verified_season_identity" for t in entries[0][1].decision_trace)


@pytest.mark.parametrize("overrides", [
    {"import_family": "drama"}, {"tmdb_hint_id": "42", "tmdb_hint_type": "movie"},
    {"relative_path": "Other/Made in Abyss Retsujitsu no Ougonkyou 2021 [01].mkv"},
    {"relative_path": "Other/Season 3/Made in Abyss Retsujitsu no Ougonkyou [01].mkv"},
    {"relative_path": "Other/Made in Abyss Retsujitsu no Ougonkyou [tmdb-99] [01].mkv",
     "tmdb_hint_id": "42", "tmdb_hint_type": "tv"},
])
def test_conflicting_local_identity_never_adopts_verified_season(overrides):
    _, entries = resolve(["Other/Made in Abyss Retsujitsu no Ougonkyou [01].mkv"])
    evidence = replace(entries[0][0], **overrides)
    facts = V4Parser().parse(evidence)
    assert not any(t.field == "verified_season_identity" for t in facts.decision_trace)
