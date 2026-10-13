"""安装版旧配置编码与损坏原件保护；全部使用临时配置与合成凭据。"""

import json

import pytest
from app.core import config
from app.main import app
from fastapi.testclient import TestClient


def test_utf8_bom_config_retains_saved_paths_without_rewriting(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    original = b"\xef\xbb\xbf" + json.dumps({
        "setup_completed": True, "local_root": "D:/媒体库", "quark_root": "Q:/夸克挂载",
        "player_mode": "external", "external_mpv_path": "D:/播放器/mpv.exe",
    }, ensure_ascii=False).encode("utf-8")
    path.write_bytes(original)
    monkeypatch.setattr(config, "CONFIG_FILE", path)
    config.invalidate_config_cache()
    saved = config.load_config()
    assert saved.setup_completed and saved.quark_root == "Q:/夸克挂载"
    assert saved.local_root == "D:/媒体库" and saved.player_mode == "external"
    assert path.read_bytes() == original


@pytest.mark.parametrize("original", [b'{"local_root":', b'[]', b'null', b'\xff\xfeinvalid'])
def test_invalid_config_cannot_be_overwritten_or_mutate_credentials(monkeypatch, tmp_path, original):
    path = tmp_path / "config.json"
    path.write_bytes(original)
    monkeypatch.setattr(config, "CONFIG_FILE", path)
    monkeypatch.setattr(config, "_credential_storage_enabled", lambda: True)
    for method in ("read", "write", "delete"):
        monkeypatch.setattr(config.SECURE_CREDENTIAL_STORE, method,
                            lambda *_a: pytest.fail("corrupt config touched credentials"))
    config.invalidate_config_cache()
    config.load_config()
    with pytest.raises(config.ConfigReadError, match="已保留原文件"):
        config.save_config(config.AppConfig(tmdb_bearer_token="fixture:synthetic"))
    assert path.read_bytes() == original
    response = TestClient(app).patch("/api/config", json={"poster_size": 5})
    assert response.status_code == 503
    assert "已保留原文件" in response.json()["detail"]
    assert path.read_bytes() == original
