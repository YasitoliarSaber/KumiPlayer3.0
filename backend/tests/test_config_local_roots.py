"""本地来源多条登记的配置契约。

一个分类下允许登记多条本地目录（动画库 / 影视库等）；``local_root`` 保留为
第一条记录的兼容镜像，首次启动引导写入的单值不会覆盖其它已登记条目。
"""

import json

import pytest
from app.core.config import AppConfig, invalidate_config_cache, load_config, save_config
from app.core.local_roots import MAX_LOCAL_ROOTS, root_id_for
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    invalidate_config_cache()
    return TestClient(app)


@pytest.fixture
def temp_config(tmp_path, monkeypatch):
    config_file = tmp_path / "config.json"
    monkeypatch.setattr("app.core.config.CONFIG_FILE", config_file)
    invalidate_config_cache()
    yield config_file
    invalidate_config_cache()


def _media_dirs(tmp_path, *names):
    folders = []
    for name in names:
        folder = tmp_path / name
        folder.mkdir()
        folders.append(folder)
    return folders


def test_patch_local_roots_round_trip_and_mirror(client, temp_config, tmp_path):
    animation, movie = _media_dirs(tmp_path, "动画库", "影视库")

    response = client.patch("/api/config", json={"local_roots": [
        {"name": "动画库", "path": str(animation)},
        {"name": "影视库", "path": str(movie)},
    ]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["path"] for item in body["local_roots"]] == [str(animation), str(movie)]
    assert [item["name"] for item in body["local_roots"]] == ["动画库", "影视库"]
    # 兼容镜像跟随第一条记录
    assert body["local_root"] == str(animation)
    assert body["local_roots"][0]["root_id"] == root_id_for(str(animation))

    invalidate_config_cache()
    saved = load_config()
    assert [record.path for record in saved.local_roots] == [str(animation), str(movie)]
    assert saved.local_root == str(animation)


def test_legacy_single_local_root_migrates_without_rewriting_file(client, temp_config, tmp_path):
    legacy = tmp_path / "旧媒体库"
    original = json.dumps({"setup_completed": True, "local_root": str(legacy)}, ensure_ascii=False)
    temp_config.write_text(original, encoding="utf-8")

    body = client.get("/api/config").json()

    assert [item["path"] for item in body["local_roots"]] == [str(legacy)]
    assert body["local_roots"][0]["name"] == "旧媒体库"
    assert body["local_root"] == str(legacy)
    # 读取只做内存迁移，不因读取回写配置文件
    assert temp_config.read_text(encoding="utf-8") == original


def test_empty_name_falls_back_to_folder_name(client, temp_config, tmp_path):
    (folder,) = _media_dirs(tmp_path, "影视库")

    body = client.patch("/api/config", json={"local_roots": [{"name": "  ", "path": str(folder)}]}).json()

    assert body["local_roots"][0]["name"] == "影视库"


def test_setup_sources_promotes_existing_entry_without_creating_duplicate(client, temp_config, tmp_path):
    animation, movie = _media_dirs(tmp_path, "动画库", "影视库")
    save_config(AppConfig(local_roots=[
        {"name": "动画库", "path": str(animation)},
        {"name": "影视库", "path": str(movie)},
    ]))

    response = client.post("/api/config/setup/sources", json={"local_root": str(movie)})

    assert response.status_code == 200, response.text
    invalidate_config_cache()
    saved = load_config()
    assert [record.path for record in saved.local_roots] == [str(movie), str(animation)]
    assert len(saved.local_roots) == 2
    assert saved.local_root == str(movie)


def test_setup_sources_appends_unknown_directory_as_primary(client, temp_config, tmp_path):
    (animation,) = _media_dirs(tmp_path, "动画库")
    (extra,) = _media_dirs(tmp_path, "新增库")
    save_config(AppConfig(local_roots=[{"name": "动画库", "path": str(animation)}]))

    assert client.post("/api/config/setup/sources", json={"local_root": str(extra)}).status_code == 200

    invalidate_config_cache()
    saved = load_config()
    assert [record.path for record in saved.local_roots] == [str(extra), str(animation)]


def test_clearing_local_root_clears_registered_entries(client, temp_config, tmp_path):
    (animation,) = _media_dirs(tmp_path, "动画库")
    save_config(AppConfig(local_roots=[{"name": "动画库", "path": str(animation)}]))

    body = client.patch("/api/config", json={"local_root": ""}).json()

    assert body["local_roots"] == []
    assert body["local_root"] == ""


def test_patch_rejects_relative_duplicate_and_overlong_name(client, temp_config, tmp_path):
    (folder,) = _media_dirs(tmp_path, "动画库")

    relative = client.patch("/api/config", json={"local_roots": [{"name": "库", "path": "动画库"}]})
    assert relative.status_code == 400
    assert "绝对路径" in relative.json()["detail"]

    duplicate = client.patch("/api/config", json={"local_roots": [
        {"name": "动画库", "path": str(folder)},
        {"name": "重复", "path": str(folder)},
    ]})
    assert duplicate.status_code == 400
    assert "重复" in duplicate.json()["detail"]

    overlong = client.patch("/api/config", json={"local_roots": [{"name": "库" * 25, "path": str(folder)}]})
    assert overlong.status_code == 400
    assert "24" in overlong.json()["detail"]


def test_patch_rejects_too_many_entries(client, temp_config, tmp_path):
    entries = [{"name": f"库{index}", "path": str(tmp_path / f"库{index}")} for index in range(MAX_LOCAL_ROOTS + 1)]

    response = client.patch("/api/config", json={"local_roots": entries})

    assert response.status_code == 400
    assert str(MAX_LOCAL_ROOTS) in response.json()["detail"]


def test_rejected_patch_keeps_saved_entries(client, temp_config, tmp_path):
    (folder,) = _media_dirs(tmp_path, "动画库")
    save_config(AppConfig(local_roots=[{"name": "动画库", "path": str(folder)}]))

    assert client.patch("/api/config", json={"local_roots": [{"name": "库", "path": "相对路径"}]}).status_code == 400

    invalidate_config_cache()
    saved = load_config()
    assert [record.path for record in saved.local_roots] == [str(folder)]


def test_media_paths_keeps_single_local_source_key(client, temp_config, tmp_path):
    """单条登记保持既有 "local" 键，旧前端与既有契约不被破坏。"""
    (animation,) = _media_dirs(tmp_path, "动画库")
    save_config(AppConfig(local_roots=[{"name": "动画库", "path": str(animation)}]))

    data = client.post("/api/config/test/media-paths").json()

    local = next(item for item in data["sources"] if item["source"] == "local")
    assert local["ok"] is True
    assert local["label"] == "动画库"


def test_media_paths_reports_every_registered_local_root(client, temp_config, tmp_path):
    animation, movie = _media_dirs(tmp_path, "动画库", "影视库")
    save_config(AppConfig(local_roots=[
        {"name": "动画库", "path": str(animation)},
        {"name": "影视库", "path": str(movie)},
    ]))

    data = client.post("/api/config/test/media-paths").json()

    local_items = [item for item in data["sources"] if item["source"].startswith("local")]
    assert len(local_items) == 2
    assert {item["label"] for item in local_items} == {"动画库", "影视库"}
    assert all(item["ok"] for item in local_items)
    assert data["ok"] is True
    # 已登记多条时不重复报告兼容镜像
    assert not any(item["source"] == "local" for item in data["sources"])


def test_registered_local_roots_are_protected_from_data_reset(temp_config, tmp_path):
    """登记的多条本地来源属于用户真实媒体根，必须纳入删除保护。"""
    from app.maintenance import reset_backend_state_v4

    animation, movie = _media_dirs(tmp_path, "动画库", "影视库")
    save_config(AppConfig(local_roots=[
        {"name": "动画库", "path": str(animation)},
        {"name": "影视库", "path": str(movie)},
    ]))

    protected = {str(path) for path in reset_backend_state_v4._configured_source_roots()}

    assert str(tmp_path / "动画库") in protected
    assert str(tmp_path / "影视库") in protected
