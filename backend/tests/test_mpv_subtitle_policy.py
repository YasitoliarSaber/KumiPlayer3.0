"""中文字幕自动加载策略（简繁优先级 / 子目录 / 内封乱标记回退）。

覆盖 2026-10-04 的字幕策略修复：
- 字幕策略统一在自有层声明，用户整体替换 portable_config 后仍然生效；
- slang 中所有简体代码必须排在所有繁体代码之前（mpv 用 `INT_MAX - slang 索引`
  打分，索引越小优先级越高，繁体排在前面会抢走简体轨）；
- sub-file-paths 覆盖动漫字幕常见子目录（Windows 分隔符是分号）；
- subs-fallback=default 让语言标记不规范的内封字幕（Chinese / und / 缺失）仍可回退。

一部分是零依赖的静态契约（防回归），一部分用真实内置 MPV 读回生效值。
"""

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MPV = ROOT / "mpv/runtime/mpv.com"
OWNED_CONF = ROOT / "mpv/config/kumiplayer/mpv.conf"
PORTABLE_CONF = ROOT / "mpv/config/portable_config/mpv.conf"

SIMPLIFIED_CODES = ("sc", "chs", "zh-cn", "zh-hans", "zh-sg", "cn", "gb")
TRADITIONAL_CODES = ("zh-hant", "zh-tw", "zh-hk", "zh-mo", "tc", "cht")
SUBTITLE_OPTION_KEYS = (
    "sub-auto",
    "sub-file-paths",
    "slang",
    "subs-fallback",
    "subs-with-matching-audio",
)

PROBE = """mp.add_timeout(0.05, function()
  local keys = {"sub-auto", "sub-file-paths", "slang", "subs-fallback", "subs-with-matching-audio"}
  for _, k in ipairs(keys) do
    mp.msg.info("AUDIT_" .. k .. "=" .. tostring(mp.get_property("options/" .. k)))
  end
  mp.commandv("quit")
end)
"""


def _declared_options(path: Path) -> dict[str, str]:
    """读取关键=值行（忽略注释与空行），键做小写归一。"""
    found: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        found[key.strip().lower()] = value.strip()
    return found


def test_subtitle_policy_declared_in_owned_layer():
    owned = _declared_options(OWNED_CONF)
    assert owned.get("sub-auto") == "fuzzy"
    assert owned.get("subs-fallback") == "default"
    assert owned.get("subs-with-matching-audio") == "yes"
    paths = owned.get("sub-file-paths", "")
    for expected in ("sub", "subs", "subtitles", "字幕"):
        assert expected in paths.split(";"), f"sub-file-paths 缺少 {expected}: {paths!r}"


def test_subtitle_policy_not_duplicated_in_replaceable_layer():
    portable = _declared_options(PORTABLE_CONF)
    duplicated = sorted(set(portable) & set(SUBTITLE_OPTION_KEYS))
    assert not duplicated, f"可替换层不应再声明字幕策略（避免两处矛盾）: {duplicated}"


def test_all_simplified_codes_precede_traditional_codes():
    slang = [
        part.strip().lower()
        for part in _declared_options(OWNED_CONF).get("slang", "").split(",")
        if part.strip()
    ]
    assert slang, "自有层未声明 slang"
    index = {code: slang.index(code) for code in slang}
    for code in SIMPLIFIED_CODES + TRADITIONAL_CODES:
        assert code in index, f"slang 缺少 {code}"
    last_simplified = max(index[code] for code in SIMPLIFIED_CODES)
    first_traditional = min(index[code] for code in TRADITIONAL_CODES)
    assert last_simplified < first_traditional, (
        "简化代码必须全部排在繁体代码之前："
        f"最后一个简体码索引 {last_simplified} 应小于第一个繁体码索引 {first_traditional}"
    )


@pytest.mark.skipif(not MPV.is_file(), reason="内置 MPV 不存在")
def test_owned_layer_overrides_replaceable_layer_subtitle_policy(tmp_path):
    """可替换层写相反取值，自有层必须覆盖——保证替换整合包后字幕行为不变。"""
    (tmp_path / "mpv.conf").write_text(
        "slang=ja,jpn\nsub-auto=no\nsubs-fallback=no\n", encoding="utf-8"
    )
    probe = tmp_path / "probe.lua"
    probe.write_text(PROBE, encoding="utf-8")
    result = subprocess.run([
        str(MPV), f"--config-dir={tmp_path}", f"--include={OWNED_CONF}",
        "--load-scripts=no", f"--script={probe}", "--idle=yes",
        "--vo=null", "--ao=null", "--terminal=yes", "--input-terminal=no",
        "--save-position-on-quit=no", "--no-resume-playback",
    ], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert result.returncode == 0, result.stderr
    out = result.stdout

    owned = _declared_options(OWNED_CONF)
    assert re.search(r"AUDIT_sub-auto=fuzzy\b", out), out
    assert re.search(r"AUDIT_subs-fallback=default\b", out), out
    assert f"AUDIT_slang={owned['slang']}" in out, out
    paths = re.search(r"AUDIT_sub-file-paths=(.+)", out)
    assert paths, out
    assert paths.group(1).count(";") >= 3, paths.group(1)


def test_slang_excludes_audio_original_language():
    """slang 不得包含日语代码：原声语言命中 slang 时 mpv 会一条字幕都不选。"""
    slang = {part.strip().lower() for part in
             _declared_options(OWNED_CONF).get("slang", "").split(",") if part.strip()}
    for forbidden in ("ja", "jpn", "jp"):
        assert forbidden not in slang, f"slang 不应包含 {forbidden}"
