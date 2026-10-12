"""Optional, local-only mount evidence; no cloud credentials or media access.

WebDAV/UNC namespaces deliberately remain distinct from a cloud provider's
directory tree. A caller must prove their correspondence before using them.
CloudDrive is not queried without an existing authorised integration.
"""

from __future__ import annotations

import configparser
import ctypes
import itertools
import os
from collections.abc import Iterator
from pathlib import Path, PureWindowsPath
from urllib.parse import unquote, urlsplit, urlunsplit

_MAX_PROCESSES = 512
_MAX_RCLONE_PROCESSES = 8
_MAX_CONFIG_BYTES = 1024 * 1024
_MAX_ROOTS = 16
_VALUE_FLAGS = {
    "--config", "--vfs-cache-mode", "--vfs-cache-max-size", "--vfs-cache-max-age",
    "--vfs-cache-poll-interval", "--vfs-read-chunk-size", "--vfs-read-chunk-size-limit",
    "--vfs-read-ahead", "--buffer-size", "--cache-dir", "--transfers", "--checkers",
    "--log-file", "--log-level", "--volname", "--dir-cache-time", "--poll-interval",
    "--timeout", "--contimeout", "--attr-timeout", "--uid", "--gid", "--umask",
}
_BOOLEAN_FLAGS = {
    "--network-mode", "--read-only", "--no-check-certificate", "--allow-other",
    "--allow-non-empty", "--vfs-fast-fingerprint", "--no-modtime", "--use-mmap",
    "--rc", "--rc-no-auth", "--quiet", "--verbose",
}


def _is_windows() -> bool:
    return os.name == "nt"


def _local_root(value: str) -> PureWindowsPath | None:
    if len(value) > 4096 or "\x00" in value:
        return None
    path = PureWindowsPath(value)
    if len(path.drive) == 2 and path.drive[1] == ":" and not path.root:
        path = PureWindowsPath(path.drive + "\\")
    if not path.is_absolute() or ".." in path.parts:
        return None
    return path


def _within(path: PureWindowsPath, root: PureWindowsPath) -> bool:
    return path == root or root in path.parents


def _network_connection(drive: str) -> str | None:
    """Ask only the requested drive; disconnected/unsupported is no evidence."""
    try:
        function = ctypes.WinDLL("mpr").WNetGetConnectionW
        function.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
        function.restype = ctypes.c_ulong
        size = ctypes.c_ulong(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if function(drive, buffer, ctypes.byref(size)) == 0:
            value = buffer.value
            if value.startswith("\\\\") and "\x00" not in value:
                return value
    except (OSError, AttributeError):
        pass
    return None


def _rclone_commands() -> Iterator[list[str]]:
    """Bound process discovery, then inspect command lines only for rclone."""
    try:
        import psutil
    except ImportError:
        return
    count = 0
    try:
        for process in itertools.islice(psutil.process_iter(["name"]), _MAX_PROCESSES):
            try:
                if str(process.info.get("name", "")).lower() not in {"rclone", "rclone.exe"}:
                    continue
                count += 1
                if count > _MAX_RCLONE_PROCESSES:
                    break
                command = process.cmdline()
                if len(command) <= 128 and all(len(value) <= 4096 for value in command):
                    yield command
            except (psutil.Error, OSError):
                continue
    except (psutil.Error, OSError):
        return


def _mount_command(command: list[str]) -> tuple[str, str, str] | None:
    """Accept explicit mount operands and config; skip uncertain CLI layouts."""
    config = ""
    seen_mount = False
    operands: list[str] = []
    index = 1
    while index < len(command):
        argument = command[index]
        flag, equals, inline_value = argument.partition("=")
        if flag in _VALUE_FLAGS:
            if equals:
                value = inline_value
            else:
                index += 1
                if index >= len(command) or command[index].startswith("-"):
                    return None
                value = command[index]
            if flag == "--config":
                if config and config != value:
                    return None
                config = value
        elif flag in _BOOLEAN_FLAGS:
            if equals and inline_value.lower() not in {"true", "false", "1", "0"}:
                return None
        elif argument == "mount" and not seen_mount and not operands:
            seen_mount = True
        elif argument.startswith("-") or not seen_mount:
            # Unknown flag arity, authentication flags and backend overrides
            # are not inspected or used to manufacture a mapping.
            return None
        else:
            operands.append(argument)
        index += 1
    if not seen_mount or len(operands) != 2 or not config or ":" not in operands[0]:
        return None
    return operands[0], operands[1], config


def _config_volume_is_local(config_path: str) -> bool:
    """Require a local physical volume, including paths through mount folders."""
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        volume_path = ctypes.create_unicode_buffer(32768)
        if not kernel.GetVolumePathNameW(ctypes.c_wchar_p(config_path), volume_path, len(volume_path)):
            return False
        root = volume_path.value
        if kernel.GetDriveTypeW(ctypes.c_wchar_p(root)) != 3:  # DRIVE_FIXED
            return False
        filesystem = ctypes.create_unicode_buffer(256)
        if not kernel.GetVolumeInformationW(
            ctypes.c_wchar_p(root), None, 0, None, None, None, filesystem, len(filesystem),
        ):
            return False
        if filesystem.value.upper() not in {"NTFS", "REFS", "FAT", "FAT32", "EXFAT"}:
            return False
        volume_name = ctypes.create_unicode_buffer(1024)
        if not kernel.GetVolumeNameForVolumeMountPointW(ctypes.c_wchar_p(root), volume_name, len(volume_name)):
            return False
        device_name = volume_name.value.removeprefix("\\\\?\\").rstrip("\\")
        device = ctypes.create_unicode_buffer(32768)
        if not kernel.QueryDosDeviceW(ctypes.c_wchar_p(device_name), device, len(device)):
            return False
        return device.value.startswith("\\Device\\HarddiskVolume")
    except (OSError, AttributeError, ValueError):
        return False


def _webdav_url(config_path: str, remote: str) -> str | None:
    """Read a bounded explicit local config, retaining only type and URL."""
    path = Path(config_path)
    # UNC configurations would make this metadata lookup depend on a server.
    if config_path.startswith(("\\\\", "//")) or not path.is_absolute() or not _config_volume_is_local(config_path):
        return None
    try:
        with path.open("rb") as source:
            content = source.read(_MAX_CONFIG_BYTES + 1)
        if len(content) > _MAX_CONFIG_BYTES:
            return None
        parser = configparser.RawConfigParser(interpolation=None)
        parser.read_string(content.decode("utf-8-sig"))
        if parser.get(remote, "type", fallback="").strip().lower() != "webdav":
            return None
        return parser.get(remote, "url", fallback="").strip() or None
    except (OSError, UnicodeError, configparser.Error):
        return None


def _endpoint_root(url: str, subpath: str) -> str | None:
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        host = parsed.hostname
        if ":" in host:
            host = "[" + host + "]"
        if parsed.port:
            host += ":" + str(parsed.port)
        path = parsed.path.replace("\\", "/").rstrip("/")
        subpath = subpath.replace("\\", "/").strip("/")
        if "?" in subpath or "#" in subpath:
            return None
        for segment in unquote(path + "/" + subpath).replace("\\", "/").split("/"):
            if segment in {".", ".."} or any(ord(character) < 32 for character in segment):
                return None
        if subpath:
            path += "/" + subpath
        return urlunsplit((parsed.scheme.lower(), host, path or "/", "", ""))
    except ValueError:
        return None


def discover_mount_relationships(local_roots: list[str]) -> list[dict]:
    """Return nonsecret evidence without guessing a provider or remote origin.

    Optional failures produce no evidence, never an assertion that a mount or
    media path is invalid. Call this inside the caller's bounded worker.
    """
    if not _is_windows():
        return []
    roots = [root for value in local_roots[:_MAX_ROOTS] if (root := _local_root(value)) is not None]
    if not roots:
        return []
    relationships: list[dict] = []
    for drive in dict.fromkeys(root.drive.upper() for root in roots if len(root.drive) == 2):
        remote = _network_connection(drive)
        if remote:
            relationships.append({
                "local_root": drive + "\\", "remote_root": remote,
                "namespace": "unc", "kind": "windows_network_connection",
                "evidence": "WNetGetConnectionW",
            })
    for command in _rclone_commands():
        operands = _mount_command(command)
        if operands is None:
            continue
        remote, mount, config = operands
        local = _local_root(mount)
        if local is None or not any(_within(root, local) for root in roots):
            continue
        config_local = _local_root(config)
        if config_local is not None and (
            _within(config_local, local)
            or any(config_local.drive.casefold() == root.drive.casefold() for root in roots)
        ):
            continue
        remote_name, subpath = remote.split(":", 1)
        url = _webdav_url(config, remote_name)
        endpoint = _endpoint_root(url, subpath) if url else None
        if endpoint is None:
            continue
        item = {
            "local_root": str(local), "remote_root": endpoint,
            "namespace": "webdav_endpoint", "kind": "rclone_mount",
            "evidence": "running_mount_arguments_and_webdav_config",
        }
        if item not in relationships:
            relationships.append(item)
    return relationships
