// V4 SQLite 投影只读接口与观看状态接口。

import { api } from './client';
import type { WorkIndex } from './types';

export type LocalWatchStatusValue = '' | 'watching' | 'watched' | 'on_hold' | 'dropped';

export interface LocalWatchStatus {
  work_id: string;
  status: LocalWatchStatusValue;
  note: string;
  favorite: boolean;
  updated_at: string;
}

export const libraryApi = {
  getChanges: (after: number, limit = 128) => api.get<LibraryChanges>(`/api/library/changes?after=${after}&limit=${limit}`),
  getCards: (workIds: string[]) => api.get<{ works: WorkIndex[] }>(`/api/library/cards?work_ids=${workIds.map(encodeURIComponent).join(',')}`),
  getLibrary: (params?: { source?: string; compact?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.source && params.source !== 'all') searchParams.set('source', params.source);
    if (params?.compact) searchParams.set('compact', 'true');
    const query = searchParams.toString();
    return api.get<{ works: WorkIndex[]; summary: Record<string, unknown>; generated_at: string; needs_rescan: boolean; change_sequence: number }>(
      `/api/library${query ? `?${query}` : ''}`,
    );
  },

  getWorkDetail: (workId: string) => api.get<WorkIndex>(`/api/library/works/${encodeURIComponent(workId)}`),

  rescanLibrary: () => api.post<{ task_id: string; status: string }>('/api/library/rescan'),

  getDiagnostics: () => api.get<{ ok: boolean; digest: string; summary: { work_count: number } }>('/api/library/diagnostics'),

  setWatchStatus: (workId: string, status: LocalWatchStatusValue, note = '', favorite?: boolean) =>
    api.patch<LocalWatchStatus>(`/api/library/watch-status/${encodeURIComponent(workId)}`, { status, note, favorite }),
};

export interface LibraryChanges {
  changes: Array<{ sequence: number; kind: 'work_upsert' | 'work_remove' | 'artwork' | 'watch' | 'reset'; work_id: string }>;
  next_sequence: number;
  has_more: boolean;
  reset_required: boolean;
}
