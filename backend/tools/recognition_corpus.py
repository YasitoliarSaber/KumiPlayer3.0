"""只读提取真实 V4 识别语料；生产记录与独立正确答案分开保存。

例：python backend/tools/recognition_corpus.py --database <数据库> --output <本地分析目录>
可选 --labels 指向以 evidence_id 为键的人工/独立核验标签。没有标签的指标为 null，
不会把已入库或自动采用直接计为正确。输出含相对媒体目录，仅供本地分析。
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


def identity_metrics(samples: list[dict]) -> dict:
    """按独立标签计数；错误身份同时损害 precision 和正确身份的 recall。"""

    labelled = [s for s in samples if "expected_provider_id" in s]
    positives = [s for s in labelled if s["expected_provider_id"] is not None]
    adopted = [s for s in labelled if s.get("predicted_provider_id")]
    correct = sum(
        s.get("predicted_provider_id") == s["expected_provider_id"]
        and s["expected_provider_id"] is not None
        for s in labelled
    )
    retrieved = sum(s["expected_provider_id"] in s.get("candidate_ids", []) for s in positives)
    reviews = [s for s in labelled if s["expected_provider_id"] is None]

    def rate(numerator: int, denominator: int) -> float | None:
        return numerator / denominator if denominator else None

    return {
        "labelled_cases": len(labelled), "unlabelled_cases": len(samples) - len(labelled),
        "correct_adoptions": correct, "wrong_adoptions": len(adopted) - correct,
        "auto_adopt_precision": rate(correct, len(adopted)),
        "identity_recall": rate(correct, len(positives)),
        "candidate_recall": rate(retrieved, len(positives)),
        "false_negative_rate": rate(len(positives) - correct, len(positives)),
        "false_positive_rate": rate(sum(bool(s.get("predicted_provider_id")) for s in reviews), len(reviews)),
        "ambiguous_rate": rate(sum(not s.get("predicted_provider_id") for s in labelled), len(labelled)),
    }


def _hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def extract_corpus(database: Path, output: Path, labels: dict | None = None) -> dict:
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
        facts = {r["evidence_id"]: r for r in conn.execute("SELECT * FROM parsed_facts")}
        work_by_id = {r["work_id"]: dict(r) for r in conn.execute("SELECT * FROM works")}
        metadata = {}
        identity_samples = {}
        status_counts: Counter = Counter()
        failure_counts: Counter = Counter()
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
            identity_samples[(row["revision_id"], row["work_id"])] = {
                "predicted_provider_id": (
                    f"{row['provider']}:{payload.get('media_type', '')}:{row['provider_id']}"
                    if row["provider_id"] and row["provider"] != "local" else None
                ),
                "candidate_ids": [
                    f"{c.get('provider', '')}:{c.get('media_type', '')}:{c.get('provider_id', '')}"
                    for c in candidates
                ],
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
        before_correct = sum(all(case["parsed_facts"].get(key) == value for key, value in case["expected_parsed"].items())
                             for case in parsed_labels)
        after_correct = sum(all(case["current_parsed_facts"].get(key) == value for key, value in case["expected_parsed"].items())
                            for case in parsed_labels)
        summary = {
            "source_evidence_count": len(evidence_rows), "case_count": len(cases), "work_count": len(work_by_id),
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
            "parser_metrics": {
                "labelled_cases": len(parsed_labels), "before_correct": before_correct, "after_correct": after_correct,
                "before_accuracy": before_correct / len(parsed_labels) if parsed_labels else None,
                "after_accuracy": after_correct / len(parsed_labels) if parsed_labels else None,
            },
            "metrics_note": "仅对附 correction_source 的独立 Provider 标签计分；未标注的已确认记录仅作兼容性参考",
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
    args = cli.parse_args()
    labels = json.loads(args.labels.read_text(encoding="utf-8")) if args.labels else None
    print(json.dumps(extract_corpus(args.database, args.output, labels), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
