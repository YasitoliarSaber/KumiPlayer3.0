"""来源无关的目录上下文，只消费观察证据，不触盘、不查询在线身份。"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.generic_container import is_generic_container_name
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

    def trace_value(self) -> dict:
        title, year = _parse_work_title_and_year(self.work_container)
        return {"container": self.work_container, "title": title, "year": year,
                "series_container": self.series_container,
                "collections": list(self.collections), "season_scoped": self.season_scoped,
                "directory_season": self.directory_season, "filename_identity": self.filename_identity,
                "collection_scopes": list(self.collection_scopes), "ordering": self.ordering}


def structure_context(evidence: SourceEvidence, root_container: str = "") -> StructureContext:
    path = semantic_path(evidence, root_container)
    directories = list(PurePosixPath(path).parts[:-1])
    filename_title = (_extract_series_name_from_filename(PurePosixPath(path).name)
                      or _extract_release_movie_title(PurePosixPath(path).name))
    filename_title = re.sub(r"(?i)\b(?:SP|OVA|OAD)\s*\d+.*$", "", filename_title).strip()
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
        repeated_parent = any(normalized_title(directories[index]) == parent_title for index in named[:-2])
        filename_matches_parent = normalized_title(filename_title) == parent_title
        leaf_year = _parse_work_title_and_year(directories[leaf])[1]
        parent_year = _parse_work_title_and_year(directories[parent])[1]
        if not is_collection_container(directories[parent]) and (
            (leaf_title == parent_title and (leaf_season is not None or leaf_year is None or leaf_year == parent_year))
            or (leaf_season is not None and parent_title and leaf_title.startswith(parent_title)
                and (repeated_parent or filename_matches_parent or _is_series_container(directories[parent])))
        ):
            work_index = parent
    collection_indexes = [index for index in named if index < work_index
                          and is_collection_container(directories[index])]
    series = ""
    if len(named) > 1 and work_index == leaf:
        parent = named[-2]
        if parent < leaf and (_is_series_container(directories[parent]) or directories[parent].startswith("[")):
            series = directories[parent]
    work_container = directories[work_index]
    parent_dirs = tuple(directories[work_index:])
    subwork = next((directories[index] for index in named if index > work_index), "")
    if not subwork and len(named) > 1 and work_index == leaf:
        subwork = directories[leaf]
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
    return StructureContext(path, work_container, subwork, parent_dirs, series,
                            tuple(directories[index] for index in collection_indexes),
                            season_scoped, directory_season, filename_identity,
                            tuple(collection_scope(index) for index in collection_indexes), ordering)


def structure_decision(facts: ParsedFacts) -> dict | None:
    return next((trace.value for trace in facts.decision_trace
                 if trace.field == "structure_context" and isinstance(trace.value, dict)), None)
