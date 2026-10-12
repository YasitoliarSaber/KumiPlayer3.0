"""Exercise new-computer build failures without compiling or modifying user data."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
POWERSHELL = shutil.which("powershell.exe")
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows installer entrypoint")


def _run(script: Path, root: Path, commands: Path):
    env = dict(os.environ, PATH=str(commands))
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
        "param($MpvRoot, $Layout)\n"
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
    env = dict(os.environ, KUMIPLAYER_BUILD_NO_PAUSE="1")
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
