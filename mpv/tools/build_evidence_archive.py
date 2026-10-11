"""Create a reproducible evidence archive; never label it complete source.

The archive deliberately excludes Git checkouts, temporary downloads, runtime
binaries and the upstream Anime4K comparison images not shipped by KumiPlayer.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    inputs = json.loads((ROOT / "sources/runtime-inputs.json").read_text(encoding="utf-8"))
    paths = {ROOT / item["path"]: item["sha256"] for item in inputs["archives"]}
    for record in (ROOT / "sources/evidence/components").glob("*/evidence.json"):
        evidence = json.loads(record.read_text(encoding="utf-8"))
        archive = evidence.get("source_only_archive")
        if archive:
            archive_path = archive["path"]
            archive_sha = archive["sha256"]
        else:
            archive_path = evidence["source_archive"]
            archive_sha = evidence["archive_sha256"]
        paths[ROOT.parent / archive_path] = archive_sha
        # Current config bytes must still match the actual inspected snapshots.
        for entry in evidence.get("local_source_files", []):
            actual = ROOT.parent / entry["path"]
            if digest(actual) != entry["sha256"]:
                raise ValueError(f"Component source changed after inspection: {actual.name}")
    for path, expected in paths.items():
        if digest(path) != expected.lower():
            raise ValueError(f"Source archive hash mismatch: {path.name}")
        # Inspect only: never extract or execute downloaded third-party files.
        with tarfile.open(path) as archive:
            if not archive.getmembers():
                raise ValueError(f"Empty source archive: {path.name}")
    roots = ("sources/evidence", "provenance/build", "licenses", "config", "tools")
    for folder in roots:
        for path in (ROOT / folder).rglob("*"):
            if not path.is_file():
                continue
            relative = path.relative_to(ROOT)
            if any(part in {"upstream-history", ".git", "__pycache__"} for part in relative.parts):
                continue
            if path.is_symlink() or not path.resolve().is_relative_to(ROOT.resolve()):
                raise ValueError("Evidence input escapes MPV root")
            if path.suffix in {".zip", ".gz", ".xz", ".pyc", ".partial"}:
                continue
            if folder == "config" and path.suffix.lower() not in {
                ".lua", ".conf", ".json", ".glsl", ".ttf", ".otf", ".md", ".txt"
            } and path.name != "LICENSE":
                continue
            # uosc's checked language/conversion tables are source. Runtime JSON
            # such as danmaku history is personal state, not corresponding code.
            if folder == "config" and path.suffix.lower() == ".json" and not relative.as_posix().startswith(
                "config/portable_config/scripts/uosc/"
            ):
                continue
            paths[path] = digest(path)
    for name in ("runtime-manifest.json", "components-manifest.json", "THIRD_PARTY_NOTICES.md",
                 "SOURCE_CODE.txt", "sources/runtime-inputs.json", "provenance/runtime.json"):
        path = ROOT / name
        paths[path] = digest(path)
    # Include immutable stats source trees containing the original license docs.
    stats = ROOT / "sources/evidence/stats"
    for path in stats.glob("mpv-stats-zh-*.zip"):
        paths[path] = digest(path)
    inventory = [{"path": path.relative_to(ROOT).as_posix(), "sha256": sha,
                  "bytes": path.stat().st_size} for path, sha in sorted(paths.items())]
    index = {"schema_version": 1, "archive_kind": "provenance-evidence",
             "complete_corresponding_source": False, "files": inventory,
             "unresolved": inputs["unresolved"],
             "limitations": ["Historical floating dependencies are not resolved by date guesses.",
                             "Stats authorization conflict requires a distribution decision.",
                             "Local archive creation does not constitute public source delivery."]}
    destination = ROOT / "sources/mpv-provenance-evidence.zip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".zip.partial")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        content = json.dumps(index, ensure_ascii=False, indent=2).encode("utf-8")
        item = zipfile.ZipInfo("EVIDENCE_INDEX.json", date_time=(2026, 10, 11, 0, 0, 0))
        item.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(item, content)
        for entry in inventory:
            item = zipfile.ZipInfo(entry["path"], date_time=(2026, 10, 11, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, (ROOT / entry["path"]).read_bytes())
    temporary.replace(destination)
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise ValueError("Evidence archive CRC error")
        for entry in inventory:
            if hashlib.sha256(archive.read(entry["path"])).hexdigest() != entry["sha256"]:
                raise ValueError("Evidence archive content hash error")
    index["archive"] = {"path": destination.relative_to(ROOT).as_posix(),
                        "sha256": digest(destination), "bytes": destination.stat().st_size}
    (ROOT / "sources/evidence-index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Evidence archive saved and read back: {len(inventory)} files; incomplete source clearly marked.")


if __name__ == "__main__":
    main()
