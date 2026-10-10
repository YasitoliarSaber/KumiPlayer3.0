"""Repeated provider/service normalization must retain mapping evidence."""

from copy import deepcopy

import pytest
from app.media_v4.jobs.metadata import finalize_metadata_statuses


def test_finalization_preserves_transient_mapping_failure_diagnostics():
    target = {"episodes": [{
        "episode_id": "episode-1", "episode_kind": "regular", "season_kind": "regular",
        "local_season_number": 1, "local_episode_number": 1,
    }]}
    result = {
        "metadata_state": "ready", "provider": "tmdb", "provider_id": "95213",
        "episode_mappings": [], "retryable": True,
        "_mapping_diagnostics": {
            "unmapped_reasons": [{"episode_id": "episode-1", "reason": "provider_unavailable"}],
            "mapping_conflicts": [], "mapping_basis_counts": {"local_number": 1},
        },
    }
    before = deepcopy(result)
    once = finalize_metadata_statuses(target, result)
    twice = finalize_metadata_statuses(target, once)

    assert result == before
    assert twice == once
    assert twice["unmapped_reason_codes"] == ["provider_unavailable"]
    assert twice["mapping_basis_counts"] == {"local_number": 1}
    assert twice["retryable"] is True


def test_finalization_recounts_members_and_discards_stale_diagnostics():
    target = {"episodes": [{
        "episode_id": "new", "episode_kind": "regular", "season_kind": "regular",
        "local_season_number": 1, "local_episode_number": 2,
    }]}
    result = {
        "metadata_state": "ready", "provider": "tmdb", "provider_id": "95213",
        "episode_mappings": [],
        "unmapped_reasons": [{"episode_id": "old", "reason": "provider_unavailable"}],
        "mapping_conflicts": [{"episode_id": "old", "reason": "numbering_conflict"}],
    }

    normalized = finalize_metadata_statuses(target, result)

    assert normalized["total_count"] == 1
    assert normalized["unmapped_episode_ids"] == ["new"]
    assert all(item["episode_id"] == "new" for item in normalized["unmapped_reasons"])
    assert normalized["mapping_conflicts"] == []


@pytest.mark.parametrize("failure_stage", ["episode_mapping", "season_detail"])
def test_completed_mapping_clears_only_resolved_mapping_failure(failure_stage):
    target = {"episodes": [{
        "episode_id": "episode-1", "episode_kind": "regular", "season_kind": "regular",
        "local_season_number": 1, "local_episode_number": 1,
    }]}
    result = {
        "metadata_state": "ready", "provider": "tmdb", "provider_id": "95213",
        "identity_status": "confirmed", "work_metadata_status": "ready",
        "reason_code": "episode_mapping_incomplete", "failure_stage": failure_stage,
        "reason": "old mapping failure", "refresh_status": "partial",
        "refresh_reason_code": "episode_mapping_incomplete", "metadata_warning": "old missing episode",
        "episode_mappings": [{"episode_id": "episode-1", "provider_episode_id": "1977227",
                              "title": "Episode title", "still_url": "https://image.tmdb.org/t/p/original/image.jpg"}],
    }

    complete = finalize_metadata_statuses(target, result)

    assert complete["episode_mapping_status"] == "complete"
    assert complete["reason_code"] == complete["failure_stage"] == complete["refresh_reason_code"] == ""
    assert not complete.get("metadata_warning")
    assert complete["refresh_status"] == "succeeded"
    unrelated = {**result, "reason_code": "work_identity_conflict", "failure_stage": "identity",
                 "refresh_status": "failed", "refresh_reason_code": "work_identity_conflict"}
    preserved = finalize_metadata_statuses(target, unrelated)
    assert preserved["reason_code"] == "work_identity_conflict"
    assert preserved["failure_stage"] == "identity"
    assert preserved["refresh_status"] == "failed"


def test_finalization_preserves_explicit_out_of_scope_mapping():
    target = {"episodes": [{
        "episode_id": "episode-1", "episode_kind": "regular", "season_kind": "regular",
        "local_season_number": 1, "local_episode_number": 1,
    }]}
    result = {"metadata_state": "waiting_review", "provider": "local",
              "episode_mappings": [], "_mapping_scope": False}

    once = finalize_metadata_statuses(target, result)
    twice = finalize_metadata_statuses(target, once)

    assert twice == once
    assert twice["episode_mapping_status"] == "not_applicable"
    assert twice["total_count"] == 0
    unknown = finalize_metadata_statuses(target, {"metadata_state": "waiting_review"})
    assert unknown["total_count"] == 1
    assert unknown["episode_mapping_status"] == "unmapped"
    empty_ready = finalize_metadata_statuses({"episodes": []}, {
        "metadata_state": "ready", "provider": "tmdb", "provider_id": "95213",
    })
    added_members = finalize_metadata_statuses(target, empty_ready)
    assert added_members["total_count"] == 1
    assert added_members["episode_mapping_status"] == "unmapped"
