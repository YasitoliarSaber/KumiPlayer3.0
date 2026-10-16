"""只读提取真实 V4 识别语料；生产记录与独立正确答案分开保存。

例：python backend/tools/recognition_corpus.py --database <数据库> --output <本地分析目录>
可选 --labels 指向以 evidence_id 为键的人工/独立核验标签。没有标签的指标为 null，
不会把已入库或自动采用直接计为正确。输出含相对媒体目录，仅供本地分析。

事实基线只能有一个：默认取 `revision_evidence` 指向的 `parsed_fact_id`，
或用 `--parser-version` 显式固定；同时存在多版本且无唯一指向时拒绝计分，
不会按 SQL 遍历顺序让后读到的行覆盖前一行。身份指标只对"确有机器自动决定
证据"且附独立标签的样本计算自动精度——人工最终选择、复用旧绑定和来源不明
都不进入自动分母。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, replace
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.media_v4.parsing.parser import V4Parser
from app.media_v4.persistence.repositories import V4Repository

_PARSE_FIELDS = (
    "work_title", "media_type", "content_class", "is_importable", "is_auxiliary",
    "season_candidate", "episode_candidate", "absolute_episode_candidate", "episode_range",
)

#: 机器/人工决定来源。只有机器自动决定计入自动精度；复用旧绑定与来源不明都不算。
DECISION_MACHINE_AUTO = "machine_auto"
DECISION_MACHINE_REVIEW = "machine_review"
DECISION_MACHINE_NO_CANDIDATE = "machine_no_candidate"
DECISION_MACHINE_BINDING_REUSE = "machine_binding_reuse"
DECISION_MANUAL = "manual"
DECISION_UNKNOWN = "unknown"

DECISION_SOURCES = (
    DECISION_MACHINE_AUTO, DECISION_MACHINE_REVIEW, DECISION_MACHINE_NO_CANDIDATE,
    DECISION_MACHINE_BINDING_REUSE, DECISION_MANUAL, DECISION_UNKNOWN,
)


def decision_source(candidate_decision: dict | None, candidate_count: int) -> str:
    """把已保存的候选决定翻译成口径可核验的来源，不能从"已有绑定"倒推。"""

    kind = str((candidate_decision or {}).get("decision") or "").strip()
    if kind == "auto_adopted":
        return DECISION_MACHINE_AUTO
    if kind == "trusted_binding":
        return DECISION_MACHINE_BINDING_REUSE
    if kind == "waiting_review":
        return DECISION_MACHINE_NO_CANDIDATE if not candidate_count else DECISION_MACHINE_REVIEW
    return DECISION_UNKNOWN


def identity_metrics(samples: list[dict]) -> dict:
    """按独立标签计数；错误身份同时损害 precision 和正确身份的 recall。

    口径（第二阶段决策固定，不得在实施中放松）：

    - 自动精度只统计**确有机器自动决定证据**的样本。人工最终选择、复用旧绑定、
      来源不明都不进入自动分母，因此手工样本无法把 auto precision 抬到 1。
    - 错误的自动采用留在自动分母里，同时损害正确身份召回；没有独立标签时
      自动精度为 null，而不是 0 或满分。
    - 缺候选（没有候选可言）与候选被拒（有候选但未采用）分开统计，
      REVIEW 与 UNRESOLVED 也分开，不能都叫 ambiguous。
    """

    labelled = [s for s in samples if "expected_provider_id" in s]
    positives = [s for s in labelled if s["expected_provider_id"] is not None]
    adopted = [s for s in labelled if s.get("predicted_provider_id")]
    auto = [s for s in labelled if s.get("decision_source") == DECISION_MACHINE_AUTO]
    auto_adopted = [s for s in auto if s.get("predicted_provider_id")]
    correct = sum(
        s.get("predicted_provider_id") == s["expected_provider_id"]
        and s["expected_provider_id"] is not None
        for s in labelled
    )
    auto_correct = sum(
        s.get("predicted_provider_id") == s["expected_provider_id"]
        and s["expected_provider_id"] is not None
        for s in auto_adopted
    )
    retrieved = sum(s["expected_provider_id"] in s.get("candidate_ids", []) for s in positives)
    reviews = [s for s in labelled if s["expected_provider_id"] is None]

    def rate(numerator: int, denominator: int) -> float | None:
        return numerator / denominator if denominator else None

    def count(source: str) -> int:
        # 决定来源分布统计全部单元：历史元数据缺少决定来源时必须显示为 unknown。
        return sum(s.get("decision_source") == source for s in samples)

    known_sources = set(DECISION_SOURCES) - {DECISION_UNKNOWN}

    return {
        "labelled_cases": len(labelled), "unlabelled_cases": len(samples) - len(labelled),
        "correct_adoptions": correct, "wrong_adoptions": len(adopted) - correct,
        "auto_adopt_precision": rate(auto_correct, len(auto_adopted)),
        "auto_adopted_correct": auto_correct,
        "auto_adopted_wrong": len(auto_adopted) - auto_correct,
        "machine_auto_decisions": count(DECISION_MACHINE_AUTO),
        "machine_review_decisions": count(DECISION_MACHINE_REVIEW),
        "machine_no_candidate_decisions": count(DECISION_MACHINE_NO_CANDIDATE),
        "machine_binding_reuse_decisions": count(DECISION_MACHINE_BINDING_REUSE),
        "manual_decisions": count(DECISION_MANUAL),
        # 没有决定来源（含历史元数据缺少 candidate_decision）一律记 unknown，
        # 不推断成机器自动决定。
        "unknown_decision_source": sum(s.get("decision_source") not in known_sources for s in samples),
        "identity_recall": rate(correct, len(positives)),
        "candidate_recall": rate(retrieved, len(positives)),
        "false_negative_rate": rate(len(positives) - correct, len(positives)),
        "false_positive_rate": rate(sum(bool(s.get("predicted_provider_id")) for s in reviews), len(reviews)),
        "review_rate": rate(sum(s.get("decision_source") == DECISION_MACHINE_REVIEW for s in labelled), len(labelled)),
        "unresolved_rate": rate(sum(s.get("decision_source") == DECISION_MACHINE_NO_CANDIDATE for s in labelled), len(labelled)),
        "not_adopted_rate": rate(sum(not s.get("predicted_provider_id") for s in labelled), len(labelled)),
    }


def _hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _select_fact_baseline(
    conn: sqlite3.Connection, parser_version: str | None
) -> tuple[dict[str, sqlite3.Row], dict]:
    """选择唯一的已存事实基线；多版本且无唯一指向时拒绝计分。

    基线只能由 ``revision_evidence`` 指向的 ``parsed_fact_id`` 决定，或由显式
    指定的 Parser 版本决定。绝不按 SQL 遍历顺序用"后读到的行"覆盖前一行。
    """

    versions: dict[str, list[sqlite3.Row]] = defaultdict(list)
    by_fact_id: dict[str, sqlite3.Row] = {}
    for row in conn.execute("SELECT * FROM parsed_facts"):
        versions[row["evidence_id"]].append(row)
        by_fact_id[row["parsed_fact_id"]] = row
    referenced: dict[str, str] = {}
    conflicts: list[str] = []
    for row in conn.execute("SELECT evidence_id,parsed_fact_id FROM revision_evidence"):
        evidence_id, fact_id = row["evidence_id"], row["parsed_fact_id"]
        if fact_id not in by_fact_id:
            continue
        if evidence_id in referenced and referenced[evidence_id] != fact_id:
            conflicts.append(evidence_id)
        referenced.setdefault(evidence_id, fact_id)
    if conflicts and parser_version is None:
        raise ValueError(
            "同一 Evidence 被不同 revision 指向了不同 ParsedFacts，没有唯一事实基线"
            f"（{len(conflicts)} 条），拒绝计分"
        )
    baseline: dict[str, sqlite3.Row] = {}
    ambiguous: list[str] = []
    missing: list[str] = []
    unreferenced_single = 0
    for evidence_id, rows in versions.items():
        if parser_version is not None:
            chosen = [row for row in rows if row["parser_version"] == parser_version]
            if len(chosen) != 1:
                missing.append(evidence_id)
                continue
            baseline[evidence_id] = chosen[0]
            continue
        fact_id = referenced.get(evidence_id)
        if fact_id is not None:
            baseline[evidence_id] = by_fact_id[fact_id]
            continue
        if len(rows) == 1:
            baseline[evidence_id] = rows[0]
            unreferenced_single += 1
            continue
        ambiguous.append(evidence_id)
    if missing:
        raise ValueError(
            f"显式 Parser 版本 {parser_version} 未覆盖 {len(missing)} 条 Evidence，拒绝计分"
        )
    if ambiguous:
        raise ValueError(
            f"{len(ambiguous)} 条 Evidence 同时存有多个版本且无 revision 指向，无法确定基线，拒绝计分"
        )
    info = {
        "mode": "parser_version" if parser_version is not None else "revision_evidence",
        "parser_version": parser_version or "",
        "parser_versions": dict(Counter(row["parser_version"] for row in baseline.values())),
        "selected_facts": len(baseline),
        "evidence_with_multiple_stored_versions": sum(len(rows) > 1 for rows in versions.values()),
        "unreferenced_single_version_facts": unreferenced_single,
        "note": "基线由 revision_evidence 指向的 parsed_fact_id 或显式 Parser 版本决定；多版本且无唯一指向时拒绝计分",
    }
    return baseline, info


def extract_corpus(
    database: Path, output: Path, labels: dict | None = None, *,
    parser_version: str | None = None,
) -> dict:
    database, output = database.resolve(strict=True), output.resolve()
    if output.is_relative_to(database.parent):
        raise ValueError("分析输出不得写入生产数据目录")
    labels = labels or {}
    before = _hash(database)
    conn = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    try:
        roots = {r["root_id"]: dict(r) for r in conn.execute("SELECT * FROM source_roots")}
        facts, fact_baseline = _select_fact_baseline(conn, parser_version)
        work_by_id = {r["work_id"]: dict(r) for r in conn.execute("SELECT * FROM works")}
        metadata = {}
        identity_samples = {}
        status_counts: Counter = Counter()
        failure_counts: Counter = Counter()
        human_choices: dict[tuple[str, str], dict] = {}
        for row in conn.execute("SELECT work_id,override_json FROM work_overrides"):
            payload = json.loads(row["override_json"] or "{}")
            provider = str(payload.get("provider") or "").strip()
            provider_id = str(payload.get("provider_id") or "").strip()
            if provider and provider_id:
                human_choices[row["work_id"]] = {
                    "provider": provider, "provider_id": provider_id,
                    "source": "work_override",
                }
        history = defaultdict(list)
        for row in conn.execute("SELECT * FROM scrape_bindings ORDER BY updated_at,binding_id"):
            payload = json.loads(row["metadata_json"])
            metadata[(row["revision_id"], row["work_id"])] = {**dict(row), "metadata": payload}
            history[(row["revision_id"], row["work_id"])].append({
                "status": row["status"], "provider": row["provider"], "provider_id": row["provider_id"],
                "updated_at": row["updated_at"], "reason_code": payload.get("reason_code"),
            })
            decision = payload.get("candidate_decision") or {}
            candidates = decision.get("ranked_candidates") or payload.get("candidates") or []
            human_choice = human_choices.get(row["work_id"])
            identity_samples[(row["revision_id"], row["work_id"])] = {
                # 类型化身份与修订一起保存；同数字 ID 或历史修订不能混算。
                "revision_id": row["revision_id"], "work_id": row["work_id"],
                "provider": row["provider"], "media_type": payload.get("media_type", ""),
                "provider_id": row["provider_id"],
                "predicted_provider_id": (
                    f"{row['provider']}:{payload.get('media_type', '')}:{row['provider_id']}"
                    if row["provider_id"] and row["provider"] != "local" else None
                ),
                "candidate_ids": [
                    f"{c.get('provider', '')}:{c.get('media_type', '')}:{c.get('provider_id', '')}"
                    for c in candidates
                ],
                "candidate_count": len(candidates),
                # 原始机器决定、人工最终选择分别保存；来源不明保持 unknown，
                # 不能从"已有绑定"倒推成机器自动决定。
                "decision_source": decision_source(decision, len(candidates)),
                "machine_decision": {
                    "decision": str(decision.get("decision") or ""),
                    "selected_provider_id": str(decision.get("selected_provider_id") or ""),
                    "reason": str(decision.get("reason") or ""),
                } if decision else None,
                "human_choice": human_choice,
                "member_episode_count": 0,
            }
            status_counts[row["status"]] += 1
        for item in metadata.values():
            if item["status"] != "confirmed":
                failure_counts[item["metadata"].get("reason_code") or "unrecorded"] += 1
        assignments = defaultdict(list)
        for row in conn.execute(
            "SELECT rb.*,s.local_season_number,e.local_episode_number FROM revision_bindings rb "
            "LEFT JOIN episodes e ON e.episode_id=rb.episode_id "
            "LEFT JOIN seasons s ON s.season_id=e.season_id"
        ):
            assignments[row["evidence_id"]].append(dict(row))
        members: dict[tuple[str, str], set[str]] = defaultdict(set)
        seasons: dict[tuple[str, str], set[int]] = defaultdict(set)
        for row in conn.execute(
            "SELECT rb.revision_id,rb.work_id,rb.episode_id,s.local_season_number FROM revision_bindings rb "
            "LEFT JOIN episodes e ON e.episode_id=rb.episode_id "
            "LEFT JOIN seasons s ON s.season_id=e.season_id WHERE rb.episode_id IS NOT NULL"
        ):
            members[(row["revision_id"], row["work_id"])].add(str(row["episode_id"]))
            if row["local_season_number"] is not None:
                seasons[(row["revision_id"], row["work_id"])].add(int(row["local_season_number"]))
        for key, sample in identity_samples.items():
            # 成员范围与本地季号同身份一起保存，避免只看标题聚合。
            sample["member_episode_count"] = len(members.get(key, ()))
            sample["local_seasons"] = sorted(seasons.get(key, ()))
        directory_context = defaultdict(list)
        evidence_rows = list(conn.execute("SELECT * FROM source_evidence ORDER BY evidence_id"))
        for row in evidence_rows:
            directory_context[(row["root_id"], str(PurePosixPath(row["relative_path"]).parent))].append(row["relative_path"])
        contexts = {key: f"directory_{index}" for index, key in enumerate(sorted(directory_context))}
        parser = V4Parser()
        cases = []
        for row in evidence_rows:
            evidence = replace(V4Repository._row_to_source_evidence(row), source_locator="", playback_locator="")
            old_row = facts.get(evidence.evidence_id)
            if old_row is None:
                continue
            old = V4Repository._row_to_parsed_facts(old_row)
            # NFO 的正文不在数据库；不能重放时静默打开真实源文件。
            replayable = evidence.entry_kind != "metadata" and PurePosixPath(evidence.relative_path).suffix.casefold() != ".nfo"
            current = parser.parse(evidence, root_container=roots[evidence.root_id]["root_container"]) if replayable else None
            bindings = assignments[evidence.evidence_id]
            downstream = []
            for binding in bindings:
                saved = metadata.get((binding["revision_id"], binding["work_id"]))
                payload = saved["metadata"] if saved else {}
                decision = payload.get("candidate_decision") or {}
                downstream.append({
                    "work": work_by_id[binding["work_id"]]["preferred_title"],
                    "season": binding["local_season_number"], "episode": binding["local_episode_number"],
                    "decision_source": binding["decision_source"],
                    "metadata_status": saved["status"] if saved else "not_recorded",
                    "reason_code": payload.get("reason_code"), "recorded_failure_stage": payload.get("failure_stage"),
                    "candidate_decision": decision, "candidates": payload.get("candidates") or decision.get("ranked_candidates") or [],
                    "selected_candidate": {"provider": saved["provider"], "provider_id": saved["provider_id"]} if saved else None,
                })
            parent = str(PurePosixPath(evidence.relative_path).parent)
            case = {
                "case_id": evidence.evidence_id, "source": evidence.ingest_method,
                "original_path": evidence.relative_path, "filename": PurePosixPath(evidence.relative_path).name,
                "parent_folder": parent, "directory_context": contexts[(evidence.root_id, parent)],
                "parsed_facts": {field: getattr(old, field) for field in _PARSE_FIELDS},
                "current_parsed_facts": {field: getattr(current, field) for field in _PARSE_FIELDS} if current else None,
                "decision_trace": [asdict(trace) for trace in current.decision_trace] if current else [],
                "classification": old.content_class, "confirmed_results": downstream,
                "expected_work": None, "expected_season": None, "expected_episode": None,
                "expected_type": None, "expected_provider": None,
                "failure_stage": None, "failure_reason": None, "severity": None,
                "correction_source": "unlabelled", "reproducible": replayable,
                "evidence": ["source_evidence", "parsed_facts", "revision_bindings", "scrape_bindings"],
            }
            label = labels.get(evidence.evidence_id)
            if label:
                if not label.get("correction_source"):
                    raise ValueError("正确答案标签必须提供 correction_source")
                for key in ("expected_work", "expected_season", "expected_episode", "expected_type", "expected_provider", "failure_stage", "failure_reason", "severity", "correction_source"):
                    if key in label:
                        case[key] = label[key]
                if "expected_parsed" in label:
                    case["expected_parsed"] = label["expected_parsed"]
                expected = label.get("expected_provider")
                if expected is not None or label.get("expected_decision") == "review":
                    expected_key = (
                        f"{expected['provider']}:{expected['media_type']}:{expected['provider_id']}"
                        if expected is not None else None
                    )
                    for binding in bindings:
                        sample = identity_samples.get((binding["revision_id"], binding["work_id"]))
                        if sample is not None:
                            if "expected_provider_id" in sample and sample["expected_provider_id"] != expected_key:
                                raise ValueError("同一已确认 Work 的正确答案标签冲突")
                            sample["expected_provider_id"] = expected_key
            cases.append(case)
        jobs = [dict(row) for row in conn.execute("SELECT job_type,status,attempts,result_json FROM jobs")]
        metrics = identity_metrics(list(identity_samples.values()))
        parsed_labels = [case for case in cases if case.get("expected_parsed") and case["reproducible"]]
        before_correct = sum(all((case.get("parsed_facts") or {}).get(key) == value
                                 for key, value in case["expected_parsed"].items())
                             for case in parsed_labels)
        after_correct = sum(all((case.get("current_parsed_facts") or {}).get(key) == value
                                for key, value in case["expected_parsed"].items())
                            for case in parsed_labels)
        summary = {
            "source_evidence_count": len(evidence_rows), "case_count": len(cases), "work_count": len(work_by_id),
            "evidence_without_stored_facts": len(evidence_rows) - len(cases),
            "parser_version": parser.VERSION, "replayable_cases": sum(c["reproducible"] for c in cases),
            "parser_changed_cases": sum(c["current_parsed_facts"] != c["parsed_facts"] for c in cases if c["reproducible"]),
            "classification_counts": dict(Counter(c["classification"] for c in cases)),
            "scrape_status_counts": dict(Counter(item["status"] for item in metadata.values())),
            "scrape_observation_status_counts": dict(status_counts),
            "scrape_history_transitions": [
                {"work": work_by_id[key[1]]["preferred_title"], "observations": observations}
                for key, observations in history.items() if len(observations) > 1
            ],
            "failure_reason_counts": dict(failure_counts),
            "job_status_counts": dict(Counter(j["job_type"] + ":" + j["status"] for j in jobs)),
            "job_outcome_counts": dict(Counter(json.loads(j["result_json"]).get("outcome", "unrecorded") for j in jobs)),
            "identity_metrics": metrics,
            "fact_baseline": fact_baseline,
            "parser_metrics": {
                "labelled_cases": len(parsed_labels), "before_correct": before_correct, "after_correct": after_correct,
                "before_accuracy": before_correct / len(parsed_labels) if parsed_labels else None,
                "after_accuracy": after_correct / len(parsed_labels) if parsed_labels else None,
            },
            "metrics_note": (
                "自动精度只对确有机器自动决定证据（candidate_decision=auto_adopted）且附独立标签的样本计分；"
                "人工选择、复用旧绑定与来源不明都不进入自动分母。919 条标签只评价所标 Parser 字段，"
                "222 组历史候选档案只证明封闭候选行为，都不是全库身份真值。"
            ),
            "retry_recovery_rate": None, "retry_note": "当前表不保存逐次失败/成功转移，attempts 不能独立证明恢复率",
            "database_unchanged": before == _hash(database),
        }
    finally:
        conn.close()
    output.mkdir(parents=True, exist_ok=True)
    contexts_payload = {contexts[key]: {"parent_folder": key[1], "siblings": paths} for key, paths in directory_context.items()}
    for name, value in (("cases.json", cases), ("directory-context.json", contexts_payload), ("summary.json", summary)):
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--database", required=True, type=Path)
    cli.add_argument("--output", required=True, type=Path)
    cli.add_argument("--labels", type=Path)
    cli.add_argument(
        "--parser-version", dest="parser_version",
        help="显式固定已存事实基线；省略时按 revision_evidence 指向的 ParsedFacts 选择",
    )
    args = cli.parse_args()
    labels = json.loads(args.labels.read_text(encoding="utf-8")) if args.labels else None
    print(json.dumps(
        extract_corpus(args.database, args.output, labels, parser_version=args.parser_version),
        ensure_ascii=False, indent=2,
    ))


if __name__ == "__main__":
    main()
