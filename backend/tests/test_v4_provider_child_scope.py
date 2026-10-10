"""Provider numbering stays inside confirmed child identity and coordinate scope."""

from copy import deepcopy

import pytest
from app.media_v4.domain.models import ParsedFacts, SourceEvidence
from app.media_v4.jobs import metadata, scrape
from app.media_v4.persistence.database import V4Database
from app.media_v4.revisions.service import V4RevisionService


class OfflineProvider:
    def __init__(self):
        self.requests = []

    def get_tv_season_episodes(self, provider_id, season):
        self.requests.append((provider_id, season))
        return {"episodes": [{"episode_number": n, "id": 9000 + season * 100 + n,
                              "name": f"Remote {season}-{n}"} for n in range(1, 30)]}

    @staticmethod
    def build_image_url(_path, _size):
        return ""


def target(title="Child A"):
    return {"preferred_title": title, "work_type": "series",
            "series_group": "Parent Family", "card_type": "main_series",
            "relation_type": "related", "episodes": [
                {"episode_id": title, "season_id": "local-season",
                 "local_season_number": 1, "local_episode_number": 1,
                 "season_kind": "regular", "episode_kind": "regular"}]}


DETAIL = {"name": "Parent Family", "seasons": [{"season_number": 1}, {"season_number": 2}]}


def test_independent_spinoff_uses_its_own_verified_provider_title():
    value = target("Heya Camp")
    value['provider_identity_scope'] = {'confirmed_child': True, 'shared_distinct_tv_ids': []}
    detail = {'name': '房间露营△', 'original_name': 'へやキャン△',
              'alternative_titles': {'results': [{'title': 'Heya Camp'}]},
              'seasons': [{'season_number': 1}]}
    client = OfflineProvider()

    mappings = metadata._build_tv_episode_mappings(client, 95213, value, work_detail=detail)

    assert len(mappings) == 1
    assert client.requests == [(95213, 1)]
    # 同一线上作品已被不同本地身份共享时，别名不能绕开逐集范围核验。
    value['provider_identity_scope']['shared_distinct_tv_ids'] = ['95213']
    assert metadata._build_tv_episode_mappings(OfflineProvider(), 95213, value, work_detail=detail) == []


def test_retained_spinoff_scope_reuses_saved_provider_titles():
    value = target("Heya Camp")
    value['provider_identity_scope'] = {'confirmed_child': True, 'shared_distinct_tv_ids': []}
    detail = {'name': '房间露营△', 'title_aliases': ['Heya Camp'], 'seasons': [{'season_number': 1}]}

    assert len(metadata._build_tv_episode_mappings(OfflineProvider(), 95213, value, work_detail=detail)) == 1


@pytest.mark.parametrize("seasons", [[1], [1, 2]])
def test_children_do_not_guess_parent_provider_coordinates(seasons):
    client = OfflineProvider()
    diagnostics = metadata._empty_mapping_diagnostics()
    detail = {**DETAIL, "seasons": [{"season_number": s} for s in seasons]}
    for title in ("Child A", "Child B"):
        value = target(title)
        original = deepcopy(value)
        assert metadata._build_tv_episode_mappings(
            client, 42, value, work_detail=detail, diagnostics=diagnostics,
        ) == []
        assert value == original
    assert [item["reason"] for item in diagnostics["unmapped_reasons"]] == [
        "ambiguous_provider_child_scope", "ambiguous_provider_child_scope"]
    assert client.requests == []


def test_child_explicit_mapping_beats_local_coordinates():
    value = target()
    value["episodes"][0].update(provider_season_number=2, provider_episode_number=1)
    original = deepcopy(value)
    client = OfflineProvider()
    mappings = metadata._build_tv_episode_mappings(client, 42, value, work_detail=DETAIL)
    assert [(m["provider_season_number"], m["provider_episode_number"]) for m in mappings] == [(2, 1)]
    assert client.requests == [(42, 2)]
    assert value == original


def test_explicit_episode_mapping_keeps_season_even_when_provider_lists_single_season():
    value = target()
    value["episodes"][0].update(local_season_number=2, provider_season_number=2,
                                provider_episode_number=1)
    mappings = metadata._build_tv_episode_mappings(
        OfflineProvider(), 42, value, work_detail={**DETAIL, "seasons": [{"season_number": 1}]},
    )
    assert [(m["provider_season_number"], m["provider_episode_number"]) for m in mappings] == [(2, 1)]


@pytest.mark.parametrize("evidence", ["absolute", "verified"])
def test_child_explicit_numbering_evidence_maps_without_changing_facts(evidence):
    value = target()
    if evidence == "absolute":
        value["episodes"][0].update(absolute_episode_number=14, absolute_origin="explicit_filename")
        detail = {**DETAIL, "seasons": [{"season_number": 1}]}
        expected = (1, 14)
    else:
        value["verified_season_offsets"] = {1: {"offset": 12, "provider_season_number": 2,
                                                "rule_version": "fixture-v1"}}
        detail = DETAIL
        expected = (2, 13)
    original = deepcopy(value)
    mappings = metadata._build_tv_episode_mappings(OfflineProvider(), 42, value, work_detail=detail)
    assert [(m["provider_season_number"], m["provider_episode_number"]) for m in mappings] == [expected]
    assert value == original


def test_ordinary_work_and_alias_title_keep_coordinate_mapping():
    value = target("Localized Title")
    for key in ("series_group", "card_type", "relation_type"):
        value.pop(key)
    mappings = metadata._build_tv_episode_mappings(OfflineProvider(), 42, value, work_detail=DETAIL)
    assert len(mappings) == 1
    assert (mappings[0]["provider_season_number"], mappings[0]["provider_episode_number"]) == (1, 1)


@pytest.mark.parametrize("pair", [(None, 1), (2, None), (0, 1), (2, 0), ("bad", 1)])
def test_partial_episode_mapping_does_not_borrow_local_coordinates(pair):
    value = target("Parent Family")
    value["episodes"][0].update(provider_season_number=pair[0], provider_episode_number=pair[1])
    client = OfflineProvider()
    diagnostics = metadata._empty_mapping_diagnostics()
    assert metadata._build_tv_episode_mappings(client, 42, value, work_detail=DETAIL,
                                               diagnostics=diagnostics) == []
    assert diagnostics["unmapped_reasons"][0]["reason"] == "incomplete_provider_coordinates"
    assert client.requests == []


def test_explicit_season_mapping_supplies_scope_for_local_episode_lookup():
    value = target()
    value["episodes"][0].update(provider_season_number=2, provider_episode_number=None,
                                provider_mapping_source="season", incomplete_provider_mapping=0)
    original = deepcopy(value)
    client = OfflineProvider()
    mappings = metadata._build_tv_episode_mappings(client, 42, value, work_detail=DETAIL)
    assert [(m["provider_season_number"], m["provider_episode_number"]) for m in mappings] == [(2, 1)]
    assert mappings[0]["mapping_basis"] == "existing_season_mapping"
    assert client.requests == [(42, 2)]
    assert value == original


def test_episode_mapping_source_never_borrows_episode_number_from_local():
    value = target()
    value["episodes"][0].update(provider_season_number=2, provider_episode_number=None,
                                provider_mapping_source="episode", incomplete_provider_mapping=1)
    diagnostics = metadata._empty_mapping_diagnostics()
    client = OfflineProvider()
    assert metadata._build_tv_episode_mappings(client, 42, value, work_detail=DETAIL,
                                               diagnostics=diagnostics) == []
    assert diagnostics["unmapped_reasons"][0]["reason"] == "incomplete_provider_coordinates"
    assert client.requests == []


def test_child_verified_mapping_reports_retryable_provider_failure():
    value = target()
    value["verified_season_offsets"] = {1: {"offset": 0, "provider_season_number": 2,
                                            "rule_version": "fixture-v1"}}

    class Unavailable(OfflineProvider):
        def get_tv_season_episodes(self, _provider_id, _season):
            raise metadata.TMDBClientError("fixture unavailable")

    diagnostics = metadata._empty_mapping_diagnostics()
    seasons = []
    assert metadata._build_tv_episode_mappings(Unavailable(), 42, value, work_detail=DETAIL,
                                               season_results=seasons, diagnostics=diagnostics) == []
    assert seasons[0]["status"] == "source_unavailable"
    assert seasons[0]["retryable"] is True
    assert diagnostics["unmapped_reasons"][0]["reason"] == "provider_unavailable"


def entry(key="one", *, number=1, title="Child A", child=False):
    evidence = SourceEvidence(
        evidence_id="ev-" + key, scan_id="scan", root_id="root", source_key=key + ".mkv",
        relative_path=f"{title}/{title} S01E{number:02d}.mkv", entry_kind="video",
        provider="local",
        source_locator=f"C:/KumiTest/provider-child/{key}/{title} S01E{number:02d}.mkv",
        playback_locator=f"C:/KumiTest/provider-child/{key}/{title} S01E{number:02d}.mkv",
        import_family="anime",
    )
    facts = ParsedFacts(
        parsed_fact_id="facts-" + key, evidence_id=evidence.evidence_id, parser_version="fixture",
        work_title=title, title_candidates=(title,), media_type="tv", group_type="season",
        season_candidate=1, episode_candidate=number, show_type="anime_series",
        series_group="Parent Family" if child else "", card_type="main_series" if child else "",
        relation_type="related" if child else "",
    )
    return evidence, facts


def setup_db(tmp_path, entries=None):
    db = V4Database(tmp_path / "scope.db")
    db.initialize()
    revisions = V4RevisionService(db)
    revisions.create_draft("revision", entries or [entry()])
    revisions.confirm("revision")
    job = next(j for j in revisions.list_jobs("revision") if j["job_type"] == "scrape_work")
    return db, revisions, job


@pytest.mark.parametrize("season_mapping", [None, 1])
@pytest.mark.parametrize("pair", [(2, 1), (None, 1), (2, None)])
def test_confirmed_scrape_loads_episode_pair_without_season_splicing(tmp_path, season_mapping, pair):
    db, _revisions, job = setup_db(tmp_path)
    with db.connect() as conn:
        episode = conn.execute("SELECT episode_id,season_id FROM episodes").fetchone()
        conn.execute("INSERT INTO episode_provider_mappings VALUES (?,'tmdb',?,?,'9201')",
                     (episode["episode_id"], *pair))
        if season_mapping is not None:
            conn.execute("INSERT INTO season_provider_mappings(season_id,provider,provider_season_number) "
                         "VALUES (?,'tmdb',?)", (episode["season_id"], season_mapping))
        original = [tuple(r) for r in conn.execute("SELECT * FROM parsed_facts")]
    captured = []
    scrape.V4ScrapeService(db).process(job["job_id"], lambda value: captured.append(deepcopy(value)) or
                                     {"provider": "local", "metadata_state": "waiting_metadata"},
                                     mirror_root=tmp_path / "mirror")
    loaded = captured[0]["episodes"][0]
    assert (loaded["provider_season_number"], loaded["provider_episode_number"]) == pair
    assert loaded["provider_mapping_source"] == "episode"
    assert (loaded["local_season_number"], loaded["local_episode_number"]) == (1, 1)
    with db.connect() as conn:
        assert [tuple(r) for r in conn.execute("SELECT * FROM parsed_facts")] == original


@pytest.mark.parametrize("child", [False, True])
def test_confirmed_season_only_binding_maps_regular_episode_and_retry_loads_full_pair(tmp_path, child):
    db, _revisions, job = setup_db(tmp_path, [entry(child=child)])
    with db.connect() as conn:
        episode = conn.execute("SELECT episode_id,season_id FROM episodes").fetchone()
        conn.execute("INSERT INTO season_provider_mappings(season_id,provider,provider_season_number) "
                     "VALUES (?,'tmdb',2)", (episode["season_id"],))
        original = [tuple(row) for row in conn.execute("SELECT * FROM parsed_facts")]
    captured = []
    client = OfflineProvider()

    def provider(value):
        captured.append(deepcopy(value))
        mappings = metadata._build_tv_episode_mappings(client, 42, value, work_detail=DETAIL)
        assert [(m["provider_season_number"], m["provider_episode_number"]) for m in mappings] == [(2, 1)]
        return {"provider": "tmdb", "provider_id": "42", "title": "Child A",
                "metadata_state": "ready", "episode_mappings": mappings}

    service = scrape.V4ScrapeService(db)
    service.process(job["job_id"], provider, mirror_root=tmp_path / "mirror")
    assert captured[0]["episodes"][0]["provider_mapping_source"] == "season"
    assert captured[0]["episodes"][0]["provider_episode_number"] is None
    retry = service.requeue_work("revision", job["work_id"])
    service.process(retry["job_id"], provider, mirror_root=tmp_path / "mirror")
    assert captured[1]["episodes"][0]["provider_mapping_source"] == "episode"
    assert client.requests == [(42, 2), (42, 2)]
    with db.connect() as conn:
        assert tuple(conn.execute("SELECT provider_season_number,provider_episode_number "
                                  "FROM episode_provider_mappings").fetchone()) == (2, 1)
        assert tuple(conn.execute("SELECT local_season_number,local_episode_number FROM seasons "
                                  "JOIN episodes USING(season_id)").fetchone()) == (1, 1)
        assert [tuple(row) for row in conn.execute("SELECT * FROM parsed_facts")] == original


def test_confirmed_child_scope_reaches_mapper_and_retry_preserves_facts(tmp_path):
    db, _revisions, job = setup_db(tmp_path, [entry(child=True)])
    client = OfflineProvider()
    captured = []

    def provider(value):
        captured.append(deepcopy(value))
        diagnostics = metadata._empty_mapping_diagnostics()
        mappings = metadata._build_tv_episode_mappings(client, 42, value, work_detail=DETAIL,
                                                      diagnostics=diagnostics)
        assert mappings == []
        assert diagnostics["unmapped_reasons"][0]["reason"] == "ambiguous_provider_child_scope"
        return {"provider": "local", "metadata_state": "waiting_metadata"}

    with db.connect() as conn:
        original = [tuple(r) for r in conn.execute("SELECT * FROM parsed_facts")]
    service = scrape.V4ScrapeService(db)
    service.process(job["job_id"], provider, mirror_root=tmp_path / "mirror")
    retry = service.requeue_work("revision", job["work_id"])
    service.process(retry["job_id"], provider, mirror_root=tmp_path / "mirror")
    assert len(captured) == 2
    assert captured[0]["provider_identity_scope"]["confirmed_child"] is True
    assert client.requests == []
    with db.connect() as conn:
        assert [tuple(r) for r in conn.execute("SELECT * FROM parsed_facts")] == original
        assert conn.execute("SELECT COUNT(*) FROM episode_provider_mappings").fetchone()[0] == 0


@pytest.mark.parametrize("other_title,expected_count", [("Child B", 0), ("Child A", 1)])
def test_shared_provider_scope_compares_confirmed_work_identity_not_just_roots(tmp_path, other_title, expected_count):
    db, revisions, job = setup_db(tmp_path)
    second_evidence, second_facts = entry("other", title=other_title)
    from dataclasses import replace
    second_evidence = replace(second_evidence, root_id="other-root", scan_id="other-scan")
    revisions.create_draft("other-revision", [(second_evidence, second_facts)])
    revisions.confirm("other-revision")
    with db.connect() as conn:
        other_work = conn.execute("SELECT work_id FROM revision_bindings WHERE revision_id='other-revision'").fetchone()[0]
        conn.execute("INSERT INTO provider_bindings(work_id,provider,media_type,provider_id) VALUES (?,'tmdb','tv','42')",
                     (other_work,))
    captured = []

    def provider(value):
        captured.append(deepcopy(value))
        assert len(metadata._build_tv_episode_mappings(OfflineProvider(), 42, value, work_detail=DETAIL)) == expected_count
        return {"provider": "local", "metadata_state": "waiting_metadata"}

    scrape.V4ScrapeService(db).process(job["job_id"], provider, mirror_root=tmp_path / "mirror")
    assert len(captured) == 1


def test_specials_never_request_provider_season_zero():
    value = target()
    value["episodes"][0].update(local_season_number=0, episode_kind="special", provider_season_number=0)
    client = OfflineProvider()
    assert metadata._build_tv_episode_mappings(client, 42, value, work_detail=DETAIL) == []
    assert client.requests == []


@pytest.mark.parametrize("old_mapping", [None, 7])
def test_one_local_season_spanning_provider_seasons_never_uses_last_claim(tmp_path, old_mapping):
    db, _revisions, job = setup_db(tmp_path, [entry("one"), entry("two", number=2)])
    with db.connect() as conn:
        episodes = [dict(r) for r in conn.execute("SELECT episode_id,season_id FROM episodes ORDER BY local_episode_number")]
        season_id = episodes[0]["season_id"]
        if old_mapping is not None:
            conn.execute("INSERT INTO season_provider_mappings(season_id,provider,provider_season_number) "
                         "VALUES (?,'tmdb',?)", (season_id, old_mapping))
    result = {"provider": "tmdb", "provider_id": "42", "metadata_state": "ready", "title": "Child A",
              "episode_mappings": [{"episode_id": row["episode_id"], "provider_season_number": n,
                                    "provider_episode_number": 1, "provider_episode_id": str(9000 + n)}
                                   for n, row in enumerate(episodes, 1)],
              "season_mappings": [{"season_id": season_id, "provider_season_number": n} for n in (1, 2)]}
    scrape.V4ScrapeService(db).process(job["job_id"], lambda _value: result, mirror_root=tmp_path / "mirror")
    with db.connect() as conn:
        rows = conn.execute("SELECT provider_season_number FROM season_provider_mappings").fetchall()
        assert [r[0] for r in rows] == ([] if old_mapping is None else [old_mapping])
        assert [tuple(r) for r in conn.execute("SELECT provider_season_number,provider_episode_number "
                                               "FROM episode_provider_mappings ORDER BY provider_season_number")] == [(1, 1), (2, 1)]
        import json
        saved = json.loads(conn.execute("SELECT metadata_json FROM scrape_bindings").fetchone()[0])
        assert saved["season_mapping_status"] == "partial"
        assert saved["season_mapping_conflicts"] == [season_id]
