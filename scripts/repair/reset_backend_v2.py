"""V4 受管媒体状态重置命令（默认预览，保留历史脚本名）。

用法：
    python scripts/repair/reset_backend_v2.py            # 只预览
    python scripts/repair/reset_backend_v2.py --apply    # 预览后确认执行

安全：
- 只删除 V4 重置清单中的受管媒体状态；配置、凭据、播放器状态和日志保留；
- 任何目标是来源根、磁盘根或用户主目录时立即中止；
- 真实媒体、本地来源目录、网盘文件与 OpenList 远端内容绝不被删除。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.maintenance.reset_backend_state_v4 import (  # noqa: E402
    ResetProtectionError,
    apply_reset,
    preview_reset,
)


def main() -> int:
    apply = "--apply" in sys.argv
    preview = preview_reset()
    print("=== KumiPlayer V4 受管媒体状态重置 ===")
    print(f"数据根：{preview['data_dir']}")
    print("将删除（KumiPlayer 受管数据，可重建）：")
    for target in preview["targets"]:
        print(f"  - {target}")
    if not preview["targets"]:
        print("  （无）")
    print("受保护来源根（绝不删除）：")
    for root in preview["source_roots_protected"]:
        print(f"  - {root}")
    if not preview["source_roots_protected"]:
        print("  （未配置）")

    if not apply:
        print("\n预览模式：未删除任何数据。确认后加 --apply 执行。")
        return 0

    answer = input("\n确认执行重置？输入 DELETE 继续：").strip()
    if answer != "DELETE":
        print("已取消，未删除任何数据。")
        return 1

    try:
        result = apply_reset()
    except ResetProtectionError as exc:
        print(f"已中止（路径保护）：{exc}")
        return 2
    print("\n已删除：")
    for path in result["removed"]:
        print(f"  - {path}")
    print("重置完成。下一次启动将创建空的 V4 媒体数据库。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
