"""编号版本文件不能被未知组织子目录夺走作品身份。"""

import pytest

from app.media_v4.parsing.parser import V4Parser, normalize_batch_parsed_facts
from app.media_v4.resolution.resolver import MediaResolver
from app.media_v4.sources.adapters import SourceEntry, to_source_evidence


def resolve(paths, provider="baidu", method="directory_tree"):
    parser = V4Parser()
    pairs = []
    for path in paths:
        evidence = to_source_evidence(SourceEntry(
            root_id="edition-parent", scan_id="edition-parent", provider=provider,
            ingest_method=method, relative_path=path,
        ))
        pairs.append((evidence, parser.parse(evidence)))
    pairs = normalize_batch_parsed_facts(pairs)
    return MediaResolver().resolve(pairs), pairs


@pytest.mark.parametrize("folder", ["sprcial", "其他版本"])
@pytest.mark.parametrize("provider,method", [
    ("baidu", "directory_tree"), ("pan115", "directory_tree"),
    ("quark", "openlist_scan"), ("local", "local_scan"),
])
def test_numbered_on_air_edition_keeps_named_parent(folder, provider, method):
    graph, pairs = resolve([
        "动画/天元突破/tv/天元突破 - S01E05 - 标题.mkv",
        "动画/天元突破/tv/天元突破 - S01E06 - 标题.mkv",
        f"动画/天元突破/{folder}/[4K_EA] 天元突破 05.5 [简体内嵌]【Bilibili_AYWDXNH】.mkv",
        f"动画/天元突破/{folder}/[4K_EA] 天元突破 06(On Air Ver) [简体内嵌]【Bilibili_AYWDXNH】.mkv",
    ], provider, method)
    assert {work.preferred_title for work in graph.works} == {"天元突破"}
    assert not pairs[2][1].is_importable
    sixth = [episode for episode in graph.episodes if episode.local_episode_number == 6]
    assert len(sixth) == 2
    assert len({episode.episode_key for episode in sixth}) == 1
    assert {episode.edition_key for episode in sixth} == {"default", "on-air"}


@pytest.mark.parametrize("path,expected", [
    ("动画/Show/Another Show/Another Show 06(On Air Ver).mkv", "Another Show"),
    ("动画/Show/Show Movie/Show Movie (2007).mkv", "Show Movie"),
    ("动画/Show Collection/Child/Show Collection 06(On Air Ver).mkv", "Child"),
    ("动画/Show/ArchiveBox/Show 06.mkv", "ArchiveBox"),
])
def test_named_subwork_and_unmarked_files_keep_directory_boundary(path, expected):
    graph, _ = resolve([path])
    assert [work.preferred_title for work in graph.works] == [expected]
