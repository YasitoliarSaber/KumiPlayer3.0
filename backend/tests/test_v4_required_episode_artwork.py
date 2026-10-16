"""分集图片单独评估；图片缺项不使已确认作品资料失效。"""
import json

import pytest

from app.media_v4.jobs.metadata_quality import require_regular_episode_metadata
from app.media_v4.jobs.runner import V4JobRunner
from app.media_v4.persistence.database import V4Database
from app.media_v4.revisions.service import V4RevisionService, metadata_recovery_policy
from tests.test_v4_import_metadata_lifecycle import confirm, provider
from tests.test_v4_import_numbering_status import _episode, _install_client, _target


def _regular():
    return [{'episode_id': 'e1', 'local_season_number': 1, 'local_episode_number': 1}]


@pytest.mark.parametrize('mapped', [True, False])
def test_missing_local_regular_thumbnail_preserves_metadata_ready(mapped):
    metadata = {'metadata_state': 'ready', 'identity_status': 'confirmed', 'work_metadata_status': 'ready',
                'provider_id': '42', 'episode_mappings':
                [{'episode_id': 'e1', 'provider_episode_id': '101', 'title': 'E1'}] if mapped else []}
    result = require_regular_episode_metadata(_regular(), metadata)
    assert result['metadata_state'] == 'ready'
    assert result['episode_artwork_status'] == 'pending'
    assert result['episode_metadata_status'] == ('complete' if mapped else 'incomplete')
    assert result['missing_episode_still_count'] == 1
    assert metadata['metadata_state'] == 'ready'


def test_local_thumbnail_does_not_require_provider_full_season_or_episode_plot():
    result = require_regular_episode_metadata(_regular() + [
        {'episode_id': 'sp', 'episode_kind': 'special'},
    ], {'metadata_state': 'ready', 'episode_mappings': [
        {'episode_id': 'e1', 'provider_episode_id': '101', 'title': '',
         'still_url': 'https://image.tmdb.org/t/p/w500/e1.jpg'},
    ]})
    assert result['metadata_state'] == 'ready'
    assert result['missing_episode_still_count'] == 0


def test_thumbnail_failure_preserves_authorization_recovery():
    recovery = metadata_recovery_policy({
        'metadata_state': 'failed', 'reason_code': 'episode_artwork_incomplete',
        'season_results': [{'reason_code': 'provider_auth_required'}],
    })
    assert recovery['action'] == 'check_settings'


@pytest.mark.parametrize('mismatch', [None, 'id', 'season', 'episode'])
def test_mapped_episode_fetches_missing_thumbnail_from_its_own_image_details(monkeypatch, mismatch):
    from app.media_v4.jobs import metadata as module

    _install_client(monkeypatch, seasons={1: [1]})
    original = module.TMDBClient.get_tv_season_episodes

    def season(client, work, number):
        data = original(client, work, number)
        data['episodes'][0]['still_path'] = ''
        return data

    requests = []

    def detail(_client, work, season, number):
        requests.append((work, season, number))
        return {'id': 999 if mismatch == 'id' else 1001,
                'season_number': 2 if mismatch == 'season' else 1,
                'episode_number': 2 if mismatch == 'episode' else 1,
                'images': {'stills': [{'file_path': '/recovered.jpg'}]}, 'overview': 'unused'}

    monkeypatch.setattr(module.TMDBClient, 'get_tv_season_episodes', season)
    monkeypatch.setattr(module.TMDBClient, 'get_tv_episode_detail', detail, raising=False)
    monkeypatch.setattr(module.TMDBClient, 'select_best_still', staticmethod(
        lambda images: images['stills'][0]['file_path']), raising=False)
    result = module.default_metadata_provider(_target([_episode('e1', season=1, episode=1)]))
    assert requests == [(42, 1, 1)]
    if mismatch is None:
        assert result['metadata_state'] == 'ready'
        assert result['episode_mappings'][0]['still_url'].endswith('/recovered.jpg')
        assert 'plot' not in result['episode_mappings'][0]
    else:
        assert result['metadata_state'] != 'ready'
        assert not any(item.get('still_url', '').endswith('/recovered.jpg') for item in result['episode_mappings'])


def test_image_sources_are_snapshotted_without_blocking_metadata_completion(tmp_path):
    database = V4Database(tmp_path / 'thumb.db')
    database.initialize()
    confirm(database, 'r1')
    V4JobRunner(database, metadata_provider=provider).process_available()
    unit = V4RevisionService(database).get_execution_progress('r1')['work_units'][0]
    # 资料本身已完成；整体仍在等必需图片，两者必须分开断言。
    assert unit['metadata_state'] == 'ready'
    assert unit['episode_mapping_status'] == 'complete'
    assert unit['overall_status'] == 'running_artwork'
    assert unit['artwork']['status'] == 'pending'
    with database.connect() as conn:
        metadata = json.loads(conn.execute('SELECT metadata_json FROM scrape_bindings').fetchone()[0])
        bindings = conn.execute(
            "SELECT b.role,r.source_url,r.state FROM artwork_bindings b "
            "JOIN artwork_resources r ON r.resource_id=b.candidate_id WHERE b.work_id=?",
            (unit['work_id'],),
        ).fetchall()
    assert metadata['metadata_state'] == 'ready'
    assert metadata['episode_mappings'][0]['still_url'].endswith('/episode.jpg')
    assert 'local_thumb_path' not in metadata['episode_mappings'][0]
    assert any(row['source_url'].endswith('/episode.jpg') and row['state'] == 'pending' for row in bindings)


def test_episode_beyond_provider_season_boundary_keeps_missing_source(monkeypatch):
    """92 个缺项的真实形态：本地集号超出在线季集数（独立核对见施工产物），

    图片阶段必须保留"缺源"分类，不能因为资料 ready 就伪造就绪或重新发起请求。
    """

    from app.media_v4.jobs import metadata as module

    requested: list[int] = []
    _install_client(monkeypatch, seasons={1: [1, 2]}, requested=requested)
    result = module.default_metadata_provider(_target([_episode('e1', season=1, episode=3)]))

    assert requested == [1]
    assert result['episode_mappings'] == []
    assert result['unmapped_reason_codes'] == ['provider_resource_missing']
    assert result['metadata_state'] == 'ready'
    after_quality = require_regular_episode_metadata(
        [{'episode_id': 'e1', 'local_season_number': 1, 'local_episode_number': 3}], result)
    assert after_quality['missing_episode_still_count'] == 1
    assert after_quality['episode_artwork_status'] != 'complete'
