"""修复桥安全与状态机回归：不启动 UAC，不接触系统 hosts。"""

import base64
import io
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image

from app.core import tmdb_image_repair as repair


def result(ok=False, reason="dns"):
    return {"ok": ok, "reason": "ready" if ok else reason, "message": "fixture",
            "repair_available": not ok and reason == "dns"}


@pytest.fixture
def manager(monkeypatch):
    monkeypatch.setattr(repair, "repair_supported", lambda: True)
    monkeypatch.setattr(repair, "restore_available", lambda: False)
    monkeypatch.setattr(repair, "_route_signature", lambda: "route-a")
    monkeypatch.setattr(repair, "probe_images", lambda: result())
    return repair.ImageRepairManager()


def wait_job(manager, job):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = manager.status(job["job_id"])
        if current["status"] != "running":
            return current
        time.sleep(0.005)
    raise AssertionError("background repair did not finish")


def test_source_and_frozen_resources_integrity(tmp_path, monkeypatch):
    path, candidates = repair.trusted_resources()
    assert path.is_file() and 'image.tmdb.org' in candidates
    bundled = tmp_path / "tmdb-repair"
    bundled.mkdir()
    for name in repair.RESOURCE_HASHES:
        (bundled / name).write_bytes((path.parent / name).read_bytes())
    monkeypatch.setattr(repair.sys, "frozen", True, raising=False)
    monkeypatch.setattr(repair.sys, "_MEIPASS", str(tmp_path), raising=False)
    assert repair.resource_directory() == bundled
    repair.trusted_resources()
    (bundled / path.name).write_text("untrusted", encoding="utf-8")
    with pytest.raises(ValueError, match="integrity"):
        repair.trusted_resources()
    assert not repair.repair_supported()


def test_encoded_command_only_fixed_operation_and_verified_script():
    path, candidates = repair.trusted_resources()
    args = repair.elevation_arguments(path, candidates, "repair")
    command = base64.b64decode(args.split()[-1]).decode("utf-16-le")
    assert repair.RESOURCE_HASHES[path.name] in command
    assert "ReadAllBytes" in command and "scriptblock" in command
    assert "-Headless -NoPause -CandidatesJson" in command
    assert "PSModulePath" in command and "-Restore" not in command
    assert "-Restore" in base64.b64decode(repair.elevation_arguments(path, candidates, "restore").split()[-1]).decode("utf-16-le")
    with pytest.raises(ValueError):
        repair.elevation_arguments(path, candidates, "repair;whoami")


def test_probe_decodes_actual_image_and_falls_back_on_404(monkeypatch):
    payload = io.BytesIO()
    Image.new("RGB", (2, 2)).save(payload, "PNG")
    calls = []

    def download(_self, url):
        calls.append(url)
        if len(calls) == 1:
            response = httpx.Response(404, request=httpx.Request("GET", url))
            raise httpx.HTTPStatusError("missing", request=response.request, response=response)
        return payload.getvalue()

    monkeypatch.setattr(repair.ArtworkService, "_download", download)
    assert repair._probe_images()["ok"]
    assert calls == list(repair.SAMPLES)


@pytest.mark.parametrize("exception,reason,available", [
    (ValueError("无法解析"), "dns", True),
    (ValueError("非公网地址"), "address", True),
    (httpx.ConnectTimeout("timeout"), "timeout", True),
    (httpx.ConnectError("CERTIFICATE_VERIFY_FAILED"), "certificate", False),
    (httpx.ProxyError("proxy contains secret"), "proxy", False),
    (ValueError("Invalid artwork signature"), "content", False),
])
def test_probe_classifies_errors_without_leaking_secrets(monkeypatch, exception, reason, available):
    def download(*_args):
        raise exception
    monkeypatch.setattr(repair.ArtworkService, "_download", download)
    monkeypatch.setattr(repair, "repair_supported", lambda: True)
    detected = repair._probe_images()
    assert detected["reason"] == reason
    assert detected["repair_available"] is available
    assert "secret" not in detected["message"]


def test_manager_requires_recent_failed_diagnostic_and_same_route(manager, monkeypatch):
    with pytest.raises(ValueError, match="先重新检测"):
        manager.start("repair", "a" * 32)
    diagnostic = manager.diagnose()
    assert manager.diagnose() == diagnostic
    monkeypatch.setattr(repair, "_route_signature", lambda: "changed")
    with pytest.raises(ValueError, match="先重新检测"):
        manager.start("repair", diagnostic["diagnostic_id"])
    monkeypatch.setattr(repair, "_route_signature", lambda: "route-a")
    manager._diagnostic["time"] -= 301
    with pytest.raises(ValueError):
        manager.start("repair", diagnostic["diagnostic_id"])


@pytest.mark.parametrize("code,healthy,status,queues,changed", [
    (1223, False, "cancelled", 0, False),
    (1, False, "failed", 0, False),
    (0, False, "failed", 0, True),
    (0, True, "completed", 1, True),
    (10, True, "completed", 1, False),
])
def test_job_retests_before_queue_and_handles_cancel(manager, monkeypatch, code, healthy, status, queues, changed):
    diagnostic = manager.diagnose()
    calls = []
    monkeypatch.setattr(repair, "run_elevated", lambda _op: code)
    monkeypatch.setattr(repair, "probe_images", lambda: result(healthy))
    monkeypatch.setattr(repair, "resume_failed_images", lambda: calls.append("queued") or 3)
    job = wait_job(manager, manager.start("repair", diagnostic["diagnostic_id"]))
    assert job["status"] == status and job["changed"] is changed
    assert len(calls) == queues


def test_duplicate_click_does_not_launch_twice(manager, monkeypatch):
    gate = threading.Event()
    calls = []
    def launch(operation):
        calls.append(operation)
        gate.wait(2)
        return 1223
    monkeypatch.setattr(repair, "run_elevated", launch)
    diagnostic = manager.diagnose()
    job = manager.start("repair", diagnostic["diagnostic_id"])
    try:
        assert manager.start("repair", diagnostic["diagnostic_id"])["job_id"] == job["job_id"]
        with pytest.raises(ValueError, match="正在进行"):
            manager.start("restore")
    finally:
        gate.set()
    wait_job(manager, job)
    assert calls == ["repair"]


def test_api_rejects_commands_paths_and_ip_inputs(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import config
    app = FastAPI()
    app.include_router(config.router)
    monkeypatch.setattr(config, "image_repair_manager", SimpleNamespace(start=lambda *_a: pytest.fail("unsafe launch")))
    client = TestClient(app)
    for payload in ({"operation": "whoami"}, {"ip": "1.1.1.1"}, {"script": "evil.ps1"},
                    {"command": "repair"}, {"diagnostic_id": "a;whoami"}):
        assert client.post("/api/config/tmdb-images/repair", json=payload).status_code == 422


def test_requeue_only_live_failed_resources(tmp_path):
    from backend.tests.test_v4_artwork_catalog import _database, enqueue_metadata
    db = _database(tmp_path)
    with db.connect() as conn:
        enqueue_metadata(conn, revision_id="r", work_id="one", snapshot_id="s", metadata={
            "poster_url": "https://image.tmdb.org/t/p/original/failed.jpg",
            "fanart_url": "https://image.tmdb.org/t/p/original/cancelled.jpg",
        })
        conn.execute("UPDATE artwork_resources SET state='failed',attempts=5,retry_at=9999999999")
        conn.execute("UPDATE artwork_resources SET state='cancelled' WHERE source_url LIKE '%cancelled.jpg'")
        conn.execute("INSERT INTO artwork_resources(resource_id,state,source_url,created_at) "
                     "VALUES ('stale','failed','https://image.tmdb.org/t/p/original/stale.jpg','now')")
        before = conn.execute("SELECT metadata_json FROM metadata_snapshots").fetchone()[0]
    service = repair.ArtworkService(db, data_root=tmp_path)
    assert service.retry_failed_tmdb_downloads() == 1
    with db.connect() as conn:
        rows = {row['resource_id']: dict(row) for row in conn.execute("SELECT * FROM artwork_resources")}
        assert rows['stale']['state'] == 'failed'
        assert any(row['state'] == 'cancelled' for row in rows.values())
        live = next(row for row in rows.values() if row['source_url'].endswith('/failed.jpg'))
        assert (live['state'], live['attempts'], live['retry_at']) == ('pending', 0, 0)
        assert conn.execute("SELECT metadata_json FROM metadata_snapshots").fetchone()[0] == before
