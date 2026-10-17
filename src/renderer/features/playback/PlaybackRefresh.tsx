import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { demoQueryKeys, useMediaService } from '@/shared/api/service-context';

/** 从原生 MPV 返回时只读刷新一次；不定时采样，不提交播放进度。 */
export function PlaybackRefresh() {
  const client = useQueryClient();
  const service = useMediaService();
  useEffect(() => {
    if (service.serviceMode !== 'real') return;
    let pending: number | undefined;
    const refresh = () => {
      if (document.visibilityState !== 'visible' || pending !== undefined) return;
      // 一次返回可能同时触发 focus/visibilitychange，合并成一次刷新。
      pending = window.setTimeout(() => {
        pending = undefined;
        if (document.visibilityState !== 'visible') return;
        void client.invalidateQueries({
          predicate: ({ queryKey }) => queryKey[0] === demoQueryKeys.library[0]
            && ['library', 'detail', 'playback'].includes(String(queryKey[1])),
          refetchType: 'active',
        }, { cancelRefetch: false });
      }, 150);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearTimeout(pending);
    };
  }, [client, service]);
  return null;
}
