"""V4 job runner：只消费已确认 revision，不重新识别来源。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.media_v4.jobs.alias_recovery import NAME_REASONS, RETRY_REASONS, recover_metadata
from app.media_v4.jobs.control import cancel_requested, claim_running, heartbeat, mark_cancelled, now
from app.media_v4.jobs.metadata import default_metadata_provider
from app.media_v4.jobs.scrape import V4ScrapeService
from app.media_v4.persistence.database import V4Database
from app.media_v4.projection.library import LibrarySnapshot, V4LibraryProjection


@dataclass(frozen=True, slots=True)
class JobRunResult:
    job_id: str
    job_type: str
    status: str
    snapshot: LibrarySnapshot | None = None


class V4JobRunner:
    """执行 V4 outbox 中可以本地完成的任务。"""

    # Work 级刮削会等待多个外部元数据请求；它们之间没有共享媒体写入，
    # 因此可以有限并发。保守上限避免大来源同时打满 TMDB 或 SQLite 写锁。
    _MAX_PARALLEL_SCRAPE_JOBS = 3

    _LOCAL_JOB_TYPES = frozenset({
        "scrape_work",
        "recover_work_aliases",
        "refresh_projection",
        "delete_source_library",
    })

    def __init__(self, database: V4Database, metadata_provider: Callable[[dict], dict] | None = None,
                 *, recovery_provider: Callable[[dict], dict] | None = None):
        self.database = database
        self.scrape = V4ScrapeService(database)
        self.projection = V4LibraryProjection(database)
        self.metadata_provider = metadata_provider or default_metadata_provider
        self.recovery_provider = recovery_provider or (recover_metadata if metadata_provider is None else None)

    def process_job(self, job_id: str, *, mirror_root: str | Path | None = None) -> JobRunResult:
        with self.database.connect() as conn:
            job = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if job is None:
            raise KeyError(job_id)
        if job['job_type'] in {'materialize_mirror', 'cleanup_superseded_artifacts'}:
            # 历史任务不迁成假成功，也不重新接回物化执行链。
            mark_cancelled(self.database, job_id)
            return JobRunResult(job_id, job['job_type'], 'cancelled')
        try:
            job_payload = json.loads(job['result_json'] or '{}')
            policy = job_payload.get('runtime_policy')
        except (ValueError, TypeError, AttributeError):
            job_payload = {}
            policy = None
        if job['job_type'] in {'scrape_work', 'recover_work_aliases'} and policy != 'sqlite-artwork-v1':
            mark_cancelled(self.database, job_id)
            return JobRunResult(job_id, job['job_type'], 'cancelled')
        if job["status"] == "succeeded":
            return JobRunResult(job_id, job["job_type"], "succeeded")
        if bool(job["cancel_requested"]):
            mark_cancelled(self.database, job_id)
            # 取消是用户可预期的终态，不应被后台 worker 或手动运行入口
            # 当作执行异常。这样“取队列后才收到终止请求”的竞态不会留下
            # 无意义的 409/错误日志，且仍保证不会领取或写入任何产物。
            return JobRunResult(job_id, job["job_type"], "cancelled")
        if job["status"] != "queued":
            raise ValueError(f"任务状态不可执行: {job['status']}")
        if job["job_type"] not in self._LOCAL_JOB_TYPES:
            raise ValueError(f"未知 V4 任务: {job['job_type']}")
        with self.database.connect() as conn:
            revision = conn.execute(
                "SELECT status FROM import_revisions WHERE revision_id = ?",
                (job["revision_id"],),
            ).fetchone()
        if revision is None or revision["status"] != "confirmed":
            raise ValueError("只有 confirmed revision 的排队任务可以执行")
        if not self._prerequisites_succeeded(dict(job)):
            raise ValueError("任务的前置步骤尚未全部成功")

        if job["job_type"] in {"scrape_work", "recover_work_aliases"}:
            provider = self.metadata_provider
            selected_provider = job_payload.get("selected_provider")
            if job["job_type"] == "scrape_work" and isinstance(selected_provider, dict):
                selected_binding = {
                    "provider": str(selected_provider.get("provider") or ""),
                    "media_type": str(selected_provider.get("media_type") or ""),
                    "provider_id": str(selected_provider.get("provider_id") or ""),
                }
                if not all(selected_binding.values()):
                    raise ValueError("人工确认任务缺少完整的 Provider 身份")

                def pinned_provider(target):
                    bindings = [
                        item for item in target.get("provider_bindings", [])
                        if (str(item.get("provider") or ""), str(item.get("media_type") or ""))
                        != (selected_binding["provider"], selected_binding["media_type"])
                    ]
                    return self.metadata_provider({
                        **target,
                        "provider_bindings": [*bindings, selected_binding],
                    })

                provider = pinned_provider
            if job["job_type"] == "recover_work_aliases":
                if self.recovery_provider is None:
                    raise ValueError("未配置名称恢复执行器")
                provider = self.recovery_provider
                if provider is recover_metadata:
                    def provider(target):
                        from app.media_v4.jobs.alias_cache import RecoveryCache

                        return recover_metadata(target, cache=RecoveryCache(self.database),
                                                should_cancel=lambda: cancel_requested(self.database, job_id))
            self.scrape.process(
                job_id,
                provider,
            )
            if job['job_type'] == 'recover_work_aliases':
                with self.database.connect() as conn:
                    current = conn.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone()
                    payload = json.loads(current['result_json'] or '{}')
                    delay = int(payload.get('alias_deferred_seconds') or 0)
                    if delay and current['status'] == 'succeeded' and int(current['attempts']) < 3 and not current['cancel_requested']:
                        payload['next_retry_at'] = (datetime.now(UTC) + timedelta(seconds=min(delay, 86400))).isoformat()
                        conn.execute("UPDATE jobs SET status='queued',result_json=?,finished_at='',updated_at=? WHERE job_id=?",
                                     (json.dumps(payload, ensure_ascii=False), now(), job_id))
            return JobRunResult(job_id, job["job_type"], self._current_status(job_id))

        if job["job_type"] == "delete_source_library":
            # 按来源删除媒体库：纯 SQL + 文件回收（退役来源 + 删除不与其它来源共享的
            # 作品的镜像产物），**不重跑识别**。取消检查贯穿批次之间。
            from app.media_v4.maintenance.source_deletion import delete_source_library

            if not claim_running(self.database, job_id):
                raise ValueError("任务已由其他执行器领取")
            with self.database.connect() as conn:
                revision = conn.execute(
                    "SELECT root_id FROM import_revisions WHERE revision_id = ?",
                    (job["revision_id"],),
                ).fetchone()
            if revision is None:
                raise ValueError("删除任务的来源 revision 不存在")
            try:
                cleanup_root = mirror_root
                if cleanup_root is None:
                    from app.core.config import load_config

                    configured = str(load_config().mirror_dir or '').strip()
                    cleanup_root = Path(configured) if configured else None
                outcome = delete_source_library(
                    self.database,
                    str(revision["root_id"]),
                    mirror_root=cleanup_root,
                    should_cancel=lambda: cancel_requested(self.database, job_id),
                    progress=lambda _done, _total: heartbeat(self.database, job_id),
                    # 本作业此刻必然是 running，阻断检查要排除它自己。
                    ignore_job_id=job_id,
                )
            except Exception as exc:
                self._retry_source_deletion(job_id, str(exc))
                return JobRunResult(job_id, job["job_type"], self._current_status(job_id))
            if outcome.get("cancelled"):
                # 取消是可预期终态：标 cancelled，且**不**重建投影制造半成品视图。
                mark_cancelled(self.database, job_id)
                return JobRunResult(job_id, job["job_type"], "cancelled")
            if not outcome.get("ok") and not outcome.get("retired"):
                self._mark_failed(job_id, str(outcome.get("reason") or "按来源删除未完成"))
                return JobRunResult(job_id, job["job_type"], "failed")
            try:
                heartbeat(self.database, job_id)
                # 来源已退役，即使有文件暂时无法回收，也先更新媒体墙避免空卡片。
                self.projection.rebuild()
            except Exception as exc:
                self._retry_source_deletion(job_id, str(exc))
                return JobRunResult(job_id, job["job_type"], self._current_status(job_id))
            if not outcome.get("ok"):
                self._retry_source_deletion(job_id, str(outcome.get("reason") or "按来源删除未完成"))
                return JobRunResult(job_id, job["job_type"], self._current_status(job_id))
            self._mark_succeeded(job_id)
            return JobRunResult(job_id, job["job_type"], "succeeded")

        if not claim_running(self.database, job_id):
            raise ValueError("任务已由其他执行器领取")
        try:
            if cancel_requested(self.database, job_id):
                mark_cancelled(self.database, job_id)
                return JobRunResult(job_id, job["job_type"], "cancelled")
            snapshot = self.projection.refresh_if_needed()
            if snapshot is None:
                snapshot = self.projection.current()
            heartbeat(self.database, job_id)
            if cancel_requested(self.database, job_id):
                mark_cancelled(self.database, job_id)
                return JobRunResult(job_id, job["job_type"], "cancelled")
            self._mark_succeeded(job_id)
            return JobRunResult(job_id, job["job_type"], "succeeded", snapshot=snapshot)
        except Exception as exc:
            self._mark_failed(job_id, str(exc))
            raise

    def process_available(self, *, mirror_root: str | Path | None = None) -> list[JobRunResult]:
        self._cancel_legacy_jobs_if_present()
        self.recover_stale_jobs()
        self.schedule_recovery()
        with self.database.connect() as conn:
            rows = conn.execute(
                """
                SELECT job_id
                FROM jobs
                WHERE status = 'queued'
                  AND job_type IN (
                      'scrape_work', 'recover_work_aliases', 'refresh_projection', 'delete_source_library'
                  )
                ORDER BY CASE job_type
                    WHEN 'delete_source_library' THEN 0
                    WHEN 'scrape_work' THEN 2
                    WHEN 'recover_work_aliases' THEN 2
                    WHEN 'refresh_projection' THEN 3
                    ELSE 9 END,
                    created_at, job_id
                """
            ).fetchall()
        results: list[JobRunResult] = []
        scrape_job_ids: list[str] = []
        deferred_job_ids: list[str] = []
        recovery_job_ids: list[str] = []
        for row in rows:
            with self.database.connect() as conn:
                job = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (row["job_id"],)).fetchone()
            if job is None:
                continue
            if bool(job["cancel_requested"]):
                # 队列快照和二次读取之间可能收到终止请求。正常取消路径会
                # 同时改写 status；这里仍须收口异常/恢复场景，不能静默跳过
                # 而留下永远排队的任务。复用 process_job 的取消分支，确保
                # 不会领取任务或产生任何文件写入。
                if job["status"] == "queued":
                    results.append(self.process_job(str(row["job_id"]), mirror_root=mirror_root))
                continue
            job_type = str(job["job_type"])
            if job_type == "refresh_projection":
                # 它们依赖本轮全部 scrape 的终态，必须等有限并发批次收口。
                deferred_job_ids.append(str(row["job_id"]))
                continue
            if not self._prerequisites_succeeded(dict(job)):
                continue
            if job_type == "scrape_work":
                scrape_job_ids.append(str(row["job_id"]))
                continue
            if job_type == "recover_work_aliases":
                recovery_job_ids.append(str(row["job_id"]))
                continue
            results.append(self.process_job(row["job_id"], mirror_root=mirror_root))

        if scrape_job_ids:
            workers = min(self._MAX_PARALLEL_SCRAPE_JOBS, len(scrape_job_ids))
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="v4-scrape") as executor:
                futures = [
                    executor.submit(self.process_job, job_id, mirror_root=mirror_root)
                    for job_id in scrape_job_ids
                ]
                # 按队列顺序读取结果，保持 API/测试的稳定可观察顺序；如果任一
                # 任务失败，executor 仍先安全等待已领取的同批任务退出。
                results.extend(future.result() for future in futures)

        # 只有本轮确实执行了刮削批次时，才可能把新成功的 scrape 转成恢复
        # 作业；空闲迭代不再重复扫描历史任务。
        if scrape_job_ids:
            self.schedule_recovery()
        with self.database.connect() as conn:
            recovery_job_ids = [str(row[0]) for row in conn.execute(
                "SELECT job_id FROM jobs WHERE job_type='recover_work_aliases' AND status='queued' ORDER BY created_at,job_id",
            )]
        for job_id in recovery_job_ids:
            with self.database.connect() as conn:
                job = conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if job and self._prerequisites_succeeded(dict(job)):
                results.append(self.process_job(job_id, mirror_root=mirror_root))
        # 每波最多十部；只有本轮确实存在待恢复作业时才需要补排下一波，
        # 空闲迭代不再重复扫描历史任务。首次调度已在迭代开头完成。
        if recovery_job_ids:
            self.schedule_recovery()

        for job_id in deferred_job_ids:
            with self.database.connect() as conn:
                job = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            if job is None:
                continue
            if bool(job["cancel_requested"]):
                if job["status"] == "queued":
                    results.append(self.process_job(job_id, mirror_root=mirror_root))
                continue
            if not self._prerequisites_succeeded(dict(job)):
                continue
            results.append(self.process_job(job_id, mirror_root=mirror_root))
        return results

    def _cancel_legacy_jobs_if_present(self) -> None:
        """只在只读探测发现待清理历史任务时才开启写事务，并在事务内重核。"""

        legacy_types = ("materialize_mirror", "cleanup_superseded_artifacts")
        with self.database.connect() as conn:
            candidates = conn.execute(
                """
                SELECT 1 FROM jobs
                WHERE status IN ('queued', 'running') AND (
                    job_type IN (?, ?) OR (
                        job_type IN ('scrape_work', 'recover_work_aliases') AND (
                            NOT json_valid(result_json) OR
                            COALESCE(json_extract(result_json, '$.runtime_policy'), '') != 'sqlite-artwork-v1'
                        )
                    )
                ) LIMIT 1
                """,
                legacy_types,
            ).fetchone()
        if candidates is None:
            return

        current_time = now()
        with self.database.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "UPDATE jobs SET status='cancelled',cancel_requested=1,finished_at=?,updated_at=? "
                "WHERE job_type IN (?, ?) AND status IN ('queued','running')",
                (current_time, current_time, *legacy_types),
            )
            conn.execute(
                """
                UPDATE jobs SET status='cancelled',cancel_requested=1,finished_at=?,updated_at=?
                WHERE job_type IN ('scrape_work','recover_work_aliases')
                  AND status IN ('queued','running')
                  AND (NOT json_valid(result_json) OR
                       COALESCE(json_extract(result_json,'$.runtime_policy'),'') != 'sqlite-artwork-v1')
                """,
                (current_time, current_time),
            )

    # 恢复候选查询：先把可能阻断恢复的 revision 物化成集合，再按集合反连接。
    # 原实现把取消/排队两个相关条件内联为主查询的 NOT EXISTS，历史 jobs
    # 只增不减（本机 4082 条时单次约 76~103ms）；空闲轮询每轮调用三次会
    # 长期占据一个逻辑核心。物化后同库单次约 10~13ms，候选行与顺序一致。
    # 只取调度实际消费的四个字段，不再整行读取 jobs。
    _RECOVERY_CANDIDATE_SQL = (
        "WITH blocked_revisions AS MATERIALIZED ("
        "SELECT DISTINCT p.revision_id FROM jobs p "
        "WHERE (p.cancel_requested=1 AND p.job_type!='recover_work_aliases') "
        "OR (p.job_type='scrape_work' AND p.status IN ('queued','running'))) "
        "SELECT j.revision_id,j.work_id,j.attempts,j.result_json "
        "FROM jobs j JOIN import_revisions ir ON ir.revision_id=j.revision_id "
        "JOIN source_roots sr ON sr.root_id=ir.root_id JOIN works w ON w.work_id=j.work_id "
        "WHERE j.job_type='scrape_work' AND j.status='succeeded' AND ir.status='confirmed' "
        "AND json_valid(j.result_json) AND json_extract(j.result_json,'$.runtime_policy')='sqlite-artwork-v1' "
        "AND sr.retired_at='' AND w.status='active' "
        "AND NOT EXISTS (SELECT 1 FROM blocked_revisions b WHERE b.revision_id=j.revision_id) "
        "ORDER BY j.created_at,j.job_id"
    )

    # 每波恢复任务上限；达到上限后由下一次调度继续补排。
    _MAX_PENDING_RECOVERY_JOBS = 10

    def schedule_recovery(self) -> int:
        """首轮全体收口后事务去重；取消/退役 revision 不产生新作业。"""
        if self.recovery_provider is None:
            return 0
        created = 0
        with self.database.connect() as conn:
            # 空闲或所有候选已处理时不占写锁；锁内仍重新检查防止重复调度。
            candidates = conn.execute(self._RECOVERY_CANDIDATE_SQL).fetchall()
            needs_recovery = False
            for candidate in candidates:
                result = json.loads(candidate['result_json'] or '{}')
                reason = str(result.get('reason_code') or result.get('refresh_reason_code')
                             or next(iter(result.get('reason_codes') or []), ''))
                key = f"recover_work_aliases:{candidate['revision_id']}:{candidate['work_id']}:{candidate['attempts']}"
                if reason in NAME_REASONS | RETRY_REASONS and not conn.execute(
                    'SELECT 1 FROM jobs WHERE idempotency_key=?', (key,),
                ).fetchone():
                    needs_recovery = True
                    break
            if not needs_recovery:
                return 0
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(self._RECOVERY_CANDIDATE_SQL).fetchall()
            # 同一写事务内只有本函数插入恢复作业，也没有其它写入者（BEGIN
            # IMMEDIATE 已持有写锁），因此活动计数读一次、插入时递增即可，
            # 不必对每个候选行重复 COUNT。
            active = 0
            if rows:
                active = int(conn.execute(
                    "SELECT COUNT(*) FROM jobs WHERE job_type='recover_work_aliases' AND status IN ('queued','running')",
                ).fetchone()[0])
            for row in rows:
                result = json.loads(row['result_json'] or '{}')
                primary = str(result.get('reason_code') or result.get('refresh_reason_code')
                              or next(iter(result.get('reason_codes') or []), ''))
                reasons = {primary}
                if not reasons & (NAME_REASONS | RETRY_REASONS):
                    continue
                key = f"recover_work_aliases:{row['revision_id']}:{row['work_id']}:{row['attempts']}"
                if conn.execute("SELECT 1 FROM jobs WHERE idempotency_key=?", (key,)).fetchone():
                    continue
                if active >= self._MAX_PENDING_RECOVERY_JOBS:
                    break
                stamp = now()
                conn.execute(
                    "INSERT INTO jobs(job_id,job_type,revision_id,work_id,idempotency_key,created_at,updated_at,result_json) "
                    "VALUES (?,'recover_work_aliases',?,?,?,?,?,'{\"runtime_policy\":\"sqlite-artwork-v1\"}')",
                    (str(uuid.uuid4()), row['revision_id'], row['work_id'], key, stamp, stamp),
                )
                created += 1
                active += 1
        return created

    def _prerequisites_succeeded(self, job: dict) -> bool:
        job_type = str(job["job_type"])
        if job_type == "scrape_work":
            return True
        if job_type == "delete_source_library":
            # 按来源删除不依赖本 revision 的镜像/刮削是否完成：它只回收产物并按
            # 引用计数决定哪些作品离开媒体库。
            return True
        params: tuple[object, ...]
        if job_type == "recover_work_aliases":
            payload = json.loads(job.get('result_json') or '{}')
            if payload.get('next_retry_at', '') > now():
                return False
            predicate = "job_type='scrape_work'"
            params = (job["revision_id"],)
        elif job_type == "refresh_projection":
            # Projection is the revision's final step: it must wait for both
            # first-pass scraping and any alias-recovery work scheduled from it.
            predicate = "job_type IN ('scrape_work','recover_work_aliases')"
            params = (job["revision_id"],)
        else:
            return False
        with self.database.connect() as conn:
            pending = "status IN ('queued', 'running')" if job_type in {'refresh_projection', 'cleanup_superseded_artifacts', 'recover_work_aliases'} else "status != 'succeeded'"
            blocked = conn.execute(
                f"SELECT 1 FROM jobs WHERE revision_id = ? AND {predicate} "
                f"AND {pending} LIMIT 1",
                params,
            ).fetchone()
        return blocked is None

    def cancel_revision(self, revision_id: str) -> dict[str, int | str]:
        """请求终止一个已确认导入；运行中任务在下一安全边界收口。"""

        with self.database.connect() as conn:
            revision = conn.execute(
                "SELECT revision_id FROM import_revisions WHERE revision_id = ?",
                (revision_id,),
            ).fetchone()
            if revision is None:
                raise KeyError(revision_id)
            stamp = now()
            work_ids = [row[0] for row in conn.execute(
                'SELECT DISTINCT work_id FROM revision_bindings WHERE revision_id=?', (revision_id,))]
            conn.executemany('INSERT OR REPLACE INTO v4_meta(key,value) VALUES (?,?)',
                             [('artwork_cancelled_revision:' + revision_id + ':' + work_id, stamp)
                              for work_id in work_ids])
            running = conn.execute(
                """
                UPDATE jobs
                SET cancel_requested = 1, heartbeat_at = ?, updated_at = ?
                WHERE revision_id = ? AND status = 'running'
                """,
                (stamp, stamp, revision_id),
            ).rowcount
            cancelled = conn.execute(
                """
                UPDATE jobs
                SET status = 'cancelled', cancel_requested = 1, last_error = '',
                    heartbeat_at = ?, finished_at = ?, updated_at = ?
                WHERE revision_id = ? AND status = 'queued'
                """,
                (stamp, stamp, stamp, revision_id),
            ).rowcount
        return {"revision_id": revision_id, "running": int(running), "cancelled": int(cancelled)}

    def recover_stale_jobs(self, *, max_age_seconds: int = 120) -> int:
        """回收崩溃遗留的 running 行，避免来源卡永久显示进行中。"""

        with self.database.connect() as conn:
            rows = conn.execute(
                "SELECT job_id, job_type, attempts, cancel_requested, heartbeat_at, updated_at "
                "FROM jobs WHERE status = 'running'"
            ).fetchall()
        stale_ids: list[str] = []
        threshold = datetime.now(UTC).timestamp() - max(1, max_age_seconds)
        for row in rows:
            raw = str(row["heartbeat_at"] or row["updated_at"] or "")
            try:
                age = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
            except ValueError:
                age = 0
            if age <= threshold:
                stale_ids.append(str(row["job_id"]))
        if not stale_ids:
            return 0
        stamp = now()
        with self.database.connect() as conn:
            for job_id in stale_ids:
                row = conn.execute(
                    "SELECT job_type, attempts, cancel_requested FROM jobs WHERE job_id = ? AND status = 'running'",
                    (job_id,),
                ).fetchone()
                if row is None:
                    continue
                if str(row["job_type"]) == "delete_source_library" and int(row["attempts"]) < 3:
                    # 崩溃前可能已删掉部分可再生文件；同一删除作业从剩余产物继续。
                    # 即使收到过终止，退役后的清理仍必须收口，避免隐藏来源残留产物。
                    retired = conn.execute(
                        "SELECT sr.retired_at FROM jobs j JOIN import_revisions ir ON ir.revision_id = j.revision_id "
                        "JOIN source_roots sr ON sr.root_id = ir.root_id WHERE j.job_id = ?",
                        (job_id,),
                    ).fetchone()
                    if not bool(row["cancel_requested"]) or (retired and str(retired["retired_at"])):
                        conn.execute(
                            "UPDATE jobs SET status = 'queued', cancel_requested = 0, "
                            "last_error = '任务异常中断，继续清理', heartbeat_at = ?, updated_at = ? WHERE job_id = ?",
                            (stamp, stamp, job_id),
                        )
                        continue
                if bool(row["cancel_requested"]):
                    conn.execute(
                        "UPDATE jobs SET status = 'cancelled', finished_at = ?, heartbeat_at = ?, updated_at = ? WHERE job_id = ?",
                        (stamp, stamp, stamp, job_id),
                    )
                elif row['job_type'] == 'recover_work_aliases' and int(row['attempts']) < 3:
                    conn.execute("UPDATE jobs SET status='queued',last_error='名称核对中断，继续处理',updated_at=? WHERE job_id=?",
                                 (stamp, job_id))
                else:
                    conn.execute(
                        """
                        UPDATE jobs
                        SET status = 'failed', last_error = '任务异常中断，可重试',
                            finished_at = ?, heartbeat_at = ?, updated_at = ?
                        WHERE job_id = ?
                        """,
                        (stamp, stamp, stamp, job_id),
                    )
        return len(stale_ids)

    def _retry_source_deletion(self, job_id: str, error: str) -> None:
        """有界重试可恢复的删除作业；重试沿用同一幂等 job 与剩余产物行。"""

        stamp = now()
        with self.database.connect() as conn:
            row = conn.execute("SELECT attempts FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            if row is not None and int(row["attempts"]) < 3:
                conn.execute(
                    "UPDATE jobs SET status = 'queued', cancel_requested = 0, last_error = ?, "
                    "heartbeat_at = ?, updated_at = ? WHERE job_id = ?",
                    (error, stamp, stamp, job_id),
                )
                return
        self._mark_failed(job_id, error)

    def _mark_running(self, job_id: str) -> bool:
        return claim_running(self.database, job_id)

    def _current_status(self, job_id: str) -> str:
        with self.database.connect() as conn:
            row = conn.execute("SELECT status FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        return str(row["status"])

    def _mark_succeeded(self, job_id: str) -> None:
        stamp = now()
        with self.database.connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'succeeded', last_error = '', heartbeat_at = ?, finished_at = ?, updated_at = ? "
                "WHERE job_id = ?",
                (stamp, stamp, stamp, job_id),
            )

    def _mark_failed(self, job_id: str, error: str) -> None:
        stamp = now()
        with self.database.connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'failed', last_error = ?, heartbeat_at = ?, finished_at = ?, updated_at = ? "
                "WHERE job_id = ?",
                (error, stamp, stamp, stamp, job_id),
            )
