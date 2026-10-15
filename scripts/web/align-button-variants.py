"""把 Mantine 的按钮变体名对齐到 shadcn/ui 的变体名。

只替换确定等价的字符串：default → outline（Mantine 的 default 就是有边框按钮），
color="red" → variant="destructive"。显式 UTF-8 读写。
"""

from __future__ import annotations

import pathlib

TARGETS = [
    pathlib.Path("src/renderer/features/manage/MediaManagementPage.tsx"),
    pathlib.Path("src/renderer/features/settings/SettingsPage.tsx"),
]

REPLACEMENTS = [
    ('variant="default"', 'variant="outline"'),
    ('color="red"', 'variant="destructive"'),
]


def main() -> None:
    for path in TARGETS:
        text = path.read_text(encoding="utf-8")
        updated = text
        for old, new in REPLACEMENTS:
            updated = updated.replace(old, new)
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            print(f"updated {path}")


if __name__ == "__main__":
    main()
