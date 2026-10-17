import { describe, expect, it } from 'vitest';
import { createHttpMediaService } from '../../src/renderer/services/real/service';
import { createStubTransport, type RecordedCall } from './stub-transport';

const poster = `/api/assets/artwork/${'a'.repeat(64)}/${'b'.repeat(64)}-webp-v1/384`;
const detail = { work_id: 'main', title: '当前作品', seasons: [], episodes: [], related_works: [{ work_id: 'related' }] };
const relatedCard = { work_id: 'related', title: '关联作品', artwork: {
  poster: { resource_id: 'a'.repeat(64), content_version: `${'b'.repeat(64)}-webp-v1`, state: 'ready', variants: { '384': poster } },
} };

describe('详情真实相关作品', () => {
  it('按关联 ID 有界读取卡片，保留真实海报而非从空映射丢弃', async () => {
    const calls: RecordedCall[] = [];
    const service = createHttpMediaService({ transport: createStubTransport({
      'work.detail': { ...detail, related_works: [{ work_id: 'main' }, { work_id: 'related' }, { work_id: 'related' }] },
      'playback.history': { items: [] }, 'library.cards': { works: [relatedCard] },
    }, calls) });
    const result = await service.getWorkDetail('main');
    expect(result.related.map((item) => item.title)).toEqual(['关联作品']);
    expect(result.related[0]?.artwork.poster?.url).toBe(poster);
    expect(calls.find((call) => call.operation === 'library.cards')?.options.query).toEqual({ work_ids: 'related' });
    expect(calls.some((call) => call.operation === 'library.list')).toBe(false);
  });

  it('次要卡片读取失败仍能打开主详情；没有关联时不请求卡片', async () => {
    const service = createHttpMediaService({ transport: createStubTransport({
      'work.detail': detail, 'playback.history': { items: [] },
    }, [], { 'library.cards': '暂时不可用' }) });
    expect((await service.getWorkDetail('main')).related).toEqual([]);
    const calls: RecordedCall[] = [];
    const withoutRelated = createHttpMediaService({ transport: createStubTransport({
      'work.detail': { ...detail, related_works: [] }, 'playback.history': { items: [] },
    }, calls) });
    expect((await withoutRelated.getWorkDetail('main')).title).toBe('当前作品');
    expect(calls.some((call) => call.operation === 'library.cards')).toBe(false);
  });
});
