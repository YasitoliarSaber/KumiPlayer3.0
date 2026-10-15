/**
 * 桌面风格的返回/前进状态。
 *
 * React Router 不暴露历史位置，这里用已见 location.key 序列记录位置：
 * PUSH 追加、POP 回退到已见位置。仅供标题栏按钮的可用状态使用，
 * 不复制第二份页面历史（真正的历史仍由 Router 拥有）。
 */

import { useEffect, useState } from 'react';
import type { NavigationType } from 'react-router';

const keys: string[] = [];
let position = -1;
const listeners = new Set<() => void>();

export function recordLocation(key: string, type: NavigationType): void {
  const current = keys[position];
  if (current === key) {
    return;
  }
  const seen = keys.indexOf(key);
  if (type === 'POP' && seen >= 0) {
    position = seen;
  } else {
    keys.length = position + 1;
    keys.push(key);
    position = keys.length - 1;
  }
  notify();
}

export function canGoBack(): boolean {
  return position > 0;
}

export function canGoForward(): boolean {
  return position < keys.length - 1;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeNavHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNavHistoryState(): { readonly back: boolean; readonly forward: boolean } {
  const [state, setState] = useState(() => ({ back: canGoBack(), forward: canGoForward() }));
  useEffect(
    () =>
      subscribeNavHistory(() => {
        setState({ back: canGoBack(), forward: canGoForward() });
      }),
    [],
  );
  return state;
}

/** 记录当前 location；放在 Shell 顶层每次导航都会调用一次。 */
export function useRecordLocation(key: string, type: NavigationType): void {
  useEffect(() => {
    recordLocation(key, type);
  }, [key, type]);
}

export function resetNavHistory(): void {
  keys.length = 0;
  position = -1;
  notify();
}
