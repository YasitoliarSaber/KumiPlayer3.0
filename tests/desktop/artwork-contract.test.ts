/**
 * 作品卡片图片契约回归：真实后端 artwork 是「角色 → 图片对象」，
 * 图片对象为 `{resource_id, content_version, variants, state}`，尺寸表在 `variants` 内。
 *
 * 证据：
 * - 产出：`backend/app/media_v4/assets/catalog.py:421-426`（`_get_subject_artwork_many`）。
 * - 消费：`backend/app/api/library_v4.py:35,201`、`backend/app/media_v4/projection/collections.py:123`、
 *   `backend/app/api/playback_v4.py:186`；详情每集缩略图取 `variants['384']`（`library_v4.py:43`）。
 *
 * 旧契约把角色直接当成「宽度 → URL」，只跳过一层，于是把图片对象自己的键当成宽度键，
 * 对 `variants`（对象）要求字符串，触发用户看到的
 * “作品卡片缺少必需字段：artwork: artwork.clearlogo.variants 期望字符串”
 * （该报错出口：`src/renderer/services/real/service.ts:139`）。
 * 本用例既复现旧假设的成因，也证明真实结构可以解析、按尺寸取图并进入界面。
 */

import { describe, expect, it } from 'vitest';

import type { ArtworkImage, WorkArtwork, WorkCard } from '@shared/contracts/dto';
import { parseWorkCard, parseWorkDetail } from '@shared/contracts/dto';
import { pickArtwork, toWorkDetail, type BackendWorkDetailDto } from '@/services/real/adapters';

const RESOURCE_ID = 'a'.repeat(64);
const POSTER_DIGEST = 'b'.repeat(64);
const FANART_DIGEST = 'c'.repeat(64);
const CLEARLOGO_DIGEST = 'd'.repeat(64);
const EPISODE_DIGEST = 'e'.repeat(64);

/** 按后端真实结构构造图片对象：尺寸表在 `variants` 里，版本号是 `<digest>-webp-v1`。 */
function artworkImage(digest: string, widths: readonly number[]): ArtworkImage {
  const variants: Record<string, string> = {};
  for (const width of widths) {
    variants[String(width)] = `/api/assets/artwork/${RESOURCE_ID}/${digest}-webp-v1/${width}`;
  }
  return { resource_id: RESOURCE_ID, content_version: `${digest}-webp-v1`, state: 'ready', variants };
}

const ARTWORK: WorkArtwork = {
  poster: artworkImage(POSTER_DIGEST, [256, 384, 512]),
  fanart: artworkImage(FANART_DIGEST, [512, 768, 1280]),
  clearlogo: artworkImage(CLEARLOGO_DIGEST, [256, 384, 512]),
};

const CLEARLOGO_384 = `/api/assets/artwork/${RESOURCE_ID}/${CLEARLOGO_DIGEST}-webp-v1/384`;
const EPISODE_THUMB_384 = `/api/assets/artwork/${RESOURCE_ID}/${EPISODE_DIGEST}-webp-v1/384`;

function card(overrides: Partial<WorkCard> = {}): WorkCard {
  return {
    work_id: 'w01',
    title: 'CLANNAD',
    original_title: 'CLANNAD -クラナド-',
    year: 2007,
    title_provenance: 'tmdb',
    rating: 8.3,
    plot: '',
    genres: [],
    studios: [],
    media_type: 'tv',
    show_type: 'anime_series',
    card_type: 'main_series',
    source: 'local',
    sources: ['local'],
    episode_count: 3,
    asset_count: 3,
    season_count: 1,
    special_season_count: 0,
    metadata_state: 'ready',
    poster_path: ARTWORK.poster!.variants['384']!,
    fanart_path: ARTWORK.fanart!.variants['1280']!,
    clearlogo_path: CLEARLOGO_384,
    content_scope: '',
    watch_status: { work_id: 'w01', status: '', note: '', favorite: false, updated_at: null },
    artwork: ARTWORK,
    ...overrides,
  };
}

describe('作品卡片图片契约', () => {
  it('真实结构可以通过卡片校验，并保留 clearlogo 的 384 变体 URL', () => {
    const parsed = parseWorkCard(card());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.artwork.clearlogo?.variants['384']).toBe(CLEARLOGO_384);
    expect(parsed.value.artwork.clearlogo?.resource_id).toBe(RESOURCE_ID);
    expect(parsed.value.artwork.clearlogo?.content_version).toBe(`${CLEARLOGO_DIGEST}-webp-v1`);
    expect(parsed.value.artwork.clearlogo?.state).toBe('ready');
    expect(Object.keys(parsed.value.artwork.clearlogo?.variants ?? {})).toEqual(['256', '384', '512']);
  });

  it('pickArtwork 从真实结构按用途取尺寸', () => {
    expect(pickArtwork(ARTWORK, 'poster', 384)?.url).toBe(ARTWORK.poster!.variants['384']);
    expect(pickArtwork(ARTWORK, 'fanart', 1280)?.url).toBe(ARTWORK.fanart!.variants['1280']);
    expect(pickArtwork(ARTWORK, 'clearlogo', 512)?.url).toBe(ARTWORK.clearlogo!.variants['512']);
    // 不小于目标宽度里最小的一档；没有更大档时退最大档。
    expect(pickArtwork(ARTWORK, 'poster', 300)?.url).toBe(ARTWORK.poster!.variants['384']);
    expect(pickArtwork(ARTWORK, 'clearlogo', 2048)?.url).toBe(ARTWORK.clearlogo!.variants['512']);
    expect(pickArtwork(ARTWORK, 'clearlogo', 128)?.url).toBe(ARTWORK.clearlogo!.variants['256']);
  });

  it('详情剧集 thumb_path 通过发布校验才产出缩略图，否则保持 null', () => {
    const detail: BackendWorkDetailDto = {
      ...card(),
      episodes: [
        {
          episode_id: 'e1',
          episode_number: 1,
          title: '第一集',
          runtime: 24,
          season_id: 's1',
          thumb_path: EPISODE_THUMB_384,
        },
        {
          episode_id: 'e2',
          episode_number: 2,
          title: '第二集',
          runtime: 24,
          season_id: 's1',
          thumb_path: 'https://image.tmdb.org/t/p/w500/x.jpg',
        },
        { episode_id: 'e3', episode_number: 3, title: '第三集', runtime: 24, season_id: 's1' },
      ],
      seasons: [{ season_id: 's1', season_number: 1, label: '第 1 季' }],
    };

    const view = toWorkDetail(detail, null, () => null);
    const episodes = view.seasons[0]?.episodes ?? [];
    expect(episodes.map((episode) => episode.thumb?.url ?? null)).toEqual([EPISODE_THUMB_384, null, null]);
    // 宽度取 URL 末段数字，高度未知保持 0（与卡片图片同一取值约定）。
    expect(episodes[0]?.thumb).toEqual({ url: EPISODE_THUMB_384, width: 384, height: 0 });
  });

  it('反向：图片对象的 variants 不是对象时判为无效，校验没有被放宽', () => {
    const brokenImage = { ...ARTWORK.clearlogo!, variants: 'not-an-object' };
    const broken: unknown = { ...card(), artwork: { clearlogo: brokenImage } };
    const parsed = parseWorkCard(broken);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.join('; ')).toContain('artwork');
    }
  });

  it('旧扁平形状不再被当作契约', () => {
    // 修复前的夹具把角色直接写成「宽度 → URL」；它缺少图片对象的四个字段，必须被拒绝。
    const legacyFlat: unknown = {
      ...card(),
      artwork: {
        clearlogo: {
          '256': ARTWORK.clearlogo!.variants['256'],
          '384': CLEARLOGO_384,
          '512': ARTWORK.clearlogo!.variants['512'],
        },
      },
    };
    expect(parseWorkCard(legacyFlat).ok).toBe(false);
  });

  it('复现原始报错：旧契约把 variants 对象当成宽度值去要求字符串', () => {
    // 下面这段是修复前 dto.ts 里 `parseArtworkVariants` 的判定逻辑（已删除），
    // 仅用于钉住用户报告的报错文本，不参与产品代码。
    const legacyFlatIssues = (value: Record<string, unknown>): readonly string[] => {
      const issues: string[] = [];
      for (const [role, variants] of Object.entries(value)) {
        for (const [width, url] of Object.entries(variants as Record<string, unknown>)) {
          if (typeof url !== 'string') {
            issues.push(`artwork.${role}.${width} 期望字符串`);
          }
        }
      }
      return issues;
    };

    // 用户那张卡片当时只有 clearlogo 角色，所以报错落在 clearlogo 上。
    const reported = legacyFlatIssues({ clearlogo: ARTWORK.clearlogo });
    expect(reported).toContain('artwork.clearlogo.variants 期望字符串');
  });
});

describe('作品详情观看状态契约', () => {
  it.each([
    { episodes: [{ episode_id: 'e1', season_id: 's1', episode_number: 1 }] },
    { episodes: [] },
  ])('详情没有 season_count 时按真实季度计数，空季同样保留顺序：%j', ({ episodes }) => {
    const payload: Record<string, unknown> = {
      ...card(),
      seasons: [{ season_id: 's2', season_number: 2 }, { season_id: 's1', season_number: 1 }],
      episodes,
    };
    delete payload.season_count;
    const parsed = parseWorkDetail(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const detail = toWorkDetail(parsed.value, null, () => null);
    expect(detail.seasonCount).toBe(2);
    expect(detail.seasons.map((season) => season.id)).toEqual(['s2', 's1']);
  });

  it('没有观看记录时接受后端的 null，并能转换为未观看、未收藏的详情', () => {
    // projection/details.py 无 tracking_states 记录时明确返回 null。
    const parsed = parseWorkDetail({
      ...card(), watch_status: null, seasons: [], episodes: [], cast: [], related_works: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.watch_status).toBeNull();
    expect(toWorkDetail(parsed.value, null, () => null).watch).toEqual({
      status: '', favorite: false, note: '',
    });
  });

  it('已有观看状态和收藏信息保持原值', () => {
    const parsed = parseWorkDetail({
      ...card(),
      watch_status: { work_id: 'w01', status: 'watching', favorite: true, note: '追番', updated_at: null },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(toWorkDetail(parsed.value, null, () => null).watch).toEqual({
      status: 'watching', favorite: true, note: '追番',
    });
  });

  it.each(['watching', [], { work_id: 'w01', favorite: 'true' }])(
    '仍然拒绝非空但不符合契约的观看状态 %j', (watchStatus) => {
      expect(parseWorkDetail({ ...card(), watch_status: watchStatus }).ok).toBe(false);
    },
  );
});
