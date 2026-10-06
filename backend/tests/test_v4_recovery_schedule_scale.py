"""恢复调度热点回归：候选边界语义、调用次数与历史规模工作量。

本文件守护 2026-10-06 的后台热点修复：
- 空闲迭代不再对历史 jobs 重复调度三次，只保留开头一次调度；
- 恢复候选改为先物化被阻断 revision 集合再反连接，候选行与顺序保持不变；
- 上述改动不改变既有恢复边界（取消、退役、非 confirmed、非 active 等）。

夹具在临时数据库内构造，不读取或改写真实媒体库与任务历史。
"""

import json

from app.media_v4.jobs.runner import V4JobRunner
from app.media_v4.persistence.database import V4Database

STAMP = "2026-01-01T00:00:00+00:00"

# 夹具预置的幂等键：统计调度新建作业时必须排除，避免把预置行当成新排程。
_SEED_KEYS = (
    "seed:only-recover-cancel",
    "recover_work_aliases:rev-existing_key:work-existing_key:0",
)

# 优化前的内联形态，仅用于同库工作量对照，不参与产品执行。
_LEGACY_CANDIDATE_SQL = (
    "SELECT j.* FROM jobs j JOIN import_revisions ir ON ir.revision_id=j.revision_id "
    "JOIN source_roots sr ON sr.root_id=ir.root_id JOIN works w ON w.work_id=j.work_id "
    "WHERE j.job_type='scrape_work' AND j.status='succeeded' AND ir.status='confirmed' "
    "AND sr.retired_at='' AND w.status='active' AND NOT EXISTS ("
    "SELECT 1 FROM jobs p WHERE p.revision_id=j.revision_id AND ((p.cancel_requested=1 AND p.job_type!='recover_work_aliases') "
    "OR (p.job_type IN ('materialize_mirror','scrape_work') AND p.status IN ('queued','running')))) "
    "ORDER BY j.created_at,j.job_id"
)


def _reason(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _insert_root(conn, root_id: str, *, retired_at: str = "") -> None:
    conn.execute(
        "INSERT INTO source_roots(root_id, provider, ingest_method, retired_at, created_at, updated_at) "
        "VALUES (?, 'local', 'local_scan', ?, ?, ?)",
        (root_id, retired_at, STAMP, STAMP),
    )


def _insert_scan(conn, scan_id: str, root_id: str) -> None:
    conn.execute(
        "INSERT INTO source_scans(scan_id, root_id, generation, status) VALUES (?, ?, 1, 'completed')",
        (scan_id, root_id),
    )


def _insert_revision(conn, revision_id: str, root_id: str, scan_id: str, *, status: str = "confirmed") -> None:
    conn.execute(
        "INSERT INTO import_revisions(revision_id, root_id, scan_id, resolver_version, status, created_at) "
        "VALUES (?, ?, ?, 'fixture', ?, ?)",
        (revision_id, root_id, scan_id, status, STAMP),
    )


def _insert_work(conn, work_id: str, *, status: str = "active") -> None:
    conn.execute(
        "INSERT INTO works(work_id, identity_key, work_type, preferred_title, status, created_at, updated_at) "
        "VALUES (?, ?, 'series', 'Fixture', ?, ?, ?)",
        (work_id, work_id, status, STAMP, STAMP),
    )


def _insert_job(
    conn,
    job_id: str,
    job_type: str,
    revision_id: str,
    work_id: str = "",
    *,
    status: str = "succeeded",
    attempts: int = 0,
    cancel_requested: int = 0,
    result_json: str = "{}",
    idempotency_key: str | None = None,
) -> None:
    conn.execute(
        "INSERT INTO jobs(job_id, job_type, revision_id, work_id, idempotency_key, status, attempts, "
        "cancel_requested, created_at, updated_at, result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            job_id,
            job_type,
            revision_id,
            work_id,
            idempotency_key or f"key:{job_id}",
            status,
            attempts,
            cancel_requested,
            STAMP,
            STAMP,
            result_json,
        ),
    )


def _new_runner(database: V4Database) -> V4JobRunner:
    return V4JobRunner(
        database,
        metadata_provider=lambda _target: {},
        recovery_provider=lambda _target: {},
    )


def _recovery_revisions(database: V4Database) -> list[str]:
    placeholders = ",".join("?" for _ in _SEED_KEYS)
    with database.connect() as conn:
        return [
            str(row["revision_id"])
            for row in conn.execute(
                f"SELECT revision_id FROM jobs WHERE job_type='recover_work_aliases' "
                f"AND idempotency_key NOT IN ({placeholders}) ORDER BY revision_id",
                _SEED_KEYS,
            )
        ]


def _pending_jobs(database: V4Database) -> int:
    with database.connect() as conn:
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')"
            ).fetchone()[0]
        )


def test_idle_iteration_schedules_recovery_once(tmp_path, monkeypatch):
    """没有排队任务时，一轮迭代只应调度一次恢复，不再无条件重复扫描。"""

    database = V4Database(tmp_path / "idle.db")
    database.initialize()
    with database.connect() as conn:
        _insert_root(conn, "root")
        _insert_scan(conn, "scan", "root")
        _insert_revision(conn, "rev", "root", "scan")
        _insert_work(conn, "work")
        _insert_job(conn, "m1", "materialize_mirror", "rev", "work")
        _insert_job(conn, "s1", "scrape_work", "rev", "work",
                    result_json=_reason({"reason_codes": ["no_candidates"]}))
        # 候选已被排程过（幂等键一致），本迭代不应再产生新作业。
        _insert_job(conn, "r1", "recover_work_aliases", "rev", "work",
                    idempotency_key="recover_work_aliases:rev:work:0")

    runner = _new_runner(database)
    calls: list[int] = []
    original = runner.schedule_recovery

    def counted() -> int:
        calls.append(1)
        return original()

    monkeypatch.setattr(runner, "schedule_recovery", counted)
    assert runner.process_available(mirror_root=tmp_path / "mirror") == []
    assert len(calls) == 1

    # 第二轮空闲迭代同样只调度一次；历史任务规模不改变调用次数。
    assert runner.process_available(mirror_root=tmp_path / "mirror") == []
    assert len(calls) == 2


def test_recovery_candidate_boundaries_are_preserved(tmp_path):
    """物化候选集合后，既有恢复边界必须逐条保持。"""

    database = V4Database(tmp_path / "boundaries.db")
    database.initialize()
    cases = {
        "ok_name": True,             # reason_code 命中名称恢复
        "ok_refresh": True,          # refresh_reason_code 命中
        "ok_list": True,             # reason_codes 列表命中重试原因
        "irrelevant_reason": False,  # 认证类原因不进入恢复
        "retired_root": False,       # 来源已退役
        "draft_revision": False,     # 非 confirmed revision
        "inactive_work": False,      # 非 active work
        "queued_mirror": False,      # 同 revision 仍有排队镜像
        "running_scrape": False,     # 同 revision 仍有运行中刮削
        "cancelled_first_pass": False,  # 首轮刮削被取消
        "only_recover_cancel": True,    # 仅别名恢复被取消：不阻断首轮
        "existing_key": False,          # 已有同键恢复作业
    }
    with database.connect() as conn:
        for name in cases:
            # 每个 root 只允许一个 confirmed revision，因此每个用例独立来源。
            root_id = f"root-{name}"
            scan_id = f"scan-{name}"
            retired_at = STAMP if name == "retired_root" else ""
            _insert_root(conn, root_id, retired_at=retired_at)
            _insert_scan(conn, scan_id, root_id)
            revision_id = f"rev-{name}"
            work_id = f"work-{name}"
            _insert_revision(
                conn, revision_id, root_id, scan_id,
                status="draft" if name == "draft_revision" else "confirmed",
            )
            _insert_work(conn, work_id, status="merged" if name == "inactive_work" else "active")
            _insert_job(conn, f"m-{name}", "materialize_mirror", revision_id, work_id)
            payload = {"reason_codes": ["no_candidates"]}
            if name == "ok_name":
                payload = {"reason_code": "no_candidates"}
            elif name == "ok_refresh":
                payload = {"refresh_reason_code": "ambiguous_candidates"}
            elif name == "ok_list":
                payload = {"reason_codes": ["provider_timeout"]}
            elif name == "irrelevant_reason":
                payload = {"reason_code": "provider_auth_required"}
            _insert_job(
                conn, f"s-{name}", "scrape_work", revision_id, work_id,
                cancel_requested=1 if name == "cancelled_first_pass" else 0,
                result_json=_reason(payload),
            )
        # 阻断型附加作业
        _insert_job(conn, "block-mirror", "materialize_mirror", "rev-queued_mirror", "work-queued_mirror",
                    status="queued")
        _insert_job(conn, "block-scrape", "scrape_work", "rev-running_scrape", "work-running_scrape-other",
                    status="running")
        # 仅别名恢复取消：不阻断
        _insert_job(conn, "cancel-recover", "recover_work_aliases", "rev-only_recover_cancel",
                    "work-only_recover_cancel", status="cancelled", cancel_requested=1,
                    idempotency_key="seed:only-recover-cancel")
        # 已有同键候选
        _insert_job(conn, "existing", "recover_work_aliases", "rev-existing_key", "work-existing_key",
                    idempotency_key="recover_work_aliases:rev-existing_key:work-existing_key:0")

    runner = _new_runner(database)
    created = runner.schedule_recovery()
    expected = sorted(f"rev-{name}" for name, eligible in cases.items() if eligible)
    assert created == len(expected)
    assert _recovery_revisions(database) == expected

    # 重复调用幂等：不重复创建，也不改变候选集合。
    assert runner.schedule_recovery() == 0
    assert _recovery_revisions(database) == expected


def test_recovery_batch_is_bounded_and_resumes_on_next_schedule(tmp_path):
    """每波最多十部；上一波收口后由下一次调度继续补排。"""

    database = V4Database(tmp_path / "bounded.db")
    database.initialize()
    total = 25
    with database.connect() as conn:
        for index in range(total):
            revision_id = f"rev-{index:02d}"
            work_id = f"work-{index:02d}"
            _insert_root(conn, f"root-{index:02d}")
            _insert_scan(conn, f"scan-{index:02d}", f"root-{index:02d}")
            _insert_revision(conn, revision_id, f"root-{index:02d}", f"scan-{index:02d}")
            _insert_work(conn, work_id)
            _insert_job(conn, f"m-{index:02d}", "materialize_mirror", revision_id, work_id)
            _insert_job(conn, f"s-{index:02d}", "scrape_work", revision_id, work_id,
                        result_json=_reason({"reason_codes": ["no_candidates"]}))

    runner = _new_runner(database)
    assert runner.schedule_recovery() == 10
    # 已达上限：相同状态下不再补排，避免越过未执行批次。
    assert runner.schedule_recovery() == 0

    with database.connect() as conn:
        conn.execute("UPDATE jobs SET status='succeeded' WHERE job_type='recover_work_aliases'")
    assert runner.schedule_recovery() == 10
    with database.connect() as conn:
        conn.execute("UPDATE jobs SET status='succeeded' WHERE job_type='recover_work_aliases'")
    assert runner.schedule_recovery() == 5
    assert len(_recovery_revisions(database)) == total


def test_recovery_candidates_match_legacy_shape_on_large_history(tmp_path):
    """历史规模下候选行与顺序不变，且工作量低于原相关子查询形态。"""

    database = V4Database(tmp_path / "scale.db")
    database.initialize()
    revisions = 1500
    with database.connect() as conn:
        for index in range(revisions):
            revision_id = f"rev-{index:05d}"
            work_id = f"work-{index:05d}"
            root_id = f"root-{index:05d}"
            scan_id = f"scan-{index:05d}"
            _insert_root(conn, root_id)
            _insert_scan(conn, scan_id, root_id)
            _insert_revision(conn, revision_id, root_id, scan_id)
            _insert_work(conn, work_id)
            # 每条 revision 三条历史作业，模拟只增不减的 jobs 表。
            _insert_job(conn, f"m-{index:05d}", "materialize_mirror", revision_id, work_id)
            _insert_job(
                conn, f"s-{index:05d}", "scrape_work", revision_id, work_id,
                result_json=_reason({"reason_codes": ["no_candidates"]}),
            )
            _insert_job(
                conn, f"r-{index:05d}", "recover_work_aliases", revision_id, work_id,
                idempotency_key=f"recover_work_aliases:{revision_id}:{work_id}:0",
            )

    with database.connect() as conn:
        legacy_rows = [tuple(row) for row in conn.execute(_LEGACY_CANDIDATE_SQL)]
        optimized_rows = [tuple(row) for row in conn.execute(V4JobRunner._RECOVERY_CANDIDATE_SQL)]
        # 新形态只取调度消费的四个字段，比较候选标识与顺序。
        projected = [
            (row["revision_id"], row["work_id"], row["attempts"])
            for row in conn.execute(V4JobRunner._RECOVERY_CANDIDATE_SQL)
        ]
        legacy_projected = [(row[2], row[3], row[6]) for row in legacy_rows]
        assert projected == legacy_projected
        assert len(projected) == revisions

        legacy_steps = _vm_steps(conn, _LEGACY_CANDIDATE_SQL)
        optimized_steps = _vm_steps(conn, V4JobRunner._RECOVERY_CANDIDATE_SQL)

    # 宽松相对阈值：形状优化后不应对每个候选行重复相关检查。
    assert optimized_steps < legacy_steps
    assert len(optimized_rows) == revisions

    # 全部候选已有幂等键：调度零创建且不抛错，重复调用稳定。
    runner = _new_runner(database)
    assert runner.schedule_recovery() == 0
    assert runner.schedule_recovery() == 0
    assert len(_recovery_revisions(database)) == revisions
    assert _pending_jobs(database) == 0


def _vm_steps(connection, sql: str, *, every: int = 1000) -> int:
    """统计一条查询的 SQLite 虚拟机步进批次，用于机器无关的工作量对照。"""

    steps = 0

    def handler() -> int:
        nonlocal steps
        steps += 1
        return 0

    connection.set_progress_handler(handler, every)
    try:
        connection.execute(sql).fetchall()
    finally:
        connection.set_progress_handler(None, 0)
    return steps
