"""pytest 测试隔离。

项目运行时配置位于项目根 data/config.json，包含真实路径和本机 token。
测试期间把 app.core.config.CONFIG_FILE 指向测试专用配置，避免读取、删除或
覆盖真实配置文件。
"""

import os
import shutil
import sqlite3
import sys
import threading
from pathlib import Path

import pytest

_PROJECT_ROOT = Path(__file__).parent.parent.parent
_REAL_DATA_DIR = (_PROJECT_ROOT / "data").resolve()
_COLLECTION_DATA_DIR = _PROJECT_ROOT / "backend" / ".pytest_runtime" / "data"
os.environ.setdefault("KUMIPLAYER_DATA_DIR", str(_COLLECTION_DATA_DIR))

for _path in (_PROJECT_ROOT, _PROJECT_ROOT / "backend"):
    _path_text = str(_path)
    if _path_text not in sys.path:
        sys.path.insert(0, _path_text)


def _close_db_connections_inside(target: Path, connections: list) -> None:
    """只关闭明确登记且所属线程已退出的测试连接，避免跨线程 SQLite 探测。"""
    resolved = target.absolute()
    current = threading.current_thread()
    for db_path, connection, owner in connections:
        if not db_path.is_relative_to(resolved) or (owner is not current and owner.is_alive()):
            continue
        try:
            connection.close()
        except sqlite3.Error:
            pass


def _is_real_data_path(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path.absolute()
    return resolved == _REAL_DATA_DIR or _REAL_DATA_DIR in resolved.parents


def _install_real_config_guard() -> None:
    """防止任何测试路径（含后台线程）写入真实 data/config.json。

    与 rmtree 守卫同理：即使 CONFIG_FILE monkeypatch 被撤销、或残留后台线程
    调用 load/save_config，写入真实配置文件也会被拒绝。
    """
    from app.core import config as core_config

    original_persist = core_config._persist_config_payload

    def guarded_persist(config, *, cleared_keys=None) -> None:
        target = core_config.get_config_file()
        if _is_real_data_path(target):
            raise AssertionError(f"测试禁止写入真实配置文件: {target}")
        return original_persist(config, cleared_keys=cleared_keys)

    core_config._persist_config_payload = guarded_persist


_install_real_config_guard()


@pytest.fixture(autouse=True)
def isolate_runtime_data(tmp_path, monkeypatch, request):
    """Route runtime data/config to pytest temp paths and protect real data."""
    test_data_dir = tmp_path / "data"
    test_config_file = test_data_dir / "config.json"
    test_data_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("KUMIPLAYER_DATA_DIR", str(test_data_dir))

    for attr in ("_DATA_DIR", "_TEST_DATA_DIR"):
        if hasattr(request.module, attr):
            monkeypatch.setattr(request.module, attr, test_data_dir, raising=False)
    if hasattr(request.module, "_TEST_DIR"):
        monkeypatch.setattr(request.module, "_TEST_DIR", test_data_dir / "_test_local", raising=False)

    original_rmtree = shutil.rmtree
    from app.media_v4.persistence.database import V4Database

    connections: list[tuple[Path, sqlite3.Connection, threading.Thread]] = []
    original_open = V4Database.open_connection

    def tracked_open(database):
        connection = original_open(database)
        connections.append((database.path.absolute(), connection, threading.current_thread()))
        return connection

    monkeypatch.setattr(V4Database, 'open_connection', tracked_open)

    def guarded_rmtree(path, *args, **kwargs):
        target = Path(path)
        if _is_real_data_path(target):
            raise AssertionError(f"测试禁止删除真实运行数据目录: {target}")
        # Preflight 0 兼容：老测试在测试体内清理「测试数据目录」
        # （_TEST_DATA_DIR 被隔离到 tmp/data，独立 db 也在此目录下）。
        # 先关闭持有 db 文件的连接（Windows 文件占用锁），删除成功后
        # 按当前 data 目录重建干净独立数据库，避免 no such table。
        db_path = target / "kumiplayer.db"
        db_inside = any(
            candidate.exists()
            for candidate in (
                db_path,
                target / "kumiplayer.db-wal",
                target / "kumiplayer.db-shm",
            )
        )
        # 临时 TXT 复制目录没有数据库，不得遍历并触碰其他线程的 SQLite
        # 连接；在 Windows 下探测正在使用的连接可能导致原生访问冲突。
        if db_inside:
            _close_db_connections_inside(target, connections)
        result = original_rmtree(path, *args, **kwargs)
        if db_inside:
            from app.api import media_v4
            from app.media_v4.persistence.database import V4Database
            from app.media_v4.runtime import get_database as get_v4_database

            get_v4_database.cache_clear()
            media_v4._database = None
            V4Database(db_path).initialize()
        return result

    monkeypatch.setattr(shutil, "rmtree", guarded_rmtree)

    try:
        from app.core import config as core_config

        monkeypatch.setattr(core_config, "CONFIG_FILE", test_config_file)
        test_config_file.unlink(missing_ok=True)
        core_config.invalidate_config_cache()
    except Exception:
        pass

    # V4 是应用运行时唯一的媒体数据库。旧 fixture 曾先创建 V3 数据库，
    # 导致 TestClient(app) 被 V4 的 ResetRequiredError 拦截。
    from app.api import media_v4
    from app.media_v4.persistence.database import V4Database
    from app.media_v4.runtime import get_database as get_v4_database

    get_v4_database.cache_clear()
    media_v4._database = None
    V4Database(test_data_dir / "kumiplayer.db").initialize()

    try:
        yield
    finally:
        from app.media_v4.sources.source_scan_runner import reset_source_scan_runner

        reset_source_scan_runner()
        try:
            from app.api import media_v4
            from app.media_v4.runtime import get_database as get_v4_database

            get_v4_database.cache_clear()
            media_v4._database = None
        except Exception:
            pass
        _close_db_connections_inside(tmp_path, connections)
        try:
            from app.media_v4.sources import health as source_health

            source_health.close_connection()
        except Exception:
            pass
        try:
            from app.core import config as core_config

            core_config.invalidate_config_cache()
            test_config_file.unlink(missing_ok=True)
        except Exception:
            pass


@pytest.fixture(autouse=True)
def isolate_path_config_alias(monkeypatch):
    """Keep modules that imported load_config indirectly on the isolated config."""
    try:
        from app.core import config as core_config
        from app.core import paths as core_paths

        if hasattr(core_paths, "load_config"):
            monkeypatch.setattr(core_paths, "load_config", core_config.load_config)
    except Exception:
        pass

    yield


@pytest.fixture(scope="session", autouse=True)
def init_collection_db():
    """保留集合级 fixture 名称；实际数据库由函数级隔离 fixture 建立。"""
    yield
