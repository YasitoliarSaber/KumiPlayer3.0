"""固定图片探针及 Windows 修复桥；前端不能传命令、文件路径、IP 或 URL。"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import io
import json
import sys
import threading
import time
import uuid
from ctypes import wintypes
from pathlib import Path
from typing import Any

import httpx
from PIL import Image

from app.core.config import load_config
from app.media_v4.assets.service import ArtworkService

# 忽略 BOM/换行形式，Git 检出和冻结资源使用相同校验；改脚本必须同步本常量。
RESOURCE_HASHES = {
    "tmdb-image-hosts.ps1": "d5cbbfc31c36262fd2aa61f92da5e6a47913a3e976da2702d1207b80772b47ce",
    "candidates.json": "d759e413f37300bd9f614d341d6ca3cc6fc0d135f1478c9cdc5899f40701d87e",
}
SAMPLES = (
    "https://image.tmdb.org/t/p/w500/1E5baAaEse26fej7uHcjOgEE2t2.jpg",
    "https://image.tmdb.org/t/p/w500/wwemzKWzjKYJFfCeiB57q3r4Bcm.png",
)
MESSAGES = {
    "ready": "图片连接正常",
    "dns": "图片域名解析失败，可尝试一键修复",
    "address": "图片域名解析结果不可用，可尝试一键修复",
    "timeout": "图片连接超时，可尝试一键修复",
    "network": "图片服务暂不可访问，可尝试一键修复",
    "proxy": "图片代理不可用，请检查网络访问中的代理设置",
    "certificate": "图片连接证书校验失败，请检查系统时间、证书或 HTTPS 拦截",
    "sample": "测试图片暂不可用，请稍后重新检测",
    "content": "图片返回内容无法读取，请稍后重新检测",
}


def resource_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "tmdb-repair"  # type: ignore[attr-defined]
    return Path(__file__).resolve().parents[3] / "scripts" / "repair" / "tmdb-images"


def trusted_resources() -> tuple[Path, str]:
    root = resource_directory()
    texts = {}
    for name, expected in RESOURCE_HASHES.items():
        text = (root / name).read_text(encoding="utf-8-sig").replace("\r\n", "\n")
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != expected:
            raise ValueError("repair_resource_integrity")
        texts[name] = text
    return root / "tmdb-image-hosts.ps1", texts["candidates.json"]


def repair_supported() -> bool:
    if sys.platform != "win32":
        return False
    try:
        trusted_resources()
        return True
    except (OSError, ValueError, UnicodeError):
        return False


def _probe_images() -> dict[str, Any]:
    """复用真实 ArtworkService 的 DNS/代理/内容校验，不写库或图片文件。"""
    service = ArtworkService(None)
    kind = "network"
    for url in SAMPLES:
        try:
            payload = service._download(url)
            with Image.open(io.BytesIO(payload)) as image:
                image.verify()
            kind = "ready"
            break
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                kind = "sample"
                continue
            kind = "network"
        except httpx.ProxyError:
            kind = "proxy"
        except httpx.TimeoutException:
            kind = "timeout"
        except httpx.ConnectError as exc:
            kind = "certificate" if "CERTIFICATE_VERIFY_FAILED" in str(exc).upper() else "network"
        except ValueError as exc:
            text = str(exc)
            kind = "dns" if "无法解析" in text else "address" if "非公网" in text else "content"
        except (OSError, httpx.TransportError):
            kind = "content"
        except Exception:
            kind = "network"
        break
    return {
        "ok": kind == "ready", "reason": kind, "message": MESSAGES[kind],
        "repair_available": kind in {"dns", "address", "timeout", "network"} and repair_supported(),
    }


_PROBE_LOCK = threading.Lock()
_PROBE_THREAD: threading.Thread | None = None
_PROBE_RESULT: dict[str, Any] = {}


def probe_images() -> dict[str, Any]:
    """DNS/下载阻塞最多占一个后台探针，界面等待最多 20 秒。"""
    global _PROBE_THREAD
    with _PROBE_LOCK:
        if _PROBE_THREAD is None or not _PROBE_THREAD.is_alive():
            def run() -> None:
                result = _probe_images()
                with _PROBE_LOCK:
                    _PROBE_RESULT.clear()
                    _PROBE_RESULT.update(result)
            _PROBE_THREAD = threading.Thread(target=run, name="tmdb-image-probe", daemon=True)
            _PROBE_THREAD.start()
        thread = _PROBE_THREAD
    thread.join(timeout=20)
    with _PROBE_LOCK:
        if not thread.is_alive():
            return dict(_PROBE_RESULT)
    return {"ok": False, "reason": "timeout", "message": MESSAGES["timeout"],
            "repair_available": repair_supported()}


def _route_signature() -> str:
    # 不把代理 URL（可能含凭据）写进诊断或任务输出。
    return hashlib.sha256(str(load_config().proxy_url or "").encode()).hexdigest()


def windows_directory() -> Path:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    function = kernel.GetWindowsDirectoryW
    function.argtypes = [wintypes.LPWSTR, wintypes.UINT]
    function.restype = wintypes.UINT
    buffer = ctypes.create_unicode_buffer(32768)
    length = function(buffer, len(buffer))
    if not 0 < length < len(buffer):
        raise OSError("windows_directory_unavailable")
    return Path(buffer.value)


def restore_available() -> bool:
    if sys.platform != "win32":
        return False
    try:
        root = windows_directory() / "System32" / "drivers" / "etc"
        return (root / "KumiPlayer-TMDB-backups").is_dir()
    except OSError:
        return False


def elevation_arguments(script_path: Path, candidates: str, operation: str) -> str:
    if operation not in {"repair", "restore"}:
        raise ValueError("invalid_repair_operation")
    payload = base64.b64encode(json.dumps({
        "script": str(script_path), "candidates": candidates,
    }, ensure_ascii=True).encode()).decode()
    # 子进程读入一次、重新校验固定摘要、在内存执行；不在校验后重新打开脚本。
    command = f"""
$ErrorActionPreference='Stop'
try {{
  $env:PSModulePath=[IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows),'System32','WindowsPowerShell','v1.0','Modules')
  $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload}')) | ConvertFrom-Json
  $t=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($p.script)).TrimStart([char]65279)
  $t=$t.Replace(([string][char]13+[char]10),[string][char]10)
  $sha=[Security.Cryptography.SHA256]::Create()
  $h=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)))).Replace('-','').ToLowerInvariant()
  if($h -ne '{RESOURCE_HASHES["tmdb-image-hosts.ps1"]}'){{exit 20}}
  & ([scriptblock]::Create($t)) -Headless -NoPause -CandidatesJson $p.candidates {"-Restore" if operation == "restore" else ""}
  exit 1
}} catch {{exit 20}}
"""
    encoded = base64.b64encode(command.encode("utf-16-le")).decode()
    arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded
    if len(arguments) > 30000:
        raise ValueError("repair_command_too_large")
    return arguments


def run_elevated(operation: str) -> int:
    """只有这一个固定帮助进程提权；不创建可被重定向的管理员结果文件。"""
    script, candidates = trusted_resources()
    arguments = elevation_arguments(script, candidates, operation)
    executable = windows_directory() / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"

    class ExecuteInfo(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD), ("fMask", wintypes.ULONG), ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR),
            ("lpParameters", wintypes.LPCWSTR), ("lpDirectory", wintypes.LPCWSTR),
            ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR),
            ("hkeyClass", wintypes.HKEY), ("dwHotKey", wintypes.DWORD),
            ("hIcon", wintypes.HANDLE), ("hProcess", wintypes.HANDLE),
        ]

    shell = ctypes.WinDLL("shell32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    shell.ShellExecuteExW.argtypes = [ctypes.POINTER(ExecuteInfo)]
    shell.ShellExecuteExW.restype = wintypes.BOOL
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    ole = ctypes.WinDLL("ole32")
    ole.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoUninitialize.argtypes = []
    ole.CoUninitialize.restype = None
    initialized = ole.CoInitializeEx(None, 6) in {0, 1}
    info = ExecuteInfo()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x40 | 0x100 | 0x400
    info.lpVerb, info.lpFile, info.lpParameters, info.nShow = "runas", str(executable), arguments, 0
    try:
        if not shell.ShellExecuteExW(ctypes.byref(info)):
            return 1223 if ctypes.get_last_error() == 1223 else 1
        if not info.hProcess or kernel.WaitForSingleObject(info.hProcess, 0xFFFFFFFF) != 0:
            return 1
        result = wintypes.DWORD()
        return int(result.value) if kernel.GetExitCodeProcess(info.hProcess, ctypes.byref(result)) else 1
    finally:
        if info.hProcess:
            kernel.CloseHandle(info.hProcess)
        if initialized:
            ole.CoUninitialize()


def resume_failed_images() -> int:
    from app.api.media_v4 import get_database

    return ArtworkService(get_database()).retry_failed_tmdb_downloads()


class ImageRepairManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._probe_lock = threading.Lock()
        self._diagnostic: dict[str, Any] | None = None
        self._job: dict[str, Any] | None = None

    def diagnose(self) -> dict[str, Any]:
        with self._probe_lock:
            return self._diagnose()

    def _diagnose(self) -> dict[str, Any]:
        route = _route_signature()
        with self._lock:
            if self._diagnostic and time.monotonic() - self._diagnostic["time"] < 15 and self._diagnostic["route"] == route:
                return dict(self._diagnostic["public"])
        result = {**probe_images(), "diagnostic_id": uuid.uuid4().hex, "restore_available": restore_available()}
        with self._lock:
            self._diagnostic = {"time": time.monotonic(), "route": route, "public": result}
        return result

    def start(self, operation: str, diagnostic_id: str = "") -> dict[str, Any]:
        if operation not in {"repair", "restore"} or not repair_supported():
            raise ValueError("修复组件不可用，请检查安装文件")
        with self._lock:
            if self._job and self._job["status"] == "running":
                if self._job["operation"] == operation:
                    return dict(self._job)
                raise ValueError("已有修复操作正在进行")
            if operation == "repair":
                d = self._diagnostic
                if not d or d["public"]["diagnostic_id"] != diagnostic_id or not (d["public"]["repair_available"] or d["public"]["ok"]) or time.monotonic() - d["time"] > 300 or d["route"] != _route_signature():
                    raise ValueError("请先重新检测图片连接")
            elif not restore_available():
                raise ValueError("没有可恢复的修复记录")
            self._job = {
                "job_id": uuid.uuid4().hex, "operation": operation, "status": "running",
                "message": "正在检查图片下载并准备重试…",
                "changed": False, "queued_images": 0,
            }
            result = dict(self._job)
            threading.Thread(target=self._run, args=(operation,), name="tmdb-image-repair", daemon=True).start()
            return result

    def status(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            if not self._job or self._job["job_id"] != job_id:
                raise KeyError(job_id)
            return dict(self._job)

    def _run(self, operation: str) -> None:
        changed = False
        queued = 0
        try:
            # 先检查实际软件链路；已可下载时直接重试图片，不无谓提权或改 hosts。
            images = probe_images() if operation == "repair" else None
            if images and images["ok"]:
                code = 10
            else:
                with self._lock:
                    if self._job:
                        self._job["message"] = "请允许 Windows 管理员授权，正在验证图片连接…"
                code = run_elevated(operation)
            changed = code == 0
            if code == 1223:
                status, message = "cancelled", "已取消 Windows 授权，没有执行修复"
            elif code not in {0, 10}:
                status, message = "failed", "未能完成操作；请重新检测。备份或其他程序的 hosts 改动会保留"
            else:
                images = images if images and images["ok"] else probe_images()
                if operation == "restore":
                    status, message = "completed", "已恢复修复前的设置" if changed else "设置无需恢复"
                elif images["ok"]:
                    try:
                        queued = resume_failed_images()
                        status, message = "completed", f"图片连接正常，已安排 {queued} 张失败图片重试" if queued else "图片连接正常，没有等待重试的失败图片"
                    except Exception:
                        status, message = "completed", "图片连接正常；图片任务未能自动重试，请在媒体管理重新下载图片"
                else:
                    status, message = "failed", images["message"]
                with self._lock:
                    self._diagnostic = None
        except Exception:
            status, message = "failed", "操作未完成，请重新检测图片连接；已有备份保持保留"
        with self._lock:
            if self._job:
                self._job.update(status=status, message=message, changed=changed, queued_images=queued)


image_repair_manager = ImageRepairManager()
