/**
 * 真实后端 DTO 适配与运行期服务选择的门禁。
 * 夹具形状来自后端源码的返回结构（WorkCard / 来源卡 / 配置），
 * 不使用真实库、真实凭据或网络。
 */

import { describe, expect, it } from 'vitest';

import { pickArtwork, toWorkSummary } from '@/services/real/adapters';
import { resolveServiceMode } from '@/app/service-mode';

const POSTER_URL_384 =
  '/api/assets/artwork/' +
  'a'.repeat(64) +
  '/' +
  'b'.repeat(64) +
  '-webp-v1/384';
const POSTER_URL_512 =
  '/api/assets/artwork/' +
  'a'.repeat(64) +
  '/' +
  'c'.repeat(64) +
  '-webp-v1/512';

const CARD = {
  work_id: 'w01',
  title: 'CLANNAD',
  original_title: 'CLANNAD -クラナド-',
  year: 2007,
  rating: 8.3,
  plot: '小镇与家庭的日常。',
  genres: ['剧情', '校园'],
  studios: ['京都动画'],
  media_type: 'tv',
  show_type: 'anime_series',
  source: 'openlist',
  sources: ['openlist', 'pan115'],
  episode_count: 23,
  asset_count: 2,
  season_count: 2,
  watch_status: { work_id: 'w01', status: 'watching', note: '', favorite: true, updated_at: null },
  artwork: { poster: { '384': POSTER_URL_384, '512': POSTER_URL_512 } },
};

describe('后端 DTO 适配', () => {
  it('只选择已发布的图片派生 URL，并按用途取尺寸', () => {
    expect(pickArtwork(CARD.artwork, 'poster', 384)?.url).toBe(POSTER_URL_384);
    expect(pickArtwork(CARD.artwork, 'poster', 600)?.url).toBe(POSTER_URL_512);
    // 未发布的远程地址不会被采用。
    expect(pickArtwork({ poster: { '384': 'https://image.tmdb.org/x.jpg' } }, 'poster', 384)).toBeNull();
    expect(pickArtwork(undefined, 'fanart', 1280)).toBeNull();
  });

  it('把后端卡片换算成视图模型，不补造缺失事实', () => {
    const summary = toWorkSummary(KB(CARD), null);
    expect(summary.id).toBe('w01');
    expect(summary.showType).toBe('anime_series');
    expect(summary.sources).toEqual(['openlist', 'pan115']);
    expect(summary.watch).toEqual({ status: 'watching', favorite: true, note: '' });
    expect(summary.artwork.poster?.width).toBe(384);
    // 进度只来自后端历史；卡片没有进度时保持 null，不假设"未开始"。
    expect(summary.progress).toBeNull();
  });
});

describe('服务实现选择', () => {
  it('默认使用真实后端，只有显式演示入口才用演示数据', () => {
    expect(resolveServiceMode('', undefined).mode).toBe('real');
    expect(resolveServiceMode('?demo=1', undefined).mode).toBe('demo');
    expect(resolveServiceMode('?service=demo', undefined).mode).toBe('demo');
    expect(resolveServiceMode('', 'demo').mode).toBe('demo');
    expect(resolveServiceMode('', 'real').mode).toBe('real');
  });
});

/** 夹具断言用：把宽松对象按契约字段读取，避免测试里出现 `any`。 */
function KB(value: unknown) {
  return value as Parameters<typeof toWorkSummary>[0];
}
