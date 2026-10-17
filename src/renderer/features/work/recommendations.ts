import type { WorkDetail, WorkSummary } from '@/shared/api/service';

/** 复用旧版的类型 + 题材匹配，仅排列已入库卡片，不创建作品关系。 */
export function selectRecommendations(work: WorkDetail, library: readonly WorkSummary[]): readonly WorkSummary[] {
  const tags = new Set([...work.genres, ...work.tags].map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean));
  const excluded = new Set([work.id, ...work.related.map((item) => item.id)]);
  const best: { work: WorkSummary; score: number }[] = [];
  for (const candidate of library) {
    if (excluded.has(candidate.id) || !candidate.artwork.poster) continue;
    excluded.add(candidate.id);
    const candidateTags = new Set([...candidate.genres, ...candidate.tags].map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean));
    let score = candidate.showType === work.showType ? 2 : 0;
    for (const tag of tags) if (candidateTags.has(tag)) score += 3;
    if (score === 0) continue;
    const index = best.findIndex((item) => score > item.score || (score === item.score && candidate.rating > item.work.rating));
    best.splice(index < 0 ? best.length : index, 0, { work: candidate, score });
    if (best.length > 6) best.pop();
  }
  return best.map((item) => item.work);
}
