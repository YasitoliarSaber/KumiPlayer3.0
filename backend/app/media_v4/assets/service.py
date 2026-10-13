"""有界、可恢复的本地图片准备；下载和编码从浏览请求中隔离。"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
import warnings
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path
from urllib.parse import unquote

from PIL import Image, ImageOps

from app.core.config import load_config
from app.core.paths import get_data_dir
from app.core.url_guard import assert_public_dns_resolution, validate_remote_asset_url
from app.media_v4.assets.catalog import (
    RECIPE_VERSION,
    ROLE_WIDTHS,
    binding_publishable,
    enqueue_legacy_manual_for_diagnosis,
    enqueue_manual,
)
from app.media_v4.jobs.metadata_artifacts import _artwork_client, _valid_artwork
from app.media_v4.projection.library import bump_display_version, mark_projection_dirty

MAX_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 40_000_000
_ENCODE_LOCK = threading.Lock()
_DOWNLOAD_LIMIT = threading.BoundedSemaphore(2)


class ManualArtworkSourceError(ValueError):
    """用户本地图片来源不可采用；需要显式修正或重新提交。"""


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temporary.open('wb') as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class ArtworkService:
    def __init__(self, database, data_root: str | Path | None = None):
        self.database = database
        self.data_root = Path(data_root) if data_root is not None else get_data_dir()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._process_lock = threading.Lock()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name='artwork-resources', daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=15)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.process_available()
            except Exception:
                # SQLite 短暂忙或磁盘错误只延迟图片队列，不影响资料任务。
                pass
            self._stop.wait(2)

    def cancel(self, resource_id: str) -> None:
        with self.database.connect() as conn:
            conn.execute("UPDATE artwork_resources SET state='cancelled',lease_token='',lease_until=0 "
                         "WHERE resource_id=? AND state<>'ready'", (resource_id,))

    def retry(self, resource_id: str) -> None:
        with self.database.connect() as conn:
            conn.execute("UPDATE artwork_resources SET state='pending',retry_at=0,error_kind='' "
                         "WHERE resource_id=? AND state IN ('retry','failed','cancelled')", (resource_id,))

    def retry_failed_tmdb_downloads(self) -> int:
        """网络恢复后只重试当前有效的失败图片；不恢复取消项、不改媒体事实。"""
        count = 0
        with self.database.connect() as conn:
            rows = conn.execute(
                "SELECT resource_id FROM artwork_resources WHERE state IN ('retry','failed') "
                "AND source_url LIKE 'https://image.tmdb.org/t/p/%' "
                "AND error_kind<>'invalid_manual_source' ORDER BY created_at LIMIT 2048"
            ).fetchall()
            for row in rows:
                if not self._live_bindings(conn, row["resource_id"]):
                    continue
                count += conn.execute(
                    "UPDATE artwork_resources SET state='pending',retry_at=0,error_kind='',attempts=0 "
                    "WHERE resource_id=? AND state IN ('retry','failed')", (row["resource_id"],)
                ).rowcount
        return count

    def process_available(self, limit: int = 64) -> int:
        # 一次最多处理64个需求，只为正在执行的槽位领取租约。
        if not self._process_lock.acquire(blocking=False):
            return 0
        try:
            return self._process_available(max(0, min(int(limit), 64)))
        finally:
            self._process_lock.release()

    def _process_available(self, limit: int) -> int:
        self._adopt_manual_page()
        processed = 0
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix='artwork-download') as executor:
            pending: set[Future[None]] = set()
            submitted = 0
            while pending or (submitted < limit and not self._stop.is_set()):
                while len(pending) < 2 and submitted < limit and not self._stop.is_set():
                    claimed = self._claim(min(2 - len(pending), limit - submitted))
                    if not claimed:
                        break
                    for item in claimed:
                        pending.add(executor.submit(self._process, *item))
                    submitted += len(claimed)
                if not pending:
                    break
                completed, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in completed:
                    future.result()
                    processed += 1
        return processed

    def _claim(self, limit: int) -> list[tuple[dict, str]]:
        if limit <= 0:
            return []
        now = time.time()
        claimed = []
        with self.database.connect() as conn:
            # ArtworkService 每两秒轮询；空闲时只读检查，避免无候选也抢 SQLite 写锁。
            candidate = conn.execute("""SELECT 1 FROM artwork_resources r
                WHERE (r.state='running' AND r.lease_until<?)
                   OR ((r.state='pending' OR (r.state='retry' AND r.retry_at<=?))
                       AND EXISTS (SELECT 1 FROM artwork_bindings b WHERE b.candidate_id=r.resource_id))
                LIMIT 1""", (now, now)).fetchone()
            if candidate is None:
                return []
            conn.execute('BEGIN IMMEDIATE')
            # 读检查与认领间允许队列变化，因此在写事务中重新核实候选和租约。
            conn.execute("UPDATE artwork_resources SET state='pending',lease_token='' "
                         "WHERE state='running' AND lease_until<?", (now,))
            rows = conn.execute("""SELECT * FROM artwork_resources r
                WHERE (state='pending' OR (state='retry' AND retry_at<=?))
                AND EXISTS (SELECT 1 FROM artwork_bindings b WHERE b.candidate_id=r.resource_id)
                ORDER BY
                    (SELECT MIN(CASE b.role
                        WHEN 'poster' THEN 0
                        WHEN 'clearlogo' THEN 1 WHEN 'fanart' THEN 1
                        WHEN 'episode_thumb' THEN 2
                        WHEN 'profile' THEN 3 WHEN 'related_poster' THEN 3
                        ELSE 4 END)
                     FROM artwork_bindings b WHERE b.candidate_id=r.resource_id),
                    (SELECT MAX(CASE WHEN b.priority>=100 THEN 1 ELSE 0 END)
                     FROM artwork_bindings b WHERE b.candidate_id=r.resource_id) DESC,
                    created_at,resource_id LIMIT ?""", (now, limit)).fetchall()
            for row in rows:
                token = uuid.uuid4().hex
                conn.execute("UPDATE artwork_resources SET state='running',lease_token=?,lease_until=?, "
                             "attempts=attempts+1 WHERE resource_id=?", (token, now + 120, row['resource_id']))
                claimed.append((dict(row), token))
        return claimed

    def _adopt_manual_page(self) -> None:
        """分页一次采用用户既有手工封面；自动图和镜像资料不迁入。"""
        with self.database.connect() as conn:
            cursor = conn.execute("SELECT value FROM v4_meta WHERE key='artwork_manual_adoption_cursor'").fetchone()
            after = cursor[0] if cursor else ''
            if after == '~complete':
                return
            rows = conn.execute('SELECT work_id,override_json FROM work_overrides WHERE work_id>? '
                                'ORDER BY work_id LIMIT 64', (after,)).fetchall()
            for row in rows:
                try:
                    override = json.loads(row['override_json'])
                except (ValueError, TypeError):
                    continue
                if not isinstance(override, dict):
                    continue
                for role in ('poster', 'fanart', 'clearlogo'):
                    source = str(override.get(f'local_{role}_path') or '')
                    existing = conn.execute("SELECT priority FROM artwork_bindings WHERE subject_type='work' "
                                            'AND subject_id=? AND role=?', (row['work_id'], role)).fetchone()
                    if source and (existing is None or existing['priority'] < 100):
                        try:
                            enqueue_manual(conn, work_id=row['work_id'], role=role, local_path=source)
                        except ValueError:
                            enqueue_legacy_manual_for_diagnosis(
                                conn, work_id=row['work_id'], role=role, local_path=source
                            )
            next_cursor = rows[-1]['work_id'] if len(rows) == 64 else '~complete'
            conn.execute("INSERT INTO v4_meta(key,value) VALUES ('artwork_manual_adoption_cursor',?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (next_cursor,))

    def _download(self, url: str) -> bytes:
        parsed = validate_remote_asset_url(url)
        decoded = unquote(parsed.path)
        if (parsed.hostname != 'image.tmdb.org' or parsed.query or parsed.fragment
                or '\\' in decoded or any(part in {'.', '..'} for part in decoded.split('/'))):
            raise ValueError('Untrusted artwork source')
        # 白名单 TMDB 图片可经本机代理的 Fake-IP 访问；其他私网地址仍拒绝。
        assert_public_dns_resolution(parsed.hostname, allow_proxy_fake_ip=True)
        deadline = time.monotonic() + 45
        with _DOWNLOAD_LIMIT, _artwork_client(load_config()) as client:
            with client.stream('GET', url, follow_redirects=False) as response:
                response.raise_for_status()
                if response.status_code != 200:
                    raise ValueError('Artwork redirect refused')
                content_type = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
                length = response.headers.get('content-length')
                if length and (not length.isdigit() or int(length) > MAX_BYTES):
                    raise ValueError('Artwork too large')
                payload = bytearray()
                for chunk in response.iter_bytes():
                    if self._stop.is_set() or time.monotonic() > deadline:
                        raise InterruptedError('Artwork service stopped')
                    payload.extend(chunk)
                    if len(payload) > MAX_BYTES:
                        raise ValueError('Artwork too large')
                if not _valid_artwork(bytes(payload), content_type):
                    raise ValueError('Invalid artwork signature')
                return bytes(payload)

    def _process(self, row: dict, token: str) -> None:
        resource_id = row['resource_id']
        try:
            if self._stop.is_set():
                raise InterruptedError('Artwork service stopped')
            with self.database.connect() as conn:
                if not self._live_bindings(conn, resource_id):
                    conn.execute("UPDATE artwork_resources SET state='cancelled',lease_token='',lease_until=0, "
                                 "error_kind='inactive_demand' WHERE resource_id=? AND lease_token=?",
                                 (resource_id, token))
                    return
            original = row['original_path']
            if original and row['content_digest']:
                payload = (self.data_root / original).read_bytes()
            elif row['local_source']:
                try:
                    path = Path(row['local_source'])
                except (OSError, ValueError) as error:
                    raise ManualArtworkSourceError('Invalid manual artwork source') from error
                if (not path.is_absolute()
                        or path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}):
                    raise ManualArtworkSourceError('Invalid manual artwork source')
                try:
                    with path.open('rb') as source:
                        payload = source.read(MAX_BYTES + 1)
                except OSError as error:
                    raise ManualArtworkSourceError('Manual artwork source unavailable') from error
            else:
                payload = self._download(row['source_url'])
            if not payload or len(payload) > MAX_BYTES:
                raise ValueError('Artwork too large or empty')
            digest = hashlib.sha256(payload).hexdigest()
            original = f'artwork/originals/{digest[:2]}/{digest}'
            with self.database.connect() as conn:
                roles = {item['role'] for item in self._live_bindings(conn, resource_id)}
            widths = sorted({width for role in roles for width in ROLE_WIDTHS[role]})
            variants = []
            # Pillow 解码及所有尺寸生成串行；同一内容在两条下载任务中也不会重复编码。
            with _ENCODE_LOCK, warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                import io

                with Image.open(io.BytesIO(payload)) as source:
                    if source.width * source.height > MAX_PIXELS or source.format not in {'JPEG', 'PNG', 'WEBP'}:
                        raise ValueError('Unsupported artwork dimensions or format')
                    source.load()
                    image = ImageOps.exif_transpose(source).convert('RGBA' if 'A' in source.getbands() else 'RGB')
                    for width in widths:
                        relative = f'cache/artwork_variants/{digest[:2]}/{digest}-{RECIPE_VERSION}-{width}.webp'
                        target = self.data_root / relative
                        with self.database.connect() as conn:
                            registered = conn.execute('SELECT * FROM artwork_variants WHERE content_digest=? '
                                                      'AND recipe_version=? AND width=?',
                                                      (digest, RECIPE_VERSION, width)).fetchone()
                        if registered is None or not target.is_file():
                            sized = image.copy()
                            sized.thumbnail((width, max(1, round(image.height * width / image.width))),
                                            Image.Resampling.LANCZOS)
                            output = io.BytesIO()
                            sized.save(output, 'WEBP', quality=82, method=4)
                            encoded = output.getvalue()
                            _atomic_bytes(target, encoded)
                            dimensions = (sized.width, sized.height, len(encoded), hashlib.sha256(encoded).hexdigest())
                        else:
                            dimensions = (registered['pixel_width'], registered['pixel_height'],
                                          registered['byte_size'], registered['etag'])
                        variants.append((digest, RECIPE_VERSION, width, relative, *dimensions))
                    _atomic_bytes(self.data_root / original, payload)
            self._publish(resource_id, token, digest, original, variants)
        except Exception as error:
            with self.database.connect() as conn:
                attempts = int(row['attempts']) + 1
                state = ('cancelled' if not self._live_bindings(conn, resource_id)
                         else 'failed' if isinstance(error, ManualArtworkSourceError)
                         else 'failed' if attempts >= 5 else 'retry')
                error_kind = ('invalid_manual_source' if isinstance(error, ManualArtworkSourceError)
                              else type(error).__name__)
                conn.execute("UPDATE artwork_resources SET state=?,retry_at=?,lease_token='',lease_until=0, "
                             "error_kind=? WHERE resource_id=? AND state='running' AND lease_token=?",
                             (state, time.time() + min(3600, 30 * 2 ** attempts),
                              error_kind, resource_id, token))

    @staticmethod
    def _live_bindings(conn, resource_id: str) -> list[dict]:
        bindings = [dict(row) for row in conn.execute('SELECT * FROM artwork_bindings WHERE candidate_id=?', (resource_id,))]
        return [binding for binding in bindings if binding_publishable(conn, binding)]

    def _publish(self, resource_id, token, digest, original, variants) -> None:
        with self.database.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            changed = conn.execute("UPDATE artwork_resources SET state='ready',content_digest=?,original_path=?, "
                                   "lease_token='',lease_until=0,error_kind='' WHERE resource_id=? "
                                   "AND state='running' AND lease_token=?", (digest, original, resource_id, token)).rowcount
            if not changed:
                return
            conn.executemany('INSERT OR REPLACE INTO artwork_variants '
                             '(content_digest,recipe_version,width,relative_path,pixel_width,pixel_height,byte_size,etag) '
                             'VALUES (?,?,?,?,?,?,?,?)', variants)
            affected = set()
            available_widths = {item[0] for item in conn.execute('SELECT width FROM artwork_variants '
                                                               'WHERE content_digest=? AND recipe_version=?',
                                                               (digest, RECIPE_VERSION))}
            missing_sizes = False
            live_bindings = self._live_bindings(conn, resource_id)
            for binding in live_bindings:
                if not set(ROLE_WIDTHS[binding['role']]) <= available_widths:
                    # 编码期间新增的角色下一波补齐；不能先发布一个尺寸缺失的候选。
                    missing_sizes = True
                    continue
                if binding['published_id'] != binding['candidate_id']:
                    affected.add(binding['work_id'])
                conn.execute('UPDATE artwork_bindings SET published_id=candidate_id '
                             'WHERE subject_type=? AND subject_id=? AND role=? AND candidate_id=?',
                             (binding['subject_type'], binding['subject_id'], binding['role'], resource_id))
            for work_id in affected:
                from app.media_v4.assets.status import required_artwork_status

                published = conn.execute(
                    "SELECT 1 FROM library_cards c JOIN v4_meta m ON m.key='current_library_generation' "
                    "AND m.value=c.generation_id WHERE c.work_id=?", (work_id,),
                ).fetchone()
                manual = any(b['work_id'] == work_id and b['priority'] >= 100 for b in live_bindings)
                if published or manual:
                    bump_display_version(conn, work_id, kind='artwork')
                if not published and required_artwork_status(conn, work_id)['status'] == 'ready':
                    # 最后一张必需图发布后只重建这部作品；初始缺图不发送空卡事件。
                    mark_projection_dirty(conn, [work_id])
            if missing_sizes:
                conn.execute("UPDATE artwork_resources SET state='pending' WHERE resource_id=?", (resource_id,))
            elif not live_bindings:
                conn.execute("UPDATE artwork_resources SET state='cancelled',error_kind='inactive_demand' WHERE resource_id=?",
                             (resource_id,))
