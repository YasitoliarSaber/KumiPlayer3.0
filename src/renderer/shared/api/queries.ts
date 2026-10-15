/**
 * 最小查询层：每条查询都显式声明 Query 键（含运行代次）与失败语义。
 * 读取失败保留最后一次有效数据，由 Query 的 placeholder/前值承担，
 * 不把瞬时失败呈现成空媒体库。
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { LibrarySnapshot, TaskList, WorkDetail } from '@shared/contracts/dto';
import type { GatewayError } from '@shared/contracts/errors';

import { queryKeys } from '../../app/queryClient';
import { useDesktopEpoch } from '../hooks/use-desktop-epoch';
import { createBridgeFacade, type BridgeFacade } from './bridge';

const facade: BridgeFacade = createBridgeFacade();

export function toGatewayError(error: unknown): GatewayError {
  const candidate = error as Partial<GatewayError> | undefined;
  if (candidate && typeof candidate.message === 'string' && typeof candidate.kind === 'string') {
    return candidate as GatewayError;
  }
  return { kind: 'internal', message: '读取失败', retryable: true };
}

async function unwrap<T>(outcome: Awaited<ReturnType<BridgeFacade['call']>>): Promise<T> {
  if (outcome.ok) {
    return outcome.data as T;
  }
  throw outcome.error;
}

export function useLibrary(source = 'all'): UseQueryResult<LibrarySnapshot, GatewayError> {
  const epoch = useDesktopEpoch();
  return useQuery<LibrarySnapshot, GatewayError>({
    queryKey: queryKeys.library(epoch, source),
    queryFn: async ({ signal }) =>
      unwrap<LibrarySnapshot>(await facade.call('library.list', {
        query: { source },
        signal,
      })),
  });
}

export function useWorkDetail(workId: string): UseQueryResult<WorkDetail, GatewayError> {
  const epoch = useDesktopEpoch();
  return useQuery<WorkDetail, GatewayError>({
    queryKey: queryKeys.workDetail(epoch, workId),
    enabled: workId.length > 0,
    queryFn: async ({ signal }) =>
      unwrap<WorkDetail>(await facade.call('work.detail', { params: { workId }, signal })),
  });
}

export function useTasks(limit = 20): UseQueryResult<TaskList, GatewayError> {
  const epoch = useDesktopEpoch();
  return useQuery<TaskList, GatewayError>({
    queryKey: queryKeys.tasks(epoch, String(limit)),
    queryFn: async ({ signal }) =>
      unwrap<TaskList>(await facade.call('tasks.list', { query: { limit }, signal })),
  });
}
