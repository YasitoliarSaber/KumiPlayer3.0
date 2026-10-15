/**
 * 确定性演示目录。
 *
 * 由 7 部基础作品 × 若干变体组成约 240 个列表条目，用于验证媒体墙滚动、
 * 图片懒加载与筛选；每条都有唯一且稳定的模拟 ID（`<slug>-v<nn>`），
 * 与真实媒体库 ID 完全隔离。同一基础作品复用同一批图片 URL，不复制二进制。
 *
 * 全部取值由固定种子推导，重复运行结果一致；这里不做任何识别、合卡或编号推导。
 */

import { MOCK_ASSET_BASE, MOCK_BASE_WORKS, type MockBaseWork } from './asset-manifest';
import type {
  ArtworkRef,
  ArtworkSet,
  CastEntry,
  EpisodeEntry,
  MediaType,
  ProgressSnapshot,
  SeasonEntry,
  ShowType,
  SourceId,
  WorkDetail,
  WorkSummary,
} from '../shared/api/service';

/** 演示库总条目数：约 240 条，按基础作品均分。 */
export const MOCK_WORK_TARGET = 240;

interface BaseProfile {
  readonly slug: string;
  readonly showType: ShowType;
  readonly mediaType: MediaType;
  readonly genres: readonly string[];
  readonly studios: readonly string[];
  readonly tags: readonly string[];
  readonly plot: string;
  readonly seasons: number;
  readonly episodesPerSeason: readonly number[];
  readonly originalTitle: string;
}

/** 展示用基础资料：只描述演示条目，不参与任何识别或身份判定。 */
const PROFILES: Record<string, Omit<BaseProfile, 'slug'>> = {
  w01: {
    showType: 'anime_series',
    mediaType: 'tv',
    genres: ['剧情', '校园', '家庭'],
    studios: ['京都动画'],
    tags: ['催泪', '青春', '日常'],
    plot: '普通高中生与小镇上的人们相遇，在缓慢的日常里重新理解家庭与羁绊的意义。',
    seasons: 2,
    episodesPerSeason: [23, 24],
    originalTitle: 'CLANNAD',
  },
  w02: {
    showType: 'anime_series',
    mediaType: 'tv',
    genres: ['动作', '超自然', '喜剧'],
    studios: ['Science SARU'],
    tags: ['怪谈', '战斗', '高速'],
    plot: '相信幽灵的少年与相信外星人的少女相遇，校园生活开始被怪异与超能力搅动。',
    seasons: 2,
    episodesPerSeason: [12, 12],
    originalTitle: 'ダンダダン',
  },
  w03: {
    showType: 'anime_series',
    mediaType: 'tv',
    genres: ['悬疑', '校园', '日常'],
    studios: ['京都动画'],
    tags: ['推理', '节能主义', '古典部'],
    plot: '以节能为信条的高中生被卷入古典部的谜题，日常里的微小疑问被逐一拆开。',
    seasons: 1,
    episodesPerSeason: [22],
    originalTitle: '氷菓',
  },
  w04: {
    showType: 'anime_series',
    mediaType: 'tv',
    genres: ['喜剧', '奇幻', '冒险'],
    studios: ['Studio Deen'],
    tags: ['异世界', '搞笑', '小队'],
    plot: '转生到异世界的少年只想安稳度日，却总被队友和魔王军拖着走向大事件。',
    seasons: 3,
    episodesPerSeason: [10, 10, 11],
    originalTitle: 'この素晴らしい世界に祝福を！',
  },
  w05: {
    showType: 'anime_series',
    mediaType: 'tv',
    genres: ['奇幻', '冒险', '公路'],
    studios: ['C2C'],
    tags: ['旅行', '魔法', '单元剧'],
    plot: '见习魔女骑着扫帚走过一个又一个国家，在旅途中遇见形形色色的人与规则。',
    seasons: 1,
    episodesPerSeason: [12],
    originalTitle: '魔女の旅々',
  },
  w06: {
    showType: 'anime_movie',
    mediaType: 'movie',
    genres: ['科幻', '末日', '公路'],
    studios: ['White Fox'],
    tags: ['废土', '剧场版', '生存'],
    plot: '文明崩塌后的世界里，两名少女驾着履带车穿行废墟，寻找食物与活下去的理由。',
    seasons: 1,
    episodesPerSeason: [1],
    originalTitle: '少女終末旅行',
  },
  w07: {
    showType: 'anime_series',
    mediaType: 'tv',
    genres: ['科幻', '战争', '剧情'],
    studios: ['A-1 Pictures'],
    tags: ['机甲', '群像', '战争'],
    plot: '被排除在战场之外的一线部队，在无人机的注视下继续执行没有尽头的任务。',
    seasons: 2,
    episodesPerSeason: [11, 12],
    originalTitle: '86―エイティシックス―',
  },
};

const SOURCE_POOL: readonly SourceId[] = ['local', 'openlist', 'pan115', 'baidu', 'quark', 'hybrid'];
const RESOLUTIONS = ['1080p', '2160p', '720p'] as const;
const CODECS = ['H.264', 'HEVC', 'AV1'] as const;
const RELEASE_GROUPS = ['BDRip', 'WEB-DL', 'Baha', 'Moozzi2'] as const;

/** mulberry32：固定种子，保证每次运行的演示数据一致。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function assetUrl(file: string): string {
  return `${MOCK_ASSET_BASE}${file}`;
}

function artworkSet(base: MockBaseWork): ArtworkSet {
  const pick = (role: string): ArtworkRef | null => {
    const found = base.assets.find((asset) => asset.role === role);
    return found ? { url: assetUrl(found.file), width: found.width, height: found.height } : null;
  };
  return {
    poster: pick('poster'),
    fanart: pick('fanart'),
    clearlogo: pick('clearlogo'),
    episodeThumbs: base.assets
      .filter((asset) => asset.role === 'episode_thumb')
      .map((asset) => ({ url: assetUrl(asset.file), width: asset.width, height: asset.height })),
  };
}

export interface MockCatalog {
  readonly works: readonly WorkSummary[];
  readonly byId: ReadonlyMap<string, WorkSummary>;
}

interface CatalogOptions {
  /** 覆盖条目数，便于在小数据集下做单元测试。 */
  readonly count?: number;
}

export function buildMockCatalog(options: CatalogOptions = {}): MockCatalog {
  const target = options.count ?? MOCK_WORK_TARGET;
  const bases = MOCK_BASE_WORKS;
  if (bases.length === 0) {
    return { works: [], byId: new Map() };
  }
  const perBase = Math.floor(target / bases.length);
  const remainder = target % bases.length;
  const random = seededRandom(20261015);
  const groups: WorkSummary[][] = [];

  bases.forEach((base, baseIndex) => {
    const profile = PROFILES[base.slug];
    if (!profile) {
      return;
    }
    const artwork = artworkSet(base);
    const variantCount = perBase + (baseIndex < remainder ? 1 : 0);
    const group: WorkSummary[] = [];
    for (let variant = 1; variant <= variantCount; variant += 1) {
      const id = `${base.slug}-v${String(variant).padStart(2, '0')}`;
      const episodeCount = profile.episodesPerSeason.reduce((total, value) => total + value, 0);
      const assetCount = 1 + Math.floor(random() * 3);
      const sourceCount = random() > 0.62 ? 2 : 1;
      const sources = Array.from(
        new Set([SOURCE_POOL[(baseIndex + variant) % SOURCE_POOL.length], ...SOURCE_POOL.slice(sourceCount)]),
      ) as SourceId[];
      const year = profile.mediaType === 'movie'
        ? (base.year || 2017) + Math.floor(random() * 3)
        : (base.year || 2014) + Math.floor(random() * 8);
      const rating = Math.round((7.1 + random() * 2.3) * 10) / 10;
      const favorite = random() < 0.18;
      const watchRoll = random();
      const status = favorite
        ? 'watching'
        : watchRoll < 0.16
          ? 'watching'
          : watchRoll < 0.24
            ? 'watched'
            : watchRoll < 0.3
              ? 'on_hold'
              : watchRoll < 0.34
                ? 'dropped'
                : '';
      const hasProgress = status === 'watching' || status === 'on_hold' || random() < 0.24;
      const duration = 1420 + Math.floor(random() * 180);
      const position = hasProgress ? Math.floor(duration * (0.06 + random() * 0.72)) : 0;
      const progressEpisodeNumber = 1 + Math.floor(random() * 3);
      const progress: ProgressSnapshot | null = hasProgress
        ? {
            episodeId: `${id}-s01e${String(progressEpisodeNumber).padStart(2, '0')}`,
            episodeCode: `S01E${String(progressEpisodeNumber).padStart(2, '0')}`,
            episodeTitle: `第 ${progressEpisodeNumber} 集`,
            position,
            duration,
            completed: false,
            updatedAt: isoDaysAgo(Math.floor(random() * 14), random),
          }
        : null;

      const work: WorkSummary = {
        id,
        title: base.title,
        originalTitle: profile.originalTitle,
        year,
        rating,
        plot: profile.plot,
        genres: profile.genres,
        studios: profile.studios,
        tags: profile.tags,
        mediaType: profile.mediaType,
        showType: profile.showType,
        source: sources[0] ?? 'local',
        sources,
        seasonCount: profile.seasons,
        episodeCount: profile.mediaType === 'movie' ? 1 : episodeCount,
        assetCount,
        updatedAt: isoDaysAgo(Math.floor(random() * 40), random),
        artwork,
        watch: { status, favorite, note: '' },
        progress,
      };
      group.push(work);
    }
    groups.push(group);
  });

  // 交叉排列基作，避免默认顺序把首屏压成同名海报墙。
  const works: WorkSummary[] = [];
  const byId = new Map<string, WorkSummary>();
  const longest = groups.reduce((max, group) => Math.max(max, group.length), 0);
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) {
      const work = group[index];
      if (!work) {
        continue;
      }
      works.push(work);
      byId.set(work.id, work);
    }
  }

  return { works, byId };
}

export function buildMockDetail(work: WorkSummary, catalog: MockCatalog): WorkDetail {
  const base = MOCK_BASE_WORKS.find((item) => work.id.startsWith(item.slug));
  const profile = base ? PROFILES[base.slug] : undefined;
  const random = seededRandom(hashCode(work.id));
  const seasons: SeasonEntry[] = [];
  let episodeSeed = 0;

  for (let seasonNumber = 1; seasonNumber <= (profile?.seasons ?? 1); seasonNumber += 1) {
    const count = profile?.episodesPerSeason[seasonNumber - 1] ?? 12;
    const episodes: EpisodeEntry[] = [];
    for (let number = 1; number <= count; number += 1) {
      episodeSeed += 1;
      const thumbs = work.artwork.episodeThumbs;
      const thumb = thumbs.length > 0 ? thumbs[(episodeSeed - 1) % thumbs.length] : null;
      const assetTotal = 1 + Math.floor(random() * 2);
      const assets = Array.from({ length: assetTotal }, (_, index) => ({
        id: `${work.id}-s${seasonNumber}e${number}-a${index + 1}`,
        label: `${RELEASE_GROUPS[(episodeSeed + index) % RELEASE_GROUPS.length]} ${RESOLUTIONS[(episodeSeed + index) % RESOLUTIONS.length]}`,
        resolution: RESOLUTIONS[(episodeSeed + index) % RESOLUTIONS.length]!,
        codec: CODECS[(episodeSeed + index) % CODECS.length]!,
        sizeLabel: `${(0.8 + random() * 1.9).toFixed(2)} GB`,
        source: work.sources[(episodeSeed + index) % work.sources.length] ?? 'local',
      }));
      const duration = 1420 + Math.floor(random() * 180);
      const progressEpisode =
        work.progress && work.progress.episodeId.endsWith(`e${String(number).padStart(2, '0')}`)
          ? work.progress
          : null;
      episodes.push({
        id: `${work.id}-s${String(seasonNumber).padStart(2, '0')}e${String(number).padStart(2, '0')}`,
        number,
        code: `S${String(seasonNumber).padStart(2, '0')}E${String(number).padStart(2, '0')}`,
        title: episodeTitle(number, seasonNumber, profile?.showType === 'anime_movie'),
        thumb,
        durationSec: duration,
        position: progressEpisode?.position ?? 0,
        watched: progressEpisode?.completed ?? false,
        assets,
      });
    }
    seasons.push({
      id: `${work.id}-s${String(seasonNumber).padStart(2, '0')}`,
      number: seasonNumber,
      label: profile?.mediaType === 'movie' ? '剧场版' : `第 ${seasonNumber} 季`,
      episodes,
    });
  }

  const related = catalog.works
    .filter((candidate) => candidate.id !== work.id && candidate.showType === work.showType)
    .slice(0, 6);

  return {
    ...work,
    seasons,
    cast: buildCast(work, random),
    related,
    metadata: {
      provider: 'TMDB（演示）',
      providerId: `demo-${hashCode(work.id).toString(16).slice(0, 6)}`,
      state: 'ready',
      updatedAt: work.updatedAt,
    },
    location: `演示来源 / ${work.title} / ${
      work.mediaType === 'movie' ? '剧场版' : `第 1 季`
    }`,
    collections: work.showType === 'anime_movie' ? ['剧场版合辑'] : [],
  };
}

function buildCast(work: WorkSummary, random: () => number): readonly CastEntry[] {
  const NAMES = [
    '中村悠一',
    '大原沙耶香',
    '花泽香菜',
    '杉田智和',
    '早见沙织',
    '岛崎信长',
    '高桥李依',
    '雨宫天',
    '小林裕介',
    '石川由依',
  ];
  const ROLES = ['主演', '配角', '声优', '旁白', '客串'];
  const count = 4 + Math.floor(random() * 3);
  return Array.from({ length: count }, (_, index) => ({
    name: NAMES[(index + work.id.length) % NAMES.length]!,
    role: ROLES[index % ROLES.length]!,
    profile: null,
  }));
}

function episodeTitle(number: number, seasonNumber: number, movie: boolean | undefined): string {
  if (movie) {
    return '剧场版';
  }
  const TITLES = [
    '开始的地方',
    '熟悉的旋律',
    '第 2 幕',
    '雨后的天空',
    '交错的心意',
    '未完成的约定',
    '远处的灯光',
    '再次出发',
    '安静的下午',
    '需要回答的问题',
    '在此之前的一切',
    '前往下一个季节',
  ];
  return TITLES[(number + seasonNumber * 3) % TITLES.length]!;
}

function hashCode(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isoDaysAgo(days: number, random: () => number): string {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const at = new Date(now - days * 86_400_000 - Math.floor(random() * 20) * 3_600_000);
  return at.toISOString();
}
