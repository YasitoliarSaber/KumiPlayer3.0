"""O11：schema 版本号必须只有一个事实来源，且与 PRAGMA 字面量一致。

`PRAGMA user_version` 的值位置不接受绑定参数，只能在 `database.py` 里写字面量。
这个"常量 + 字面量"的双份结构已经咬过两次：
- 只改常量忘改字面量 → 每次启动先写错版本再抛 RuntimeError，应用根本起不来；
- 字面量落后一个版本 → 落库版本低于实际结构，下次启动被判"旧后端数据架构需要重置"，
  用户被要求清空媒体库。

因此这里把"单一来源"和"字面量一致"都变成测试，而不是依赖注释里的承诺。
"""

from __future__ import annotations

import re
from pathlib import Path


def _app_root() -> Path:
    return Path(__file__).resolve().parents[1] / "app"


def test_runtime_user_version_matches_the_schema_constant(tmp_path):
    """运行态版本号必须等于唯一常量；重复初始化不得改写或回退版本。"""

    import sqlite3

    from app.media_v4.persistence.database import V4Database
    from app.media_v4.persistence.schema_v4 import V4_SCHEMA_VERSION

    path = tmp_path / "schema-version.db"
    V4Database(path).initialize()
    with sqlite3.connect(path) as conn:
        written = int(conn.execute("PRAGMA user_version").fetchone()[0])
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert written == V4_SCHEMA_VERSION
    assert {"source_evidence", "parsed_facts", "works", "episodes"} <= tables
    # 再次打开既有库：版本读回一致，不会"旧后端数据架构需要重置"。
    V4Database(path).initialize()
    with sqlite3.connect(path) as conn:
        assert int(conn.execute("PRAGMA user_version").fetchone()[0]) == V4_SCHEMA_VERSION

    source = (_app_root() / "media_v4" / "persistence" / "database.py").read_text(encoding="utf-8")
    # 只允许一处写入字面量：多出来的那一份迟早与常量漂移。
    assert source.count("PRAGMA user_version = ") == 1


def test_schema_version_is_defined_in_exactly_one_module():
    definitions: list[str] = []
    for path in _app_root().rglob("*.py"):
        for line in path.read_text(encoding="utf-8").splitlines():
            if re.match(r"\s*V4_SCHEMA_VERSION\s*=", line):
                definitions.append(path.relative_to(_app_root()).as_posix())

    assert definitions == ["media_v4/persistence/schema_v4.py"], (
        f"版本号只能定义在 schema_v4.py，实际：{definitions}"
    )


def test_media_domain_package_exposes_no_stale_version_constant():
    import app.media_v4 as media_domain

    assert not hasattr(media_domain, "V4_SCHEMA_VERSION"), (
        "app.media_v4 不应再暴露版本号副本（历史上曾是陈旧的 4）"
    )


def test_deleted_scan_state_helpers_stay_deleted():
    """README/注释曾经承诺"统一阶段语义"，但那些常量无人引用；删掉后不要被重新加回。"""

    from app.media_v4.sources import scan_state

    for name in ("ACTIVE_SCAN_STATUSES", "TERMINAL_SCAN_STATUSES", "STAGE_LABELS", "stage_order"):
        assert not hasattr(scan_state, name), f"{name} 已确认无引用，不应重新引入"
