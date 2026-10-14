import { API_BASE as GLOBAL_API_BASE, requestJson } from './client';

const BASE_PATH = '/api/system';
const API_BASE = GLOBAL_API_BASE ? `${GLOBAL_API_BASE}${BASE_PATH}` : BASE_PATH;

export interface OpenFolderResult {
  ok: boolean;
  opened: boolean;
  exists: boolean;
  folder_path: string;
  source_path: string;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  return requestJson<T>(url, options);
}

export const systemApi = {
  async openFolder(workId: string, episodeId?: string, open = true, assetId = ''): Promise<OpenFolderResult> {
    return fetchJson(`${API_BASE}/open-folder`, {
      method: 'POST',
      body: JSON.stringify({
        work_id: workId,
        episode_id: episodeId || '',
        ...(assetId ? { asset_id: assetId } : {}),
        open,
      }),
    });
  },

};
