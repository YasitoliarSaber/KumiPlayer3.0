"""V4 来源根与 durable scan 登记的原子发布合同。"""

from __future__ import annotations

import pytest


def _database(tmp_path):
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / "scan-registration.db")
    database.initialize()
    return database


def _root_spec():
    return {
        "root_id": "root-registration",
        "provider": "openlist",
        "ingest_method": "openlist_scan",
        "source_locator": "/Anime",
        "playback_locator": "K:\\OpenList\\Anime",
        "route_id": "route-anime",
        "root_container": "Anime",
        "source_mode": "openlist_full",
        "last_scan_mode": "full",
    }


def _scan_spec():
    return {
        "scan_id": "scan-registration",
        "root_id": "root-registration",
        "scan_kind": "openlist_full",
        "source_mode": "openlist_full",
        "request": {"remote_root": "/Anime"},
    }


def test_durable_registration_rolls_back_root_when_scan_insert_fails(tmp_path, monkeypatch):
    from app.api import media_v4
    from app.media_v4.sources import source_scan_runner

    database = _database(tmp_path)

    def fail_registration(*_args, **_kwargs):
        raise RuntimeError("登记失败")

    monkeypatch.setattr(source_scan_runner, "register_source_scan", fail_registration)

    with pytest.raises(RuntimeError, match="登记失败"):
        media_v4._register_durable_source_scan(
            database,
            root=_root_spec(),
            scan=_scan_spec(),
        )

    with database.connect() as conn:
        assert conn.execute(
            "SELECT 1 FROM source_roots WHERE root_id = 'root-registration'"
        ).fetchone() is None
        assert conn.execute(
            "SELECT 1 FROM source_scans WHERE scan_id = 'scan-registration'"
        ).fetchone() is None


def test_durable_registration_publishes_separate_source_and_playback_locators(tmp_path):
    from app.api import media_v4

    database = _database(tmp_path)
    media_v4._register_durable_source_scan(
        database,
        root=_root_spec(),
        scan=_scan_spec(),
    )

    with database.connect() as conn:
        root = conn.execute(
            "SELECT source_locator, playback_locator FROM source_roots "
            "WHERE root_id = 'root-registration'"
        ).fetchone()
        scan = conn.execute(
            "SELECT root_id, status FROM source_scans WHERE scan_id = 'scan-registration'"
        ).fetchone()
    assert tuple(root) == ("/Anime", "K:\\OpenList\\Anime")
    assert tuple(scan) == ("root-registration", "queued")


@pytest.mark.parametrize("status", ["queued", "running", "paused", "failed", "cancelled", "completed"])
def test_rescan_of_retired_source_has_card_before_draft_without_reviving_media(tmp_path, status):
    from app.api import media_v4
    from app.media_v4.projection.source_libraries import list_source_cards

    database = _database(tmp_path)
    root = {**_root_spec(), "provider": "quark"}
    media_v4._ensure_root_container(database, **root)
    with database.connect() as conn:
        conn.execute(
            "UPDATE source_roots SET retired_at='2000-01-01T00:00:00+00:00', "
            "retired_reason='fixture cleanup' WHERE root_id=?", (root["root_id"],),
        )
    assert list_source_cards(database) == []

    media_v4._register_durable_source_scan(database, root=root, scan=_scan_spec())
    with database.connect() as conn:
        conn.execute("UPDATE source_scans SET status=? WHERE scan_id=?", (status, "scan-registration"))
    # 模拟返回页面：新读取者只依赖持久状态，不依赖原页面或扫描线程。
    cards = list_source_cards(type(database)(database.path))
    assert len(cards) == 1
    assert cards[0]["scan"]["scan_id"] == "scan-registration"
    assert cards[0]["scan"]["status"] == status
    assert cards[0]["revision_id"] == ""
    assert cards[0]["has_confirmed_baseline"] is False
    assert cards[0]["counts_scope"] == "scan"
    with database.connect() as conn:
        retired = conn.execute("SELECT retired_at,retired_reason FROM source_roots WHERE root_id=?",
                               (root["root_id"],)).fetchone()
        assert tuple(retired) == ("2000-01-01T00:00:00+00:00", "fixture cleanup")
        assert conn.execute("SELECT COUNT(*) FROM import_revisions").fetchone()[0] == 0


@pytest.mark.parametrize("status", ["queued", "running", "failed", "cancelled"])
def test_rescan_keeps_pending_cleanup_on_the_same_card(tmp_path, status):
    from app.api import media_v4
    from app.media_v4.maintenance.source_deletion import enqueue_source_deletion
    from app.media_v4.projection.source_libraries import list_source_cards

    from tests.test_v4_source_deletion import _two_sources

    database, _mirror = _two_sources(tmp_path)
    job_id = enqueue_source_deletion(database, "root-a")
    with database.connect() as conn:
        conn.execute("UPDATE source_roots SET retired_at='2000-01-01T00:00:00+00:00',enabled=0 WHERE root_id='root-a'")
        conn.execute("UPDATE jobs SET status=? WHERE job_id=?", (status, job_id))
        cleanup_revision = conn.execute("SELECT revision_id FROM jobs WHERE job_id=?", (job_id,)).fetchone()[0]
    media_v4._register_durable_source_scan(database, root={**_root_spec(), "root_id": "root-a"},
                                         scan={**_scan_spec(), "root_id": "root-a"})
    cards = [card for card in list_source_cards(database) if card["root_id"] == "root-a"]
    assert len(cards) == 1
    card = cards[0]
    assert card["phase"] == "scan"
    assert card["scan"]["scan_id"] == "scan-registration"
    assert card["revision_id"] == ""
    assert card["work_count"] is None
    assert card["pending_cleanup"] == {"status": status, "revision_id": cleanup_revision}
    assert card["deletion_retry_required"] is (status in {"failed", "cancelled"})
    assert card["job_summary"][status] == 1
    with database.connect() as conn:
        conn.execute("UPDATE jobs SET status='succeeded' WHERE job_id=?", (job_id,))
    card = next(card for card in list_source_cards(database) if card["root_id"] == "root-a")
    assert not card.get("pending_cleanup")


def test_scan_before_retirement_does_not_restore_source_card(tmp_path):
    from app.api import media_v4
    from app.media_v4.projection.source_libraries import list_source_cards

    database = _database(tmp_path)
    media_v4._register_durable_source_scan(database, root=_root_spec(), scan=_scan_spec())
    with database.connect() as conn:
        conn.execute("UPDATE source_roots SET retired_at='2999-01-01T00:00:00+00:00'")
    assert list_source_cards(database) == []


def test_rescan_card_does_not_expose_old_confirmed_revision_or_unhide_disabled_card(tmp_path):
    from datetime import UTC, datetime

    from app.api import media_v4
    from app.media_v4.projection.source_libraries import list_source_cards
    from app.media_v4.revisions.service import V4RevisionService

    from tests.test_v4_source_reactivation import _entry

    database = _database(tmp_path)
    revisions = V4RevisionService(database)
    revisions.create_draft("rev-old", [_entry("root-registration")])
    revisions.confirm("rev-old")
    with database.connect() as conn:
        conn.execute("UPDATE jobs SET status='succeeded' WHERE revision_id='rev-old'")
        conn.execute("UPDATE source_roots SET retired_at=?", (datetime.now(UTC).isoformat(),))
        before = conn.execute("SELECT COUNT(*) FROM revision_bindings").fetchone()[0]
    media_v4._register_durable_source_scan(database, root=_root_spec(), scan=_scan_spec())

    card = list_source_cards(database)[0]
    assert card["phase"] == "scan"
    assert card["revision_id"] == ""
    assert card["has_confirmed_baseline"] is False
    assert card["work_count"] is None
    with database.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM revision_bindings").fetchone()[0] == before
        assert conn.execute("SELECT status FROM import_revisions WHERE revision_id='rev-old'").fetchone()[0] == "confirmed"
        conn.execute("UPDATE source_roots SET enabled=0")
    assert list_source_cards(database) == []
