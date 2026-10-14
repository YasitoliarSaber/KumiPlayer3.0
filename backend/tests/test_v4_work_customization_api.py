from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager

from app.api import work_customization_v4
from app.api.work_customization_v4 import WorkTag, WorkTagsRequest


class _Database:
    def __init__(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("CREATE TABLE works(work_id TEXT PRIMARY KEY)")
        self.connection.execute(
            "CREATE TABLE work_overrides(work_id TEXT PRIMARY KEY, override_json TEXT, created_at TEXT, updated_at TEXT)"
        )
        self.connection.execute("INSERT INTO works VALUES ('work-1')")
        self.connection.execute(
            "INSERT INTO work_overrides VALUES ('work-1', ?, 'created', 'before')",
            (json.dumps({"title": "手工标题", "local_poster_path": "local-art"}),),
        )
        self.connection.commit()

    @contextmanager
    def connect(self):
        try:
            yield self.connection
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise


def test_saving_tags_preserves_existing_title_and_artwork_overrides(monkeypatch) -> None:
    database = _Database()
    monkeypatch.setattr(work_customization_v4, "get_database", lambda: database)

    response = work_customization_v4.replace_work_tags(
        "work-1",
        WorkTagsRequest(tags=[WorkTag(id="mood", label="收藏待看", color="#7c9cff")]),
    )

    stored = json.loads(database.connection.execute(
        "SELECT override_json FROM work_overrides WHERE work_id='work-1'"
    ).fetchone()[0])
    assert response["tags"] == [{"id": "mood", "label": "收藏待看", "color": "#7c9cff"}]
    assert stored["title"] == "手工标题"
    assert stored["local_poster_path"] == "local-art"
    assert stored["detail_tags"] == response["tags"]


def test_work_tags_request_limits_color_and_label() -> None:
    try:
        WorkTag(id="bad", label="标签", color="red")
    except ValueError:
        pass
    else:
        raise AssertionError("invalid tag colors must be rejected")

    try:
        WorkTagsRequest(tags=[WorkTag(id=f"tag-{index}", label=f"标签{index}", color="#ffffff") for index in range(17)])
    except ValueError:
        pass
    else:
        raise AssertionError("more than 16 work tags must be rejected")
