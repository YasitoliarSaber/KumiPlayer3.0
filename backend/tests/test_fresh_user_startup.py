"""空数据目录与无凭据环境下的首次使用仿真，不访问用户真实数据。"""

import socket
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import media_v4
from app.core import config
from app.core.paths import get_data_dir
from app.main import app
from app.media_v4.persistence.schema_v4 import V4_SCHEMA_VERSION


def test_fresh_user_starts_with_empty_v4_library_and_no_external_credentials(monkeypatch):
    data = get_data_dir()
    assert data != Path(__file__).resolve().parents[2] / "data"
    # 函数级 fixture 创建过空库；移除该隔离空库，验证真实生命周期的新库创建。
    for suffix in ("", "-wal", "-shm"):
        (data / ("kumiplayer.db" + suffix)).unlink(missing_ok=True)
    config.invalidate_config_cache()
    credential_calls = []

    def forbidden_credential(*args, **kwargs):
        credential_calls.append(True)
        raise AssertionError("首次使用仿真不得读取或修改系统凭据")

    for name in ("read", "write", "delete"):
        monkeypatch.setattr(config.SECURE_CREDENTIAL_STORE, name, forbidden_credential)
    monkeypatch.setattr(socket, "create_connection", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("首次使用仿真不得联网")))
    monkeypatch.setenv("KUMIPLAYER_API_TOKEN", "fresh-user-fixture")
    with TestClient(app, headers={"Origin": "http://tauri.localhost", "X-KumiPlayer-Token": "fresh-user-fixture"}) as client:
        assert client.get("/api/health").status_code == 200
        setup = client.get("/api/config/setup/status")
        assert setup.status_code == 200, setup.text
        assert setup.json()["setup_completed"] is False
        libraries = client.get("/api/v4/sources/libraries")
        assert libraries.status_code == 200, libraries.text
        assert libraries.json()["cards"] == []
        fresh = config.load_config()
        assert not any(getattr(fresh, name) for name in config._CREDENTIAL_FIELDS)
        with media_v4.get_database().connect() as conn:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == V4_SCHEMA_VERSION
            for table in ("source_roots", "source_evidence", "works", "import_revisions"):
                assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    assert credential_calls == []
