import { describe, expect, it } from 'vitest';

import type { LibraryChanges, LibrarySnapshot, WorkCard } from '@shared/contracts/dto';
import {
  applyChanges,
  applySnapshot,
  batchIds,
  emptyLibraryIndex,
  pumpIntervalMs,
} from '../../src/renderer/shared/api/library-index';

function card(workId: string, title = workId): WorkCard {
  return {
    work_id: workId,
    title,
    original_title: title,
    year: null,
    title_provenance: 'local',
    rating: 0,
    plot: '',
    genres: [],
    studios: [],
    media_type: 'tv',
    show_type: 'anime_series',
    card_type: 'main_series',
    source: 'local',
    sources: ['local'],
    episode_count: 0,
    asset_count: 0,
    season_count: 0,
    special_season_count: 0,
    metadata_state: 'ready',
    poster_path: '',
    fanart_path: '',
    clearlogo_path: '',
    content_scope: '',
    watch_status: {
      work_id: workId,
      status: '',
      note: '',
      favorite: false,
      updated_at: null,
    },
    artwork: {},
  };
}

function snapshot(sequence: number, works: readonly WorkCard[]): LibrarySnapshot {
  return {
    change_sequence: sequence,
    works,
    collections: [],
    summary: { work_count: works.length, episode_count: 0 },
    generation_id: `gen-${sequence}`,
    updating: false,
    background_active: false,
    digest: `digest-${sequence}`,
  };
}

function changes(overrides: Partial<LibraryChanges>): LibraryChanges {
  return {
    next_sequence: 0,
    has_more: false,
    reset_required: false,
    changes: [],
    generation_id: 'gen-1',
    updating: false,
    background_active: false,
    ...overrides,
  };
}

describe('轻量作品索引与增量合并', () => {
  it('基线快照建立规范化索引并推进游标', () => {
    const index = applySnapshot(emptyLibraryIndex(1), snapshot(12, [card('a'), card('b')]));
    expect(index.cursor).toBe(12);
    expect(index.order).toEqual(['a', 'b']);
    expect(Object.keys(index.works)).toEqual(['a', 'b']);
  });

  it('变更按 work_remove 移除并推进游标', () => {
    const base = applySnapshot(emptyLibraryIndex(1), snapshot(12, [card('a'), card('b')]));
    const applied = applyChanges(
      base,
      changes({
        next_sequence: 14,
        changes: [
          { sequence: 13, work_id: 'b', kind: 'work_remove' },
          { sequence: 14, work_id: 'c', kind: 'work_upsert' },
        ],
      }),
      [card('c', '新作品')],
    );
    expect(applied.resyncRequired).toBe(false);
    expect(applied.index.cursor).toBe(14);
    expect(applied.index.order).toEqual(['a', 'c']);
    expect(applied.index.works.c.title).toBe('新作品');
  });

  it('reset_required 要求重新读基线，且不推进游标', () => {
    const base = applySnapshot(emptyLibraryIndex(1), snapshot(12, [card('a')]));
    const applied = applyChanges(base, changes({ reset_required: true, next_sequence: 99 }), []);
    expect(applied.resyncRequired).toBe(true);
    expect(applied.index.cursor).toBe(12);
    expect(applied.index.order).toEqual(['a']);
  });

  it('同一个作品重复出现时保持单一索引项', () => {
    const base = applySnapshot(emptyLibraryIndex(1), snapshot(3, [card('a', '旧标题')]));
    const applied = applyChanges(base, changes({ next_sequence: 4 }), [card('a', '新标题')]);
    expect(applied.index.order).toEqual(['a']);
    expect(applied.index.works.a?.title).toBe('新标题');
  });

  it('变更泵节奏承接现有实现：活跃 1 秒 / 空闲 5 秒 / 隐藏 30 秒', () => {
    expect(pumpIntervalMs(true, true)).toBe(1_000);
    expect(pumpIntervalMs(true, false)).toBe(5_000);
    expect(pumpIntervalMs(false, true)).toBe(30_000);
  });

  it('卡片批次不超过后端 128 上限', () => {
    const ids = Array.from({ length: 300 }, (_, index) => `w${index}`);
    const batches = batchIds(ids);
    expect(batches.map((batch) => batch.length)).toEqual([128, 128, 44]);
  });
});
