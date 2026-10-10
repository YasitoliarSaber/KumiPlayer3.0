"""Partial episode snapshots must remain eligible for bounded gap recovery."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.media_v4.jobs.metadata import default_metadata_provider
from app.media_v4.jobs.scrape import V4ScrapeService
from app.media_v4.persistence.database import V4Database
from app.scrape.tmdb_client import TMDBClientError
from tests.test_v4_import_metadata_lifecycle import confirm, provider


@pytest.mark.parametrize('gap', ['mapping', 'all_mappings', 'title', 'still'])
def test_rescan_recovers_only_incomplete_episode_details(tmp_path, gap):
    database = V4Database(tmp_path / 'recovery.db')
    database.initialize()
    confirm(database, 'first', (1, 2), provider_hint=True)
    service = V4ScrapeService(database)
    job = next(j for j in service.enqueue_for_revision('first') if j['job_type'] == 'scrape_work')

    def partial(target):
        result = provider(target)
        if gap in {'mapping', 'all_mappings'}:
            result['episode_mappings'] = result['episode_mappings'][:1] if gap == 'mapping' else []
            missing = target['episodes'][1:] if gap == 'mapping' else target['episodes']
            result['unmapped_reasons'] = [{'episode_id': item['episode_id'],
                                          'reason': 'provider_unavailable'} for item in missing]
        else:
            result['episode_mappings'][1]['title' if gap == 'title' else 'still_url'] = ''
        return result

    service.process(job['job_id'], partial)
    confirm(database, 'second', (1, 2), provider_hint=True)
    requested = []

    def recovered(target):
        requested.extend(e['local_episode_number'] for e in target['episodes'])
        assert target['retained_work_metadata']['title'] == 'Online title'
        return provider(target)

    job = next(j for j in service.enqueue_for_revision('second') if j['job_type'] == 'scrape_work')
    service.process(job['job_id'], recovered)
    assert requested == ([1, 2] if gap == 'all_mappings' else [2])
    with database.connect() as conn:
        snapshot = conn.execute(
            'SELECT ms.metadata_json FROM revision_metadata_refs r '
            'JOIN metadata_snapshots ms ON ms.snapshot_id=r.snapshot_id WHERE r.revision_id=?',
            ('second',),
        ).fetchone()
    metadata = json.loads(snapshot[0])
    assert metadata['mapped_count'] == metadata['total_count'] == 2
    assert metadata['missing_episode_title_count'] == metadata['missing_episode_still_count'] == 0


def test_complete_snapshot_rescan_does_not_fetch_provider(tmp_path):
    database = V4Database(tmp_path / 'complete.db')
    database.initialize()
    service = V4ScrapeService(database)
    confirm(database, 'first', provider_hint=True)
    job = next(j for j in service.enqueue_for_revision('first') if j['job_type'] == 'scrape_work')
    service.process(job['job_id'], provider)
    confirm(database, 'second', provider_hint=True)
    job = next(j for j in service.enqueue_for_revision('second') if j['job_type'] == 'scrape_work')

    def forbidden(_target):
        raise AssertionError('Complete unchanged metadata must be reused')

    service.process(job['job_id'], forbidden)
    with database.connect() as conn:
        row = conn.execute('SELECT result_json FROM jobs WHERE job_id=?', (job['job_id'],)).fetchone()
    assert json.loads(row[0])['outcome'] == 'reused'


@pytest.mark.parametrize('error, retryable', [
    (TMDBClientError('timeout', reason_code='source_unavailable', retryable=True), True),
    (TMDBClientError('missing', status_code=404, reason_code='provider_resource_missing', retryable=False), False),
])
def test_retained_work_gap_recovery_reports_current_failure(monkeypatch, error, retryable):
    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get_tv_season_episodes(self, *_args):
            raise error

    monkeypatch.setattr('app.media_v4.jobs.metadata.TMDBClient', Client)
    monkeypatch.setattr('app.media_v4.jobs.metadata.load_config',
                        lambda: SimpleNamespace(tmdb_bearer_token='fixture'))
    result = default_metadata_provider({
        'work_type': 'series', 'preferred_title': 'Show',
        'provider_bindings': [{'provider': 'tmdb', 'provider_id': '123', 'media_type': 'tv'}],
        'retained_work_metadata': {
            'provider': 'tmdb', 'provider_id': '123', 'title': 'Online title',
            'metadata_state': 'ready', 'retryable': False, 'refresh_status': 'succeeded',
        },
        'episodes': [{'episode_id': 'e', 'season_id': 's', 'episode_kind': 'regular',
                      'local_season_number': 1, 'local_episode_number': 1}],
    })
    assert result['title'] == 'Online title'
    assert result['metadata_state'] == 'ready'
    assert result['refresh_status'] == 'partial'
    assert result['retryable'] is retryable
    assert result['failure_stage'] == 'season_detail'
    assert result['season_results'][0]['reason_code'] == error.reason_code


@pytest.mark.parametrize('fail_detail', [False, True])
def test_retained_gap_recovery_keeps_missing_still_and_current_detail_error(monkeypatch, fail_detail):
    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get_tv_season_episodes(self, *_args):
            return {'episodes': [{'id': 101, 'episode_number': 1, 'name': 'First'}]}

        def get_tv_episode_detail(self, *_args):
            if fail_detail:
                raise TMDBClientError('timeout', reason_code='source_unavailable', retryable=True)
            return {'id': 101, 'season_number': 1, 'episode_number': 1, 'name': 'First'}

        def build_image_url(self, *_args):
            return ''

    monkeypatch.setattr('app.media_v4.jobs.metadata.TMDBClient', Client)
    monkeypatch.setattr('app.media_v4.jobs.metadata.load_config',
                        lambda: SimpleNamespace(tmdb_bearer_token='fixture'))
    result = default_metadata_provider({
        'work_type': 'series', 'preferred_title': 'Show',
        'provider_bindings': [{'provider': 'tmdb', 'provider_id': '123', 'media_type': 'tv'}],
        'retained_work_metadata': {
            'provider': 'tmdb', 'provider_id': '123', 'title': 'Online title',
            'metadata_state': 'ready', 'retryable': False, 'refresh_status': 'partial',
            'reason_code': 'episode_mapping_incomplete', 'reason': 'old mapping failure',
            'metadata_refresh_error': 'old timeout',
        },
        'episodes': [{'episode_id': 'e', 'season_id': 's', 'episode_kind': 'regular',
                      'local_season_number': 1, 'local_episode_number': 1}],
    })
    assert result['mapped_count'] == 1
    assert result['missing_episode_still_count'] == 1
    assert result['refresh_status'] == 'partial'
    assert result['retryable'] is fail_detail
    assert result['reason'] != 'old mapping failure'
    assert result['metadata_refresh_error'] != 'old timeout'
    if fail_detail:
        assert result['reason_code'] == 'source_unavailable'
        assert result['failure_stage'] == 'episode_detail'
    else:
        assert result['reason_code'] == 'episode_artwork_source_missing'
