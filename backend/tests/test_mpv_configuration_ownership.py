"""用户解码偏好与受控队列配置互不抢占（真实 MPV，隔离配置）。"""

import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MPV = ROOT / "mpv/runtime/mpv.com"


@pytest.mark.skipif(not MPV.is_file(), reason="内置 MPV 不存在")
@pytest.mark.parametrize("user_config, expected", [
    ("hwdec=no\n", "no"),
    ("hwdec=auto-copy\n", "auto-copy"),
    (None, "auto-safe"),
])
def test_user_hardware_decode_preference_survives_owned_config(tmp_path, user_config, expected):
    config = user_config if user_config is not None else (
        ROOT / "mpv/config/portable_config/mpv.conf"
    ).read_text(encoding="utf-8")
    (tmp_path / "mpv.conf").write_text(config, encoding="utf-8")
    probe = tmp_path / "probe.lua"
    probe.write_text(
        'mp.add_timeout(0.05, function() '
        'mp.msg.info("AUDIT_HWDEC=" .. mp.get_property("options/hwdec")); '
        'mp.msg.info("AUDIT_DIRECTORY=" .. mp.get_property("options/directory-mode")); '
        'mp.commandv("quit") end)\n', encoding="utf-8",
    )
    result = subprocess.run([
        str(MPV), f"--config-dir={tmp_path}",
        f"--include={ROOT / 'mpv/config/kumiplayer/mpv.conf'}",
        "--load-scripts=no", f"--script={probe}", "--idle=yes", "--vo=null", "--ao=null",
        "--terminal=yes", "--input-terminal=no", "--save-position-on-quit=no",
        "--no-resume-playback",
    ], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert result.returncode == 0
    assert f"AUDIT_HWDEC={expected}" in result.stdout
    assert "AUDIT_DIRECTORY=ignore" in result.stdout
