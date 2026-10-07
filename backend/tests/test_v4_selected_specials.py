"""小数集、零集与 OVA/OAD/SP 的排除回归，正片仍保持准入。"""
from pathlib import PurePosixPath

import pytest

from app.media_v4.domain.models import SourceEvidence
from app.media_v4.parsing.parser import V4Parser


def parse(path):
    evidence = SourceEvidence(
        evidence_id=path, scan_id="special-fixture", root_id="offline-root",
        source_key=path, relative_path=path, entry_kind="video", provider="local",
        playback_locator=f"fixture://{path}",
    )
    return evidence, V4Parser().parse(evidence)


@pytest.mark.parametrize("name", [
    "Show - 09.5.mkv", "Show.S01E14.5.mkv", "Show [14.5][1080p].mkv",
    "Show.S01E00.mkv", "Show - 00.mkv", "Show 第0集.mkv",
    "Show OVA01.mkv", "Show OAD02.mkv", "Show [14(OVA)].mkv", "Show OVA.mkv", "Show SP01.mkv", "Show [SP].mkv",
])
def test_explicit_special_is_excluded_with_original_name_retained_as_evidence(name):
    _, facts = parse(f"Show/Season 1/{name}")
    assert not facts.is_importable and facts.is_auxiliary
    assert facts.content_class == "attached_special"
    assert facts.group_type == "special"
    assert facts.episode_candidate is None
    assert facts.absolute_episode_candidate is None
    assert facts.episode_title == PurePosixPath(name).stem


@pytest.mark.parametrize("path", [
    "Show/Season 1/Show S01E01 [AAC 5.1][23.976fps].mkv",
    "Show/Season 1/Show S01E02 v1.5.mkv",
    "Show/Season 1/Show S01E03 [H264.50fps].mkv",
])
def test_technical_decimal_does_not_become_special(path):
    _, facts = parse(path)
    assert facts.group_type == "season"
    assert facts.is_importable


@pytest.mark.parametrize("path", [
    "Show/Season 1/Show NCOP 09.5.mkv",
    "Show/Season 1/Show [14.5][PV].mkv", "Show/Specials/Show - 花絮.mkv",
])
def test_other_excluded_material_stays_excluded(path):
    assert not parse(path)[1].is_importable


def test_mixed_specials_confirm_materialize_only_regular_episodes(tmp_path, monkeypatch):
    from app.api import library_v4
    from app.media_v4.jobs.mirror import V4MirrorMaterializer
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.revisions.service import V4RevisionService

    paths = ["Show/Season 1/Show.S01E01.mkv", "Show/Season 2/Show.S02E01.mkv",
             "Show/Season 1/Show - 09.5.mkv", "Show/Season 2/Show - 09.5.mkv",
             "Show/Season 1/Show.S01E00.mkv", "Show/Season 1/Show OVA01.mkv",
             "Show/Season 1/Show - 14.5.mkv", "Show/Season 1/Show OAD01.mkv",
             "Show/Season 1/Show OVA.mkv", "Show/Season 1/Show - 14.05.mkv",
             "Show/Specials/Show SP01.mkv", "Show/Specials/Show SP02.mkv",
             "Show/Show OVA02.mkv"]
    entries = [parse(path) for path in paths]
    database = V4Database(tmp_path / "specials.db")
    database.initialize()
    service = V4RevisionService(database)
    draft = service.create_draft("special-fixture", entries)
    assert len(draft.works) == 1
    assert len(draft.episodes) == 2
    assert all(e.season_kind == "regular" for e in draft.episodes)
    assert {eid for e in draft.episodes for eid in e.asset_evidence_ids} == set(paths[:2])
    service.confirm("special-fixture")
    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works").fetchone()[0]
        job_id = conn.execute("SELECT job_id FROM jobs WHERE job_type='materialize_mirror'").fetchone()[0]
    result = V4MirrorMaterializer(database).process(job_id, tmp_path / "mirror")
    assert result.status == "succeeded"
    assert len(list((tmp_path / "mirror").rglob("*.strm"))) == 2
    monkeypatch.setattr(library_v4, "get_database", lambda: database)
    detail = library_v4.get_work_detail(work_id)
    assert len(detail["episodes"]) == 2
    assert all(e["kind"] == "regular" for e in detail["episodes"])
    assert {e["original_filename"] for e in detail["episodes"]} == {PurePosixPath(p).name for p in paths[:2]}
