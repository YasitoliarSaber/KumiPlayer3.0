"""映射只由真实文件样本决定，覆盖挂载层级与确认闭锁。"""

from dataclasses import asdict
from types import SimpleNamespace

import pytest

from app.integrations.openlist.providers import OpenListRouteConfig
from app.media_v4.sources.openlist_playback_mapping import (
    PlaybackMappingError,
    choose_mapping,
    collect_samples,
    prepare_mapping,
    require_verified_mapping,
)

ROUTES = [OpenListRouteConfig(route_id='quark', remote_prefix='/夸克', provider_id='quark')]


def metadata(files, unknown=()):
    return lambda path: {'status': 'file' if path in files else 'unavailable' if path in unknown else 'missing'}


@pytest.mark.parametrize(('mount', 'files', 'expected'), [
    ('K:/', ['K:\\夸克\\动画\\Show\\1.mkv'], '/'),
    ('K:/夸克', ['K:\\夸克\\动画\\Show\\1.mkv'], '/夸克'),
    ('K:/动画', ['K:\\动画\\Show\\1.mkv'], '/夸克/动画'),
])
def test_disk_provider_and_subdirectory_mounts_select_only_reachable_mapping(mount, files, expected):
    proof = choose_mapping(remote_root='/夸克/动画', mapping_root='/', mount_root=mount,
                           routes=ROUTES, samples=['/夸克/动画/Show/1.mkv'], probe=metadata(files))
    assert proof['mapping_root'] == expected
    assert proof['local_paths'] == files


def test_real_repeated_directory_names_are_preserved():
    target = 'K:\\夸克\\夸克\\Show\\1.mkv'
    proof = choose_mapping(remote_root='/夸克', mapping_root='/', mount_root='K:/夸克',
                           routes=ROUTES, samples=['/夸克/夸克/Show/1.mkv'], probe=metadata([target]))
    assert proof['mapping_root'] == '/夸克'
    assert proof['local_paths'] == [target]


def test_explicit_last_resort_mapping_is_verified_without_guessing_other_ranges():
    route = OpenListRouteConfig(route_id='quark', remote_prefix='/夸克', provider_id='quark', local_root='J:/动画')
    calls = []
    def probe(path):
        calls.append(path)
        return {'status': 'file'}
    proof = choose_mapping(remote_root='/夸克', mapping_root='/', mount_root='K:/', routes=[route],
                           samples=['/夸克/Show/1.mkv'], probe=probe)
    assert proof['local_paths'] == ['J:\\动画\\Show\\1.mkv']
    assert calls == proof['local_paths']
    with pytest.raises(PlaybackMappingError):
        choose_mapping(remote_root='/夸克', mapping_root='/', mount_root='K:/', routes=[route],
                       samples=['/夸克/Show/1.mkv'], probe=metadata([]))


def test_child_route_without_manual_mapping_keeps_automatic_candidates():
    routes = [
        OpenListRouteConfig(route_id='parent', remote_prefix='/夸克', provider_id='quark', local_root='J:/网盘'),
        OpenListRouteConfig(route_id='child', remote_prefix='/夸克/动画', provider_id='quark'),
    ]
    target = 'K:\\Show\\1.mkv'
    proof = choose_mapping(remote_root='/夸克/动画', mapping_root='/', mount_root='K:/', routes=routes,
                           samples=['/夸克/动画/Show/1.mkv'], probe=metadata([target]))
    assert proof['mapping_root'] == '/夸克/动画'
    assert proof['local_paths'] == [target]


def test_ambiguous_files_require_explicit_verified_choice():
    targets = ['K:\\夸克\\Show\\1.mkv', 'K:\\Show\\1.mkv']
    args = dict(remote_root='/夸克', mapping_root='/', mount_root='K:/', routes=ROUTES,
                samples=['/夸克/Show/1.mkv'], probe=metadata(targets))
    with pytest.raises(PlaybackMappingError) as error:
        choose_mapping(**args)
    assert error.value.preview['state'] == 'ambiguous'
    choices = error.value.preview['choices']
    assert len(choices) == 2
    proof = choose_mapping(**args, choice_id=choices[1]['id'])
    assert proof['local_paths'] == choices[1]['path_samples']
    with pytest.raises(PlaybackMappingError):
        choose_mapping(**args, choice_id='stale-choice')


def test_unknown_candidate_cannot_be_ruled_out_by_one_reachable_file():
    with pytest.raises(PlaybackMappingError) as error:
        choose_mapping(remote_root='/夸克', mapping_root='/', mount_root='K:/', routes=ROUTES,
                       samples=['/夸克/Show/1.mkv'],
                       probe=metadata(['K:\\Show\\1.mkv'], ['K:\\夸克\\Show\\1.mkv']))
    assert error.value.preview['state'] == 'unverifiable'
    assert error.value.preview['choices'] == []


def test_no_samples_and_missing_files_do_not_generate_paths():
    for samples, state in [([], 'unverifiable'), (['/夸克/1.mkv'], 'invalid')]:
        with pytest.raises(PlaybackMappingError) as error:
            choose_mapping(remote_root='/夸克', mapping_root='/', mount_root='K:/', routes=ROUTES,
                           samples=samples, probe=metadata([]))
        assert error.value.preview['state'] == state
        assert error.value.preview['choices'] == []


def test_out_of_scope_sample_is_rejected_before_probe():
    with pytest.raises(ValueError, match='所选远端来源'):
        choose_mapping(remote_root='/夸克', mapping_root='/', mount_root='K:/', routes=ROUTES,
                       samples=['/其他盘/1.mkv'], probe=lambda _: pytest.fail('must not probe'))


def test_sampler_handles_short_pages_and_refreshes_without_downloading():
    calls = []
    class Client:
        def list_dir(self, path, **kwargs):
            calls.append((path, kwargs))
            entry = SimpleNamespace(name='note.txt' if kwargs['page'] == 1 else '1.mkv',
                                    remote_path='/夸克/note.txt' if kwargs['page'] == 1 else '/夸克/1.mkv', is_dir=False)
            return SimpleNamespace(entries=[entry] if kwargs['page'] <= 2 else [], total=0)
    assert collect_samples(Client(), '/夸克') == ['/夸克/1.mkv']
    assert [call[1]['page'] for call in calls] == [1, 2, 3]
    assert all(call[1]['refresh'] for call in calls)


def fresh_scan(tmp_path):
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.sources.source_scan_runner import register_source_scan
    db = V4Database(tmp_path / 'mapping.db')
    db.initialize()
    with db.connect() as conn:
        conn.execute("INSERT INTO source_roots(root_id,provider,ingest_method,created_at,updated_at) VALUES ('root','quark','openlist_scan','','')")
    request = {'remote_root': '/夸克', 'mapping_root': '/', 'mount_root': 'K:/',
               'routes': [asdict(route) for route in ROUTES], 'verify_openlist_playback': True}
    register_source_scan(db, scan_id='scan', root_id='root', scan_kind='openlist_full', source_mode='openlist_full', request=request)
    return db, request


def test_failed_preflight_persists_error_but_no_media_evidence(tmp_path, monkeypatch):
    import app.media_v4.sources.openlist_playback_mapping as mapping
    db, request = fresh_scan(tmp_path)
    monkeypatch.setattr(mapping, 'collect_samples', lambda *a, **k: ['/夸克/1.mkv'])
    monkeypatch.setattr(mapping, 'BoundedMetadataProbe', lambda **k: metadata([]))
    with pytest.raises(PlaybackMappingError):
        prepare_mapping(db, SimpleNamespace(request=request, scan_id='scan'), None,
                        SimpleNamespace(report_progress=lambda **k: None, cancellation_requested=lambda: False))
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM source_evidence').fetchone()[0] == 0
        assert 'invalid' in conn.execute('SELECT request_json FROM source_scan_requests').fetchone()[0]


def test_confirm_reprobes_and_rejects_drift_or_disconnected_mount(tmp_path, monkeypatch):
    import json

    import app.media_v4.sources.openlist_playback_mapping as mapping
    from app.media_v4.persistence.repositories import V4Repository
    from app.media_v4.sources.adapters import SourceEntry, to_source_evidence
    db, request = fresh_scan(tmp_path)
    target = 'K:\\Show\\1.mkv'
    proof = choose_mapping(remote_root='/夸克', mapping_root='/', mount_root='K:/', routes=ROUTES,
                           samples=['/夸克/Show/1.mkv'], probe=metadata([target]))
    request['playback_mapping'] = proof
    with db.connect() as conn:
        conn.execute('UPDATE source_scan_requests SET request_json=?', (json.dumps(request),))
    V4Repository(db).save_source_evidence(to_source_evidence(SourceEntry(
        root_id='root', scan_id='scan', provider='quark', ingest_method='openlist_api',
        relative_path='Show/1.mkv', source_key='/夸克/Show/1.mkv',
        source_locator='/夸克/Show/1.mkv', playback_locator='K:\\wrong\\1.mkv')))
    monkeypatch.setattr(mapping, 'BoundedMetadataProbe', lambda **k: metadata([target]))
    with pytest.raises(ValueError, match='映射不一致'):
        require_verified_mapping(db, 'scan', require=True)
    monkeypatch.setattr(mapping, 'BoundedMetadataProbe', lambda **k: metadata([]))
    with pytest.raises(ValueError, match='无法访问'):
        require_verified_mapping(db, 'scan')
    request['playback_mapping']['remote_paths'] = ['/另一盘/1.mkv']
    with db.connect() as conn:
        conn.execute('UPDATE source_scan_requests SET request_json=?', (json.dumps(request),))
    with pytest.raises(ValueError, match='证明与来源范围'):
        require_verified_mapping(db, 'scan')


def test_legacy_openlist_evidence_without_proof_cannot_be_confirmed(tmp_path):
    from app.media_v4.persistence.repositories import V4Repository
    from app.media_v4.sources.adapters import SourceEntry, to_source_evidence
    db, _ = fresh_scan(tmp_path)
    with db.connect() as conn:
        conn.execute('DELETE FROM source_scan_requests')
    V4Repository(db).save_source_evidence(to_source_evidence(SourceEntry(
        root_id='root', scan_id='scan', provider='quark', ingest_method='openlist_api',
        relative_path='1.mkv', source_key='/夸克/1.mkv', source_locator='/夸克/1.mkv', playback_locator='K:/1.mkv')))
    with pytest.raises(ValueError, match='重新扫描来源'):
        require_verified_mapping(db, 'scan', require=True)


def test_real_sync_scan_uses_verified_folder_and_confirm_rechecks_it(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import media_v4, openlist_v4
    from app.core.config import AppConfig
    from app.integrations.openlist.models import OpenListEntry
    from app.media_v4.parsing.parser import V4Parser
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.playback.session import V4PlaybackManager
    from app.media_v4.playback.store import V4PlaybackStore
    from app.media_v4.revisions.service import V4RevisionService
    from app.media_v4.sources.adapters import SourceEntry, to_source_evidence

    db = V4Database(tmp_path / 'sync.db')
    db.initialize()
    mount = tmp_path / 'provider-mount'
    video = mount / 'Show' / 'Show.S01E01.mkv'
    video.parent.mkdir(parents=True)
    video.write_bytes(b'')
    config = AppConfig(openlist_server_url='https://fixture.test', openlist_remote_root='/',
                       openlist_mount_root=str(mount), openlist_routes=ROUTES)
    for target in ('app.core.config.load_config',):
        monkeypatch.setattr(target, lambda: config)
    monkeypatch.setattr(media_v4, 'get_database', lambda: db)
    monkeypatch.setattr(media_v4, '_select_openlist_config', lambda _: config)
    monkeypatch.setattr(media_v4, '_openlist_credentials', lambda _: ('fixture', '', 'found'))
    monkeypatch.setattr('app.core.config.resolve_openlist_credentials', lambda *a: ('fixture', '', 'found'))
    monkeypatch.setattr(media_v4, 'stage_scan_state', lambda *a: None)
    monkeypatch.setattr(media_v4, 'activate_scan_state', lambda *a: None)
    class Client:
        def list_dir(self, path, **kwargs):
            entries = [] if kwargs['page'] > 1 else [
                OpenListEntry(name='Show', remote_path='/夸克/Show', is_dir=True)
            ] if path == '/夸克' else [
                OpenListEntry(name=video.name, remote_path='/夸克/Show/' + video.name)
            ]
            return SimpleNamespace(entries=entries, total=len(entries), skipped_entries=0)
    monkeypatch.setattr(openlist_v4, '_client', lambda _: Client())
    # 旧库夹具：已确认的远端身份正确，播放定位多拼一层。通过新扫描修订修复，
    # 而不是改写旧 SourceEvidence；原 Work/Episode/Asset 与续播身份须保持。
    root_id = media_v4._source_openlist_root_id(config, 'fixture', '/夸克')
    old_evidence = to_source_evidence(SourceEntry(
        root_id=root_id, scan_id='legacy-scan', provider='quark', ingest_method='openlist_api',
        source_key='/夸克/Show/' + video.name, relative_path='Show/' + video.name,
        source_locator='/夸克/Show/' + video.name, playback_locator=str(mount / '夸克' / 'Show' / video.name)))
    revisions = V4RevisionService(db)
    revisions.create_draft('legacy-revision', [(old_evidence, V4Parser().parse(old_evidence))], source_mode='openlist_full')
    revisions.confirm('legacy-revision')
    with db.connect() as conn:
        old = dict(conn.execute("SELECT work_id,episode_id,asset_id FROM revision_bindings WHERE revision_id='legacy-revision'").fetchone())
    V4PlaybackStore(db).save_progress(old['work_id'], old['episode_id'], old['asset_id'], 123, 1500, False)
    scanned = media_v4.scan_source(media_v4.SourceScanRequest(source='openlist', root_path='/夸克', scan_mode='full'))
    assert scanned['effective_playback_root'] == str(mount)
    assert scanned['entries'][0]['playback_locator'] == str(video)
    with db.connect() as conn:
        assert 'playback_mapping' in conn.execute('SELECT request_json FROM source_scan_requests').fetchone()[0]
    app = FastAPI()
    app.include_router(media_v4.router)
    api = TestClient(app)
    preview = api.post('/api/v4/imports/preview', json={
        'revision_id': 'proof-revision', 'scan_id': scanned['scan_id'], 'root_id': scanned['root_id'], 'entries': []})
    assert preview.status_code == 200, preview.text
    video.unlink()
    blocked = api.post('/api/v4/imports/proof-revision/confirm')
    assert blocked.status_code == 409, blocked.text
    assert '无法访问' in blocked.json()['detail']
    video.write_bytes(b'')
    confirmed = api.post('/api/v4/imports/proof-revision/confirm')
    assert confirmed.status_code == 200, confirmed.text
    with db.connect() as conn:
        current = dict(conn.execute("SELECT work_id,episode_id,asset_id FROM revision_bindings WHERE revision_id='proof-revision'").fetchone())
        assert current == old
        assert conn.execute('SELECT playback_locator FROM source_evidence WHERE evidence_id=?', (old_evidence.evidence_id,)).fetchone()[0] == old_evidence.playback_locator
    current_asset = V4PlaybackManager(db, session_dir=tmp_path / 'sessions')._resolve_asset(old['work_id'], old['episode_id'], old['asset_id'])
    assert current_asset['playback_locator'] == str(video)
    assert V4PlaybackStore(db).get_progress(old['episode_id'], old['asset_id'])['position'] == 123


def test_durable_handler_verifies_before_any_evidence_and_freezes_resume_mapping(tmp_path, monkeypatch):
    import json

    from app.api import media_v4, openlist_v4
    from app.core.config import AppConfig
    from app.integrations.openlist.models import OpenListEntry
    from app.media_v4.sources import incremental
    from app.media_v4.sources.source_scan_runner import SourceScanRunner

    db, request = fresh_scan(tmp_path)
    mount = tmp_path / 'mount'
    media = mount / 'Show' / 'Show.S01E01.mkv'
    media.parent.mkdir(parents=True)
    media.write_bytes(b'')
    request['mount_root'] = str(mount)
    request['revision_id'] = 'durable-proof'
    with db.connect() as conn:
        conn.execute('UPDATE source_scan_requests SET request_json=?', (json.dumps(request),))
    config = AppConfig(openlist_server_url='https://fixture.test', openlist_mount_root=str(mount), openlist_routes=ROUTES)
    monkeypatch.setattr(media_v4, 'get_database', lambda: db)
    monkeypatch.setattr(openlist_v4, '_connection_config', lambda _: config)
    monkeypatch.setattr(incremental, 'stage_scan_state', lambda *a: None)
    class Client:
        def list_dir(self, path, **kwargs):
            entries = [] if kwargs['page'] > 1 else [
                OpenListEntry(name='Show', remote_path='/夸克/Show', is_dir=True)
            ] if path == '/夸克' else [
                OpenListEntry(name=media.name, remote_path='/夸克/Show/' + media.name)
            ]
            return SimpleNamespace(entries=entries, total=len(entries), skipped_entries=0)
    monkeypatch.setattr(openlist_v4, '_client', lambda _: Client())
    runner = SourceScanRunner(db)
    task = runner.claim_next_scan()
    runner.run_scan(task)
    with db.connect() as conn:
        state = conn.execute('SELECT * FROM source_scans').fetchone()
        assert state['status'] == 'completed', dict(state)
        proof_request = json.loads(conn.execute('SELECT request_json FROM source_scan_requests').fetchone()[0])
        assert proof_request['playback_mapping']['local_paths'] == [str(media)]
        assert conn.execute('SELECT playback_locator FROM source_evidence').fetchone()[0] == str(media)
    # 同一任务续跑只允许原候选再次证明；另一个候选碰巧可达不能改写旧证据。
    alternative = mount / '夸克' / 'Show' / media.name
    alternative.parent.mkdir(parents=True)
    alternative.write_bytes(b'')
    media.unlink()
    with pytest.raises(PlaybackMappingError):
        prepare_mapping(db, SimpleNamespace(request=proof_request, scan_id='scan'), Client(),
                        SimpleNamespace(report_progress=lambda **k: None, cancellation_requested=lambda: False))
    with db.connect() as conn:
        assert conn.execute('SELECT playback_locator FROM source_evidence').fetchone()[0] == str(media)
