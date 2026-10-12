"""安装版运行目录与用户数据隔离测试。"""

import hashlib
import json

import pytest

from app.core import config as core_config
from app.core import runtime as core_runtime
from app.core.runtime import (
    get_default_data_dir,
    get_kumiplayer_mpv_plugins_dir,
    get_mpv_config_dir,
    get_mpv_runtime_dir,
    get_runtime_dir,
)


@pytest.mark.parametrize("bundled", [False, True])
def test_player_manifest_is_checked_in_source_and_installed_layout(tmp_path, monkeypatch, bundled):
    from app.playback import mpv_runtime

    mpv_root = tmp_path / "mpv"
    binary_dir = mpv_root if bundled else mpv_root / "runtime"
    binary_dir.mkdir(parents=True)
    binary = binary_dir / "mpv.exe"
    binary.write_bytes(b"isolated player fixture")
    manifest_path = mpv_root / "runtime-manifest.json"
    manifest_path.write_text(json.dumps({"files": [{
        "path": "mpv.exe", "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
    }]}), encoding="utf-8")
    (mpv_root / "portable_config").mkdir()
    layer = mpv_root / "kumiplayer"
    (layer / "scripts").mkdir(parents=True)
    (layer / "mpv.conf").touch()
    for script in mpv_runtime.REQUIRED_SCRIPTS:
        (layer / "scripts" / script).touch()
    monkeypatch.setattr(core_runtime.sys, "frozen", False, raising=False)
    monkeypatch.setenv("KUMIPLAYER_RUNTIME_KIND", "bundled" if bundled else "source")
    monkeypatch.setenv("KUMIPLAYER_MPV_RUNTIME_DIR", str(binary_dir))
    monkeypatch.setenv("KUMIPLAYER_MPV_CONFIG_DIR", str(mpv_root / "portable_config"))
    monkeypatch.setenv("KUMIPLAYER_MPV_LAYER_DIR", str(layer))
    monkeypatch.setattr(mpv_runtime, "read_mpv_version", lambda path: ("mpv v0.41.0", ""))
    mpv_runtime.invalidate_mpv_runtime_cache()

    assert mpv_runtime.get_mpv_manifest_path() == manifest_path
    status = mpv_runtime.check_mpv_runtime(verify_files=True)
    assert status["available"] and status["manifest_valid"] and status["files_valid"]
    assert status["configuration_available"]
    binary.write_bytes(b"changed player")
    assert not mpv_runtime.check_mpv_runtime(verify_files=True)["files_valid"]


def test_config_file_follows_the_runtime_data_directory(tmp_path, monkeypatch):
    data_dir = tmp_path / "KumiPlayer" / "data"
    monkeypatch.setenv("KUMIPLAYER_DATA_DIR", str(data_dir))
    monkeypatch.setattr(core_config, "CONFIG_FILE", None)

    assert core_config.get_config_file() == data_dir / "config.json"


def test_runtime_dir_override_locates_app_owned_mpv_resources(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.setenv("KUMIPLAYER_RUNTIME_DIR", str(runtime_dir))
    monkeypatch.setenv("KUMIPLAYER_RUNTIME_KIND", "bundled")
    config_dir = tmp_path / "portable_config"
    monkeypatch.setenv("KUMIPLAYER_MPV_CONFIG_DIR", str(config_dir))
    layer_dir = tmp_path / "kumiplayer"
    monkeypatch.setenv("KUMIPLAYER_MPV_LAYER_DIR", str(layer_dir))

    assert get_runtime_dir() == runtime_dir
    # 安装模式内置 MPV 在运行时目录的 mpv/ 下
    assert get_mpv_runtime_dir() == runtime_dir / "mpv"
    assert get_mpv_config_dir() == config_dir
    assert get_kumiplayer_mpv_plugins_dir() == layer_dir / "scripts"


def test_source_desktop_runtime_uses_project_owned_plugins(tmp_path, monkeypatch):
    monkeypatch.setattr(core_runtime.sys, "frozen", False, raising=False)
    monkeypatch.setenv("KUMIPLAYER_RUNTIME_KIND", "source")
    monkeypatch.setenv("KUMIPLAYER_RUNTIME_DIR", str(tmp_path / "project-runtime"))
    monkeypatch.delenv("KUMIPLAYER_MPV_CONFIG_DIR", raising=False)

    assert get_kumiplayer_mpv_plugins_dir() == (
        core_runtime.get_project_root()
        / "mpv"
        / "config"
        / "kumiplayer"
        / "scripts"
    )


def test_source_backend_uses_project_owned_plugins(monkeypatch):
    monkeypatch.setattr(core_runtime.sys, "frozen", False, raising=False)
    monkeypatch.delenv("KUMIPLAYER_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("KUMIPLAYER_MPV_CONFIG_DIR", raising=False)

    assert get_kumiplayer_mpv_plugins_dir() == (
        core_runtime.get_project_root()
        / "mpv"
        / "config"
        / "kumiplayer"
        / "scripts"
    )


def test_frozen_backend_defaults_to_local_app_data(tmp_path, monkeypatch):
    monkeypatch.setattr(core_runtime.sys, "frozen", True, raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))

    assert get_default_data_dir() == tmp_path / "LocalAppData" / "KumiPlayer" / "data"


def test_frozen_backend_defaults_mirror_to_install_root(tmp_path, monkeypatch):
    install_root = tmp_path / "KumiPlayer"
    monkeypatch.setattr(core_runtime.sys, "frozen", True, raising=False)
    monkeypatch.setenv("KUMIPLAYER_INSTALL_DIR", str(install_root))

    assert core_runtime.get_install_root() == install_root
    assert core_runtime.get_default_mirror_dir() == install_root / "mirror"


def test_source_backend_keeps_project_data_mirror_default(monkeypatch):
    monkeypatch.setattr(core_runtime.sys, "frozen", False, raising=False)
    monkeypatch.delenv("KUMIPLAYER_INSTALL_DIR", raising=False)

    assert core_runtime.get_default_mirror_dir() == core_runtime.get_project_root() / "data" / "mirror"


def test_source_backend_ignores_stale_install_root_for_mirror_default(tmp_path, monkeypatch):
    monkeypatch.setattr(core_runtime.sys, "frozen", False, raising=False)
    monkeypatch.setenv("KUMIPLAYER_INSTALL_DIR", str(tmp_path / "Installed"))

    assert core_runtime.get_default_mirror_dir() == core_runtime.get_project_root() / "data" / "mirror"
