"""本地正片资料覆盖：不要求在线全集，不把可选分集资料当作导入失败。"""
from copy import deepcopy

from app.media_v4.jobs import metadata as metadata_module
from app.scrape.tmdb_client import TMDBClientError
from tests.test_v4_import_numbering_status import _episode, _install_client, _target


def test_partial_metadata_messages_distinguish_optional_data_from_numbering_conflicts():
    from app.media_v4.revisions.service import _friendly_metadata_reason

    assert '可正常浏览与播放' in _friendly_metadata_reason('ready', '', 'episode_mapping_incomplete')
    assert '尚待核对' in _friendly_metadata_reason('failed', '', 'episode_mapping_incomplete')
    assert '可正常浏览与播放' in _friendly_metadata_reason('ready', '', 'episode_details_incomplete')


def test_main_series_display_alias_does_not_create_provider_child_scope(tmp_path):
    from dataclasses import replace

    from app.media_v4.domain.models import ParsedFacts
    from app.media_v4.jobs.scrape import _provider_identity_scope
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / 'scope.db')
    database.initialize()
    fact = ParsedFacts(parsed_fact_id='f', evidence_id='e', parser_version='fixture',
                       work_title='轻音少女', series_group='K-ON!', card_type='main_series', group_type='season')
    target = {'work_id': 'main', 'preferred_title': '轻音少女', 'identity_titles': ['K-ON!']}
    with database.connect() as conn:
        assert _provider_identity_scope(conn, target, [fact])['confirmed_child'] is False
        child = replace(fact, card_type='standalone', relation_type='related')
        assert _provider_identity_scope(conn, target, [child])['confirmed_child'] is True


def test_old_optional_episode_gap_is_reassessed_without_hiding_true_conflict():
    from app.media_v4.jobs.metadata_quality import require_regular_episode_metadata

    episodes = [{'episode_id': 'e', 'local_season_number': 1, 'local_episode_number': 23}]
    old = {'metadata_state': 'failed', 'reason_code': 'episode_mapping_incomplete',
           'identity_status': 'confirmed', 'work_metadata_status': 'ready', 'provider_id': '42',
           'episode_mappings': [{'episode_id': 'e', 'still_url': 'https://image.tmdb.org/t/p/w500/e.jpg'}],
           'unmapped_reasons': [{'episode_id': 'e', 'reason': 'provider_episode_not_found'}]}
    assert require_regular_episode_metadata(episodes, old)['metadata_state'] == 'ready'
    assert old['metadata_state'] == 'failed'
    conflict = {**old, 'mapping_conflicts': [{'episode_id': 'e', 'reason': 'numbering_conflict'}]}
    assert require_regular_episode_metadata(episodes, conflict)['metadata_state'] == 'failed'


def test_local_subset_does_not_require_online_whole_season(monkeypatch):
    _install_client(monkeypatch, seasons={1: list(range(1, 14))})
    target = _target([_episode(f'e{i}', season=1, episode=i) for i in (8, 9, 13)])
    result = metadata_module.default_metadata_provider(target)
    assert result['metadata_state'] == 'ready'
    assert (result['mapped_count'], result['total_count']) == (3, 3)
    assert result['episode_mapping_status'] == 'complete'


def test_partial_season_response_recovers_only_local_missing_coordinates(monkeypatch):
    _install_client(monkeypatch, seasons={1: list(range(1, 8))})
    requests = []

    def detail(_client, work, season, episode):
        requests.append((work, season, episode))
        return {'id': 1000 + episode, 'season_number': season,
                'episode_number': episode, 'name': f'E{episode}', 'still_path': '/episode.jpg'}

    monkeypatch.setattr(metadata_module.TMDBClient, 'get_tv_episode_detail', detail, raising=False)
    target = _target([_episode(f'e{i}', season=1, episode=i) for i in range(1, 14)])
    original = deepcopy(target)
    result = metadata_module.default_metadata_provider(target)
    assert result['metadata_state'] == 'ready'
    assert result['episode_mapping_status'] == 'complete'
    assert requests == [(42, 1, i) for i in range(8, 14)]
    assert result['missing_episode_still_count'] == 0
    assert target == original


def test_single_episode_fallback_does_not_adopt_other_coordinates(monkeypatch):
    _install_client(monkeypatch, seasons={1: [1]})
    monkeypatch.setattr(metadata_module.TMDBClient, 'get_tv_episode_detail',
                        lambda *args: {'id': 99, 'season_number': 2, 'episode_number': 1}, raising=False)
    result = metadata_module.default_metadata_provider(
        _target([_episode('e8', season=1, episode=8)]))
    assert result['episode_mappings'] == []
    assert result['metadata_state'] != 'ready'


def test_missing_online_entry_keeps_local_coordinates_but_needs_thumbnail(monkeypatch):
    _install_client(monkeypatch, seasons={1: [1]})
    result = metadata_module.default_metadata_provider(
        _target([_episode('e1', season=1, episode=1), _episode('e8', season=1, episode=8)]))
    assert result['metadata_state'] == 'ready'
    assert result['episode_mapping_status'] == 'partial'
    assert result['unmapped_episode_ids'] == ['e8']
    assert result.get('reason_code') != 'episode_artwork_incomplete'
    assert result['missing_episode_still_count'] == 1
    assert result['episode_coordinate_status'] == 'confirmed'


def test_season_data_outage_keeps_confirmed_work_and_local_coordinates_usable(monkeypatch):
    _install_client(monkeypatch, season_errors={1: TMDBClientError('fixture season unavailable')})
    result = metadata_module.default_metadata_provider(
        _target([_episode('e1', season=1, episode=1)]))
    assert result['metadata_state'] == 'ready'
    assert result['identity_status'] == 'confirmed'
    assert result['episode_mapping_status'] == 'unmapped'
    assert result['unmapped_episode_ids'] == ['e1']


def test_single_episode_fallback_outage_remains_honest_and_retryable(monkeypatch):
    _install_client(monkeypatch, seasons={1: [1]})

    def unavailable(*_args):
        raise TMDBClientError('fixture episode unavailable')

    monkeypatch.setattr(metadata_module.TMDBClient, 'get_tv_episode_detail', unavailable, raising=False)
    result = metadata_module.default_metadata_provider(
        _target([_episode('e8', season=1, episode=8)]))
    assert result['metadata_state'] == 'ready'
    assert result['unmapped_reason_codes'] == ['provider_unavailable']
    assert result['retryable'] is True


def test_single_episode_fallback_never_guesses_unknown_season(monkeypatch):
    _install_client(monkeypatch, seasons={1: [1]})

    def unexpected(*_args):
        raise AssertionError('unknown season must not request guessed coordinates')

    monkeypatch.setattr(metadata_module.TMDBClient, 'get_tv_episode_detail', unexpected, raising=False)
    result = metadata_module.default_metadata_provider(
        _target([_episode('e8', season=None, episode=8)]))
    assert result['episode_mappings'] == []
    assert result['metadata_state'] != 'ready'


def test_explicit_mapping_conflict_is_not_hidden_by_complete_display_fields():
    result = metadata_module.finalize_metadata_statuses(
        _target([_episode('e1', season=1, episode=1)]),
        {'provider': 'tmdb', 'provider_id': '42', 'metadata_state': 'ready',
         'episode_mappings': [{'episode_id': 'e1', 'provider_episode_id': '11',
                               'title': 'Episode', 'still_url': 'https://image.tmdb.org/t/p/w500/fixture.jpg'}],
         '_mapping_diagnostics': {'mapping_conflicts': [{'episode_id': 'e1', 'reason': 'numbering_conflict'}]}},
    )
    assert result['metadata_state'] == 'failed'
    assert result['episode_coordinate_status'] == 'needs_review'


def test_missing_episode_display_details_do_not_discard_reusable_work_snapshot(tmp_path, monkeypatch):
    from app.media_v4.jobs.runner import V4JobRunner
    from app.media_v4.projection.library import V4LibraryProjection
    from tests import test_v4_import_metadata_lifecycle as lifecycle_tests

    complete_provider = lifecycle_tests.provider

    def no_display_details(target):
        metadata = complete_provider(target)
        for item in metadata['episode_mappings']:
            item.update(title='')
        return metadata

    monkeypatch.setattr(lifecycle_tests, 'provider', no_display_details)
    database, mirror = lifecycle_tests.prepare(tmp_path, monkeypatch)
    lifecycle_tests.confirm(database, 'r2')

    def unexpected(_target):
        raise AssertionError('missing optional episode display fields must not refetch an unchanged work')

    V4JobRunner(database, metadata_provider=unexpected).process_available(mirror_root=mirror)
    card = V4LibraryProjection(database).ensure_current().cards[0]
    assert card['metadata']['metadata_state'] == 'ready'
    assert card['metadata']['episode_metadata_status'] == 'incomplete'
    with database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM metadata_snapshots').fetchone()[0] == 1
