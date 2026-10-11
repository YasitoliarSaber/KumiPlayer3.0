"""Archive proved runtime inputs without guessing floating dependency revisions.

Does not build, execute downloaded code, or grant distribution approval.
First acquisition records observed SHA-256; subsequent acquisitions require it.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parents[1]
MPV_COMMIT = "41f6a645068483470267271e1d09966ca3b9f413"
INPUTS = [
    ("mpv", MPV_COMMIT, f"https://codeload.github.com/mpv-player/mpv/tar.gz/{MPV_COMMIT}"),
    ("ffmpeg", "1fcb201ab10cbc98d931e340da6ace292e82b1e1", "https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/1fcb201ab10cbc98d931e340da6ace292e82b1e1"),
    ("dav1d", "43f3b8d33bae5179a134d1cd7c394063b1cebfcb", "https://codeload.github.com/videolan/dav1d/tar.gz/43f3b8d33bae5179a134d1cd7c394063b1cebfcb"),
    ("luajit", "7152e15489d2077cd299ee23e3d51a4c599ab14f", "https://codeload.github.com/LuaJIT/LuaJIT/tar.gz/7152e15489d2077cd299ee23e3d51a4c599ab14f"),
    ("libiconv", "1.18", "https://ftp.gnu.org/pub/gnu/libiconv/libiconv-1.18.tar.gz"),
    ("zlib", "1.3.1", "https://zlib.net/fossils/zlib-1.3.1.tar.gz"),
    ("freetype", "2.14.1", "https://download.savannah.gnu.org/releases/freetype/freetype-2.14.1.tar.xz"),
    ("fribidi", "1.0.16", "https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz"),
    ("harfbuzz", "12.2.0", "https://github.com/harfbuzz/harfbuzz/releases/download/12.2.0/harfbuzz-12.2.0.tar.xz"),
]


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def acquire(item: tuple[str, str, str], previous: dict) -> dict:
    name, revision, url = item
    suffix = ".tar.xz" if url.endswith(".tar.xz") else ".tar.gz"
    path = ROOT / "sources" / "runtime" / f"{name}-{revision}{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        request = urllib.request.Request(url, headers={"User-Agent": "KumiPlayer-source-evidence"})
        temporary = path.with_suffix(path.suffix + ".partial")
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open("wb") as output:
            expected_length = response.headers.get("Content-Length")
            written = 0
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                written += len(chunk)
        if expected_length is not None and written != int(expected_length):
            raise ValueError(f"Truncated download: {name}")
        with tarfile.open(temporary) as archive:
            if not archive.getmembers():
                raise ValueError(f"Empty archive: {name}")
        temporary.replace(path)
    with tarfile.open(path) as archive:
        if not archive.getmembers():
            raise ValueError(f"Empty archive: {name}")
    sha256 = digest(path)
    if name in previous and previous[name]["sha256"] != sha256:
        raise ValueError(f"Previously recorded archive changed: {name}")
    # Versioned tarballs are the exact inputs named by the pinned CI script;
    # downloaded bytes have an observed hash, not a claimed signed attestation.
    return {"component": name, "revision": revision, "url": url,
            "path": path.relative_to(ROOT).as_posix(), "sha256": sha256,
            "bytes": path.stat().st_size,
            "basis": "binary commit/version plus pinned CI input",
            "hash_origin": "locally computed, no signature verification claimed"}


def main() -> None:
    index = ROOT / "sources" / "runtime-inputs.json"
    old = json.loads(index.read_text(encoding="utf-8")) if index.exists() else {}
    previous = {item["component"]: item for item in old.get("archives", [])}
    original = ROOT / "provenance/downloads/mpv-v0.41.0-x86_64-w64-mingw32.zip"
    manifest = json.loads((ROOT / "runtime-manifest.json").read_text(encoding="utf-8"))
    if digest(original) != manifest["artifact_sha256"].lower():
        raise ValueError("Original upstream release ZIP hash mismatch")
    with zipfile.ZipFile(original) as outer:
        names = outer.namelist()
        if names != ["mpv-git-2025-12-21-41f6a64-x86_64.zip"]:
            raise ValueError("Unexpected official release ZIP layout")
        with zipfile.ZipFile(io.BytesIO(outer.read(names[0]))) as inner:
            declared = {item["path"]: item["sha256"].lower() for item in manifest["files"]}
            if set(inner.namelist()) != set(declared):
                raise ValueError("Upstream runtime inventory mismatch")
            for name, sha in declared.items():
                if hashlib.sha256(inner.read(name)).hexdigest() != sha or digest(ROOT / "runtime" / name) != sha:
                    raise ValueError(f"Actual/upstream runtime differs: {name}")
    archives, failures = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(acquire, item, previous): item[0] for item in INPUTS}
        for future in concurrent.futures.as_completed(pending):
            name = pending[future]
            try:
                archives.append(future.result())
                print(f"Archived {name}", flush=True)
            except Exception as error:
                failures.append({"component": name, "error_type": type(error).__name__})
                print(f"Acquisition unavailable: {name} ({type(error).__name__})", flush=True)
    record = {"schema_version": 1, "complete_corresponding_source": False,
              "runtime_verified_files": len(declared),
              "upstream_artifact_sha256": digest(original),
              "archives": sorted(archives, key=lambda item: item["component"]),
              "acquisition_failures": failures,
              "unresolved": ["libass", "lcms2", "libplacebo", "shaderc and git-sync-deps closure",
                             "SPIRV-Cross", "nv-codec-headers", "Vulkan-Headers", "Vulkan-Loader",
                             "mujs WrapDB revision", "MinGW/GCC toolchain and build environment"]}
    index.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Original ZIP and {len(declared)} runtime files matched; {len(archives)} source inputs archived.")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
