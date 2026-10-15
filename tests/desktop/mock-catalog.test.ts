import { describe, expect, it } from 'vitest';

import { buildMockCatalog, buildMockDetail, MOCK_WORK_TARGET } from '../../src/renderer/mock/catalog';
import { MOCK_ASSET_BASE } from '../../src/renderer/mock/asset-manifest';

describe('演示目录', () => {
  const catalog = buildMockCatalog();

  it('生成约 240 条唯一且稳定的模拟条目', () => {
    expect(catalog.works).toHaveLength(MOCK_WORK_TARGET);
    const ids = new Set(catalog.works.map((work) => work.id));
    expect(ids.size).toBe(MOCK_WORK_TARGET);
    // 重复构建必须完全一致（确定性）。
    const again = buildMockCatalog();
    expect(again.works.map((work) => work.id)).toEqual(catalog.works.map((work) => work.id));
    expect(again.works[10]?.rating).toBe(catalog.works[10]?.rating);
  });

  it('模拟 ID 与图片 URL 都指向演示命名空间，不暴露任何本地路径', () => {
    for (const work of catalog.works) {
      expect(work.id.startsWith('w')).toBe(true);
      expect(work.id).toMatch(/^w\d{2}-v\d{2}$/);
      if (work.artwork.poster) {
        expect(work.artwork.poster.url.startsWith(MOCK_ASSET_BASE)).toBe(true);
      }
      expect(JSON.stringify(work)).not.toMatch(/[A-Za-z]:\\\\|[A-Za-z]:\\/);
    }
  });

  it('交叉排列基作，首屏不会全是同名卡片', () => {
    const firstEight = catalog.works.slice(0, 8).map((work) => work.title);
    expect(new Set(firstEight).size).toBeGreaterThan(3);
  });

  it('详情与列表一致：同一 ID 的标题、集数与图片一致，进度落在真实存在的剧集上', () => {
    const work = catalog.works.find((entry) => entry.progress !== null);
    expect(work).toBeDefined();
    const detail = buildMockDetail(work!, catalog);
    expect(detail.title).toBe(work!.title);
    expect(detail.artwork.poster?.url).toBe(work!.artwork.poster?.url);

    const episodes = detail.seasons.flatMap((season) => season.episodes);
    expect(episodes.length).toBeGreaterThan(0);
    if (work!.progress) {
      const matched = episodes.some((episode) => episode.id === work!.progress!.episodeId);
      expect(matched).toBe(true);
    }
    // 每个剧集都必须有可用版本，否则"选择版本"菜单会是空的。
    for (const episode of episodes) {
      expect(episode.assets.length).toBeGreaterThan(0);
    }
  });

  it('缺少透明标志的基作回退为文本标题而不是空白', () => {
    const withoutLogo = catalog.works.find((work) => work.artwork.clearlogo === null);
    expect(withoutLogo).toBeDefined();
    const detail = buildMockDetail(withoutLogo!, catalog);
    expect(detail.artwork.clearlogo).toBeNull();
    expect(detail.title.length).toBeGreaterThan(0);
  });
});
