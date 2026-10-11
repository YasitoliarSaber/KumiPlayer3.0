"""Small MPV JSON IPC client used for local playback progress tracking."""

import json
import os
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class MpvProgressEvent:
    position: float
    duration: float
    playlist_position: int
    force_checkpoint: bool = False
    media_path: str = ""
    shutdown: bool = False


def make_ipc_server_name(session_id: str) -> str:
    safe_id = "".join(ch for ch in session_id if ch.isalnum() or ch in {"_", "-"})
    if os.name == "nt":
        return rf"\\.\pipe\kumiplayer-{safe_id}"
    return str(Path(tempfile.gettempdir()) / f"kumiplayer-{safe_id}.sock")


def read_mpv_progress(ipc_server: str, timeout: float = 0.5) -> tuple[float, float, int] | None:
    """Read progress and the active playlist position from mpv.

    Returns None while mpv is still starting or when the IPC pipe is unavailable.
    """
    try:
        with _open_ipc(ipc_server, timeout) as pipe:
            position = _get_property(pipe, "time-pos", 1)
            duration = _get_property(pipe, "duration", 2)
            playlist_position = _get_property(pipe, "playlist-pos", 3)
    except (OSError, TimeoutError, ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None

    if position is None or duration is None or playlist_position is None:
        return None
    return float(position), float(duration), int(playlist_position)


def observe_mpv_progress(
    ipc_server: str,
    timeout: float = 0.5,
    should_stop: Callable[[], bool] | None = None,
) -> Iterator[MpvProgressEvent]:
    """Yield progress changes from one persistent MPV JSON IPC connection."""
    observations = (
        (1, "playlist-pos"),
        (5, "path"),
        (2, "duration"),
        (3, "time-pos"),
        (4, "pause"),
    )
    pending_requests = {100 + observation_id for observation_id, _name in observations}
    playlist_position: int | None = None
    position: float | None = None
    duration: float | None = None
    media_path = ""
    force_next_checkpoint = False

    with _open_ipc(ipc_server, timeout) as pipe:
        for observation_id, property_name in observations:
            _write_command(
                pipe,
                ["observe_property", observation_id, property_name],
                100 + observation_id,
            )

        if isinstance(pipe, _WindowsNamedPipe):
            pipe.set_read_timeout(timeout)
        while should_stop is None or not should_stop():
            try:
                line = pipe.readline()
            except TimeoutError:
                # 暂停时可能长时间没有事件，保留同一连接和未完成的读取。
                continue
            if not line:
                raise OSError("mpv IPC closed while observing progress")
            message = json.loads(line.decode("utf-8"))

            request_id = message.get("request_id")
            if request_id in pending_requests:
                if message.get("error") != "success":
                    raise OSError(f"mpv refused progress observation {request_id}")
                pending_requests.discard(request_id)
                continue

            event_name = message.get("event")
            if event_name == "shutdown":
                yield MpvProgressEvent(
                    position=position or 0.0,
                    duration=duration or 0.0,
                    playlist_position=playlist_position if playlist_position is not None else -1,
                    force_checkpoint=True,
                    media_path=media_path,
                    shutdown=True,
                )
                return
            if event_name == "seek":
                force_next_checkpoint = True
                continue
            if event_name != "property-change":
                continue

            property_name = message.get("name")
            value = message.get("data")
            if property_name == "playlist-pos":
                next_playlist_position = int(value) if value is not None else None
                if playlist_position is not None and next_playlist_position != playlist_position:
                    position = None
                    duration = None
                    force_next_checkpoint = True
                playlist_position = next_playlist_position
            elif property_name == "path":
                next_media_path = str(value or "")
                if media_path and next_media_path != media_path:
                    position = None
                    duration = None
                    force_next_checkpoint = True
                media_path = next_media_path
            elif property_name == "duration":
                duration = float(value) if value is not None else None
            elif property_name == "time-pos":
                position = float(value) if value is not None else None
            elif property_name == "pause" and value is True:
                force_next_checkpoint = True

            has_complete_sample = (
                playlist_position is not None
                and position is not None
                and duration is not None
                and bool(media_path)
            )
            should_emit = property_name == "time-pos" or (property_name == "pause" and value is True)
            if not has_complete_sample or not should_emit:
                continue
            assert position is not None
            assert duration is not None
            assert playlist_position is not None

            force_checkpoint = force_next_checkpoint
            force_next_checkpoint = False
            yield MpvProgressEvent(
                position=position,
                duration=duration,
                playlist_position=playlist_position,
                force_checkpoint=force_checkpoint,
                media_path=media_path,
            )


def set_mpv_playback_title(ipc_server: str, media_title: str, timeout: float = 0.5) -> bool:
    """Update both the native window title and fullscreen controller title."""
    try:
        with _open_ipc(ipc_server, timeout) as pipe:
            media_updated = _set_property(pipe, "force-media-title", media_title, 11)
            window_updated = _set_property(pipe, "title", media_title, 12)
    except (OSError, TimeoutError, ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return False
    return media_updated and window_updated


def send_mpv_script_message(
    ipc_server: str,
    script_name: str,
    message: str,
    args: tuple[str, ...],
    timeout: float = 0.5,
) -> bool:
    """向运行中的 MPV 发送 script-message（如 Anime4K set-default）。

    命令格式：script-message <script_name> <message> [args...]
    失败静默返回 False，不阻塞调用方（配置保存不应因播放器离线而失败）。
    """
    command = f"script-message {script_name} {message}"
    if args:
        command += " " + " ".join(str(arg) for arg in args)
    try:
        with _open_ipc(ipc_server, timeout) as pipe:
            request = json.dumps({"command": command.split()}).encode("utf-8") + b"\n"
            pipe.write(request)
            pipe.flush()
            response = pipe.readline()
            try:
                data = json.loads(response)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return True  # 无响应体时视为已投递
            return data.get("error") is None or data.get("error") == "success"
    except (OSError, TimeoutError, ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return False


def send_mpv_quit(ipc_server: str, timeout: float = 1.0) -> bool:
    """通过 IPC 发送 quit 命令，让 MPV 优雅退出。

    优先于 process.terminate() 使用，避免 Windows 硬杀触发
    "mpv has stopped working" 崩溃对话框和 CrashSender.exe。
    成功返回 True；IPC 不可用或超时返回 False（调用方应回退到 terminate）。
    """
    try:
        with _open_ipc(ipc_server, timeout) as pipe:
            request = json.dumps({"command": ["quit"], "request_id": 999}).encode("utf-8") + b"\n"
            pipe.write(request)
            pipe.flush()
            # 不等待响应：MPV 收到 quit 后立即开始关闭，pipe 会断开
            return True
    except (OSError, TimeoutError, ValueError):
        return False


def _open_ipc(ipc_server: str, timeout: float):
    if os.name == "nt":
        return _open_windows_named_pipe(ipc_server, timeout)
    return open(ipc_server, "r+b", buffering=0)


def _open_windows_named_pipe(pipe_name: str, timeout: float):
    import ctypes

    class Overlapped(ctypes.Structure):
        _fields_ = [
            ("Internal", ctypes.c_size_t),
            ("InternalHigh", ctypes.c_size_t),
            ("Offset", ctypes.c_uint32),
            ("OffsetHigh", ctypes.c_uint32),
            ("hEvent", ctypes.c_void_p),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    deadline = time.monotonic() + max(0.0, timeout)
    kernel32.WaitNamedPipeW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32]
    kernel32.WaitNamedPipeW.restype = ctypes.c_int
    kernel32.CreateFileW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    ]
    kernel32.CreateFileW.restype = ctypes.c_void_p
    kernel32.CreateEventW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_wchar_p]
    kernel32.CreateEventW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.WaitForSingleObject.restype = ctypes.c_uint32
    for name in ("ReadFile", "WriteFile"):
        function = getattr(kernel32, name)
        function.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(Overlapped),
        ]
        function.restype = ctypes.c_int
    kernel32.GetOverlappedResult.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(Overlapped), ctypes.POINTER(ctypes.c_uint32), ctypes.c_int,
    ]
    kernel32.GetOverlappedResult.restype = ctypes.c_int
    kernel32.CancelIoEx.argtypes = [ctypes.c_void_p, ctypes.POINTER(Overlapped)]
    kernel32.CancelIoEx.restype = ctypes.c_int

    timeout_ms = max(1, int(max(0.0, deadline - time.monotonic()) * 1000))
    if not kernel32.WaitNamedPipeW(pipe_name, timeout_ms):
        raise TimeoutError(pipe_name)

    handle = kernel32.CreateFileW(
        pipe_name,
        0x80000000 | 0x40000000,  # GENERIC_READ | GENERIC_WRITE
        0,
        None,
        3,  # OPEN_EXISTING
        0x40000000,  # FILE_FLAG_OVERLAPPED：连接成功不代表后续读写不会阻塞。
        None,
    )
    invalid = ctypes.c_void_p(-1).value
    if handle == invalid:
        raise OSError(ctypes.get_last_error(), pipe_name)

    return _WindowsNamedPipe(kernel32, handle, Overlapped, deadline)


class _WindowsNamedPipe:
    """按调用预算等待异步 I/O；空闲观察保留待完成读取及半行数据。"""

    def __init__(self, kernel32, handle, overlapped_type, deadline: float):
        self._kernel32 = kernel32
        self._handle = handle
        self._overlapped_type = overlapped_type
        self._deadline = deadline
        self._read_timeout: float | None = None
        self._buffer = bytearray()
        self._pending = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def set_read_timeout(self, timeout: float) -> None:
        self._read_timeout = max(0.01, timeout)

    def write(self, payload: bytes) -> int:
        written = 0
        while written < len(payload):
            count = self._transfer("write", payload[written:], self._deadline)
            if not count:
                raise OSError("mpv IPC closed while writing")
            written += count
        return written

    def flush(self) -> None:
        # WriteFile 完成即已投递；FlushFileBuffers 会等待服务端读取而再次无界阻塞。
        pass

    def readline(self) -> bytes:
        deadline = (
            time.monotonic() + self._read_timeout
            if self._read_timeout is not None else self._deadline
        )
        if time.monotonic() >= deadline:
            raise TimeoutError("mpv IPC I/O timed out")
        while b"\n" not in self._buffer:
            chunk = self._transfer("read", 4096, deadline)
            if not chunk:
                result = bytes(self._buffer)
                self._buffer.clear()
                return result
            self._buffer.extend(chunk)
        end = self._buffer.index(b"\n") + 1
        result = bytes(self._buffer[:end])
        del self._buffer[:end]
        return result

    def _transfer(self, operation: str, value, deadline: float):
        import ctypes

        if self._handle is None:
            raise OSError("mpv IPC connection is closed")
        if time.monotonic() >= deadline:
            raise TimeoutError("mpv IPC I/O timed out")
        kernel32 = self._kernel32
        count = ctypes.c_uint32()
        completed = False
        if self._pending is None:
            buffer = ctypes.create_string_buffer(value)
            event = kernel32.CreateEventW(None, True, False, None)
            if not event:
                raise ctypes.WinError(ctypes.get_last_error())
            overlapped = self._overlapped_type()
            overlapped.hEvent = event
            self._pending = (operation, buffer, overlapped, event)
            function = kernel32.WriteFile if operation == "write" else kernel32.ReadFile
            size = len(value) if operation == "write" else value
            completed = function(self._handle, buffer, size, None, ctypes.byref(overlapped))
            if not completed:
                error = ctypes.get_last_error()
                if error != 997:  # ERROR_IO_PENDING
                    self._complete(0)
                    if operation == "read" and error in (109, 233):
                        return b""
                    raise ctypes.WinError(error)

        pending_operation, _buffer, overlapped, event = self._pending
        if pending_operation != operation:
            raise OSError("mpv IPC has another pending operation")
        if not completed:
            remaining_ms = max(0, int((deadline - time.monotonic()) * 1000))
            wait_result = kernel32.WaitForSingleObject(event, remaining_ms)
            if wait_result == 258:  # WAIT_TIMEOUT；保留 buffer/OVERLAPPED，不能提前释放。
                raise TimeoutError("mpv IPC I/O timed out")
            if wait_result != 0:
                raise ctypes.WinError(ctypes.get_last_error())
        if not kernel32.GetOverlappedResult(self._handle, ctypes.byref(overlapped), ctypes.byref(count), False):
            error = ctypes.get_last_error()
            self._complete(0)
            if operation == "read" and error in (109, 233):
                return b""
            raise ctypes.WinError(error)
        return self._complete(count.value)

    def _complete(self, count: int):
        operation, buffer, _overlapped, event = self._pending
        result = buffer.raw[:count] if operation == "read" else count
        self._kernel32.CloseHandle(event)
        self._pending = None
        return result

    def close(self) -> None:
        import ctypes

        handle, self._handle = self._handle, None
        if handle is None:
            return
        pending, self._pending = self._pending, None
        kernel32 = self._kernel32
        if pending is None:
            kernel32.CloseHandle(handle)
            return
        _operation, _buffer, overlapped, event = pending
        kernel32.CancelIoEx(handle, ctypes.byref(overlapped))

        def finish_cancelled_io() -> None:
            # CancelIoEx 只请求取消：完成前必须保持结构和 buffer 存活。
            kernel32.WaitForSingleObject(event, 0xFFFFFFFF)
            kernel32.CloseHandle(event)
            kernel32.CloseHandle(handle)
            _ = pending

        if kernel32.WaitForSingleObject(event, 0) == 0:
            finish_cancelled_io()
        else:
            threading.Thread(target=finish_cancelled_io, name="mpv-ipc-cleanup", daemon=True).start()


def _get_property(pipe, property_name: str, request_id: int) -> float | None:
    response = _send_command(pipe, ["get_property", property_name], request_id)
    if response.get("error") != "success":
        return None
    value = response.get("data")
    if value is None:
        return None
    return float(value)


def _set_property(pipe, property_name: str, value: str, request_id: int) -> bool:
    response = _send_command(pipe, ["set_property", property_name, value], request_id)
    return response.get("error") == "success"


def _send_command(pipe, command: list[Any], request_id: int) -> dict[str, Any]:
    _write_command(pipe, command, request_id)
    for _ in range(20):
        line = pipe.readline()
        if not line:
            raise OSError("mpv IPC closed before replying")
        response = json.loads(line.decode("utf-8"))
        if response.get("request_id") == request_id:
            return response
    raise ValueError(f"mpv IPC response missing for request {request_id}")


def _write_command(pipe, command: list[Any], request_id: int) -> None:
    payload = json.dumps(
        {"command": command, "request_id": request_id},
        ensure_ascii=False,
    ).encode("utf-8") + b"\n"
    pipe.write(payload)
