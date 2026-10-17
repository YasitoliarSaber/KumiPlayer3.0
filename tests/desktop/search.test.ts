import { describe, expect, it } from 'vitest';

import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { searchWorks } from '../../src/renderer/shared/api/search';

const catalog = buildMockCatalog({ count: 60 });

describe('演示库本地搜索', () => {
  it('空查询返回空结果，不返回整库', () => {
    expect(searchWorks(catalog.works, '   ')).toEqual([]);
  });

  it('标题匹配优先于原名与分类匹配，并给出命中原因', () => {
    const title = catalog.works.find((work) => work.title.includes('CLANNAD'))!;
    const hits = searchWorks(catalog.works, 'CLANNAD');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.work.title).toBe(title.title);
    expect(hits[0]?.reason).toContain('标题');
    // 命中原因必须来自作品自身字段，不能是空串。
    for (const hit of hits) {
      expect(hit.reason.length).toBeGreaterThan(0);
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  it('按类型与制作公司也能命中，用于解释结果来源', () => {
    const byGenre = searchWorks(catalog.works, '日常', { limit: 3 });
    expect(byGenre.length).toBeGreaterThan(0);
    expect(byGenre[0]?.reason).toContain('类型');

    const byStudio = searchWorks(catalog.works, '京都动画', { limit: 3 });
    expect(byStudio.length).toBeGreaterThan(0);
    expect(byStudio[0]?.reason).toContain('制作');
  });

  it('结果数受 limit 限制，且顺序对所有条目稳定', () => {
    const hits = searchWorks(catalog.works, 'e', { limit: 5 });
    expect(hits.length).toBeLessThanOrEqual(5);
    const again = searchWorks(catalog.works, 'e', { limit: 5 });
    expect(again.map((hit) => hit.work.id)).toEqual(hits.map((hit) => hit.work.id));
  });

  it('无匹配时返回空数组，不抛错', () => {
    expect(searchWorks(catalog.works, 'zzz-不存在-zzz')).toEqual([]);
  });
});
