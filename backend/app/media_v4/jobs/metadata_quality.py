"""本地正片编号与在线资料质量分离，不修改已确认媒体事实。"""
from __future__ import annotations


def require_regular_episode_metadata(episodes: list[dict], metadata: dict) -> dict:
    result = dict(metadata)
    regular = {str(item['episode_id']) for item in episodes
               if item.get('episode_id') and item.get('episode_kind', 'regular') not in {'special', 'auxiliary', 'movie'}
               and item.get('season_kind', 'regular') != 'special'}
    mappings = {str(item.get('episode_id')): item for item in result.get('episode_mappings') or []
                if isinstance(item, dict) and str(item.get('provider_episode_id') or '').strip()}
    missing = regular - mappings.keys()
    missing_titles = {key for key in regular & mappings.keys() if not str(mappings[key].get('title') or '').strip()}
    missing_stills = {key for key in regular & mappings.keys() if not str(mappings[key].get('still_url') or '').strip()}
    result.update(episode_metadata_status='incomplete' if missing or missing_titles or missing_stills else 'complete',
                  missing_episode_title_count=len(missing_titles), missing_episode_still_count=len(missing_stills))
    reasons = {str(item.get('episode_id')): str(item.get('reason') or '')
               for item in result.get('unmapped_reasons') or [] if isinstance(item, dict)}
    conflicts = {str(item.get('episode_id')) for item in result.get('mapping_conflicts') or []
                 if isinstance(item, dict)}
    unresolved = {'missing_local_number', 'unknown_local_season', 'insufficient_numbering_evidence',
                  'numbering_conflict', 'ambiguous_provider_child_scope', 'incomplete_provider_coordinates'}
    by_id = {str(item.get('episode_id')): item for item in episodes if isinstance(item, dict)}
    blocked = regular & conflicts | {key for key in missing if reasons.get(key) in unresolved
               or not _positive_coordinate(by_id[key].get('local_episode_number'))
               or not _positive_coordinate(by_id[key].get('local_season_number'))}
    result['episode_coordinate_status'] = 'needs_review' if blocked else 'confirmed'
    if (not blocked and result.get('metadata_state') == 'failed'
            and result.get('reason_code') in {'episode_mapping_incomplete', 'episode_details_incomplete'}
            and result.get('identity_status') == 'confirmed' and result.get('work_metadata_status') == 'ready'
            and str(result.get('provider_id') or '').strip()):
        # 旧门槛保存的失败状态按当前合同重评；不能恢复真实身份或编号冲突。
        result.update(metadata_state='ready', reason='', refresh_status='partial',
                      refresh_reason_code=result['reason_code'])
    if not (blocked or missing or missing_titles or missing_stills) or result.get('metadata_state') not in {'ready', 'confirmed'}:
        return result
    # 在线分集条目、标题或缩略图缺失是资料诊断；已明确的本地正片无需等待全集资料。
    if not blocked:
        if missing:
            result['metadata_warning'] = f'{len(missing)} 个本地正片尚无在线分集资料，保留本地编号，可正常浏览与播放。'
            if result.get('refresh_status') not in {'failed', 'cancelled', 'pending'}:
                result.update(refresh_status='partial', refresh_reason_code='episode_mapping_incomplete')
        return result
    code = 'episode_mapping_incomplete'
    reason = f'{len(blocked)} 个本地正片的分季或集号依据尚未确认，请核对编号对应关系。'
    result.update(
        metadata_state='failed', reason_code=code, reason=reason,
        failure_stage='episode_mapping', retryable=False, refresh_status='partial',
        refresh_reason_code=code,
    )
    result.pop('metadata_warning', None)
    return result


def _positive_coordinate(value) -> bool:
    try:
        number = int(value)
        return number > 0 and float(value) == number
    except (TypeError, ValueError, OverflowError):
        return False


def current_episode_metadata(conn, revision_id: str | None, work_id: str, metadata: dict,
                             episode_ids: set[str] | None = None) -> dict:
    episodes = [dict(row) for row in conn.execute(
        'SELECT DISTINCT e.episode_id,e.episode_kind,e.local_episode_number,s.local_season_number,s.season_kind FROM episodes e '
        'JOIN seasons s ON s.season_id=e.season_id '
        'JOIN revision_bindings rb ON rb.episode_id=e.episode_id '
        'JOIN import_revisions ir ON ir.revision_id=rb.revision_id '
        'JOIN source_roots sr ON sr.root_id=ir.root_id '
        "WHERE rb.work_id=? AND (? IS NULL OR rb.revision_id=?) AND ir.status='confirmed' AND sr.retired_at=''",
        (work_id, revision_id, revision_id),
    )]
    if episode_ids is not None:
        episodes = [item for item in episodes if str(item['episode_id']) in episode_ids]
    return require_regular_episode_metadata(episodes, metadata)
