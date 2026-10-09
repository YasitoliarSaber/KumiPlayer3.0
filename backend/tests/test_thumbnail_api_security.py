"""已发布图片 GET 支持桌面查询令牌；准备接口已经退役。"""

from fastapi.testclient import TestClient

from app.main import app

ASSET_URL = f'/api/assets/artwork/{"a" * 64}/{"b" * 64}-webp-v1/384'


def test_artwork_endpoint_accepts_desktop_session_query_token(monkeypatch):
    monkeypatch.setenv("KUMIPLAYER_API_TOKEN", "thumbnail-session-token")

    with TestClient(app) as client:
        response = client.get(
            ASSET_URL,
            params={
                "api_token": "thumbnail-session-token",
            },
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "图片资源未发布"


def test_artwork_endpoint_rejects_wrong_query_token(monkeypatch):
    monkeypatch.setenv("KUMIPLAYER_API_TOKEN", "thumbnail-session-token")

    with TestClient(app) as client:
        response = client.get(
            ASSET_URL,
            params={
                "api_token": "wrong-token",
            },
        )

    assert response.status_code == 401


def test_retired_preparation_is_not_revived_by_valid_session_header(monkeypatch):
    monkeypatch.setenv("KUMIPLAYER_API_TOKEN", "thumbnail-session-token")
    with TestClient(app) as client:
        body = {"items": [{"path": "missing/poster.jpg", "width": 384}]}
        assert client.post("/api/assets/thumbnails/prepare", json=body).status_code == 401
        assert client.post("/api/assets/thumbnails/prepare?api_token=thumbnail-session-token", json=body).status_code == 401
        response = client.post("/api/assets/thumbnails/prepare", json=body, headers={"X-KumiPlayer-Token": "thumbnail-session-token"})
        assert response.status_code == 404
