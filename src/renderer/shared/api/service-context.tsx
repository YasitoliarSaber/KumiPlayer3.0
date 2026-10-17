/**
 * 业务服务注入点：页面只依赖 `MediaService` 接口，不关心实现来自演示数据还是真实后端。
 * 单例服务 + TanStack Query 缓存，避免每个页面各建一套请求状态。
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type {
  LibrarySnapshot,
  MediaService,
  PlaybackSession,
  SettingsSnapshot,
  TaskEntry,
  WorkDetail,
} from './service';
import { createMockMediaService } from '../../mock/service';
import { createHttpMediaService } from '../../services/real/service';
import { resolveServiceMode } from '../../app/service-mode';

const ServiceContext = createContext<MediaService | null>(null);

export function ServiceProvider({
  children,
  service,
}: {
  readonly children: ReactNode;
  readonly service?: MediaService;
}) {
  // 明确的二选一：真实模式失败就如实报错，不会在后台换成演示数据。
  const value = useMemo(
    () => service ?? (resolveServiceMode().mode === 'demo' ? createMockMediaService() : createHttpMediaService()),
    [service],
  );
  return <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>;
}

export function useMediaService(): MediaService {
  const service = useContext(ServiceContext);
  if (!service) {
    throw new Error('缺少 MediaService：请在 ServiceProvider 内渲染演示页面');
  }
  return service;
}

export const demoQueryKeys = {
  library: ['demo', 'library'] as const,
  detail: (workId: string) => ['demo', 'detail', workId] as const,
  sources: ['demo', 'sources'] as const,
  review: (sourceId: string) => ['demo', 'review', sourceId] as const,
  tasks: ['demo', 'tasks'] as const,
  settings: ['demo', 'settings'] as const,
  playback: ['demo', 'playback'] as const,
};

export function useLibrary(): UseQueryResult<LibrarySnapshot, Error> {
  const service = useMediaService();
  return useQuery({
    queryKey: demoQueryKeys.library,
    queryFn: ({ signal }) => service.listLibrary(signal),
  });
}

export function useWorkDetail(workId: string): UseQueryResult<WorkDetail, Error> {
  const service = useMediaService();
  return useQuery({
    queryKey: demoQueryKeys.detail(workId),
    enabled: workId.length > 0,
    queryFn: ({ signal }) => service.getWorkDetail(workId, signal),
  });
}

export function useSources(): UseQueryResult<readonly import('./service').SourceCard[], Error> {
  const service = useMediaService();
  return useQuery({
    queryKey: demoQueryKeys.sources,
    queryFn: ({ signal }) => service.listSources(signal),
  });
}

export function useReviewIssues(sourceId: string): UseQueryResult<readonly import('./service').ReviewIssue[], Error> {
  const service = useMediaService();
  return useQuery({
    queryKey: demoQueryKeys.review(sourceId),
    enabled: sourceId.length > 0,
    queryFn: () => service.getReviewIssues(sourceId),
  });
}

export function useTasks(): UseQueryResult<readonly TaskEntry[], Error> {
  const service = useMediaService();
  return useQuery({
    queryKey: demoQueryKeys.tasks,
    queryFn: ({ signal }) => service.listTasks(signal),
    // 演示任务有生命周期，需要短轮询；真实实现可换成后端推送或游标。
    refetchInterval: 900,
  });
}

export function useSettings(): UseQueryResult<SettingsSnapshot, Error> {
  const service = useMediaService();
  return useQuery({
    queryKey: demoQueryKeys.settings,
    queryFn: () => service.getSettings(),
  });
}

export function usePlayback(): UseQueryResult<PlaybackSession | null, Error> {
  const service = useMediaService();
  return useQuery({
    queryKey: demoQueryKeys.playback,
    queryFn: () => service.getPlayback(),
    refetchInterval: 900,
  });
}
