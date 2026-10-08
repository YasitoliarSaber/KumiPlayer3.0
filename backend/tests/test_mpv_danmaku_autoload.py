"""真实 MPV：手动关联后，缺少容器帧率的下一集也应自动下载并渲染。"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MPV = ROOT / "mpv/runtime/mpv.exe"
PLUGIN = ROOT / "mpv/config/portable_config/scripts/uosc_danmaku"


def _run(args: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(MPV), *args], capture_output=True, encoding="utf-8", errors="replace",
        timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        env={**os.environ, "NO_PROXY": "127.0.0.1,localhost",
             "no_proxy": "127.0.0.1,localhost"},
    )


def test_manual_match_is_inherited_after_automatic_eof_with_unknown_fps(tmp_path):
    if not MPV.is_file() or not (PLUGIN / "main.lua").is_file():
        pytest.skip("本地 MPV 或弹幕插件不可用")
    first = tmp_path / "Show.S01E01.mkv"
    # 不写容器帧率元数据；时间戳仍然定义正常的 24 fps 视频。
    encoded = _run([
        "--no-config", "--no-audio", "--frames=1488", "--ovc=mpeg4",
        "--of=matroska", f"--o={first}", "av://lavfi:testsrc=size=64x64:rate=24",
    ], timeout=30)
    assert encoded.returncode == 0, encoded.stdout + encoded.stderr
    second = tmp_path / "Show.S01E02.mkv"
    second.write_bytes(first.read_bytes())
    requests = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            requests.append(self.path)
            data = json.dumps({"count": 3, "comments": [
                {"p": f"{i},1,16777215", "m": f"fixture-{i}"} for i in range(3)
            ]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data)

    history = tmp_path / "history.json"
    history.write_text('{"show_danmaku":false}', encoding="utf-8")
    output = tmp_path / "result.json"
    harness = tmp_path / "probe.lua"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    values = {"PLUGIN": PLUGIN.as_posix(), "HISTORY": history.as_posix(),
              "OUTPUT": output.as_posix(),
              "SERVER": f"http://127.0.0.1:{server.server_port}"}
    harness.write_text(
        "\n".join(f"{key} = {json.dumps(value)}" for key, value in values.items()) + r'''
package.path = PLUGIN .. '/?.lua;' .. package.path
local overlays = {}
local create_overlay = mp.create_osd_overlay
mp.create_osd_overlay = function(...)
    local overlay = create_overlay(...)
    overlays[#overlays + 1] = overlay
    return overlay
end
dofile(PLUGIN .. '/main.lua')
HISTORY_PATH = HISTORY
options.api_server = SERVER
options.auto_load = true
options.autoload_for_url = false
options.autoload_local_danmaku = false
options.save_danmaku = false
options.vf_fps = false
local files, loaded, snapshots = 0, false, {}
local function finish(code)
    local file = assert(io.open(OUTPUT, 'w'))
    file:write(require('mp.utils').format_json(snapshots)); file:close()
    mp.commandv('quit', tostring(code))
end
mp.register_event('file-loaded', function()
    files = files + 1
    loaded = false
    if files == 1 then
        mp.add_timeout(0.1, function()
            mp.commandv('script-message-to', mp.get_script_name(), 'load-danmaku',
                        'Show', '第1话', '123001', SERVER)
        end)
    end
end)
mp.add_periodic_timer(0.05, function()
    if not loaded and COMMENTS and #COMMENTS > 0 then
        loaded = true
        snapshots[#snapshots + 1] = {
            file=files, count=#COMMENTS, episode=DANMAKU.episode,
            has_danmaku=mp.get_property_native(HAS_DANMAKU),
            visible=get_danmaku_visibility(),
            rendered=overlays[1].data:find('fixture', 1, true) ~= nil,
            container_fps=mp.get_property_number('container-fps', 0),
        }
        if files == 1 then
            mp.commandv('seek', '61.8', 'absolute')
        else
            finish(0)
        end
    end
end)
mp.add_timeout(5, function() finish(1) end)
''', encoding="utf-8",
    )
    try:
        result = _run([
            "--no-config", "--load-scripts=no", "--vo=null", "--ao=null",
            "--terminal=yes", "--keep-open=no", f"--script={harness}",
            str(first), str(second),
        ])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert output.is_file(), result.stdout + result.stderr
    snapshots = json.loads(output.read_text(encoding="utf-8"))
    assert requests == ["/api/v2/comment/123001", "/api/v2/comment/123002"], (
        f"切集后没有请求正确弹幕：{requests}\n{result.stdout}{result.stderr}"
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert [item["episode"] for item in snapshots] == ["第1话", "第2话"]
    assert all(item["container_fps"] == 0 for item in snapshots)
    assert all(item["count"] == 3 and item["has_danmaku"] and item["visible"]
               and item["rendered"] for item in snapshots)
