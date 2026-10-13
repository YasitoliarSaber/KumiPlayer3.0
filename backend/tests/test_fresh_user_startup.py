"""空数据目录与无凭据环境下的首次使用仿真，不访问用户真实数据。"""

import socket
import sys
from pathlib import Path

import pytest
from app.api import media_v4
from app.core import config
from app.core.paths import get_data_dir
from app.main import app
from app.media_v4.persistence.schema_v4 import V4_SCHEMA_VERSION
from fastapi.testclient import TestClient


def test_desktop_backend_starts_without_console_streams(monkeypatch):
    import desktop_backend
    import uvicorn

    started = []

    class Server:
        def __init__(self, server_config):
            self.config = server_config

        def run(self):
            started.append(self.config)

    # PyInstaller --noconsole makes both streams None. Exercise real logging
    # configuration while substituting only the socket-serving loop.
    with monkeypatch.context() as patch:
        patch.setattr(uvicorn, "Server", Server)
        patch.setattr(app.state, "request_shutdown", None, raising=False)
        patch.setattr(sys, "stdout", None)
        patch.setattr(sys, "stderr", None)
        desktop_backend.main()
    assert len(started) == 1


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


@pytest.mark.parametrize("credential_store_available", [True, False])
def test_first_install_creates_its_own_data_without_prior_settings(
    monkeypatch, tmp_path, credential_store_available,
):
    """仿真全新安装账户：没有配置、令牌或网盘挂载，正常/不可用凭据服务均可进入。"""
    from app.api import config as config_api
    from app.core import runtime

    local_app_data = tmp_path / "新用户 LocalAppData"
    install_dir = tmp_path / "程序目录"
    install_dir.mkdir()
    media_dir = tmp_path / "本地媒体"
    media_dir.mkdir()
    monkeypatch.setattr(runtime, "is_frozen_backend", lambda: True)
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    monkeypatch.setenv("KUMIPLAYER_INSTALL_DIR", str(install_dir))
    monkeypatch.delenv("KUMIPLAYER_DATA_DIR", raising=False)
    monkeypatch.setattr(config, "CONFIG_FILE", None)
    monkeypatch.setattr(config.SECURE_CREDENTIAL_STORE, "available", credential_store_available)
    # 用空凭据服务替身，绝不读取当前 Windows 用户的真实凭据。
    monkeypatch.setattr(config.SECURE_CREDENTIAL_STORE, "read", lambda *_: "")
    for method in ("write", "delete"):
        monkeypatch.setattr(config.SECURE_CREDENTIAL_STORE, method,
                            lambda *_: pytest.fail("fresh setup must not mutate credentials"))
    monkeypatch.setattr(socket, "create_connection",
                        lambda *_a, **_kw: pytest.fail("fresh local setup must not require external network"))
    # 此项只验证内置播放器已随包就绪时的引导合同，不冒充冻结二进制验收。
    monkeypatch.setattr(config_api, "check_mpv_runtime", lambda **_: {
        "available": True, "manifest_valid": True, "files_valid": True,
        "configuration_available": True,
    })
    config.invalidate_config_cache()
    default_data = local_app_data / "KumiPlayer" / "data"
    assert not default_data.exists()
    assert get_data_dir() == default_data
    # 正常默认路径只读核对；测试实际写入独立覆盖目录，继续受生产测试护栏约束。
    monkeypatch.setenv("KUMIPLAYER_DATA_DIR", str(tmp_path / "隔离安装数据"))
    config_file = get_data_dir() / "config.json"
    assert not config_file.exists()
    monkeypatch.setenv("KUMIPLAYER_API_TOKEN", "fresh-installed-fixture")
    with TestClient(app, headers={
        "Origin": "http://tauri.localhost", "X-KumiPlayer-Token": "fresh-installed-fixture",
    }) as client:
        assert client.get("/api/config").status_code == 200
        initial = client.get("/api/config/setup/status").json()
        assert not initial["setup_completed"] and not initial["source_configured"]
        assert client.get("/api/v4/sources/libraries").json()["cards"] == []
        deferred = client.post("/api/config/setup/defer")
        assert deferred.status_code == 200 and deferred.json()["setup_deferred"]
        completed = client.post("/api/config/setup/complete", json={"local_root": str(media_dir)})
        assert completed.status_code == 200 and completed.json()["setup_completed"]
        assert config_file.is_file()
        fresh = config.load_config(force_reload=True)
        assert fresh.local_root == str(media_dir) and not fresh.proxy_url
        assert not any(getattr(fresh, name) for name in config._CREDENTIAL_FIELDS)
    assert list(install_dir.iterdir()) == []
