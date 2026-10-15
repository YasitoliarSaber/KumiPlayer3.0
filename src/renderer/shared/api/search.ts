/**
 * 演示库内的有界本地搜索。
 *
 * 纯函数：只在已加载的演示索引上做排序与截断，不建立第二份全局索引，
 * 也不承担任何识别或身份判定。调用方负责传入当前来源筛选后的集合。
 */

import type { WorkSummary } from './service';

export interface SearchHit {
  readonly work: WorkSummary;
  /** 命中的字段，用于结果里解释为什么匹配。 */
  readonly reason: string;
  readonly score: number;
}

export interface SearchOptions {
  /** 返回条数上限；默认 8，避免面板一次渲染整库。 */
  readonly limit?: number;
}

const WEIGHTS = {
  titleExact: 100,
  titlePrefix: 80,
  titleContains: 60,
  originalTitle: 40,
  genre: 24,
  studio: 20,
} as const;

/** 归一化：去空白、统一小写，便于中英文混排匹配。 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function searchWorks(
  works: readonly WorkSummary[],
  query: string,
  options: SearchOptions = {},
): readonly SearchHit[] {
  const limit = Math.max(1, options.limit ?? 8);
  const needle = normalize(query);
  if (needle.length === 0) {
    return [];
  }

  const hits: SearchHit[] = [];
  for (const work of works) {
    const title = normalize(work.title);
    const original = normalize(work.originalTitle);
    let score = 0;
    let reason = '';

    if (title === needle) {
      score = WEIGHTS.titleExact;
      reason = '标题完全匹配';
    } else if (title.startsWith(needle)) {
      score = WEIGHTS.titlePrefix;
      reason = '标题开头匹配';
    } else if (title.includes(needle)) {
      score = WEIGHTS.titleContains;
      reason = '标题包含';
    } else if (original.includes(needle)) {
      score = WEIGHTS.originalTitle;
      reason = '原名匹配';
    } else {
      const genre = work.genres.find((item) => normalize(item).includes(needle));
      if (genre) {
        score = WEIGHTS.genre;
        reason = `类型：${genre}`;
      } else {
        const studio = work.studios.find((item) => normalize(item).includes(needle));
        if (studio) {
          score = WEIGHTS.studio;
          reason = `制作：${studio}`;
        }
      }
    }

    if (score > 0) {
      hits.push({ work, reason, score });
    }
  }

  return hits
    .sort((left, right) => right.score - left.score || left.work.title.localeCompare(right.work.title, 'zh-Hans-CN'))
    .slice(0, limit);
}

/** 常用导航项：与侧栏保持同一组目的地，避免两套入口漂移。 */
export const QUICK_NAV: ReadonlyArray<{ readonly label: string; readonly to: string }> = [
  { label: '首页', to: '/' },
  { label: '我的收藏', to: '/favorites' },
  { label: '最近观看', to: '/recent' },
  { label: '番剧', to: '/library/anime_series' },
  { label: '动画电影', to: '/library/anime_movie' },
  { label: '媒体管理', to: '/manage' },
  { label: '任务中心', to: '/tasks' },
  { label: '设置', to: '/settings' },
];

export function searchNav(query: string): readonly { readonly label: string; readonly to: string }[] {
  const needle = normalize(query);
  if (needle.length === 0) {
    return QUICK_NAV.slice(0, 6);
  }
  return QUICK_NAV.filter((item) => normalize(item.label).includes(needle));
}
