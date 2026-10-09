import pytest
from app.media_v4.parsing.parser import V4Parser
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence


def parse(path):
    evidence = to_source_evidence(SourceEntry(root_id="r", scan_id="s", provider="quark", ingest_method="openlist_api", relative_path=path, source_key=path))
    return V4Parser().parse(evidence)


@pytest.mark.parametrize("path", [
    "灵能百分百/第二季/[Ygm] Mob Psycho 100 II [14(OVA)][Ma10p_2160p][x265_flac_ass].mkv",
    "赛马娘/第一季/[Ygm] Uma Musume Pretty Derby [14(OVA01)][Ma10p_2160p].mkv",
    "命运石之门/第一季/[MAI] Steins;Gate [25 SP][Ma10p_2160p].mkv",
    "Love Live/第一季/Fan Disc/[Group] Love Live! Fan Disc [School Map #02].mkv",
    "Love Live/第一季/μ's Best Album Best Live! Collection/[Ygm] Song [Wonderful Rush].mkv",
])
def test_explicit_attached_bonus_is_not_regular_episode(path):
    facts = parse(path)
    if "OVA" in path or "[25 SP]" in path:
        assert not facts.is_importable
        assert facts.content_class == "attached_special"
        assert facts.episode_candidate is None
        assert facts.group_type == "special"
        assert facts.is_auxiliary
        assert facts.special_number is None
    else:
        assert not facts.is_importable
        assert facts.content_class in {"auxiliary", "attached_special"}


@pytest.mark.parametrize("marker", ["OP01", "ED01", "PV01", "Menu", "Trailer"])
def test_sp_marker_never_overrides_auxiliary_video(marker):
    facts = parse(f"命运石之门/第一季/[MAI] Steins;Gate [25 SP][{marker}].mkv")
    assert not facts.is_importable
    assert facts.is_auxiliary
    assert facts.content_class == "auxiliary"


def test_real_numbered_sp_is_excluded_without_regular_or_provider_coordinates():
    from pathlib import PurePosixPath

    from app.media_v4.resolution.resolver import MediaResolver

    path = "命运石之门/第一季/[MAI] Steins;Gate [25 SP][Ma10p_2160p].mkv"
    evidence = to_source_evidence(SourceEntry(
        root_id="r", scan_id="s", provider="quark", ingest_method="openlist_api",
        relative_path=path, source_key=path,
    ))
    facts = V4Parser().parse(evidence)
    assert facts.episode_title == PurePosixPath(path).stem
    graph = MediaResolver().resolve([(evidence, facts)])
    assert not facts.is_importable
    assert facts.episode_candidate is None
    assert graph.works == graph.episodes == graph.work_assets == ()


def test_malformed_episode_bracket_does_not_drop_clear_episode_number():
    facts = parse("冰海战记/第二季/[TUDO&Ygm] Vinland Saga S2 [06[Ma10p_2160p][x265_flac_ass].mkv")
    assert facts.episode_candidate == 6
    assert facts.season_candidate == 2


@pytest.mark.parametrize("path", ["电影/Other Movie.mkv", "Other Movie/Other Movie.mkv", "Another Spin-off/Another Spin-off.S01E01.mkv"])
def test_independent_release_forms_remain_importable(path):
    assert parse(path).is_importable


@pytest.mark.parametrize("path", [
    "Independent OVA/[Group] Independent OVA [01].mkv",
    "Independent OVA/[Group] Independent OVA [01(OVA01)].mkv",
    "电影/Other Movie [01(OVA)].mkv",
])
def test_explicit_special_markers_are_excluded_even_in_movie_directory(path):
    facts = parse(path)
    assert not facts.is_importable
    assert facts.content_class == "attached_special"
