"""目录树播放根由用户选择的位置与目录边界确定，不依赖 TXT 保存位置。"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath

from app.media_v4.sources.scanner import export_root_scope, tree_media_relative_paths, tree_root_id
from app.media_v4.sources.tree_mapping import mapped_entries, mapping_scope


def tree_scope_name(stem: str) -> str:
    """文件名中的目录提示，仅供显示；不得作为播放根或来源身份依据。"""
    value = Path(stem).stem if Path(stem).suffix else stem
    scope = re.sub(r"[_\s-]*(?:文件目录|目录树)(?:[_\s-]*\d{6,})?$", "", value).strip()
    return "" if scope.casefold().startswith("根目录") else scope


@dataclass(frozen=True, slots=True)
class TreeRootResolution:
    root: str
    ok: bool
    reason: str
    hits: int
    total: int
    candidates: tuple[str, ...]
    export_scope: str | None = None
    mapping_mode: str = "direct"
    mapping_scope: str = ""
    selected_count: int = 0
    skipped_count: int = 0
    path_samples: tuple[str, ...] = ()
    state: str = "confirmed"
    choices: tuple[dict, ...] = ()
    mapping_rule: dict = field(default_factory=dict)


def tree_scan_root_id(
    *, provider: str, configured_roots: list[str], resolution: TreeRootResolution,
    tree_file: str | Path,
) -> str:
    """同步与持久扫描共享身份；同一播放位置的不同挂载分支不得混合。"""
    root = resolution.root if resolution.ok else (configured_roots[0] if configured_roots else "")
    scope = resolution.export_scope or ""
    if resolution.mapping_mode == "mounted_subdir":
        scope = "\x1f".join((scope, "mounted_subdir", resolution.mapping_scope))
    return tree_root_id(provider, root, tree_file, export_scope=scope)


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _remote_parts(value: str) -> tuple[str, ...]:
    if not value.startswith("/") or value.startswith("//"):
        raise ValueError("远端目录边界必须是同一命名空间内的绝对目录")
    parts = () if value == "/" else tuple(value[1:].removesuffix("/").split("/"))
    if any(p in {"", ".", ".."} or "\\" in p or any(ord(ch) < 32 for ch in p) for p in parts):
        raise ValueError("远端目录边界包含空段或路径跳转")
    return parts


def _distributed_samples(paths: list[str], maximum: int = 3) -> list[str]:
    """优先覆盖不同目录分支；不枚举实际挂载内容。"""
    if not paths:
        return []
    parts = [p.split("/") for p in paths]
    depth = 0
    while all(len(p) > depth + 1 and p[depth] == parts[0][depth] for p in parts):
        depth += 1
    selected: list[str] = []
    branches: set[str] = set()
    for path, segments in zip(paths, parts, strict=True):
        branch = "/".join(segments[:min(depth + 1, len(segments) - 1)])
        if branch not in branches:
            selected.append(path)
            branches.add(branch)
        if len(selected) >= maximum:
            break
    # 缺失证据可检查同目录的不同文件，但成功证据仍须覆盖不同父目录。
    for path in paths:
        if len(selected) >= maximum:
            break
        if path not in selected:
            selected.append(path)
    return selected


class TreePlaybackRootResolver:
    """分别解析导出边界和挂载边界；弱提示仅生成候选，不自动裁剪目录。

    默认纯词法执行。probe 是调用方提供的受限只读适配器；已知关系和
    已确认规则在探测前返回，后台恢复只消费冻结结果，不重新获取证据。
    """

    def __init__(
        self, tree_path: str | Path, *, configured_roots: Iterable[str | Path],
        extra_candidates: Iterable[str | Path] = (),
        mapping_mode: str = "direct", mapping_scope: str = "",
        mount_remote_root: str | None = None, export_remote_root: str | None = None,
        saved_rule: dict | None = None, choice_id: str = "", probe=None,
        config_fingerprint: str = "",
        mount_relationships: Iterable[dict] = (),
    ) -> None:
        self.tree_path = str(tree_path)
        self.configured_roots = [str(root).strip() for root in (*configured_roots, *extra_candidates) if str(root).strip()]
        self.mapping_mode = mapping_mode
        self.mapping_scope = mapping_scope
        self.mount_remote_root = mount_remote_root
        self.export_remote_root = export_remote_root
        self.saved_rule = saved_rule or {}
        self.choice_id = choice_id
        self.probe = probe
        self.config_fingerprint = config_fingerprint
        self.mount_relationships = tuple(mount_relationships)

    def resolve(self, text: str) -> TreeRootResolution:
        if self.mapping_mode == "auto":
            return self._resolve_automatic(text)
        proof_scope = export_root_scope(text) or ""
        unique = {str(PureWindowsPath(root)).rstrip("\\").casefold(): root for root in self.configured_roots}
        candidates = tuple(unique.values())
        scope = self.mapping_scope.strip()

        def result(root: str, ok: bool, reason: str, **kwargs) -> TreeRootResolution:
            return TreeRootResolution(root, ok, reason, 0, 0, candidates, proof_scope,
                                      self.mapping_mode, scope, state="confirmed" if ok else "invalid", **kwargs)

        try:
            scope_parts = mapping_scope(self.mapping_mode, scope)
            scope = "/".join(scope_parts)
            paths = tree_media_relative_paths(text)
            entries = mapped_entries([(p, "video") for p in paths],
                                     mode=self.mapping_mode, scope=scope)
        except ValueError as exc:
            return result("", False, f"目录树路径校验拒绝：{exc}")
        if not candidates:
            return result("", False, "当前内容来源尚未配置本地挂载路径")
        if len(candidates) != 1:
            return result("", False, "多个来源根都可能覆盖该目录树，请明确选择本次播放位置")
        root = candidates[0]
        if self.mapping_mode == "export_subdir":
            root = str(PureWindowsPath(root).joinpath(*scope_parts))
        samples = tuple(str(PureWindowsPath(root).joinpath(mapped)) for _, mapped, _ in entries[:3])
        return result(root, True, "播放路径已根据明确的目录对应关系生成",
                      selected_count=len(entries), skipped_count=len(paths) - len(entries),
                      path_samples=samples)

    def _resolve_automatic(self, text: str) -> TreeRootResolution:
        from app.media_v4.path_validation import validate_playback_locator_syntax
        from app.media_v4.sources.scanner import _top_node_provenance

        paths = tree_media_relative_paths(text)
        # 每个目录边界建立一次索引，覆盖任何分支而非仅前几个目录。
        # 后续裁剪只处理该分支，避免对每个候选重复遍历整份 TXT。
        directory_paths: dict[str, list[str]] = {}
        for path in paths:
            parts = path.split("/")
            for depth in range(1, len(parts)):
                directory_paths.setdefault("/".join(parts[:depth]), []).append(path)
        header, header_kind = _top_node_provenance(text)
        export = self.export_remote_root
        if export is None and header_kind == "absolute_root" and header.startswith("/") and not header.startswith("//"):
            export = header
        if export is not None:
            try:
                export = "/" + "/".join(_remote_parts(export))
            except ValueError as exc:
                return TreeRootResolution("", False, str(exc), 0, 0, (), state="invalid")
        if header_kind == "absolute_root" and PureWindowsPath(header).is_absolute():
            valid, reason = validate_playback_locator_syntax(header)
            if not valid:
                return TreeRootResolution("", False, reason, 0, 0, (), state="invalid")
        name_hint = tree_scope_name(Path(self.tree_path).stem) if re.search("目录树|文件目录", Path(self.tree_path).name) else ""
        context = _digest([header if header_kind in {"absolute_root", "export_header"} else "",
                           header_kind, name_hint, self.export_remote_root, self.mount_remote_root])
        choices: list[dict] = []
        candidate_keys: set[tuple] = set()
        error = ""
        text_digest = _digest(text)

        def add(root: str, mode: str = "direct", scope: str = "", relation: dict | None = None) -> None:
            nonlocal error
            ok, reason = validate_playback_locator_syntax(root)
            if not ok:
                error = reason
                return
            try:
                scope = "/".join(mapping_scope(mode, scope))
                branch = directory_paths.get(scope, []) if mode == "mounted_subdir" else paths
                entries = mapped_entries([(p, "video") for p in branch], mode=mode, scope=scope)
            except ValueError as exc:
                error = str(exc)
                return
            playback_root = str(PureWindowsPath(root).joinpath(*scope.split("/"))) if mode == "export_subdir" else root
            key = (str(PureWindowsPath(playback_root)).casefold(), mode == "mounted_subdir", scope if mode == "mounted_subdir" else "")
            if key in candidate_keys:
                return
            candidate_keys.add(key)
            sampled = _distributed_samples([r for r, _, _ in entries])
            by_original = {r: m for r, m, _ in entries}
            samples = [str(PureWindowsPath(playback_root).joinpath(by_original[r])) for r in sampled]
            rule = {"version": 1, "source_root": root, "mapping_mode": mode, "mapping_scope": scope,
                    "export_root": export if export is not None else header if header_kind == "absolute_root" else None,
                    "mount_remote_root": self.mount_remote_root,
                    "context": context, "config_fingerprint": self.config_fingerprint}
            if relation:
                rule["mount_relation"] = {key: relation[key] for key in ("local_root", "remote_root", "namespace")}
            choices.append({"id": _digest([rule, text_digest]), "root": playback_root,
                            "mapping_mode": mode, "mapping_scope": scope, "rule": rule,
                            "selected_count": len(entries), "skipped_count": len(paths) - len(entries),
                            "path_samples": samples, "hits": 0, "missing": 0, "unknown": 0,
                            "hit_directories": []})

        roots = list(dict.fromkeys(self.configured_roots))
        known = False
        if export is not None and self.mount_remote_root is not None:
            try:
                ep, mp = _remote_parts(export), _remote_parts(self.mount_remote_root)
                for root in roots:
                    if ep[:len(mp)] == mp:
                        remainder = ep[len(mp):]
                        add(root, "export_subdir" if remainder else "direct", "/".join(remainder))
                    elif mp[:len(ep)] == ep:
                        remainder = mp[len(ep):]
                        add(root, "mounted_subdir", "/".join(remainder))
                known = True
            except ValueError as exc:
                error = str(exc)
        elif header_kind == "absolute_root" and PureWindowsPath(header).is_absolute():
            # TXT 正文给出本地绝对导出根时，只接受其位于明确本地挂载范围内。
            for root in roots:
                try:
                    remainder = PureWindowsPath(header).relative_to(PureWindowsPath(root))
                except ValueError:
                    continue
                add(root, "export_subdir" if remainder.parts else "direct", "/".join(remainder.parts))
            if not choices:
                # 只用与 TXT 相同的 UNC 空间；WebDAV URL 不能证明网盘原始根。
                for relation in self.mount_relationships:
                    if relation.get("namespace") != "unc":
                        continue
                    for root in roots:
                        try:
                            suffix = PureWindowsPath(root).relative_to(PureWindowsPath(relation["local_root"]))
                            remote = PureWindowsPath(relation["remote_root"]).joinpath(suffix)
                            remainder = PureWindowsPath(header).relative_to(remote)
                        except (KeyError, ValueError):
                            continue
                        add(root, "export_subdir" if remainder.parts else "direct", "/".join(remainder.parts), relation)
            known = bool(choices)
        else:
            for root in roots:
                if (self.saved_rule.get("version") == 1
                        and not self.saved_rule.get("mount_relation")
                        and self.saved_rule.get("context") == context
                        and self.saved_rule.get("config_fingerprint") == self.config_fingerprint
                        and self.saved_rule.get("source_root") == root):
                    add(root, self.saved_rule.get("mapping_mode", "direct"), self.saved_rule.get("mapping_scope", ""))
                add(root)
                for prefix in directory_paths:
                    add(root, "mounted_subdir", prefix)
                hints: list[str] = []
                if export is not None:
                    try:
                        export_parts = _remote_parts(export)
                        hints.extend("/".join(export_parts[index:]) for index in range(min(4, len(export_parts))))
                    except ValueError as exc:
                        error = str(exc)
                try:
                    parent = PureWindowsPath(self.tree_path).parent.relative_to(PureWindowsPath(root))
                    if parent.parts:
                        hints.append("/".join(parent.parts))
                except ValueError:
                    pass
                if re.search("目录树|文件目录", Path(self.tree_path).name):
                    hints.append(name_hint)
                for hint in hints:
                    if hint and not any(p == hint or p.startswith(hint + "/") for p in paths):
                        add(root, "export_subdir", hint)

        def result(selected: dict | None, state: str, reason: str) -> TreeRootResolution:
            return TreeRootResolution(
                root=selected["root"] if selected else "", ok=selected is not None,
                reason=reason, hits=selected["hits"] if selected else 0,
                total=(selected["hits"] + selected["missing"] + selected["unknown"]) if selected else 0,
                candidates=tuple(c["root"] for c in choices), export_scope=export if export is not None else export_root_scope(text),
                mapping_mode=selected["mapping_mode"] if selected else "direct",
                mapping_scope=selected["mapping_scope"] if selected else "",
                selected_count=selected["selected_count"] if selected else len(paths),
                skipped_count=selected["skipped_count"] if selected else 0,
                path_samples=tuple(selected["path_samples"]) if selected else (),
                state=state, choices=tuple(choices), mapping_rule=selected["rule"] if selected else {},
            )

        if not choices and header_kind == "absolute_root" and PureWindowsPath(header).is_absolute() and not error:
            # 尚无匹配的 UNC/盘符对应证据，仍允许解析并确认相对正文的播放位置。
            for root in roots:
                add(root)
        if not choices:
            return result(None, "invalid", error or "导出范围与挂载范围不相交，请检查来源位置")
        if self.choice_id:
            selected = next((c for c in choices if c["id"] == self.choice_id), None)
            return result(selected, "confirmed" if selected else "ambiguous",
                          "已按本次确认的目录边界生成播放路径" if selected else "路径选择已过期，请核对当前候选")
        if self.saved_rule.get("version") == 1:
            selected = next((c for c in choices if c["rule"] == self.saved_rule), None)
            if selected:
                return result(selected, "confirmed", "已复用此来源保存的目录映射规则")
        if known and len(choices) == 1:
            return result(choices[0], "confirmed", "已根据明确的导出与挂载边界生成播放路径")
        if self.probe is not None:
            # 共同访问错误立即终止；未知不等于缺失，也不能据命中率破除双解。
            systemic_failure = False
            for choice in choices:
                for path in choice["path_samples"]:
                    observed = self.probe(path)
                    status = observed.get("status", "unavailable")
                    if status == "file":
                        choice["hits"] += 1
                        parent = str(PureWindowsPath(path).parent).casefold()
                        if parent not in choice["hit_directories"]:
                            choice["hit_directories"].append(parent)
                    elif status == "missing":
                        choice["missing"] += 1
                    else:
                        choice["unknown"] += 1
                        systemic_failure = True
                        break
                if systemic_failure:
                    break
            winners = [c for c in choices if len(c["hit_directories"]) >= 2 and not c["unknown"]]
            if len(winners) == 1 and all(c is winners[0] or (c["hits"] == 0 and c["missing"] >= 2 and not c["unknown"]) for c in choices):
                return result(winners[0], "supported", "多个不同目录样本支持此映射；验证未覆盖全部媒体")
            if systemic_failure:
                return result(None, "unverifiable", "挂载暂时无法验证，请在预览中确认实际播放路径")
        return result(None, "ambiguous", "播放路径需要确认；TXT 导出起点与实际挂载起点尚不能唯一确定")
