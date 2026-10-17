/**
 * 后端 DTO → Renderer 视图模型的适配层。
 *
 * 只做形状换算与展示派生，不改写后端事实：不重新识别、不合并作品、
 * 不推导季集编号，也不把缺失字段补成看起来合理的内容。
 * 图片只消费后端已发布的 `/api/assets/artwork/...` 派生 URL，
 * 未发布时不回退原图、远程地址或示例图片。
 */

import type { ArtworkVariants, WorkCard } from '@shared/contracts/dto';

import type {
  ArtworkRef,
  ArtworkSet,
  AssetEntry,
  CastEntry,
  EpisodeEntry,
  ProgressSnapshot,
  SeasonEntry,
  ShowType,
  SourceId,
  WatchState,
  WorkDetail as WorkDetailView,
  WorkSummary,
} from '../../shared/api/service';

const PUBLISHED_ARTWORK = /^\/api\/assets\/artwork\/[0-9a-f]{64}\/[0-9a-f]{64}-webp-v1\/(?:256|384|512|768|1280)$/;

/** 详情接口多返回的字段（`work_detail` = WorkIndex + studios/tags）。 */
export interface BackendWorkDetailDto extends WorkCard {
  readonly seasons?: readonly unknown[];
  readonly episodes?: readonly unknown[];
  readonly related_works?: readonly unknown[];
  readonly cast?: readonly unknown[];
  readonly tags?: readonly string[];
  readonly dir_path?: string;
  readonly metadata_snapshot_id?: string;
  readonly refresh_status?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * 尺寸选择：按用途取"不小于目标宽度里最小的一档"，没有更大档时退最大档。
 * 目标宽度对应虚拟海报墙与详情背景的实际渲染尺寸。
 */
export function pickArtwork(
  variants: ArtworkVariants | undefined,
  role: 'poster' | 'fanart' | 'clearlogo',
  targetWidth: number,
): ArtworkRef | null {
  const roleVariants = variants?.[role];
  if (!roleVariants) {
    return null;
  }
  const usable = Object.entries(roleVariants)
    .map(([width, url]) => ({ width: Number(width), url }))
    .filter((entry) => Number.isFinite(entry.width) && entry.width > 0 && PUBLISHED_ARTWORK.test(entry.url))
    .sort((left, right) => left.width - right.width);
  if (usable.length === 0) {
    return null;
  }
  const selected = usable.find((entry) => entry.width >= targetWidth) ?? usable[usable.length - 1]!;
  return { url: selected.url, width: selected.width, height: 0 };
}

export function toArtworkSet(card: WorkCard): ArtworkSet {
  return {
    poster: pickArtwork(card.artwork, 'poster', 384),
    fanart: pickArtwork(card.artwork, 'fanart', 1280),
    clearlogo: pickArtwork(card.artwork, 'clearlogo', 512),
    episodeThumbs: [],
  };
}

/** 后端来源标识就是来源权威；未知取值不猜测，直接保留原字符串。 */
function toSourceId(value: unknown): SourceId {
  const text = str(value);
  switch (text) {
    case 'local':
    case 'pan115':
    case 'baidu':
    case 'quark':
    case 'openlist':
    case 'hybrid':
      return text;
    default:
      return 'local';
  }
}

function toShowType(value: unknown, mediaType: unknown): ShowType {
  const text = str(value);
  if (text === 'anime_series' || text === 'anime_movie' || text === 'live_series' || text === 'live_movie') {
    return text;
  }
  return str(mediaType) === 'movie' ? 'anime_movie' : 'anime_series';
}

function toWatchStatus(card: WorkCard): WatchState {
  const raw = str(card.watch_status?.status ?? '');
  const status: WatchState['status'] =
    raw === 'watching' || raw === 'watched' || raw === 'on_hold' || raw === 'dropped' ? raw : '';
  return { status, favorite: card.watch_status?.favorite === true, note: str(card.watch_status?.note) };
}

export function toWorkSummary(card: WorkCard, progress: ProgressSnapshot | null): WorkSummary {
  const sources = (card.sources ?? []).map(toSourceId);
  return {
    id: card.work_id,
    title: card.title,
    originalTitle: card.original_title,
    year: card.year ?? 0,
    rating: card.rating,
    plot: card.plot,
    genres: card.genres ?? [],
    studios: card.studios ?? [],
    tags: [],
    mediaType: card.media_type === 'movie' ? 'movie' : card.media_type === 'unknown' ? 'tv' : card.media_type,
    showType: toShowType(card.show_type, card.media_type),
    source: toSourceId(card.source),
    sources: sources.length > 0 ? sources : [toSourceId(card.source)],
    seasonCount: card.season_count,
    episodeCount: card.episode_count,
    assetCount: card.asset_count,
    updatedAt: '',
    artwork: toArtworkSet(card),
    watch: toWatchStatus(card),
    progress,
  };
}

function toEpisode(dto: Record<string, unknown>): EpisodeEntry {
  const assets = Array.isArray(dto.assets) ? dto.assets : [];
  const runtimeMinutes = num(dto.runtime, 0);
  const episodeNumber = typeof dto.episode_number === 'number' ? dto.episode_number : null;
  return {
    id: str(dto.episode_id),
    number: episodeNumber ?? 0,
    code: episodeNumber === null ? str(dto.title, '未编号') : String(episodeNumber).padStart(2, '0'),
    title: str(dto.title),
    // 后端 runtime 来自 TMDB 的分钟数；未知时保持 0，由界面显示“时长未知”。
    thumb: null,
    durationSec: runtimeMinutes > 0 ? runtimeMinutes * 60 : 0,
    position: 0,
    watched: false,
    assets: assets.map<AssetEntry>((entry) => {
      const asset = asRecord(entry);
      return {
        id: str(asset.asset_id),
        label: str(asset.playback_locator).split(/[\\/]/).pop() || str(asset.asset_id),
        resolution: str(asset.availability) || 'unknown',
        codec: '',
        sizeLabel: '',
        source: toSourceId(asset.source),
      };
    }),
  };
}

function toSeason(dto: Record<string, unknown>, episodes: readonly EpisodeEntry[]): SeasonEntry {
  const number = typeof dto.season_number === 'number' ? dto.season_number : null;
  const groupType = str(dto.group_type);
  const label = str(dto.label) || (number === null ? '特别篇' : `第 ${number} 季`);
  return {
    id: str(dto.season_id),
    number: number ?? 0,
    label,
    episodes:
      groupType === 'special'
        ? episodes
        : episodes.filter((episode) => episode.number > 0),
  };
}

function toCast(dto: Record<string, unknown>): CastEntry {
  return {
    name: str(dto.name),
    role: str(dto.role),
    profile: null,
  };
}

export function toWorkDetail(
  dto: BackendWorkDetailDto,
  progress: ProgressSnapshot | null,
  relatedOf: (workId: string) => WorkSummary | null,
): WorkDetailView {
  const summary = toWorkSummary(dto, progress);
  const episodeDtos = (dto.episodes ?? []).map(asRecord).filter((entry) => str(entry.episode_id) !== '');
  const episodes = episodeDtos.map(toEpisode);
  const bySeason = new Map<string, EpisodeEntry[]>();
  episodeDtos.forEach((entry, index) => {
    const seasonId = str(entry.season_id);
    if (seasonId === '') {
      return;
    }
    const list = bySeason.get(seasonId) ?? [];
    list.push(episodes[index]!);
    bySeason.set(seasonId, list);
  });
  // 只有后端返回了季标识时才分组；没有季数据时按“全部剧集”单季展示，
  // 不虚构季号，也不把 unknown 折成第 0 季。
  const seasons =
    bySeason.size > 0
      ? (dto.seasons ?? [])
          .map(asRecord)
          .filter((entry) => str(entry.season_id) !== '')
          .map((entry) => toSeason(entry, bySeason.get(str(entry.season_id)) ?? []))
      : [{ id: 'all', number: 0, label: '全部剧集', episodes }];

  const related = (dto.related_works ?? [])
    .map(asRecord)
    .map((entry) => relatedOf(str(entry.work_id)))
    .filter((entry): entry is WorkSummary => entry !== null)
    .slice(0, 6);

  return {
    ...summary,
    tags: strArray(dto.tags),
    seasons,
    cast: (dto.cast ?? []).map(asRecord).map(toCast),
    related,
    metadata: {
      provider: 'TMDB',
      providerId: str(dto.metadata_snapshot_id),
      state: str(dto.refresh_status) || str(dto.metadata_state),
      updatedAt: '',
    },
    location: str(dto.dir_path),
    collections: [],
  };
}

/** 播放历史行 → 卡片进度快照（进度唯一权威仍是后端 `playback_progress`）。 */
export function toProgressSnapshot(item: Record<string, unknown>): ProgressSnapshot | null {
  const workId = str(item.work_id);
  const episodeId = str(item.episode_id);
  if (workId === '' || episodeId === '') {
    return null;
  }
  return {
    episodeId,
    episodeCode: typeof item.episode_number === 'number' ? String(item.episode_number).padStart(2, '0') : '',
    episodeTitle: str(item.episode_title),
    position: num(item.position),
    duration: num(item.duration),
    completed: item.completed === true,
    updatedAt: str(item.updated_at),
  };
}
