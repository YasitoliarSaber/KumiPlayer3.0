"""分集图片单独评估；图片缺项不使已确认作品资料失效。"""
import hashlib
import json
from pathlib import Path

import pytest

from app.core.config import AppConfig
from app.media_v4.jobs.metadata_quality import missing_episode_artwork, require_regular_episode_metadata
from app.media_v4.jobs.runner import V4JobRunner
from app.media_v4.jobs.scrape import V4ScrapeService
from app.media_v4.persistence.database import V4Database
from app.media_v4.projection.library import V4LibraryProjection
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


@pytest.mark.parametrize('missing_download', [True, False])
@pytest.mark.parametrize('invalidation', ['delete', 'corrupt'])
def test_actual_local_thumbnail_download_controls_completion(tmp_path, monkeypatch, missing_download, invalidation):
    config = AppConfig(artwork_storage_mode='local')
    monkeypatch.setattr('app.media_v4.jobs.metadata_artifacts.load_config', lambda: config)
    monkeypatch.setattr('app.media_v4.jobs.completeness.load_config', lambda: config)

    def download(url, path, **_kwargs):
        if missing_download and url.endswith('/episode.jpg'):
            return ''
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture-image')
        return hashlib.sha256(path.read_bytes()).hexdigest()

    monkeypatch.setattr('app.media_v4.jobs.metadata_artifacts._download_artwork', download)
    database = V4Database(tmp_path / 'thumb.db')
    database.initialize()
    confirm(database, 'r1')
    V4JobRunner(database, metadata_provider=provider).process_available(mirror_root=tmp_path / 'mirror')
    unit = V4RevisionService(database).get_execution_progress('r1')['work_units'][0]
    assert unit['overall_status'] == ('needs_attention' if missing_download else 'completed')
    with database.connect() as conn:
        metadata = json.loads(conn.execute('SELECT metadata_json FROM scrape_bindings').fetchone()[0])
    assert metadata['metadata_state'] == ('failed' if missing_download else 'ready')
    if not missing_download:
        thumb = Path(metadata['episode_mappings'][0]['local_thumb_path'])
        if invalidation == 'delete':
            thumb.unlink()
        else:
            thumb.write_bytes(b'corrupted')
        card = V4LibraryProjection(database).rebuild().cards[0]
        assert card['metadata']['metadata_state'] == 'ready'
        # 资料读取不以现场检查撤销成功；图片完整性由显式后台检查单独判定。
        with database.connect() as conn:
            artifacts = [dict(row) for row in conn.execute("SELECT * FROM artifacts WHERE artifact_type='episode_thumb'")]
        assert missing_episode_artwork(
            [{'episode_id': metadata['episode_mappings'][0]['episode_id']}], metadata, artifacts, 'local') == 1
    # 缺图失败、文件丢失或损坏后，复用已保存的身份和图片地址即可恢复。
    missing_download = False
    result = V4ScrapeService(database).retry_artifacts('r1', unit['work_id'], mirror_root=tmp_path / 'mirror')
    assert result['metadata_state'] == 'ready'
    assert V4RevisionService(database).get_execution_progress('r1')['work_units'][0]['overall_status'] == 'completed'
