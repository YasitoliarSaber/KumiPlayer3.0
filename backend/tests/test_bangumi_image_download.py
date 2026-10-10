"""Bangumi 图片首次下载回归：真实 URL 构造，只有远程传输使用 MockTransport。"""

import hashlib

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import bangumi
from app.core import url_guard


@pytest.mark.parametrize(
    ("endpoint", "cache_name", "image_path"),
    [
        ("avatar", "bangumi_avatars", "/pic/user/l/000/12/88/1288588_example.jpg"),
        ("subject-image", "bangumi_subject_images", "/pic/cover/l/example.jpg"),
    ],
)
@pytest.mark.parametrize("query", ["", "?r=1760000000&hd=1"])
def test_first_image_download_preserves_query_and_then_uses_cache(
    monkeypatch, tmp_path, endpoint, cache_name, image_path, query,
):
    raw_url = f"https://lain.bgm.tv{image_path}{query}"
    image_body = b"\xff\xd8\xff\xe0bangumi-image-fixture"
    requests = []
    dns_checks = []
    client_options = []
    real_client = httpx.Client

    def download(request):
        requests.append(request)
        return httpx.Response(200, content=image_body, headers={"Content-Type": "image/jpeg"})

    def client_factory(**kwargs):
        client_options.append(kwargs)
        return real_client(transport=httpx.MockTransport(download), **kwargs)

    def check_dns(hostname, *, allow_proxy_fake_ip=False):
        dns_checks.append((hostname, allow_proxy_fake_ip))

    monkeypatch.setattr(bangumi, "get_cache_dir", lambda: tmp_path / "cache")
    monkeypatch.setattr(bangumi.httpx, "Client", client_factory)
    monkeypatch.setattr(url_guard, "assert_public_dns_resolution", check_dns)
    app = FastAPI()
    app.include_router(bangumi.router)

    with TestClient(app) as client:
        response = client.get(f"/api/integrations/bangumi/{endpoint}", params={"url": raw_url})
        assert response.status_code == 200
        assert response.content == image_body
        assert response.headers["content-type"] == "image/jpeg"
        assert len(requests) == 1
        assert str(requests[0].url) == raw_url
        assert dns_checks == [("lain.bgm.tv", True)]
        assert client_options == [{"timeout": 10, "follow_redirects": False}]
        digest = hashlib.sha256(raw_url.encode("utf-8")).hexdigest()[:24]
        assert (tmp_path / "cache" / cache_name / f"{digest}.jpg").read_bytes() == image_body

        cached = client.get(f"/api/integrations/bangumi/{endpoint}", params={"url": raw_url})
        assert cached.status_code == 200
        assert cached.content == image_body
        assert cached.headers["etag"] == response.headers["etag"]
        assert len(requests) == len(dns_checks) == 1
