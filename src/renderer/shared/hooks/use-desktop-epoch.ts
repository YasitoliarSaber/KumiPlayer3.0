/**
 * 运行代次：所有查询键都带上它，后端重启后旧结果自然隔离。
 */

import { useDesktopStore } from '../../app/desktop-store';

export function useDesktopEpoch(): number {
  return useDesktopStore((state) => state.status?.epoch ?? 0);
}

export function useDesktopStatus() {
  return useDesktopStore((state) => state.status);
}
