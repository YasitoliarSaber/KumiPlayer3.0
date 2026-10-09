"""Manual decisions follow a continuous SourceFile, never rewrite parsed facts."""
import json
from dataclasses import replace

import pytest
from app.media_v4.persistence.database import V4Database
from app.media_v4.playback.store import V4PlaybackStore
from app.media_v4.revisions.service import V4RevisionService

from backend.tests.test_v4_revision_confirmation import _entry_for_root


def entry(tmp_path, scan, *, size=100, mtime=1, root='root', filename='Show.S01E01.mkv', raw_file_id=''):
    evidence, facts = _entry_for_root(root_id=root, scan_id=scan, evidence_id=scan, episode=1)
    return replace(evidence, source_key=filename, relative_path=filename,
                   playback_locator=str(tmp_path/filename), size=size, mtime=mtime,
                   raw_file_id=raw_file_id, ingest_method='local_scan'), facts


def setup(tmp_path, **kwargs):
    db = V4Database(tmp_path/'library.db')
    db.initialize()
    service = V4RevisionService(db)
    service.create_draft('first', [entry(tmp_path, 'scan1', **kwargs)])
    service.apply_override('first', 'scan1', {'episode_candidate':7})
    service.confirm('first')
    return db, service


def binding(db, revision):
    with db.connect() as conn:
        return tuple(conn.execute('SELECT rb.asset_id,rb.episode_id,e.local_episode_number '
                                  'FROM revision_bindings rb JOIN episodes e ON e.episode_id=rb.episode_id '
                                  'WHERE revision_id=?',(revision,)).fetchone())


def test_same_content_rescan_preserves_manual_episode_and_original_facts(tmp_path):
    db, service = setup(tmp_path)
    before = binding(db,'first')
    with db.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM revision_bindings WHERE revision_id='first'").fetchone()[0]
    playback = V4PlaybackStore(db)
    playback.save_progress(work_id, before[1], before[0], 42, 120, False)
    playback.record_activation(work_id, before[1], before[0])
    service.create_draft('second',[entry(tmp_path,'scan2')])
    service.confirm('second')
    assert binding(db,'second') == before
    service.create_draft('third',[entry(tmp_path,'scan3')])
    service.confirm('third')
    assert binding(db,'third') == before
    with db.connect() as conn:
        assert conn.execute("SELECT episode_candidate FROM parsed_facts WHERE evidence_id='scan2'").fetchone()[0] == 1
        payload = json.loads(conn.execute("SELECT overrides_json FROM revision_overrides WHERE revision_id='third'").fetchone()[0])
        assert payload['episode_candidate'] == 7
        progress = conn.execute('SELECT work_id,episode_id,asset_id,position FROM playback_progress').fetchone()
        assert tuple(progress) == (work_id, before[1], before[0], 42)
        assert conn.execute('SELECT count(*) FROM playback_history').fetchone()[0] == 1


@pytest.mark.parametrize('change',[{'size':200},{'mtime':2}])
def test_content_change_requires_review_of_previous_manual_decision(tmp_path, change):
    db, service = setup(tmp_path)
    before = binding(db,'first')
    graph = service.create_draft('changed',[entry(tmp_path,'scan2',**change)])
    assert 'manual_override_continuity_conflict' in {i.code for i in graph.issues}
    with pytest.raises(ValueError, match='人工修正'):
        service.confirm('changed')
    assert service.get_status('first') == 'confirmed'
    assert service.get_status('changed') == 'draft'
    assert binding(db,'first') == before
    service.apply_override('changed','scan2',{'episode_candidate':3})
    service.confirm('changed')
    assert binding(db,'changed')[2] == 3


def test_strong_provider_rename_preserves_correction(tmp_path):
    db, service = setup(tmp_path, raw_file_id='persistent-file')
    service.create_draft('renamed',[entry(tmp_path,'scan2',filename='Renamed.mkv',raw_file_id='persistent-file')])
    service.confirm('renamed')
    assert binding(db,'renamed') == binding(db,'first')


def test_other_root_does_not_inherit_manual_correction(tmp_path):
    db, service = setup(tmp_path)
    service.create_draft('other',[entry(tmp_path,'scan2',root='other')])
    service.confirm('other')
    assert binding(db,'other')[2] == 1


def test_confirm_enforces_absolute_paths_in_transaction(tmp_path):
    db = V4Database(tmp_path/'library.db')
    db.initialize()
    service = V4RevisionService(db)
    evidence, facts = entry(tmp_path,'scan1')
    service.create_draft('invalid',[(replace(evidence,playback_locator='relative.mkv'),facts)])
    with pytest.raises(ValueError):
        service.confirm('invalid')
    assert service.get_status('invalid') == 'draft'
    with db.connect() as conn:
        assert conn.execute('SELECT count(*) FROM assets').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM jobs').fetchone()[0] == 0


def test_abandoned_draft_cannot_replace_confirmed_manual_decision(tmp_path):
    db, service = setup(tmp_path)
    service.create_draft('abandoned', [entry(tmp_path, 'scan1')])
    service.apply_override('abandoned', 'scan1', {'episode_candidate': 9})
    service.create_draft('next', [entry(tmp_path, 'scan2')])
    service.confirm('next')
    assert service.get_status('abandoned') == 'superseded'
    assert binding(db, 'next')[2] == 7


def test_partial_review_keeps_remaining_manual_continuity_issue_visible(tmp_path):
    _db, service = setup(tmp_path)
    service.create_draft('changed', [entry(tmp_path, 'scan2', size=200)])
    graph = service.apply_override('changed', 'scan2', {'title_candidates': ['Renamed show']})
    assert 'manual_override_continuity_conflict' in {issue.code for issue in graph.issues}
