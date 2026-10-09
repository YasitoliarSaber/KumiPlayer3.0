"""在新解析中采用精确、无冲突的发行身份，不读取网络、库或学习结果。"""

import re
import unicodedata
from dataclasses import replace
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Any

from app.media_v4.domain.identity import (
    CLASSIFICATION_EXPLICIT,
    CONTENT_CLASS_MOVIE,
    ORIGIN_EXPLICIT_DIRECTORY,
    ORIGIN_EXPLICIT_FILENAME,
    ORIGIN_PARSER_RULE,
    ORIGIN_UNKNOWN,
    DecisionTrace,
    NumberingEvidence,
)
from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.parsing.release_catalog import VERIFIED_RELEASES, VerifiedRelease
from app.recognition.media import _extract_release_movie_title, _parse_work_title_and_year

_FORM_PREFIX = re.compile(
    r"(?i)^(?:(?:Gekij(?:ou|o|ō)ban|Tokubetsu[ ._-]+Hen|Movie)\b[\s:._-]*|(?:剧场版|劇場版|映画|电影)[\s:：._-]*)"
)
_YEAR = re.compile(r"(?<!\d)(?:19|20)\d{2}(?!\d)")
_DISPLAY_FORM = re.compile(r"剧场版|劇場版|电影版|電影版|映画")


@lru_cache(maxsize=4096)
def _normalized_title(title: str) -> str:
    # resolution 的包入口导入 Parser，比较函数须在解析器加载完成后复用。
    from app.media_v4.resolution.title_norm import normalize_match_title

    return normalize_match_title(_FORM_PREFIX.sub("", unicodedata.normalize("NFKC", title).strip(), count=1))


def match_verified_release(title: str, releases: tuple[VerifiedRelease, ...] = VERIFIED_RELEASES) -> VerifiedRelease | None:
    """完整等值且仅有一个发行身份才采用；不依赖表顺序或最长子串。"""
    normalized = _normalized_title(title)
    if not normalized:
        return None
    matches = [release for release in releases if normalized in {
        _normalized_title(alias) for alias in (release.title, *release.aliases)
    }]
    return matches[0] if len(matches) == 1 else None


def apply_verified_release(facts: ParsedFacts, evidence: SourceEvidence, work_container: str) -> ParsedFacts:
    """只生成当前解析的值对象；已保存的旧事实永远不经过此入口。"""
    season_facts = _apply_verified_season(facts, evidence, work_container)
    if season_facts is not facts:
        return season_facts
    if (evidence.import_family.strip().casefold() != "anime"
            or not facts.is_importable or facts.is_auxiliary
            or facts.content_class not in {"unknown", "regular", "movie"}
            or facts.special_candidate or facts.episode_candidate is not None
            or facts.absolute_episode_candidate is not None or facts.episode_range
            or facts.numbering.season_origin == ORIGIN_EXPLICIT_FILENAME
            or any(trace.field == "episode_number_candidate" for trace in facts.decision_trace)):
        return facts
    if ((facts.tmdb_hint_id and facts.tmdb_hint_type != "movie")
            or (evidence.tmdb_hint_type and evidence.tmdb_hint_type != "movie")):
        return facts
    filename = PurePosixPath(evidence.relative_path.replace("\\", "/")).name
    filename_title, _ = _parse_work_title_and_year(_extract_release_movie_title(filename))
    release = match_verified_release(filename_title)
    if release is None or release.release_form not in {"theatrical_movie", "theatrical_special"}:
        return facts
    # 文件声明及当前作品目录的年份优先；不拿祖先 TV 开播年否定电影发行年。
    local_years = {int(match.group()) for match in _YEAR.finditer(filename)}
    local_years.update(int(match.group()) for match in _YEAR.finditer(work_container))
    if local_years and local_years != {release.year}:
        return facts
    # 已经正确识别的电影展示名继续保留；目录 S2 或不同作品名不能借此保留。
    display_release = match_verified_release(_DISPLAY_FORM.sub("", facts.work_title))
    display_title = (facts.work_title if facts.content_class == CONTENT_CLASS_MOVIE
                     and display_release is not None and display_release.key == release.key else release.title)
    identity: dict[str, Any] = {
        "work_title": display_title, "series_group": release.series_title,
        "media_type": "movie", "card_type": "standalone", "relation_type": "related",
        "season_candidate": None, "group_type": "movie", "year_candidate": release.year,
    }
    traces = []
    for trace in facts.decision_trace:
        if trace.field == "structure_context" and isinstance(trace.value, dict):
            traces.append(replace(trace, value={**trace.value, "parsed_identity": identity}))
        elif trace.field in {"work_title", "content_class"}:
            traces.append(replace(trace, field=trace.field + "_candidate"))
        elif trace.field == "numbering":
            traces.append(replace(trace, field="numbering_candidate", value={
                **trace.value, "numbering_evidence": {
                    "season_origin": facts.numbering.season_origin,
                    "episode_origin": facts.numbering.episode_origin,
                    "absolute_origin": facts.numbering.absolute_origin,
                    "scope_key": facts.numbering.scope_key, "basis": list(facts.numbering.basis),
                },
            }))
        elif trace.field != "unknown_filename_identity":
            traces.append(trace)
    traces.extend((
        DecisionTrace(field="verified_release_identity", origin=ORIGIN_PARSER_RULE, scope="file",
                      rule_id="verified_release_exact_title", value={
                          "release_key": release.key, "matched_title": filename_title,
                          "canonical_title": release.title, "year": release.year,
                          "release_form": release.release_form, "source_urls": list(release.source_urls),
                      }),
        DecisionTrace(field="work_title", value=display_title, origin=ORIGIN_PARSER_RULE,
                      scope="file", rule_id="verified_release_exact_title"),
        DecisionTrace(field="content_class", value=CONTENT_CLASS_MOVIE, origin=ORIGIN_PARSER_RULE,
                      scope="file", rule_id="verified_release_exact_title"),
        DecisionTrace(field="numbering", value={
                          "season": None, "episode": None, "absolute": None, "episode_origin": ORIGIN_UNKNOWN,
                      }, origin=ORIGIN_UNKNOWN, scope="local", rule_id="verified_feature_has_no_episode"),
    ))
    return replace(
        facts, **identity, original_title=filename_title,
        content_class=CONTENT_CLASS_MOVIE, classification_state=CLASSIFICATION_EXPLICIT,
        title_candidates=tuple(dict.fromkeys((display_title, release.title, filename_title, *release.aliases))),
        confidence="high", needs_review=False, episode_title="", season_token_raw="",
        numbering=NumberingEvidence(),
        show_type=facts.show_type.split("_", 1)[0] + "_movie" if "_" in facts.show_type else facts.show_type,
        decision_trace=tuple(traces), reasons=(*facts.reasons, "完整标题匹配已核验的官方发行身份"),
    )


def _apply_verified_season(facts: ParsedFacts, evidence: SourceEvidence, work_container: str) -> ParsedFacts:
    if (evidence.import_family.strip().casefold() != "anime" or not facts.is_importable or facts.is_auxiliary
            or facts.content_class != "regular" or facts.episode_candidate is None or facts.episode_candidate <= 0
            or facts.episode_range or facts.special_candidate or facts.classification_state == "conflict"
            or any(trace.rule_id == "hint_conflict" for trace in facts.decision_trace)):
        return facts
    filename = PurePosixPath(evidence.relative_path.replace("\\", "/")).name
    title, _ = _parse_work_title_and_year(_extract_release_movie_title(filename))
    release = match_verified_release(title)
    if release is None or release.release_form != "tv_season" or release.season_number is None:
        return facts
    if ((facts.tmdb_hint_type and facts.tmdb_hint_type != "tv")
            or (evidence.tmdb_hint_type and evidence.tmdb_hint_type != "tv")):
        return facts
    if (facts.numbering.season_origin in {ORIGIN_EXPLICIT_FILENAME, ORIGIN_EXPLICIT_DIRECTORY}
            and facts.season_candidate != release.season_number):
        return facts
    local_years = {int(match.group()) for match in _YEAR.finditer(filename + " " + work_container)}
    if local_years and local_years != {release.year}:
        return facts
    identity: dict[str, Any] = {
        "work_title": release.series_title, "series_group": release.series_title, "media_type": "tv",
        "card_type": "main_series", "relation_type": "", "season_candidate": release.season_number,
        "group_type": "season", "year_candidate": None,
    }
    traces = []
    for trace in facts.decision_trace:
        if trace.field == "structure_context" and isinstance(trace.value, dict):
            traces.append(replace(trace, value={**trace.value, "title": release.series_title, "year": None,
                "season_scoped": True, "directory_season": release.season_number, "parsed_identity": identity}))
        elif trace.field in {"numbering", "work_title"}:
            traces.append(replace(trace, field=trace.field + "_candidate"))
        else:
            traces.append(trace)
    traces.extend((
        DecisionTrace(field="verified_season_identity", origin=ORIGIN_PARSER_RULE, scope="file",
            rule_id="verified_season_exact_title", value={"release_key": release.key, "title": release.title,
                "year": release.year, "season": release.season_number, "source_urls": list(release.source_urls)}),
        DecisionTrace(field="work_title", value=release.series_title, origin=ORIGIN_PARSER_RULE,
                      scope="file", rule_id="verified_season_exact_title"),
        DecisionTrace(field="numbering", value={"season": release.season_number,
            "episode": facts.episode_candidate, "absolute": facts.absolute_episode_candidate,
            "episode_origin": facts.numbering.episode_origin}, origin=ORIGIN_PARSER_RULE,
            scope="local", rule_id="verified_season_exact_title"),
    ))
    return replace(facts, **identity, original_title=title, season_token_raw="",
        numbering=replace(facts.numbering, season_origin=ORIGIN_PARSER_RULE,
                          basis=(*facts.numbering.basis, "verified_season_exact_title")),
        title_candidates=tuple(dict.fromkeys((release.series_title, release.title, title, *release.aliases))),
        confidence="high", decision_trace=tuple(traces))
