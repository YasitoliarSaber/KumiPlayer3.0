"""真实目录的正片、特别篇、辅助内容及所有版本一起验证，不能只挑成功文件。"""

import json
from pathlib import Path

import pytest
from backend.tests.test_v4_structure_context import resolve, semantics

from app.media_v4.resolution.resolver import MediaResolver

PATHS = json.loads(Path(__file__).with_name("fixtures").joinpath("media_structure_paths.json").read_text(encoding="utf-8"))["paths"]


@pytest.mark.parametrize("provider", ["quark", "local"])
def test_real_corpus_root_invariance_asset_coverage_and_order(provider):
    broad, pairs = resolve(PATHS, provider=provider)
    narrow, _ = resolve(PATHS, prefix="动画/", root_container="动画", provider=provider)
    assert semantics(broad) == semantics(narrow)
    assert semantics(broad) == semantics(MediaResolver().resolve(list(reversed(pairs))))
    admitted = {e.evidence_id for e, f in pairs if f.is_importable and not f.is_auxiliary}
    member_ids = {evidence_id for episode in broad.episodes for evidence_id in episode.asset_evidence_ids}
    member_ids.update(evidence_id for asset in broad.work_assets for evidence_id in asset.asset_evidence_ids)
    assert member_ids == admitted
    # 编号剧集的多版本都归于同一逻辑身份；未定位文件保留各自资产。
    assert sum(len(work.source_evidence_ids) for work in broad.works) == len(admitted)
    assert len(PATHS) >= 500


@pytest.mark.parametrize("keyword,title,regular_count", [
    ("Clannad", "Clannad", 46),
    ("排球少年", "排球少年", 85),
    ("辉夜", "辉夜大小姐想让我告白", 37),
])
def test_real_multiseason_main_and_specials_remain_together(keyword, title, regular_count):
    paths = [path for path in PATHS if keyword.casefold() in path.casefold()]
    graph, _ = resolve(paths)
    matching = [work for work in graph.works if work.preferred_title.casefold() == title.casefold()]
    assert len(matching) == 1
    work = matching[0]
    regular = [episode for episode in graph.episodes
               if episode.work_key == work.work_key and episode.episode_kind == "regular"]
    assert len(regular) == regular_count
    assert not any(other.preferred_title == title and other.work_key != work.work_key for other in graph.works)


def test_real_monogatari_is_collection_with_independent_children():
    graph, _ = resolve([path for path in PATHS if "物语系列" in path])
    families = [collection for collection in graph.collections if "物语" in collection.preferred_title]
    assert families and len(families[0].member_work_keys) >= 12
    assert not any("物语系列" == work.preferred_title for work in graph.works)
    assert {"化物语", "伪物语"} <= {work.preferred_title for work in graph.works}
    assert all(episode.provider_season_number is None and episode.provider_episode_number is None
               for episode in graph.episodes)
