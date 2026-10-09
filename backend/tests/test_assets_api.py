"""旧文件路径端点退役；保留可信图片 URL 的安全 helper 回归。"""


import pytest
from app.core.config import invalidate_config_cache
from app.core.url_guard import validate_remote_asset_url
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """创建测试客户端"""
    invalidate_config_cache()
    return TestClient(app)


@pytest.fixture
def mirror_dir(tmp_path, monkeypatch):
    """使用临时 mirror 目录"""
    mirror = tmp_path / "mirror"
    mirror.mkdir()
    return mirror


# ============================================================
# GET /api/assets
# ============================================================

class TestRetiredGetAsset:
    """各种旧文件引用都不再公开，不访问镜像查找文件。"""

    def test_does_not_return_mirror_image(self, client, mirror_dir):
        """已存在图片也不复活旧文件端点。"""
        # 创建测试图片
        poster = mirror_dir / "115" / "CLANNAD"
        poster.mkdir(parents=True)
        (poster / "poster.jpg").write_bytes(b"\xff\xd8\xff\xe0fake-jpg")

        resp = client.get("/api/assets?path=115/CLANNAD/poster.jpg")
        assert resp.status_code == 404
        assert resp.content != b"\xff\xd8\xff\xe0fake-jpg"

    def test_does_not_return_nfo(self, client, mirror_dir):
        """NFO 不再属于应用图片接口。"""
        nfo_dir = mirror_dir / "115" / "CLANNAD"
        nfo_dir.mkdir(parents=True)
        nfo_content = '<?xml version="1.0"?><tvshow><title>CLANNAD</title></tvshow>'
        (nfo_dir / "tvshow.nfo").write_text(nfo_content, encoding="utf-8")

        resp = client.get("/api/assets?path=115/CLANNAD/tvshow.nfo")
        assert resp.status_code == 404
        assert resp.text != nfo_content

    def test_returns_404_for_missing_file(self, client, mirror_dir):
        """文件不存在时应返回 404"""
        resp = client.get("/api/assets?path=115/CLANNAD/poster.jpg")
        assert resp.status_code == 404

    def test_rejects_path_traversal(self, client, mirror_dir):
        """应拒绝路径遍历"""
        resp = client.get("/api/assets?path=../etc/passwd")
        assert resp.status_code == 404

    def test_retired_route_rejects_normal_filename_with_dots(self, client, mirror_dir):
        """普通旧文件名同样不开放兼容读取。"""
        asset_dir = mirror_dir / "115" / "CLANNAD"
        asset_dir.mkdir(parents=True)
        (asset_dir / "poster...v1.jpg").write_bytes(b"fake-jpg")

        resp = client.get("/api/assets?path=115/CLANNAD/poster...v1.jpg")
        assert resp.status_code == 404

    def test_rejects_absolute_outside_mirror(self, client, mirror_dir):
        """应拒绝 mirror 外的绝对路径"""
        resp = client.get("/api/assets?path=C:/Windows/System32/config/SAM")
        assert resp.status_code == 404

    def test_rejects_disallowed_extension(self, client, mirror_dir):
        """应拒绝不允许的扩展名"""
        video_dir = mirror_dir / "115" / "CLANNAD"
        video_dir.mkdir(parents=True)
        (video_dir / "video.mkv").write_bytes(b"fake-video")

        resp = client.get("/api/assets?path=115/CLANNAD/video.mkv")
        assert resp.status_code == 404

    def test_retired_route_rejects_empty_path(self, client, mirror_dir):
        """退役接口不再解析文件参数。"""
        resp = client.get("/api/assets?path=")
        assert resp.status_code == 404

    def test_no_old_image_extension_revives_route(self, client, mirror_dir):
        """所有旧图片格式都必须使用新已发布资源索引。"""
        img_dir = mirror_dir / "test"
        img_dir.mkdir()

        for ext in [".jpg", ".jpeg", ".png", ".webp", ".svg"]:
            filename = f"image{ext}"
            (img_dir / filename).write_bytes(b"fake-image")
            resp = client.get(f"/api/assets?path=test/{filename}")
            assert resp.status_code == 404, f"旧路径端点不再返回 {ext}"

    def test_no_absolute_mirror_path_is_public(self, client, mirror_dir):
        """镜像绝对路径不再是展示资源契约。"""
        poster = mirror_dir / "115" / "CLANNAD"
        poster.mkdir(parents=True)
        (poster / "poster.jpg").write_bytes(b"fake-jpg")

        abs_path = str(poster / "poster.jpg")
        resp = client.get(f"/api/assets?path={abs_path}")
        assert resp.status_code == 404

    def test_retired_route_has_no_image_cache_header(self, client, mirror_dir):
        """不存在的路由不提供图片缓存响应。"""
        poster = mirror_dir / "test"
        poster.mkdir()
        (poster / "poster.jpg").write_bytes(b"fake-jpg")

        resp = client.get("/api/assets?path=test/poster.jpg")
        assert resp.status_code == 404
        assert "Cache-Control" not in resp.headers


@pytest.mark.parametrize("url", [
    "https://image.tmdb.org/t/p/w500/poster.jpg",
    "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/example.jpg",
])
def test_remote_image_proxy_accepts_only_known_cdn_paths(url):
    validate_remote_asset_url(url)


@pytest.mark.parametrize("url", [
    "http://image.tmdb.org/t/p/w500/poster.jpg",
    "https://image.tmdb.org:8443/t/p/w500/poster.jpg",
    "https://127.0.0.1/private.jpg",
    "https://s4.anilist.co/not-anilist-cdn/example.jpg",
])
def test_remote_image_proxy_rejects_untrusted_targets(url):
    with pytest.raises(ValueError):
            validate_remote_asset_url(url)
