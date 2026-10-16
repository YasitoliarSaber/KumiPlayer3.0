"""验证真实语料工具只读，且不会漏算错绑或把缺少答案算成满分。"""

import hashlib
import importlib.util
import sqlite3
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[1] / "tools/recognition_corpus.py"
_SPEC = importlib.util.spec_from_file_location("recognition_corpus", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
corpus = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(corpus)


def test_wrong_adoptions_are_in_precision_denominator_and_count_as_missed_identity():
    metrics = corpus.identity_metrics([
        {"expected_provider_id": "a", "predicted_provider_id": "a", "candidate_ids": ["a"],
         "decision_source": "machine_auto"},
        {"expected_provider_id": "b", "predicted_provider_id": "wrong", "candidate_ids": ["b", "wrong"],
         "decision_source": "machine_auto"},
        {"expected_provider_id": None, "predicted_provider_id": "wrong",
         "decision_source": "machine_auto"},
        {"predicted_provider_id": "unlabelled", "decision_source": "machine_auto"},
    ])
    assert metrics["auto_adopt_precision"] == pytest.approx(1 / 3)
    assert metrics["identity_recall"] == 0.5
    assert metrics["candidate_recall"] == 1.0
    assert metrics["false_negative_rate"] == 0.5
    assert metrics["false_positive_rate"] == 1.0
    assert metrics["wrong_adoptions"] == 2
    assert metrics["auto_adopted_wrong"] == 2
    assert metrics["unlabelled_cases"] == 1


def test_unknown_truth_and_zero_adoptions_do_not_report_perfect_precision():
    assert corpus.identity_metrics([{}])["auto_adopt_precision"] is None
    assert corpus.identity_metrics([{}])["identity_recall"] is None
    assert corpus.identity_metrics([{"expected_provider_id": "a"}])["auto_adopt_precision"] is None


def test_manual_or_unknown_decisions_never_count_as_auto_precision():
    """第一阶段实测：只给一条人工正确样本时，工具曾报 auto precision = 1。"""

    manual = corpus.identity_metrics([
        {"expected_provider_id": "tmdb:tv:42", "predicted_provider_id": "tmdb:tv:42",
         "candidate_ids": ["tmdb:tv:42"], "decision_source": "manual"},
    ])
    assert manual["auto_adopt_precision"] is None
    assert manual["manual_decisions"] == 1
    assert manual["machine_auto_decisions"] == 0

    unknown = corpus.identity_metrics([
        {"expected_provider_id": "tmdb:tv:42", "predicted_provider_id": "tmdb:tv:42"},
    ])
    assert unknown["auto_adopt_precision"] is None
    assert unknown["unknown_decision_source"] == 1

    reused = corpus.identity_metrics([
        {"expected_provider_id": "tmdb:tv:42", "predicted_provider_id": "tmdb:tv:42",
         "decision_source": "machine_binding_reuse"},
    ])
    assert reused["auto_adopt_precision"] is None
    assert reused["machine_binding_reuse_decisions"] == 1


def test_review_unresolved_and_missing_candidate_are_separate():
    metrics = corpus.identity_metrics([
        {"expected_provider_id": "a", "predicted_provider_id": None, "candidate_ids": ["a"],
         "decision_source": "machine_review"},
        {"expected_provider_id": "b", "predicted_provider_id": None, "candidate_ids": [],
         "decision_source": "machine_no_candidate"},
        {"expected_provider_id": "c", "predicted_provider_id": "c", "candidate_ids": ["c"],
         "decision_source": "machine_auto"},
    ])
    assert metrics["machine_review_decisions"] == 1
    assert metrics["machine_no_candidate_decisions"] == 1
    assert metrics["review_rate"] == pytest.approx(1 / 3)
    assert metrics["unresolved_rate"] == pytest.approx(1 / 3)
    assert metrics["not_adopted_rate"] == pytest.approx(2 / 3)
    assert metrics["auto_adopt_precision"] == 1.0


def test_decision_source_never_infers_auto_from_existing_binding():
    assert corpus.decision_source(None, 3) == "unknown"
    assert corpus.decision_source({"decision": "trusted_binding"}, 1) == "machine_binding_reuse"
    assert corpus.decision_source({"decision": "waiting_review"}, 0) == "machine_no_candidate"
    assert corpus.decision_source({"decision": "waiting_review"}, 2) == "machine_review"
    assert corpus.decision_source({"decision": "auto_adopted"}, 2) == "machine_auto"


def test_decision_source_distribution_covers_unlabelled_units():
    metrics = corpus.identity_metrics([
        {"predicted_provider_id": "tmdb:tv:1", "decision_source": "machine_auto"},
        {"predicted_provider_id": "tmdb:tv:2", "decision_source": "machine_auto"},
        {"predicted_provider_id": None, "decision_source": "machine_no_candidate"},
    ])

    assert metrics["labelled_cases"] == 0
    assert metrics["machine_auto_decisions"] == 2
    assert metrics["machine_no_candidate_decisions"] == 1
    assert metrics["auto_adopt_precision"] is None


def test_review_rates_use_only_the_labelled_population():
    metrics = corpus.identity_metrics([
        {"expected_provider_id": "a", "decision_source": "machine_review"},
        {"expected_provider_id": "b", "decision_source": "machine_no_candidate"},
        *({"decision_source": "machine_review"} for _ in range(4)),
        *({"decision_source": "machine_no_candidate"} for _ in range(4)),
    ])
    assert metrics["machine_review_decisions"] == 5
    assert metrics["machine_no_candidate_decisions"] == 5
    assert metrics["review_rate"] == 0.5
    assert metrics["unresolved_rate"] == 0.5


def _baseline_conn(facts, references=()):
    """最小夹具：只提供基线选择需要的事实与 revision 指向。"""

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE parsed_facts(parsed_fact_id TEXT PRIMARY KEY,evidence_id TEXT,"
                 "parser_version TEXT)")
    conn.execute("CREATE TABLE revision_evidence(revision_id TEXT,evidence_id TEXT,"
                 "parsed_fact_id TEXT)")
    conn.executemany("INSERT INTO parsed_facts VALUES (?,?,?)", facts)
    conn.executemany("INSERT INTO revision_evidence VALUES (?,?,?)", references)
    return conn


def test_fact_baseline_uses_revision_reference_not_sql_order():
    conn = _baseline_conn(
        [("f-late", "ev-1", "v4-parser-19"), ("f-ref", "ev-1", "v4-parser-18")],
        [("rev-1", "ev-1", "f-ref")],
    )
    baseline, info = corpus._select_fact_baseline(conn, None)

    assert baseline["ev-1"]["parsed_fact_id"] == "f-ref"
    assert info["mode"] == "revision_evidence"
    assert info["parser_versions"] == {"v4-parser-18": 1}
    assert info["evidence_with_multiple_stored_versions"] == 1


def test_fact_baseline_refuses_ambiguous_or_uncovered_versions():
    ambiguous = _baseline_conn([("f1", "ev-1", "v4-parser-18"), ("f2", "ev-1", "v4-parser-19")])
    with pytest.raises(ValueError, match="无法确定基线"):
        corpus._select_fact_baseline(ambiguous, None)

    conflicting = _baseline_conn(
        [("f1", "ev-1", "v4-parser-18"), ("f2", "ev-1", "v4-parser-19")],
        [("rev-1", "ev-1", "f1"), ("rev-2", "ev-1", "f2")],
    )
    with pytest.raises(ValueError, match="没有唯一事实基线"):
        corpus._select_fact_baseline(conflicting, None)

    missing = _baseline_conn([("f1", "ev-1", "v4-parser-18")], [("rev-1", "ev-1", "f1")])
    with pytest.raises(ValueError, match="未覆盖"):
        corpus._select_fact_baseline(missing, "v4-parser-19")


def test_fact_baseline_falls_back_to_single_unreferenced_version():
    conn = _baseline_conn([("f1", "ev-1", "v4-parser-18")])
    baseline, info = corpus._select_fact_baseline(conn, None)

    assert baseline["ev-1"]["parsed_fact_id"] == "f1"
    assert info["unreferenced_single_version_facts"] == 1


def test_explicit_parser_version_disambiguates_different_revision_references():
    conn = _baseline_conn(
        [("f1", "ev-1", "v4-parser-18"), ("f2", "ev-1", "v4-parser-19")],
        [("rev-1", "ev-1", "f1"), ("rev-2", "ev-1", "f2")],
    )
    baseline, info = corpus._select_fact_baseline(conn, "v4-parser-19")
    assert baseline["ev-1"]["parsed_fact_id"] == "f2"
    assert info["mode"] == "parser_version"


def test_export_opens_database_read_only_and_rejects_output_in_data_directory(tmp_path):
    from app.media_v4.persistence.database import V4Database

    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    path = data_dir / "fixture.db"
    database = V4Database(path)
    database.initialize()
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    summary = corpus.extract_corpus(path, tmp_path / "audit")
    assert summary["database_unchanged"]
    assert summary["identity_metrics"]["auto_adopt_precision"] is None
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    with pytest.raises(ValueError, match="生产数据目录"):
        corpus.extract_corpus(path, data_dir / "audit")
