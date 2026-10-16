"""2026-10-16 真实库回归；只重放相对目录与已留存候选，不访问真实媒体。"""

import json
from types import SimpleNamespace

import pytest
from app.media_v4.domain.models import SourceEvidence
from app.media_v4.jobs import metadata
from app.media_v4.parsing.parser import V4Parser
from app.media_v4.resolution.candidates import query_variants, strip_season_marker
from app.media_v4.resolution.ranker import CandidateRanker


def test_real_road_to_the_top_query_does_not_delete_oad_inside_title():
    queries = query_variants("Uma Musume Pretty Derby - Road to the Top")
    assert not any("R to the Top" in query for query in queries)
    assert "Road to the Top" in queries
    assert "作品 OAD" not in query_variants("作品 OAD")[1:]


@pytest.mark.parametrize(("word", "season", "episode"), [("Second", 2, 19), ("Third", 3, 7)])
def test_real_yama_no_susume_ordinal_seasons_keep_their_numbers(word, season, episode):
    title = f"Yama no Susume {word} Season"
    path = (
        "动画/[VCB-Studio] Yama no Susume/"
        f"[VCB-Studio] {title} [Ma10p_1080p]/"
        f"[VCB-Studio] {title} [{episode:02d}][Ma10p_1080p][x265_flac].mkv"
    )
    evidence = SourceEvidence("ordinal", "scan", "root", path, path, "video", provider="pan115")
    facts = V4Parser().parse(evidence)
    assert facts.season_candidate == season
    assert facts.episode_candidate == episode
    assert facts.content_class == "regular"
    assert facts.is_importable
    assert strip_season_marker(title) == "Yama no Susume"


def test_real_numbered_movie_container_does_not_steal_filename_identity():
    path = "摇曳露营/Special 2 剧场版/[Ygm] Yuru Camp Movie [Ma10p_2160p][x265_flac_ass].mkv"
    evidence = SourceEvidence("movie", "scan", "root", path, path, "video", provider="quark")
    facts = V4Parser().parse(evidence)
    assert facts.work_title == "Yuru Camp Movie"
    assert facts.media_type == "movie"
    assert facts.group_type == "movie"
    assert facts.is_importable
    assert facts.episode_candidate is None


def test_real_road_to_the_top_parent_query_is_not_identity_evidence(monkeypatch):
    target = {
        "preferred_title": "赛马娘 巅峰之路",
        "identity_titles": ["赛马娘 巅峰之路", "Uma Musume Pretty Derby - Road to the Top"],
        "work_type": "series",
        "show_type": "anime_series",
    }
    candidates = [
        {"provider": "tmdb", "provider_id": "77694", "media_type": "tv",
         "title": "赛马娘 Pretty Derby", "original_title": "ウマ娘 プリティーダービー",
         "aliases": ["Uma Musume Pretty Derby"], "year": 2018},
        {"provider": "tmdb", "provider_id": "223251", "media_type": "tv",
         "title": "赛马娘 巅峰之路", "original_title": "ウマ娘 プリティーダービー ROAD TO THE TOP",
         "aliases": [], "year": 2023},
    ]
    monkeypatch.setattr(metadata, "enrich_candidate_aliases", lambda *_a, **_k: candidates)
    ranked, adopted, _reason = metadata._rank_metadata_candidates(
        target, "tv", metadata._search_titles(target), {}, object(),
    )
    assert adopted is not None and adopted.provider_id == "223251"
    parent = next(c for c in ranked if c.provider_id == "77694")
    assert not parent.identity_safe


@pytest.mark.parametrize("recovery", [False, True])
def test_subtitle_query_never_authorizes_the_parent_even_without_competitor(monkeypatch, recovery):
    target = {
        "preferred_title": "始动篇",
        "identity_titles": ["始动篇", "Saiki Kusuo no Sainan - Shidou Hen"],
        "work_type": "series",
    }
    if recovery:
        target["recovery_search_queries"] = ["Saiki Kusuo no Sainan"]
    candidates = [{"provider": "tmdb", "provider_id": "67676", "media_type": "tv",
                   "title": "齐木楠雄的灾难", "aliases": ["Saiki Kusuo no Sainan"], "year": 2016}]
    monkeypatch.setattr(metadata, "enrich_candidate_aliases", lambda *_a, **_k: candidates)
    _ranked, adopted, _reason = metadata._rank_metadata_candidates(
        target, "tv", metadata._search_titles(target), {}, object(),
    )
    assert adopted is None


def test_movie_formatting_can_be_normalized_without_discarding_subtitle(monkeypatch):
    target = {"preferred_title": "剧场版 排球少年 垃圾场决战", "work_type": "movie"}
    candidates = [{"provider": "tmdb", "provider_id": "1012201", "media_type": "movie",
                   "title": "排球少年！！垃圾场决战", "year": 2024}]
    monkeypatch.setattr(metadata, "enrich_candidate_aliases", lambda *_a, **_k: candidates)
    _ranked, adopted, _reason = metadata._rank_metadata_candidates(
        target, "movie", metadata._search_titles(target), {}, object(),
    )
    assert adopted is not None and adopted.provider_id == "1012201"


def test_ordinal_words_inside_sentences_are_not_season_tokens():
    from app.media_v4.parsing.season_tokens import ordinal_season_number

    assert ordinal_season_number("The Third Season of Love") is None
    assert ordinal_season_number("Third Person") is None
    assert ordinal_season_number("Yama no Susume Third Season [Ma10p_1080p]") == 3


def test_explicit_file_season_wins_over_english_directory_season():
    path = "Example Third Season/Example.S02E07.mkv"
    evidence = SourceEvidence("conflict", "scan", "root", path, path, "video")
    facts = V4Parser().parse(evidence)
    assert facts.season_candidate == 2
    assert "season_evidence_conflict" in facts.reasons


def test_margin_keeps_plausible_runner_up_below_the_adoption_floor():
    ranker = CandidateRanker(min_score=60, min_margin=11)
    ranked = ranker.rank(
        {"preferred_title": "A Complete Title", "media_type": "tv", "year": 2023},
        [{"provider": "tmdb", "provider_id": "1", "media_type": "tv", "title": "An Alias",
          "aliases": ["A Complete Title"], "year": 2023},
         {"provider": "tmdb", "provider_id": "2", "media_type": "tv", "title": "A Complete Title", "year": 2022}],
    )
    assert [item.score for item in ranked] == [68, 58]
    adopted, reason = ranker.auto_adopt(ranked)
    assert adopted is None and "分差不足" in reason


def test_candidate_diagnostics_roundtrip_replays_scoring_and_hard_conflicts():
    target = {"preferred_title": "Real Movie", "media_type": "movie", "year": 2024, "show_type": "anime_movie"}
    candidates = [{"provider": "tmdb", "provider_id": "movie", "media_type": "movie", "title": "Real Movie",
                   "year": 2024, "genre_ids": [16]},
                  {"provider": "tmdb", "provider_id": "tv", "media_type": "tv", "title": "Real Movie",
                   "year": 2020, "genre_ids": [18]}]
    ranker = CandidateRanker()
    ranked = ranker.rank(target, candidates)
    adopted, reason = ranker.auto_adopt(ranked)
    saved = json.loads(json.dumps(metadata._candidate_decision_payload(
        ranked, adopted, reason, identity_input=target,
    )))
    replay = ranker.rank(saved["identity_input"], saved["ranked_candidates"])
    assert [(c.score, c.identity_safe, c.blocked) for c in replay] == [(c.score, c.identity_safe, c.blocked) for c in ranked]
    rejected = next(c for c in saved["ranked_candidates"] if c["provider_id"] == "tv")
    assert set(rejected["hard_conflicts"]) == {"year_conflict", "media_type_conflict", "domain_conflict"}


@pytest.mark.parametrize("aliases,expected", [(["Porco Rosso", "红猪"], "11621"), (["Porco Rosso"], None), (["红猪"], None)])
def test_real_bilingual_movie_needs_both_provider_title_names(aliases, expected):
    ranker = CandidateRanker()
    ranked = ranker.rank(
        {"preferred_title": "红猪.Porco.Rosso", "media_type": "movie"},
        [{"provider": "tmdb", "provider_id": "11621", "media_type": "movie", "title": "紅の豚", "aliases": aliases}],
    )
    adopted, _reason = ranker.auto_adopt(ranked)
    assert (adopted.provider_id if adopted else None) == expected


@pytest.mark.parametrize("has_candidate", [False, True])
def test_metadata_distinguishes_retrieval_from_identity_gate(monkeypatch, has_candidate):
    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def search_tv(self, *_args):
            return [{"id": 1, "name": "Different title"}] if has_candidate else []

        def get_tv_detail(self, *_args):
            return {}

    monkeypatch.setattr(metadata, "TMDBClient", Client)
    monkeypatch.setattr(metadata, "load_config", lambda: SimpleNamespace(tmdb_bearer_token="fixture"))
    result = metadata.default_metadata_provider({"preferred_title": "Confirmed local title", "work_type": "series"})
    assert result["failure_stage"] == ("identity_resolution" if has_candidate else "candidate_retrieval")
    assert result["candidate_decision"]["identity_input"]["queries"] == ["Confirmed local title"]
