"""Desktop-owned graceful shutdown endpoint contract."""

import asyncio
import threading
import time

from app.api.system import router
from app.core.api_security import ApiSessionMiddleware
from app.main import _bounded_thread_call, _stop_background_tasks
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _client():
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(ApiSessionMiddleware)
    return app, TestClient(app)


def test_shutdown_is_unavailable_without_a_desktop_server_callback(monkeypatch):
    monkeypatch.delenv("KUMIPLAYER_API_TOKEN", raising=False)
    _app, client = _client()

    response = client.post("/api/system/shutdown")

    assert response.status_code == 503
    assert response.json() == {"detail": "当前服务未注册桌面关闭入口"}


def test_shutdown_requires_the_desktop_session_token(monkeypatch):
    monkeypatch.setenv("KUMIPLAYER_API_TOKEN", "expected-session-token")
    app, client = _client()
    called = []
    app.state.request_shutdown = lambda: called.append(True)

    unauthorized = client.post(
        "/api/system/shutdown",
        headers={"X-KumiPlayer-Token": "wrong-token"},
    )
    assert unauthorized.status_code == 401
    assert called == []

    response = client.post(
        "/api/system/shutdown",
        headers={"X-KumiPlayer-Token": "expected-session-token"},
    )

    assert response.status_code == 202
    assert response.json() == {"accepted": True}
    # TestClient waits for the response background task, proving it is deferred
    # through FastAPI's response lifecycle rather than called in the handler.
    assert called == [True]


def test_shutdown_cancels_unresponsive_workers_after_a_short_deadline():
    async def scenario():
        cancelled = asyncio.Event()

        async def worker():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        task = asyncio.create_task(worker())
        started = time.monotonic()

        await _stop_background_tasks((task,), timeout=0.02)

        assert task.cancelled()
        assert cancelled.is_set()
        assert time.monotonic() - started < 0.25

    asyncio.run(scenario())


def test_shutdown_thread_hook_does_not_wait_for_a_blocked_provider_worker():
    async def scenario():
        release = threading.Event()
        started = time.monotonic()

        completed = await _bounded_thread_call(release.wait, 0.02)

        assert completed is False
        assert time.monotonic() - started < 0.25
        release.set()

    asyncio.run(scenario())
