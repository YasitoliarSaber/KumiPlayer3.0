import pytest

from app.media_v4.revisions.service import metadata_recovery_policy


def test_empty_candidates_are_not_described_as_multiple_matches_or_a_blocker():
    result = metadata_recovery_policy({"metadata_state": "waiting_review", "reason_code": "no_candidates"})
    assert result["reason"] == "暂未找到对应的在线作品，已保留本地信息。可调整名称重新搜索，也可以稍后处理。"
    assert result["action"] == "choose_candidate"


def test_ambiguous_candidates_keep_optional_recovery():
    result = metadata_recovery_policy({"metadata_state": "waiting_review", "reason_code": "ambiguous_candidates"})
    assert "已保留本地信息" in result["reason"]
    assert "后继续" not in result["reason"]
    assert result["action"] == "choose_candidate"


def test_confirmed_identity_is_retained_when_detail_request_fails():
    result = metadata_recovery_policy({
        "metadata_state": "source_unavailable", "identity_status": "confirmed",
        "failure_stage": "work_detail", "reason_code": "provider_unavailable",
        "reason": "SECRET: low-level exception",
    })
    assert result["reason"] == "已识别作品，但在线资料暂时获取失败；可以稍后重试。"
    assert result["action"] == "retry_metadata"


def test_authorization_error_is_not_hidden_by_confirmed_identity():
    result = metadata_recovery_policy({
        "metadata_state": "source_unavailable", "identity_status": "confirmed",
        "failure_stage": "work_detail", "reason_code": "provider_auth_required",
    })
    assert result["action"] == "check_settings"
    assert "授权" in result["reason"]


@pytest.mark.parametrize('content_scope', ['ongoing', 'completed'])
@pytest.mark.parametrize('season_code', ['episode_not_found', 'provider_unavailable'])
def test_confirmed_local_coordinates_make_partial_episode_details_optional(content_scope, season_code):
    from app.media_v4.jobs.metadata_quality import require_regular_episode_metadata

    legacy = {
        'metadata_state': 'failed', 'identity_status': 'confirmed', 'work_metadata_status': 'ready',
        'provider': 'tmdb', 'provider_id': '42', 'reason_code': 'episode_mapping_incomplete',
        'reason': '正片尚未全部匹配在线分集资料', 'content_scope': content_scope,
        'episode_mappings': [{'episode_id': 'e1', 'still_url': 'https://image.tmdb.org/t/p/w500/e1.jpg'}],
        'unmapped_reasons': [{'episode_id': 'e1', 'reason': 'provider_unavailable'}],
        'season_results': [{'local_season_number': 1, 'reason_code': season_code, 'status': 'partial'}],
    }
    normalized = require_regular_episode_metadata([
        {'episode_id': 'e1', 'local_season_number': 1, 'local_episode_number': 1},
    ], legacy)
    assert normalized['metadata_state'] == 'ready'
    assert metadata_recovery_policy(normalized, binding_status='failed') == {
        'reason': '', 'action': 'none', 'hint': '',
    }
    assert legacy['metadata_state'] == 'failed'


def test_database_write_contention_has_a_specific_safe_error_message():
    from app.media_v4.revisions.service import _friendly_job_error

    message = _friendly_job_error('database is locked')
    assert '媒体库正在写入' in message
    assert '数据库' not in message
