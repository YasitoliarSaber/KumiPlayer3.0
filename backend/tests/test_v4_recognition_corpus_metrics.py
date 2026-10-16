"""验证真实语料工具只读，且不会漏算错绑或把缺少答案算成满分。"""

import hashlib
import importlib.util
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[1] / "tools/recognition_corpus.py"
_SPEC = importlib.util.spec_from_file_location("recognition_corpus", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
corpus = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(corpus)


def test_wrong_adoptions_are_in_precision_denominator_and_count_as_missed_identity():
    metrics = corpus.identity_metrics([
        {"expected_provider_id": "a", "predicted_provider_id": "a", "candidate_ids": ["a"]},
        {"expected_provider_id": "b", "predicted_provider_id": "wrong", "candidate_ids": ["b", "wrong"]},
        {"expected_provider_id": None, "predicted_provider_id": "wrong"},
        {"predicted_provider_id": "unlabelled"},
    ])
    assert metrics["auto_adopt_precision"] == pytest.approx(1 / 3)
    assert metrics["identity_recall"] == 0.5
    assert metrics["candidate_recall"] == 1.0
    assert metrics["false_negative_rate"] == 0.5
    assert metrics["false_positive_rate"] == 1.0
    assert metrics["wrong_adoptions"] == 2
    assert metrics["unlabelled_cases"] == 1


def test_unknown_truth_and_zero_adoptions_do_not_report_perfect_precision():
    assert corpus.identity_metrics([{}])["auto_adopt_precision"] is None
    assert corpus.identity_metrics([{}])["identity_recall"] is None
    assert corpus.identity_metrics([{"expected_provider_id": "a"}])["auto_adopt_precision"] is None


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
