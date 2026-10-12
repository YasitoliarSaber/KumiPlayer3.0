"""Exercise new-computer build failures without compiling or modifying user data."""

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
POWERSHELL = shutil.which("powershell.exe")
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows installer entrypoint")


def _powershell_env():
    # A parent PowerShell 7 module path cannot be reused by Windows PowerShell 5.
    return {key: value for key, value in os.environ.items() if key.casefold() != "psmodulepath"}


def _run(script: Path, root: Path, commands: Path):
    env = dict(_powershell_env(), PATH=str(commands))
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script),
         "-ProjectRoot", str(root)],
        capture_output=True, text=True, errors="replace", env=env, timeout=30,
    )


def _root(tmp_path: Path):
    root = tmp_path / "project"
    (root / "mpv").mkdir(parents=True)
    (root / "mpv/runtime-manifest.json").write_text(
        json.dumps({"distribution_status": "development-only"}), encoding="utf-8",
    )
    for directory in ("data", "release", "packaging/runtime/backend"):
        target = root / directory
        target.mkdir(parents=True)
        (target / "sentinel").write_bytes(b"keep existing bytes")
    return root


def _commands(tmp_path: Path):
    commands = tmp_path / "commands"
    commands.mkdir()
    for name in ("python", "node", "npm", "cargo", "rustc"):
        (commands / f"{name}.cmd").write_bytes(
            b"@echo off\r\n"
            b'if "%~1"=="--version" echo fixture-version\r\n'
            b'if "%~1"=="-vV" echo host: x86_64-pc-windows-gnu\r\n'
            b"exit /b 0\r\n"
        )
    return commands


def test_store_placeholder_and_missing_tools_are_reported_together(tmp_path):
    root = _root(tmp_path)
    commands = tmp_path / "WindowsApps"
    commands.mkdir()
    (commands / "python.exe").write_bytes(b"")
    result = _run(ROOT / "scripts/check_installer_prerequisites.ps1", root, commands)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "Windows Store shortcut" in result.stdout
    assert "Node.js 22" in result.stdout
    assert "npm is unavailable" in result.stdout
    assert "Install Rust" in result.stdout
    assert "Built-in MPV release materials" in result.stdout
    for directory in ("data", "release", "packaging/runtime/backend"):
        assert (root / directory / "sentinel").read_bytes() == b"keep existing bytes"


def test_installed_tools_still_cannot_bypass_mpv_gate(tmp_path):
    root = _root(tmp_path)
    result = _run(ROOT / "scripts/check_installer_prerequisites.ps1", root, _commands(tmp_path))
    assert result.returncode == 1, result.stdout + result.stderr
    assert "[OK] python" in result.stdout
    assert "[OK] npm.cmd" in result.stdout
    assert "only public-release may enter an installer" in result.stdout
    assert "Installer build prerequisites passed." not in result.stdout


def test_ready_tools_and_successful_release_verification_pass(tmp_path):
    root = _root(tmp_path)
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    script = scripts / "check_installer_prerequisites.ps1"
    shutil.copyfile(ROOT / "scripts/check_installer_prerequisites.ps1", script)
    # Isolate prerequisite orchestration; the real release gate is covered above.
    (scripts / "verify_mpv_distribution.ps1").write_text(
        "param($MpvRoot, $Layout, [switch]$LocalTest)\n"
        "if ($Layout -ne 'source') { throw 'incorrect layout' }\n"
        "Write-Output 'fixture release verification passed'", encoding="utf-8",
    )
    result = _run(script, root, _commands(tmp_path))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "fixture release verification passed" in result.stdout
    assert "Installer build prerequisites passed." in result.stdout


def test_active_linker_from_previous_computer_is_reported(tmp_path):
    root = _root(tmp_path)
    (root / ".cargo").mkdir()
    old_linker = (tmp_path / "old-computer/linker.exe").as_posix()
    (root / ".cargo/config.toml").write_text(
        f'[target.x86_64-pc-windows-gnu]\nlinker = "{old_linker}"\n', encoding="utf-8",
    )
    result = _run(ROOT / "scripts/check_installer_prerequisites.ps1", root, _commands(tmp_path))
    assert result.returncode == 1
    assert "active linker" in result.stdout
    assert "previous computer" not in result.stderr


def test_batch_failure_keeps_error_and_returns_failure_without_building(tmp_path):
    root = tmp_path / "batch"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    shutil.copyfile(ROOT / "build_installer.bat", root / "build_installer.bat")
    (scripts / "ensure_kumiplayer_runtime_stopped.ps1").write_text("exit 0", encoding="utf-8")
    (scripts / "check_installer_prerequisites.ps1").write_text(
        "Write-Output 'fixture prerequisites missing'; exit 1", encoding="utf-8",
    )
    env = dict(_powershell_env(), KUMIPLAYER_BUILD_NO_PAUSE="1")
    result = subprocess.run(
        [os.environ["COMSPEC"], "/d", "/c", str(root / "build_installer.bat")],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=30,
    )
    assert result.returncode == 1
    assert "fixture prerequisites missing" in result.stdout
    assert "Installer build stopped" in result.stdout
    assert "[1/9]" not in result.stdout
    assert not (root / "packaging").exists()
    content = (root / "build_installer.bat").read_bytes()
    assert content.startswith(b"@echo off\r\nchcp 65001 >nul\r\n")
    assert b"\n" not in content.replace(b"\r\n", b"")
    assert 'if /I not "%KUMIPLAYER_BUILD_NO_PAUSE%"=="1" pause' in content.decode("utf-8")


@pytest.mark.parametrize("layout", ["source", "staged"])
def test_local_installation_verifies_hashes_and_keeps_public_gate(tmp_path, layout):
    root = tmp_path / "mpv"
    binary_root = root / "runtime" if layout == "source" else root
    binary_root.mkdir(parents=True)
    binary = binary_root / "mpv.exe"
    binary.write_bytes(b"player fixture")
    (root / "runtime-manifest.json").write_text(json.dumps({
        "distribution_status": "development-only",
        "files": [{"path": "mpv.exe", "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}],
    }), encoding="utf-8")
    config_root = root / "config" if layout == "source" else root
    for name in ("portable_config/mpv.conf", "kumiplayer/mpv.conf", "kumiplayer/scripts/kumiplayer_bindings.lua"):
        path = config_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture", encoding="utf-8")
    if layout == "staged":
        (root / "LOCAL_TEST_ONLY.txt").write_text("local test", encoding="utf-8")
    command = [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
               str(ROOT / "scripts/verify_mpv_distribution.ps1"), "-MpvRoot", str(root), "-Layout", layout]
    env = _powershell_env()
    public = subprocess.run(command, capture_output=True, text=True, errors="replace", env=env, timeout=30)
    assert public.returncode != 0
    assert "only public-release" in public.stderr
    local = subprocess.run(command + ["-LocalTest"], capture_output=True, text=True, errors="replace", env=env, timeout=30)
    assert local.returncode == 0, local.stdout + local.stderr
    assert "LOCAL TEST ONLY" in local.stdout
    if layout == "source":
        for name in ("components-manifest.json", "distribution-manifest.json"):
            (root / name).write_text('{"source_archive":{"path":null}}', encoding="utf-8")
        for name in ("THIRD_PARTY_NOTICES.md", "SOURCE_CODE.txt"):
            (root / name).write_text("fixture", encoding="utf-8")
        (root / "licenses").mkdir()
        history = config_root / "portable_config/danmaku-history.json"
        history.write_bytes(b"personal history sentinel")
        stage_command = [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                         str(ROOT / "scripts/stage_mpv_runtime.ps1"), "-ProjectRoot", str(tmp_path), "-LocalTest"]
        staged = subprocess.run(stage_command, capture_output=True, text=True, errors="replace", env=env, timeout=30)
        assert staged.returncode == 0, staged.stdout + staged.stderr
        assert (tmp_path / "packaging/runtime/mpv/LOCAL_TEST_ONLY.txt").exists()
        assert not (tmp_path / "packaging/runtime/mpv/portable_config/danmaku-history.json").exists()
        assert history.read_bytes() == b"personal history sentinel"
    binary.write_bytes(b"corrupt player")
    corrupt = subprocess.run(command + ["-LocalTest"], capture_output=True, text=True, errors="replace", env=env, timeout=30)
    assert corrupt.returncode != 0
    assert "missing, empty or changed" in corrupt.stderr
