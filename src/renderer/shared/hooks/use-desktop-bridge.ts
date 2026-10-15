/**
 * 订阅 Main 广播的桌面状态；卸载时退订，不保留第二条轮询。
 */

import { useEffect } from 'react';

import { useDesktopStore } from '../../app/desktop-store';

export function useDesktopStatusSubscription(): void {
  const setStatus = useDesktopStore((state) => state.setStatus);
  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.kumiplayer;
    if (!bridge) {
      return undefined;
    }
    return bridge.onStatus(setStatus);
  }, [setStatus]);
}
