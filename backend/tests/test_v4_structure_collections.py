"""非媒体合集必须保存子作品关系，不占用 TV Work 或 Season 身份。"""

import json
import sqlite3
from dataclasses import asdict, replace

import pytest
from backend.tests.test_v4_library_projection import _ready_library
from backend.tests.test_v4_structure_context import resolve as _resolve

from app.media_v4.persistence.database import V4Database
from app.media_v4.projection.library import V4LibraryProjection
from app.media_v4.resolution.candidates import merge_graph
from app.media_v4.revisions.service import V4RevisionService


def resolve(paths, **kwargs):
    """给可确认的结构图合成已挂载的本地播放路径，保留来源定位符。"""
    graph, pairs = _resolve(paths, **kwargs)
    mounted_pairs = [
        (replace(evidence, playback_locator=f"C:/KumiTest/collections/{evidence.relative_path}"), facts)
        for evidence, facts in pairs
    ]
    return graph, mounted_pairs

PATHS = ["动画/物语系列/化物语/化物语 S01E01.mkv",
         "动画/物语系列/伪物语/伪物语 S01E01.mkv"]


@pytest.mark.parametrize("parsed", [False, True])
def test_ordinary_standalone_movie_keeps_online_canonical_title(tmp_path, parsed):
    from dataclasses import replace

    from backend.tests.test_v4_library_projection import _entry
    db = V4Database(tmp_path / "ordinary-movie.db")
    db.initialize()
    if parsed:
        _, pairs = resolve(["Movies/Local Film (2024)/Local Film Movie.mkv"])
    else:
        evidence, facts = _entry("movie")
        pairs = [(evidence, replace(facts, media_type="movie", group_type="movie",
                                   card_type="standalone", series_group=""))]
    service = V4RevisionService(db)
    service.create_draft("ordinary-movie", pairs)
    service.confirm("ordinary-movie")
    with db.connect() as conn:
        conn.execute("INSERT INTO scrape_bindings(binding_id,revision_id,work_id,provider,provider_id,metadata_json,status,created_at,updated_at) "
                     "SELECT 'binding-'||work_id,'ordinary-movie',work_id,'tmdb','42',?,'confirmed','now','now' FROM works",
                     (json.dumps({"title": "Canonical Online Film", "metadata_state": "ready"}),))
    _ready_library(db)
    card = V4LibraryProjection(db).rebuild().cards[0]
    assert card["card_type"] == "standalone"
    assert card["metadata"]["collections"] == []
    assert card["title"] == "Canonical Online Film"


@pytest.mark.parametrize("scope", ["collection", "parent_child"])
def test_verified_movie_title_is_stable_across_projection_detail_and_refresh(tmp_path, monkeypatch, scope):
    from dataclasses import replace

    from backend.tests.test_v4_library_projection import _entry

    from app.api import library_v4

    db = V4Database(tmp_path / "canonical-title.db")
    db.initialize()
    evidence, facts = _entry("movie-title")
    movie = replace(facts, work_title="1 Tabidachi no Yoake", media_type="movie", group_type="movie",
                    card_type="standalone", series_group="")
    service = V4RevisionService(db)
    service.create_draft("title", [(evidence, movie)])
    service.confirm("title")
    with db.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM works").fetchone()[0]
        original = conn.execute("SELECT preferred_title FROM works WHERE work_id=?", (work_id,)).fetchone()[0]
        if scope == "collection":
            conn.execute("INSERT INTO media_collections(collection_id,collection_key,preferred_title,root_id,created_at) VALUES('films','films','电影合集','root-projection','now')")
            conn.execute("INSERT INTO revision_collection_members(revision_id,collection_id,work_id) VALUES('title','films',?)", (work_id,))
        else:
            parent_evidence, parent_facts = _entry("parent-title")
            parent_evidence = replace(parent_evidence, root_id="root-parent-title", scan_id="scan-parent-title")
            service.create_draft("parent", [(parent_evidence, parent_facts)])
            service.confirm("parent")
            parent_id = conn.execute("SELECT work_id FROM works WHERE work_id != ?", (work_id,)).fetchone()[0]
            conn.execute("INSERT INTO work_relations(relation_id,parent_work_id,child_work_id,relation_type) VALUES('movie-relation',?,?,'movie')", (parent_id, work_id))
        metadata = {"title": "来自深渊：启程的拂晓", "provider": "tmdb", "provider_id": "526426",
                    "media_type": "movie", "metadata_state": "ready"}
        conn.execute("INSERT INTO scrape_bindings(binding_id,revision_id,work_id,provider,provider_id,metadata_json,status,created_at,updated_at) VALUES('scrape','title',?,'tmdb','526426',?,'ready','now','now')",
                     (work_id, json.dumps(metadata, ensure_ascii=False)))
    monkeypatch.setattr(library_v4, "get_database", lambda: db)
    projection = V4LibraryProjection(db)
    _ready_library(db)
    projected = next(card for card in projection.rebuild().cards if card["work_id"] == work_id)
    assert projected["title"] == metadata["title"]
    with db.connect() as conn:
        conn.execute("UPDATE library_cards SET title=? WHERE work_id=?", (original, work_id))
        conn.execute("UPDATE v4_meta SET value='regular-only-2' WHERE key='library_presentation_policy'")
    # 已发布的旧投影也自动更新，不能只修复以后新建的媒体库。
    assert next(card for card in projection.rebuild().cards if card["work_id"] == work_id)["title"] == metadata["title"]
    for _ in range(2):
        listed = next(work for work in library_v4.get_library()["works"] if work["work_id"] == work_id)
        detailed = library_v4.get_work_detail(work_id)
        assert listed["title"] == detailed["title"] == metadata["title"]
        projection.rebuild()
    with db.connect() as conn:
        assert conn.execute("SELECT preferred_title FROM works WHERE work_id=?", (work_id,)).fetchone()[0] == original
        conn.execute("INSERT INTO work_overrides(work_id,override_json,created_at,updated_at) VALUES(?,?, 'now','now')", (work_id, json.dumps({"title": "我的中文名"})))
    listed = next(work for work in library_v4.get_library()["works"] if work["work_id"] == work_id)
    assert listed["title"] == library_v4.get_work_detail(work_id)["title"] == "我的中文名"


def test_shared_tv_title_guard_is_identical_in_list_and_detail(tmp_path, monkeypatch):
    from app.api import library_v4

    db = V4Database(tmp_path / "shared-tv-title.db")
    db.initialize()
    _, pairs = resolve(["动画/来自深渊/来自深渊 S01E01.mkv",
                        "动画/来自深渊 烈日的黄金乡/来自深渊 烈日的黄金乡 S01E01.mkv"])
    service = V4RevisionService(db)
    service.create_draft("shared", pairs)
    service.confirm("shared")
    metadata = {"title": "Online Parent", "provider": "tmdb", "provider_id": "42",
                "media_type": "tv", "metadata_state": "ready"}
    with db.connect() as conn:
        conn.execute("INSERT INTO provider_bindings(work_id,provider,provider_id,media_type) SELECT work_id,'tmdb','42','tv' FROM works")
        conn.execute("INSERT INTO scrape_bindings(binding_id,revision_id,work_id,provider,provider_id,metadata_json,status,created_at,updated_at) SELECT 'binding-'||work_id,'shared',work_id,'tmdb','42',?,'ready','now','now' FROM works", (json.dumps(metadata, ensure_ascii=False),))
    monkeypatch.setattr(library_v4, "get_database", lambda: db)
    _ready_library(db)
    V4LibraryProjection(db).rebuild()  # 先由后台发布，再核对只读列表与详情的一致性。
    listed = library_v4.get_library()["works"]
    assert {work["title"] for work in listed} == {"来自深渊", "来自深渊 烈日的黄金乡"}
    for work in listed:
        assert library_v4.get_work_detail(work["work_id"])["title"] == work["title"]


def test_shared_tv_uses_reliable_chinese_online_title():
    from app.media_v4.projection.presentation import display_work_title, preserve_identity_title

    metadata = {"title": "来自深渊", "provider": "tmdb", "provider_id": "42",
                "media_type": "tv", "collections": [{"collection_id": "set"}]}
    preserve = preserve_identity_title("work", "tv", metadata, {"work"}, {"work"})
    assert preserve is False
    assert display_work_title("來自深淵 烈日的黃金鄉", metadata, preserve_identity=preserve) == "来自深渊"
    assert display_work_title("來自深淵 烈日的黃金鄉", metadata, preserve_identity=preserve,
                              override={"title": "用户覆盖标题"}) == "用户覆盖标题"

    english_metadata = {**metadata, "title": "ReLIFE"}
    preserve_english = preserve_identity_title("work", "tv", english_metadata, {"work"}, {"work"})
    assert preserve_english is True
    assert display_work_title("ReLIFE 完结篇", english_metadata,
                              preserve_identity=preserve_english) == "ReLIFE 完结篇"


@pytest.mark.parametrize("scope", ["confirmed_parent", "shared_tv_identity"])
def test_confirmed_child_identity_protects_title_without_collection(tmp_path, scope):
    db = V4Database(tmp_path / "child-title.db")
    db.initialize()
    paths = (["动画/玉子市场/玉子市场 S01E01.mkv", "动画/玉子市场/玉子爱情故事 [1080p].mkv"]
             if scope == "confirmed_parent" else
             ["动画/来自深渊/来自深渊 S01E01.mkv", "动画/来自深渊 烈日的黄金乡/来自深渊 烈日的黄金乡 S01E01.mkv"])
    _, pairs = resolve(paths)
    service = V4RevisionService(db)
    service.create_draft("child-title", pairs)
    service.confirm("child-title")
    with db.connect() as conn:
        conn.execute("INSERT INTO scrape_bindings(binding_id,revision_id,work_id,provider,provider_id,metadata_json,status,created_at,updated_at) "
                     "SELECT 'binding-'||work_id,'child-title',work_id,'tmdb','42',?,'confirmed','now','now' FROM works",
                     (json.dumps({"title": "Online Parent Title", "metadata_state": "ready"}),))
        if scope == "shared_tv_identity":
            conn.execute("INSERT INTO provider_bindings(work_id,provider,provider_id,media_type) "
                         "SELECT work_id,'tmdb','42','tv' FROM works")
    _ready_library(db)
    cards = V4LibraryProjection(db).rebuild().cards
    child_title = "玉子爱情故事" if scope == "confirmed_parent" else "来自深渊 烈日的黄金乡"
    assert child_title in {card["title"] for card in cards}
    assert all(card["metadata"]["title"] == "Online Parent Title" for card in cards)


def test_collection_graph_is_non_media_and_survives_candidate_merge():
    graph, _ = resolve(PATHS)
    assert len(graph.collections) == 1
    collection = graph.collections[0]
    assert collection.preferred_title == "物语系列"
    assert set(collection.member_work_keys) == {work.work_key for work in graph.works}
    assert all(work.preferred_title != "物语系列" for work in graph.works)
    left, right = [work.work_key for work in graph.works]
    merged = merge_graph(graph, {right: left})
    assert merged.collections[0].member_work_keys == (left,)


def test_collection_direct_files_and_nested_children_have_same_boundaries():
    graph, _ = resolve(["动画/物语系列/化物语 S01E01.mkv",
                        "动画/物语系列/伪物语 S01E01.mkv",
                        "动画/物语系列/化物语/化物语 S01E02.mkv"])
    assert {work.preferred_title for work in graph.works} == {"化物语", "伪物语"}
    assert len(graph.collections) == 1
    assert len(graph.collections[0].member_work_keys) == 2


def test_same_named_collections_in_different_source_branches_do_not_mix():
    graph, _ = resolve(["动画/归档甲/精选合集/作品甲/作品甲 S01E01.mkv",
                        "动画/归档乙/精选合集/作品乙/作品乙 S01E01.mkv"])
    assert len(graph.collections) == 2
    assert all(len(collection.member_work_keys) == 1 for collection in graph.collections)


def test_confirmed_collection_persists_projects_and_obeys_retirement(tmp_path, monkeypatch):
    db = V4Database(tmp_path / "collections.db")
    db.initialize()
    _, pairs = resolve(PATHS)
    before = [asdict(facts) for _, facts in pairs]
    service = V4RevisionService(db)
    service.create_draft("rev", pairs)
    service.confirm("rev")
    with db.connect() as conn:
        conn.execute("INSERT INTO scrape_bindings(binding_id,revision_id,work_id,provider,provider_id,metadata_json,status,created_at,updated_at) "
                     "SELECT 'binding-'||work_id,'rev',work_id,'tmdb','42',?,'confirmed','now','now' FROM works",
                     (json.dumps({"title": "母系列在线标题", "metadata_state": "ready", "related_works": None}),))
    _ready_library(db)
    first = V4LibraryProjection(db).rebuild()
    assert len(first.cards) == 2
    assert all(card["metadata"]["collections"][0]["title"] == "物语系列" for card in first.cards)
    assert all("collection_related_works" not in card["metadata"] for card in first.cards)
    assert {card["title"] for card in first.cards} == {"化物语", "伪物语"}
    from app.api import library_v4
    monkeypatch.setattr(library_v4, "get_database", lambda: db)
    library = library_v4.get_library()
    assert len(library["collections"]) == 1
    assert set(library["collections"][0]["work_ids"]) == {card["work_id"] for card in first.cards}
    detail = library_v4.get_work_detail(first.cards[0]["work_id"])
    assert detail["collections"][0]["title"] == "物语系列"
    assert detail["related_works"] == []
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM media_collections").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM revision_collection_members").fetchone()[0] == 2
        conn.execute("UPDATE source_roots SET retired_at='retired'")
    assert not V4LibraryProjection(db).rebuild().cards
    assert [asdict(service.repository.get_parsed_facts(facts.parsed_fact_id)) for _, facts in pairs] == before


def test_hidden_work_is_not_reintroduced_through_collection_relations(tmp_path):
    from app.media_v4.projection.collections import collection_metadata
    db = V4Database(tmp_path / "hidden.db")
    db.initialize()
    _, pairs = resolve(PATHS)
    service = V4RevisionService(db)
    service.create_draft("hidden", pairs)
    service.confirm("hidden")
    with db.connect() as conn:
        hidden, visible = [row[0] for row in conn.execute("SELECT work_id FROM works ORDER BY preferred_title")]
        conn.execute("INSERT INTO work_overrides(work_id,override_json,created_at,updated_at) VALUES(?,?,?,?)",
                     (hidden, json.dumps({"hidden": True}), "now", "now"))
        value = collection_metadata(conn)
        assert hidden not in value
        assert "collection_related_works" not in value[visible]


def test_v25_physical_fixture_migration_preserves_existing_confirmed_data(tmp_path):
    # 使用旧版导出的物理 DDL，不用当前建表函数伪装旧 schema。
    from pathlib import Path
    db = V4Database(tmp_path / "old.db")
    with sqlite3.connect(db.path) as conn:
        conn.executescript(Path(__file__).with_name("fixtures").joinpath("v4_schema_v25_structure.sql").read_text(encoding="utf-8"))
        conn.execute("INSERT INTO v4_meta(key,value) VALUES('structure-preservation',?)",
                     (json.dumps({"中文": "保留"}, ensure_ascii=False),))
        conn.execute("INSERT INTO works(work_id,identity_key,preferred_title,work_type,created_at,updated_at) VALUES('old','old-identity','旧作品','series','now','now')")
        conn.commit()
    db.initialize()
    _, old_pairs = resolve(["旧来源/迁移正片 S01E01.mkv"])
    service = V4RevisionService(db)
    service.create_draft("old-confirmed", old_pairs)
    service.confirm("old-confirmed")
    protected = ("source_evidence", "parsed_facts", "import_revisions", "revision_bindings",
                 "works", "seasons", "episodes", "editions", "assets", "jobs")
    with db.connect() as conn:
        before = {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                  for table in protected}
    db.initialize()
    with db.connect() as conn:
        from app.media_v4.persistence.database import V4_SCHEMA_VERSION

        assert conn.execute("PRAGMA user_version").fetchone()[0] == V4_SCHEMA_VERSION
        assert conn.execute("SELECT preferred_title FROM works WHERE work_id='old'").fetchone()[0] == "旧作品"
        assert json.loads(conn.execute("SELECT value FROM v4_meta WHERE key='structure-preservation'").fetchone()[0]) == {"中文": "保留"}
        assert not conn.execute("SELECT * FROM media_collections").fetchall()
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        after = {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                 for table in protected}
        assert after == before
    db.initialize()
    with db.connect() as conn:
        assert conn.execute("SELECT status FROM import_revisions WHERE revision_id='old-confirmed'").fetchone()[0] == "confirmed"


def test_independent_unknown_candidate_excludes_parent_from_identity_aliases(tmp_path):
    from app.media_v4.resolution.candidates import work_identity_title_inputs
    graph, pairs = resolve(["动画/玉子市场/玉子市场 S01E01.mkv",
                            "动画/玉子市场/尚未收录的爱情故事 [1080p].mkv"])
    child = next(work for work in graph.works if work.preferred_title == "尚未收录的爱情故事")
    related = [facts for evidence, facts in pairs if evidence.evidence_id in child.source_evidence_ids]
    assert child.media_type == "unknown"
    assert work_identity_title_inputs(child, related) == ["尚未收录的爱情故事"]
    db = V4Database(tmp_path / "candidate.db")
    db.initialize()
    service = V4RevisionService(db)
    service.create_draft("candidate", pairs)
    evidence_id = child.source_evidence_ids[0]
    overridden = service.apply_override("candidate", evidence_id, {"media_type": "movie", "group_type": "movie"})
    movie = next(work for work in overridden.works if evidence_id in work.source_evidence_ids)
    assert movie.preferred_title == "尚未收录的爱情故事" and movie.show_type == "anime_movie"
    service.confirm("candidate")
    with db.connect() as conn:
        aliases = conn.execute("SELECT a.normalized_title FROM work_aliases a JOIN works w ON w.work_id=a.work_id WHERE w.preferred_title=?",
                               (movie.preferred_title,)).fetchall()
        assert aliases
        assert "玉子市场" not in {row[0] for row in aliases}
