"""来源无关的目录上下文，只消费观察证据，不触盘、不查询在线身份。"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.generic_container import is_generic_container_name
from app.media_v4.parsing.evidence_policy import parse_numbering, tokenize_filename
from app.recognition.media import (
    _extract_release_movie_title,
    _extract_series_name_from_filename,
    _infer_season_from_context,
    _is_generic_category_name,
    _is_group_folder,
    _is_series_container,
    _looks_like_plain_season_dir,
    _looks_like_specials_dir,
    _parse_work_title_and_year,
)
from app.recognition.title_cleaner import clean_work_title_container


def normalized_title(value: str) -> str:
    title, _ = _parse_work_title_and_year(value)
    title = re.sub(r"(?i)(?:\bseason\s*\d+|\bS\d{1,2}\b|第[一二三四五六七八九十\d]+季)", "", title)
    return re.sub(r"[^a-z0-9\u3400-\u9fff]+", "", title.casefold())


def is_collection_container(value: str) -> bool:
    title, _ = _parse_work_title_and_year(value)
    return bool(re.search(r"(?i)(?:系列|合集|\bcollection\b|\bseries\b)\s*$", title))


def _is_structure(value: str) -> bool:
    return bool(is_generic_container_name(value) or _is_generic_category_name(value)
                or _looks_like_plain_season_dir(value) or _looks_like_specials_dir(value)
                or _is_group_folder(value)
                or re.fullmatch(r"(?i)(?:剧场版|电影|movie|movies)(?:合集|collection)?", value))


def semantic_path(evidence: SourceEvidence, root_container: str = "") -> str:
    """定位符与相对路径后缀一致时恢复祖先；不使用播放 URL 或不透明 file id。"""
    relative = evidence.relative_path.replace("\\", "/").strip("/")
    parts = PurePosixPath(relative).parts
    best = parts
    for locator in (evidence.source_locator, evidence.source_key):
        value = locator.replace("\\", "/")
        if evidence.ingest_method == "local_scan":
            # 磁盘定位符包含选中根以外的用户/临时目录，不是扫描到的媒体祖先。
            # OpenList 的 local 挂载仍消费接口实际观察到的路径，不能按 provider 排除。
            continue
        if "://" in value or "?" in value or "#" in value:
            continue
        candidate = tuple(part for part in PurePosixPath(value).parts
                          if part not in {"/", "."} and not re.fullmatch(r"[A-Za-z]:", part))
        if ".." in candidate:
            continue
        if parts and len(candidate) > len(best) and candidate[-len(parts):] == parts:
            best = candidate
    root = root_container.strip()
    if root and not _is_structure(root) and root not in best[:-1] and best == parts:
        # 扫描器给出的选中目录本身仍是有效祖先，通用扫描分类不能成为身份。
        best = (root, *best)
    return PurePosixPath(*best).as_posix()


@dataclass(frozen=True)
class StructureContext:
    path: str
    work_container: str
    subwork_dir: str
    parent_dirs: tuple[str, ...]
    series_container: str
    collections: tuple[str, ...]
    season_scoped: bool
    directory_season: int | None
    filename_identity: str = ""
    collection_scopes: tuple[str, ...] = ()
    ordering: tuple[str, str, str, bool] | None = None
    parent_scope: str = ""
    season_family: tuple[str, str, str] | None = None

    def trace_value(self) -> dict:
        title, year = _parse_work_title_and_year(self.work_container)
        return {"container": self.work_container, "title": title, "year": year,
                "series_container": self.series_container,
                "collections": list(self.collections), "season_scoped": self.season_scoped,
                "directory_season": self.directory_season, "filename_identity": self.filename_identity,
                "collection_scopes": list(self.collection_scopes), "ordering": self.ordering,
                "parent_scope": self.parent_scope, "season_family": self.season_family}


def structure_context(evidence: SourceEvidence, root_container: str = "") -> StructureContext:
    path = semantic_path(evidence, root_container)
    directories = list(PurePosixPath(path).parts[:-1])
    filename_title = (_extract_series_name_from_filename(PurePosixPath(path).name)
                      or _extract_release_movie_title(PurePosixPath(path).name))
    filename_title = re.sub(r"(?i)\b(?:SP|OVA|OAD)\s*\d+.*$", "", filename_title).strip()
    filename = PurePosixPath(path).name
    file_numbering = parse_numbering(tokenize_filename(filename))
    numbered_file = bool(file_numbering.episode is not None or file_numbering.absolute is not None
                         or file_numbering.candidates or re.search(r"(?i)(?<![A-Za-z])(?:SP|OVA|OAD)(?![A-Za-z])", filename))
    # 小数序号仅在去掉前缀后与文件作品名一致时剥离；真片名中的小数保留。
    for index, value in enumerate(directories):
        match = re.match(r"^\d{1,3}\.\d+\s+(.+)$", value)
        if match:
            filename_base = normalized_title(re.sub(r"(?i)\s*(?:Movie|剧场版|映画)\s*$", "", filename_title))
            directory_base = normalized_title(re.sub(r"(?i)\s*(?:Movie|剧场版|映画)\s*$", "", match[1]))
            if filename_base and directory_base and filename_base.startswith(directory_base):
                directories[index] = match[1]
    named = [index for index, value in enumerate(directories) if not _is_structure(value)]
    def collection_scope(index):
        # 身份必须包含真实目录边界；只保存摘要，不复制定位符到决策说明。
        return hashlib.sha256(PurePosixPath(*directories[:index + 1]).as_posix().encode("utf-8")).hexdigest()
    if not named:
        return StructureContext(path, "", "", tuple(directories), "", (), False, None)
    leaf = named[-1]
    if is_collection_container(directories[leaf]):
        indexes = [index for index in named if is_collection_container(directories[index])]
        collections = tuple(directories[index] for index in indexes)
        filename_identity = clean_work_title_container(filename_title).title
        return StructureContext(path, "", "", (), "", collections, False, None, filename_identity,
                                tuple(collection_scope(index) for index in indexes))
    work_index = leaf
    leaf_season = _infer_season_from_context([directories[leaf]])
    if len(named) > 1:
        parent = named[-2]
        leaf_title = normalized_title(directories[leaf])
        parent_title = normalized_title(directories[parent])
        season_pattern = r"(?:\bS\d{1,2}\b|\bSeason\s*\d+|第[一二三四五六七八九十\d]+季)"
        season_marker = re.search(season_pattern, directories[leaf], re.IGNORECASE)
        clean_parent = _parse_work_title_and_year(directories[parent])[0]
        clean_leaf = _parse_work_title_and_year(directories[leaf])[0]
        # 季号可以在标题之前，副标题也可以使用全角标点；词边界仍排除 Foo/Foobar。
        clean_leaf = re.sub(r"^" + season_pattern + r"[\s._:：-]*", "", clean_leaf, flags=re.IGNORECASE)
        title_boundary = bool(re.match(re.escape(clean_parent) + r"(?:[\W_]|$)", clean_leaf, re.IGNORECASE))
        explicit_season = bool(season_marker and (title_boundary
                               or normalized_title(directories[leaf][:season_marker.start()]) == parent_title))
        repeated_parent = any(normalized_title(directories[index]) == parent_title for index in named[:-2])
        filename_matches_parent = normalized_title(filename_title) == parent_title
        leaf_year = _parse_work_title_and_year(directories[leaf])[1]
        parent_year = _parse_work_title_and_year(directories[parent])[1]
        if not is_collection_container(directories[parent]) and (
            (leaf_title == parent_title and (leaf_season is not None or leaf_year is None or leaf_year == parent_year))
            or (leaf_season is not None and parent_title and leaf_title.startswith(parent_title)
                and ((explicit_season and numbered_file and season_marker.start() > 0)
                     or (repeated_parent and (title_boundary or explicit_season))
                     or filename_matches_parent or _is_series_container(directories[parent])))
        ):
            work_index = parent
        elif (directories[leaf].startswith("[")
              and re.search(r"(?i)(?:\b\d{3,4}p\b|\b(?:HEVC|BDRip|x26[45])\b)", directories[leaf])
              and re.search(r"(?i)(?:剧场版|映画|\bmovie\b)", directories[parent])):
            # 具名电影下面的压制目录是版本，不能覆盖电影标题、年份与父系列。
            work_index = parent
    collection_indexes = [index for index in named if index < work_index
                          and is_collection_container(directories[index])]
    series = ""
    parents = [index for index in named if index < work_index]
    if parents:
        parent = parents[-1]
        if _is_series_container(directories[parent]) or directories[parent].startswith("["):
            series = directories[parent]
    work_container = directories[work_index]
    parent_dirs = tuple(directories[work_index:])
    subwork = next((directories[index] for index in named if index > work_index), "")
    if work_index != leaf and leaf_season is None and directories[leaf].startswith("["):
        # 已收口的压制版本目录不再参与电影子作品命名。
        subwork = ""
        parent_dirs = (work_container,)
    directory_season = _infer_season_from_context(list(parent_dirs))
    season_scoped = bool(leaf_season is not None and not _looks_like_plain_season_dir(directories[leaf]))
    filename_identity = ""
    if collection_indexes and any(normalized_title(work_container) == normalized_title(directories[index])
                                  for index in collection_indexes):
        title = clean_work_title_container(filename_title).title
        if title and normalized_title(title) != normalized_title(work_container):
            filename_identity = title
    ordering = None
    order_match = re.match(r"^(\d{1,3}(?:\.\d+)?)[.．、\s]+(.+)$", work_container)
    if collection_indexes and order_match:
        scope = hashlib.sha256(PurePosixPath(*directories[:work_index]).as_posix().encode("utf-8")).hexdigest()
        original_filename_title = _extract_release_movie_title(PurePosixPath(path).name)
        preserves_decimal = bool(re.match(re.escape(order_match[1]) + r"(?:\s|[A-Za-z\u3400-\u9fff])", original_filename_title))
        ordering = (scope, order_match[1], order_match[2], preserves_decimal)
    family = None
    if (work_index == leaf and collection_indexes
            and collection_indexes[-1] == (parents[-1] if parents else -1) and leaf_season is not None):
        parent = collection_indexes[-1]
        # 单文件只声明候选；Resolver 必须验证同批不同季共享文件作品名。
        family = (collection_scope(parent), directories[parent], filename_title)
    return StructureContext(path, work_container, subwork, parent_dirs, series,
                            tuple(directories[index] for index in collection_indexes),
                            season_scoped, directory_season, filename_identity,
                            tuple(collection_scope(index) for index in collection_indexes), ordering,
                            collection_scope(work_index - 1) if work_index > 0 else "", family)


def structure_decision(facts: ParsedFacts) -> dict | None:
    return next((trace.value for trace in facts.decision_trace
                 if trace.field == "structure_context" and isinstance(trace.value, dict)), None)
