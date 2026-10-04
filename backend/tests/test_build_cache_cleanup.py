"""在隔离目录验证构建缓存清理，不触碰项目真实缓存或发布产物。"""

import ctypes
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows 文件占用与 PowerShell 回归")


def _fixture(root: Path) -> Path:
    root.mkdir()
    (root / "package.json").write_text("{}", encoding="utf-8")
    for name in ("src-tauri/target", "node_modules", "data", "mpv", "release", "dist"):
        directory = root / name
        directory.mkdir(parents=True)
        (directory / "sentinel.txt").write_text("fixture", encoding="utf-8")
    return root


def _cleanup(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         str(ROOT / "scripts/cleanup_build_cache.ps1"), "-ProjectRoot", str(root)],
        capture_output=True, text=True, timeout=20,
    )


def _assert_protected(root: Path) -> None:
    for name in ("data", "mpv", "release", "dist"):
        assert (root / name / "sentinel.txt").read_text(encoding="utf-8") == "fixture"


def test_cleanup_removes_only_fixture_caches(tmp_path: Path):
    root = _fixture(tmp_path / "cleanup-success")
    result = _cleanup(root)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Regenerable build and source caches removed." in result.stdout
    assert not (root / "src-tauri/target").exists()
    assert not (root / "node_modules").exists()
    _assert_protected(root)


def test_locked_cache_reports_partial_failure_and_can_be_retried(tmp_path: Path):
    root = _fixture(tmp_path / "cleanup-locked")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                  ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.CreateFileW(str(root / "src-tauri/target/sentinel.txt"),
                                0x80000000, 0, None, 3, 0, None)
    assert handle != ctypes.c_void_p(-1).value, ctypes.get_last_error()
    try:
        result = _cleanup(root)
        assert result.returncode != 0, result.stdout + result.stderr
        assert "Regenerable build and source caches removed." not in result.stdout
        assert "WARNING" in result.stdout
        assert "Failure detail:" in result.stdout
        assert "sentinel.txt" in result.stdout
        assert (root / "src-tauri/target/sentinel.txt").exists()
        assert not (root / "node_modules").exists()
        _assert_protected(root)
    finally:
        kernel.CloseHandle(handle)
    result = _cleanup(root)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not (root / "src-tauri/target").exists()
    _assert_protected(root)


def test_batch_checks_cleanup_exit_code_at_execution_time():
    script = (ROOT / "build_tauri.bat").read_text(encoding="utf-8")
    cleanup_block = script.split('"scripts\\cleanup_build_cache.ps1"', 1)[1]
    assert "if errorlevel 1 (" in cleanup_block
    assert "%ERRORLEVEL%" not in cleanup_block
