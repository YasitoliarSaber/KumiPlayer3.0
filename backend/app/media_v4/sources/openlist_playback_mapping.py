"""OpenList 播放映射：有限候选、只读媒体样本、唯一解与确认闭锁。"""

from __future__ import annotations

import hashlib
import json
from collections import deque
from dataclasses import asdict
from pathlib import PurePosixPath

from app.integrations.openlist.client import normalize_remote_path
from app.integrations.openlist.providers import (
    OpenListRouteConfig,
    is_ancestor_or_self,
    match_route,
    resolve_local_path,
)
from app.media_v4.sources.tree_mapping_probe import BoundedMetadataProbe

MAX_SAMPLE_PAGES = 8
MAX_SAMPLES = 3
MAX_CANDIDATES = 8


class PlaybackMappingError(ValueError):
    def __init__(self, preview: dict):
        self.preview = preview
        super().__init__(preview['reason'])


def mapping_preview(proof: dict) -> dict:
    return {'state': 'supported', 'requires_confirmation': False,
            'path_samples': proof['local_paths'], 'selected_count': len(proof['local_paths']),
            'reason': '真实媒体样本已验证可达，已采用唯一匹配的播放位置；验证未覆盖全部文件。'}


def collect_samples(client, remote_root: str, *, should_cancel=None) -> list[str]:
    """最多读八页，只采真实视频文件名；不下载内容或无界遍历。"""
    from app.media_v4.sources.scanner import VIDEO_SUFFIXES, SourceScanCancelled

    root = normalize_remote_path(remote_root)
    queue = deque([(root, 1)])
    seen: set[tuple[str, int]] = set()
    samples: list[str] = []
    delivered: dict[str, int] = {}
    while queue and len(seen) < MAX_SAMPLE_PAGES and len(samples) < MAX_SAMPLES:
        if should_cancel and should_cancel():
            raise SourceScanCancelled()
        path, page = queue.popleft()
        if (path, page) in seen:
            continue
        seen.add((path, page))
        listing = client.list_dir(path, page=page, per_page=100, refresh=True)
        delivered[path] = delivered.get(path, 0) + len(listing.entries)
        for entry in listing.entries:
            remote = normalize_remote_path(entry.remote_path)
            if not is_ancestor_or_self(root, remote):
                raise ValueError('目录返回了所选来源之外的路径，请重新检查 OpenList 连接')
            if entry.is_dir:
                queue.append((remote, 1))
            elif PurePosixPath(entry.name).suffix.casefold() in VIDEO_SUFFIXES:
                if remote not in samples:
                    samples.append(remote)
                    if len(samples) == MAX_SAMPLES:
                        break
        if listing.entries and (not listing.total or delivered[path] < listing.total):
            queue.append((path, page + 1))
    return samples


def choose_mapping(*, remote_root: str, mapping_root: str, mount_root: str,
                   routes: list[OpenListRouteConfig], samples: list[str],
                   choice_id: str = '', probe=None) -> dict:
    """唯一全部命中者自动采用；未知访问状态不能当作不存在排除候选。"""
    root = normalize_remote_path(remote_root)
    if not is_ancestor_or_self(mapping_root, root) or any(not is_ancestor_or_self(root, sample) for sample in samples):
        raise ValueError('媒体样本必须属于所选远端来源')
    if len(samples) > MAX_SAMPLES:
        raise ValueError('播放映射样本超过预算')
    probe = probe or BoundedMetadataProbe(timeout=5.0, max_requests=64,
                                         roots=[mount_root, *(route.local_root for route in routes if route.enabled and route.local_root)])
    candidates: list[dict] = []
    seen: set[tuple[str, ...]] = set()

    def add(remote_mapping: str, local_mapping: str, candidate_routes: list[OpenListRouteConfig]) -> None:
        if len(candidates) >= MAX_CANDIDATES:
            return
        try:
            local_root = resolve_local_path(local_mapping, remote_mapping, root, candidate_routes)
            paths = [resolve_local_path(local_mapping, remote_mapping, sample, candidate_routes) for sample in samples]
        except ValueError:
            return
        key = tuple([local_root, *paths])
        if key in seen:
            return
        seen.add(key)
        identity = hashlib.sha256(json.dumps(key, ensure_ascii=False).encode('utf-8')).hexdigest()[:20]
        candidates.append({'id': identity, 'root': local_root, 'mapping_scope': root,
                           'path_samples': paths, 'selected_count': len(samples), 'skipped_count': 0,
                           'mapping_root': remote_mapping, 'mount_root': local_mapping,
                           'routes': [asdict(route) for route in candidate_routes]})

    add(mapping_root, mount_root, routes)
    matched = match_route(routes, root)
    explicit = bool(matched and matched.local_root.strip())
    # 所选网盘根可能直接挂成盘符或一个文件夹；也可能仍位于连接总挂载根下。
    # 每个候选的尾部都使用完整相对路径，不根据同名字符串直接裁剪。
    fallback_routes = [OpenListRouteConfig(**{**asdict(route), 'local_root': ''})
                       if is_ancestor_or_self(route.remote_prefix, root) else route for route in routes]
    if not explicit:
        add(root, mount_root, fallback_routes)
        for route in sorted(routes, key=lambda item: len(item.remote_prefix), reverse=True):
            if route.enabled and is_ancestor_or_self(route.remote_prefix, root):
                add(route.remote_prefix, mount_root, fallback_routes)
        for ancestor in PurePosixPath(root).parents:
            remote_mapping = str(ancestor)
            if is_ancestor_or_self(mapping_root, remote_mapping):
                add(remote_mapping, mount_root, fallback_routes)

    preview = {'state': 'unverifiable', 'requires_confirmation': True,
               'selected_count': len(samples), 'choices': [], 'path_samples': [],
               'reason': '没有取得可验证的媒体样本，请进入媒体目录或恢复网盘后重试。'}
    if not samples:
        raise PlaybackMappingError(preview)
    for candidate in candidates:
        candidate['statuses'] = [probe(path).get('status', 'unavailable') for path in candidate['path_samples']]
    public = [{key: candidate[key] for key in ('id', 'root', 'mapping_scope', 'path_samples', 'selected_count', 'skipped_count')}
              for candidate in candidates]
    preview['choices'] = public
    winners = [candidate for candidate in candidates if all(status == 'file' for status in candidate['statuses'])]
    unknown = any(status not in {'file', 'missing', 'directory'} for candidate in candidates for status in candidate['statuses'])
    selected = next((candidate for candidate in winners if candidate['id'] == choice_id), None) if choice_id else None
    if not choice_id and len(winners) == 1 and not unknown:
        selected = winners[0]
    if selected:
        return {'version': 1, 'state': 'verified', 'mapping_root': selected['mapping_root'],
                'mount_root': selected['mount_root'], 'routes': selected['routes'],
                'effective_root': selected['root'], 'remote_paths': samples,
                'local_paths': selected['path_samples'], 'choice_id': selected['id']}
    preview['state'] = 'unverifiable' if unknown else 'ambiguous' if winners else 'invalid'
    preview['path_samples'] = public[0]['path_samples'] if public else []
    preview['choices'] = [item for item in public if any(candidate['id'] == item['id'] for candidate in winners)] if len(winners) > 1 else []
    preview['reason'] = ('挂载盘未响应，尚不能验证播放位置；请恢复挂载后重试。' if unknown else
                         '样本或路径选择已变化，请重新检查当前播放位置。' if choice_id and not selected else
                         '有多个播放位置都可访问，请核对样本后选择。' if winners else
                         '这些媒体样本在挂载盘中都无法找到。请先检查挂载范围，仍不匹配时再到设置选择对应文件夹。')
    raise PlaybackMappingError(preview)


def prepare_mapping(database, task, client, runtime) -> dict:
    """新任务先验证再生成任何证据；续跑复用同一映射并重新核对样本。"""
    request = task.request
    request['verify_openlist_playback'] = True
    stored = request.get('playback_mapping')
    samples = stored.get('remote_paths', []) if isinstance(stored, dict) else []
    if not samples:
        runtime.report_progress(stage='verifying_playback_paths', processed_count=0, total_count=0)
        samples = collect_samples(client, str(request['remote_root']), should_cancel=runtime.cancellation_requested)
    routes = [OpenListRouteConfig(**item) for item in request.get('routes', [])]
    try:
        proof = choose_mapping(remote_root=request['remote_root'], mapping_root=request['mapping_root'],
                               mount_root=request['mount_root'], routes=routes, samples=samples,
                               choice_id=request.get('openlist_mapping_choice', '') or (stored or {}).get('choice_id', ''))
    except PlaybackMappingError as exc:
        request['path_validation'] = exc.preview
        _save_request(database, task.scan_id, request)
        raise
    request.update(mapping_root=proof['mapping_root'], mount_root=proof['mount_root'], routes=proof['routes'],
                   playback_mapping=proof, effective_playback_root=proof['effective_root'])
    request.pop('path_validation', None)
    _save_request(database, task.scan_id, request)
    return request


def _save_request(database, scan_id: str, request: dict) -> None:
    with database.connect() as conn:
        conn.execute('UPDATE source_scan_requests SET request_json=? WHERE scan_id=?',
                     (json.dumps(request, ensure_ascii=False), scan_id))


def require_verified_mapping(database, scan_id: str, *, require: bool = False) -> None:
    """确认与自动追更共用：读取已保存证明，重新探测，拒绝失联与路径漂移。"""
    with database.connect() as conn:
        row = conn.execute('SELECT request_json FROM source_scan_requests WHERE scan_id=?', (scan_id,)).fetchone()
    with database.connect() as conn:
        has_openlist = conn.execute("SELECT 1 FROM source_evidence WHERE scan_id=? AND ingest_method LIKE 'openlist_%' LIMIT 1", (scan_id,)).fetchone()
    request = json.loads(row[0]) if row else {}
    if not request.get('verify_openlist_playback') and not (require and has_openlist):
        return
    proof = request.get('playback_mapping') or {}
    if request.get('connection_fingerprint'):
        from app.core.config import load_config
        from app.core.openlist_connections import connection_fingerprint, select_connection

        current = select_connection(load_config(), request.get('connection_id', 'legacy'))
        if connection_fingerprint(current) != request['connection_fingerprint']:
            raise ValueError('来源连接或挂载设置已改变，请重新验证播放位置后扫描')
    if proof.get('version') != 1 or proof.get('state') != 'verified' or not proof.get('local_paths'):
        raise ValueError('播放路径尚未通过真实媒体样本验证，请重新扫描来源')
    routes = [OpenListRouteConfig(**item) for item in proof.get('routes', [])]
    remote_paths = proof.get('remote_paths') or []
    if (not 0 < len(remote_paths) <= MAX_SAMPLES or len(remote_paths) != len(proof['local_paths'])
            or any(not is_ancestor_or_self(request['remote_root'], path) for path in remote_paths)
            or [resolve_local_path(proof['mount_root'], proof['mapping_root'], path, routes) for path in remote_paths] != proof['local_paths']
            or resolve_local_path(proof['mount_root'], proof['mapping_root'], request['remote_root'], routes) != proof['effective_root']):
        raise ValueError('播放映射证明与来源范围不一致，请重新扫描')
    probe = BoundedMetadataProbe(timeout=3.0, max_requests=12, roots=[proof['effective_root']])
    if any(probe(path).get('status') != 'file' for path in proof['local_paths']):
        raise ValueError('媒体挂载目前无法访问，未确认导入；恢复挂载后可再次确认')
    with database.connect() as conn:
        rows = conn.execute('SELECT source_locator, playback_locator FROM source_evidence WHERE scan_id=? AND entry_kind=?', (scan_id, 'video')).fetchall()
    if any(resolve_local_path(proof['mount_root'], proof['mapping_root'], row['source_locator'], routes) != row['playback_locator'] for row in rows):
        raise ValueError('扫描结果与已验证的播放映射不一致，请重新扫描来源')
