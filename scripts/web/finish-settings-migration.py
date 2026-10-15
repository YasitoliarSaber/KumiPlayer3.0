"""完成设置页与入口的 Mantine 退出收尾。

1) 去掉 <Input ...> 上残留的 Mantine size 属性；
2) 从 main.tsx 移除 Mantine 样式表导入（新 Renderer 已无 Mantine 组件）。
显式 UTF-8 读写。
"""

from __future__ import annotations

import re
import pathlib

SETTINGS = pathlib.Path("src/renderer/features/settings/SettingsPage.tsx")
MAIN = pathlib.Path("src/renderer/main.tsx")

INLINE_SIZE = re.compile(r'(<Input\b[^>]*?)\s+size="(?:xs|sm|md)"')

MANTINE_CSS_BLOCK = (
    "\n// 详情 / 媒体管理 / 设置仍在迁移中，暂时保留 Mantine 样式表；\n"
    "// 这三个页面迁出 Mantine 后与 @mantine 依赖一并移除。\n"
    "import '@mantine/core/styles.css';\n"
)


def main() -> None:
    settings = SETTINGS.read_text(encoding="utf-8")
    updated, count = INLINE_SIZE.subn(r"\1", settings)
    if count:
        SETTINGS.write_text(updated, encoding="utf-8")
        print(f"settings: removed {count} inline size attribute(s)")

    entry = MAIN.read_text(encoding="utf-8")
    without_mantine = entry.replace(MANTINE_CSS_BLOCK, "")
    if without_mantine != entry:
        MAIN.write_text(without_mantine, encoding="utf-8")
        print("entry: removed Mantine stylesheet import")


if __name__ == "__main__":
    main()
