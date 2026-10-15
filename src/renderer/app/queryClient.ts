/**
 * 单一 QueryClient（ADR-05）。
 *
 * 默认值必须显式声明：本地后端是无互联网也可用的回环服务，
 * 不能用浏览器在线状态暂停查询，也不能让默认重试放大读取压力。
 * mutation 由调用方显式决定，默认不重放。
 */

import { QueryClient } from '@tanstack/react-query';

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        retry: 1,
        retryDelay: 500,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // 本地回环服务不依赖 navigator.onLine；可用性由桌面状态与错误决定。
        networkMode: 'always',
      },
      mutations: {
        retry: 0,
        networkMode: 'always',
      },
    },
  });
}

/** Query 键必须包含运行代次，后端重启后旧结果不能落进新代次。 */
export const queryKeys = {
  desktop: (epoch: number) => ['desktop', epoch] as const,
  library: (epoch: number, source: string) => ['library', epoch, source] as const,
  workDetail: (epoch: number, workId: string) => ['work', epoch, workId] as const,
  tasks: (epoch: number, filter: string) => ['tasks', epoch, filter] as const,
  playbackStatus: (epoch: number) => ['playback-status', epoch] as const,
};
