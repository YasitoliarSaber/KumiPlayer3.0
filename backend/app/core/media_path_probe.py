"""Bounded filesystem checks using spawn IPC, including frozen desktop builds."""

import multiprocessing
import os
from pathlib import Path

MEDIA_PATH_PROBE_TIMEOUT_SECONDS = 4


class MediaPathProbeError(RuntimeError):
    """The probe failed internally; no filesystem verdict is available."""


def _probe_worker(connection, checks: list[tuple[str, str]]) -> None:
    try:
        states = []
        for kind, path in checks:
            try:
                states.append(os.path.isdir(path) if kind == "dir" else os.path.isfile(path))
            except OSError:
                states.append(False)
        connection.send(states)
    finally:
        connection.close()


def probe_media_path_states(
    root: Path, sample_paths: list[Path], *, timeout: float = MEDIA_PATH_PROBE_TIMEOUT_SECONDS,
) -> tuple[list[bool], bool]:
    """Never invoke the frozen server as a Python interpreter or use console streams."""
    checks = [("dir", str(root)), *(("file", str(path)) for path in sample_paths)]
    failed = [False] * len(checks)
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    worker = context.Process(target=_probe_worker, args=(sender, checks), daemon=True)
    started = False
    try:
        worker.start()
        started = True
        sender.close()
        if not receiver.poll(timeout):
            return failed, True
        states = receiver.recv()
        if not isinstance(states, list) or len(states) != len(checks) or any(type(state) is not bool for state in states):
            raise MediaPathProbeError("Invalid filesystem worker response")
        return states, False
    except (OSError, EOFError, ValueError, RuntimeError) as exc:
        raise MediaPathProbeError("Filesystem worker unavailable") from exc
    finally:
        receiver.close()
        sender.close()
        if started:
            worker.join(timeout=0.1)
            if worker.is_alive():
                # Only terminate the filesystem worker created by this request.
                worker.terminate()
                worker.join(timeout=1)
            if not worker.is_alive():
                worker.close()
