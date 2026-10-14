import { api } from './client';

export interface WorkDetailTag {
  id: string;
  label: string;
  color: string;
}

export interface WorkCustomization {
  work_id: string;
  tags: WorkDetailTag[];
}

export interface ExtraVideoCategorySummary {
  category: 'substantive_special' | 'auxiliary' | 'unmatched' | 'uncertain';
  count: number;
  reasons: string[];
}

export interface ExtraVideoOverview {
  work_id: string;
  substantive_special_count: number;
  auxiliary_count: number;
  unmatched_count: number;
  uncertain_count: number;
  reasons: string[];
  categories?: ExtraVideoCategorySummary[];
}

const workPath = (workId: string) => `/api/v4/work-customization/${encodeURIComponent(workId)}`;

export const workCustomizationApi = {
  get: (workId: string) => api.get<WorkCustomization>(workPath(workId)),
  saveTags: (workId: string, tags: WorkDetailTag[]) => api.put<WorkCustomization>(workPath(workId), { tags }),
  getExtraVideos: (workId: string) => api.get<ExtraVideoOverview>(`${workPath(workId)}/extra-videos`),
};
