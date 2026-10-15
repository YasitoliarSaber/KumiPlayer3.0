"""删除设置页多行标签上残留的 Mantine 专有 size 属性行。

只在属性独占一行（缩进后紧跟 size="xs"）时删除，不触碰 Button 等内联写法。
显式 UTF-8 读写。
"""

from __future__ import annotations

import re
import pathlib

TARGET = pathlib.Path("src/renderer/features/settings/SettingsPage.tsx")
PATTERN = re.compile(r"\n[ \t]+size=\"(?:xs|sm|md)\"")


def main() -> None:
    text = TARGET.read_text(encoding="utf-8")
    updated, count = PATTERN.subn("", text)
    if count:
        TARGET.write_text(updated, encoding="utf-8")
        print(f"removed {count} size attribute line(s)")


if __name__ == "__main__":
    main()
