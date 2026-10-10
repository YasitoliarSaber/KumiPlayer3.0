"""M02：技术参数、小数标题与真实集号的离线编号边界。"""

from pathlib import PurePosixPath

import pytest
from app.media_v4.parsing.evidence_policy import parse_numbering, tokenize_filename
from app.media_v4.parsing.parser import V4Parser
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence

TECHNICAL_FIELDS = (
    "DTS_5.1", "DTS-HD_5.1", "DTS-HD MA 5.1", "FLAC7.1", "AAC5.1",
    "AAC 5.1", "23.976fps", "H264.50fps", "v1.5", "2160p",
    "DDP 5.1", "DD+ 5.1", "Dolby Digital 5.1", "DTS:X 7.1",
    "[DTS_5.1][FLAC7.1][23.976fps][v1.5][2160p]",
)


def _parse(path):
    evidence = to_source_evidence(SourceEntry(
        root_id="technical-boundaries", scan_id="offline", provider="quark",
        ingest_method="openlist_api", relative_path=path, source_key=path,
    ))
    return V4Parser().parse(evidence)


@pytest.mark.parametrize("technical", TECHNICAL_FIELDS)
@pytest.mark.parametrize("bracketed", [False, True])
def test_technical_parameters_never_supply_episode_numbers(technical, bracketed):
    field = f"[{technical}]" if bracketed else technical
    path = f"凉宫春日的消失/The Disappearance of Haruhi Suzumiya {field}.mkv"
    numbering = parse_numbering(tokenize_filename(path))
    assert numbering.episode is None
    assert numbering.absolute is None
    assert not numbering.candidates
    facts = _parse(path)
    assert facts.episode_candidate is None
    assert facts.absolute_episode_candidate is None
    assert facts.content_class not in {"regular", "playable_special", "attached_special"}
    assert not [trace for trace in facts.decision_trace if trace.field == "episode_number_candidate"]


@pytest.mark.parametrize("technical", TECHNICAL_FIELDS)
@pytest.mark.parametrize(("marker", "season", "episode"), [("[01]", 1, 1), ("S02E03", 2, 3)])
def test_explicit_numbers_survive_technical_parameters(technical, marker, season, episode):
    facts = _parse(f"作品甲/作品甲 {marker} [{technical}].mkv")
    assert (facts.season_candidate, facts.episode_candidate) == (season, episode)
    assert facts.content_class == "regular"


@pytest.mark.parametrize("marker", ["- 13", "part-13", "13(On Air Ver)", "13.1080p", "13.2160p"])
def test_technical_fields_before_real_bare_episode_do_not_hide_it(marker):
    facts = _parse(f"作品甲/作品甲 DTS_5.1 {marker}.mkv")
    assert facts.episode_candidate == 13


@pytest.mark.parametrize("number", [480, 576, 720])
def test_bracketed_large_episode_numbers_are_not_resolution_parameters(number):
    facts = _parse(f"作品甲/作品甲 [{number}][1080p].mkv")
    assert facts.episode_candidate == number


@pytest.mark.parametrize("title", ["2.5次元的诱惑", "2.5 Dimensional Seduction", "作品 8.5"])
def test_title_decimals_do_not_supply_partial_integer_episode(title):
    numbering = parse_numbering(tokenize_filename(f"{title}/{title}.mkv"))
    assert numbering.episode is None
    assert not numbering.candidates
    facts = _parse(f"{title}/{title} S02E03 [DTS_5.1].mkv")
    assert (facts.season_candidate, facts.episode_candidate) == (2, 3)
    assert facts.content_class == "regular"
    assert title in facts.title_candidates


@pytest.mark.parametrize("marker", ["[8.5]", "- 8.5", "第8.5集", "E8.5", "[5.1]", "- 7.1"])
def test_real_fractional_episodes_are_excluded_specials(marker):
    path = f"2.5次元的诱惑/2.5次元的诱惑 {marker} [DTS_5.1].mkv"
    facts = _parse(path)
    assert facts.content_class == "attached_special"
    assert not facts.is_importable and facts.is_auxiliary
    assert facts.episode_candidate is None
    assert facts.episode_title == PurePosixPath(path).stem


@pytest.mark.parametrize("marker", ["S01E14.0", "[14.0]", "- 14.00", "第14.0集"])
def test_integral_episode_decimal_is_not_a_special_by_punctuation_alone(marker):
    facts = _parse(f"作品甲/Season 1/作品甲 {marker} [DDP 5.1].mkv")
    assert facts.is_importable and facts.content_class == "regular"
    assert facts.episode_candidate == 14


@pytest.mark.parametrize("title", ["不要再来总集篇啦 ！", "电影之夜", "Movie Night", "外传的故事"])
def test_episode_title_keywords_do_not_turn_explicit_regular_into_movie(title):
    facts = _parse(f"白箱/白箱 - S01E03 - {title}.mkv")
    assert facts.is_importable and facts.content_class == "regular"
    assert facts.work_title == "白箱" and facts.card_type != "standalone"
    assert (facts.season_candidate, facts.episode_candidate) == (1, 3)



@pytest.mark.parametrize("marker", ["04.5(Extra Episode)", "04.5 (Extra Episode)", "04.5(特别篇)"])
def test_annotated_fraction_in_year_named_tv_directory_stays_special(marker):
    path = f"动画/作品甲.TV版+外传+剧场版/1.作品甲.2018/[Group] Show - {marker} [Ma10p_2160p][x265_flac_ass].mkv"
    facts = _parse(path)
    assert facts.content_class == "attached_special" and not facts.is_importable
    assert facts.media_type == "tv" and facts.card_type == "main_series"
    assert facts.episode_candidate is None
    assert facts.episode_token_raw == "04.5"
    assert facts.episode_title == PurePosixPath(path).stem
