/**
 * 作品详情：背景与海报/标志、简介与元信息、季集切换、缩略图、版本选择、
 * 收藏、模拟播放与更多菜单。复刻当前应用详情页的信息层级与操作位置。
 */

import {
  ArrowLeft,
  Check,
  CirclePlay,
  FolderOpen,
  Heart,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';

import type { EpisodeEntry, WorkDetail } from '../../shared/api/service';
import { demoQueryKeys, useMediaService, useWorkDetail } from '../../shared/api/service-context';
import { Artwork } from '../../shared/ui/Artwork';
import { ProgressBar, StatusChip } from '../../shared/ui/Surface';
import { ErrorSurface, LoadingSurface } from '../../shared/ui/Surface';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { Input } from '@/shared/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs';
import { BangumiPanel, ManualScrapePanel } from './WorkMetadataPanels';
import styles from './WorkDetailPage.module.css';

export function WorkDetailPage() {
  const params = useParams();
  const workId = params.workId ?? '';
  const navigate = useNavigate();
  const service = useMediaService();
  const queryClient = useQueryClient();
  const detail = useWorkDetail(workId);
  const [seasonIndex, setSeasonIndex] = useState(0);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingTitle, setPendingTitle] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const work = detail.data;
  const season = work?.seasons[Math.min(seasonIndex, Math.max(0, work.seasons.length - 1))];

  useEffect(() => {
    setSeasonIndex(0);
  }, [workId]);

  const refreshLibrary = useCallback(
    () => queryClient.invalidateQueries({ queryKey: demoQueryKeys.library }),
    [queryClient],
  );

  const play = useCallback(
    async (episode: EpisodeEntry, assetId?: string) => {
      if (!work) {
        return;
      }
      setBusy(true);
      try {
        const target = assetId ?? episode.assets[0]?.id ?? '';
        const session = await service.play(work.id, episode.id, target);
        setNotice(`演示播放已开始：${session.episodeCode} · ${session.episodeTitle}`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '演示播放未能开始');
      } finally {
        setBusy(false);
      }
    },
    [service, work],
  );

  const resume = useMemo(() => {
    if (!work) {
      return null;
    }
    const episodes = work.seasons.flatMap((entry) => entry.episodes);
    return episodes.find((episode) => episode.position > 0) ?? episodes[0] ?? null;
  }, [work]);

  if (detail.isPending) {
    return <LoadingSurface label="正在打开作品" detail="正在读取演示详情数据" />;
  }
  if (detail.isError || !work) {
    return (
      <ErrorSurface
        title="无法打开这个作品"
        detail={detail.error?.message ?? '演示数据中没有这个作品'}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  return (
    <article className={styles.page} data-route="work-detail">
      <div className={styles.hero}>
        <Artwork artwork={work.artwork.fanart ?? work.artwork.poster} alt="" className={styles.heroBackdrop} />
        <span className={styles.heroShade} aria-hidden="true" />
        <button type="button" className={styles.heroBack} onClick={() => navigate(-1)}>
          <ArrowLeft aria-hidden="true" />
          <span>返回</span>
        </button>
        <div className={styles.heroBody}>
          <div className={styles.heroPoster}>
            <Artwork artwork={work.artwork.poster} alt={work.title} fallbackLabel={work.title} />
          </div>
          <div className={styles.heroCopy}>
            {work.artwork.clearlogo ? (
              <Artwork artwork={work.artwork.clearlogo} alt={work.title} kind="logo" className={styles.heroLogo} />
            ) : (
              <h1 className={styles.heroTitle}>{work.title}</h1>
            )}
            {work.originalTitle && work.originalTitle !== work.title ? (
              <p className={styles.heroOriginal}>{work.originalTitle}</p>
            ) : null}
            <div className={styles.heroMeta}>
              {work.rating > 0 ? <span className={styles.metaChip}>★ {work.rating.toFixed(1)}</span> : null}
              <span className={styles.metaChip}>{work.year}</span>
              <span className={styles.metaChip}>
                {work.mediaType === 'movie' ? '剧场版' : `共 ${work.seasonCount} 季`}
              </span>
              <span className={styles.metaChip}>{work.episodeCount} 集</span>
              <span className={styles.metaChip}>{work.assetCount} 个版本</span>
            </div>
            <div className={styles.heroTags}>
              {work.genres.map((genre) => (
                <StatusChip key={genre}>{genre}</StatusChip>
              ))}
              {work.tags.slice(0, 2).map((tag) => (
                <StatusChip key={tag} tone="info">
                  {tag}
                </StatusChip>
              ))}
            </div>
            <p className={styles.heroPlot}>{work.plot}</p>
            <div className={styles.heroActions}>
              <Button onClick={() => resume && void play(resume)} disabled={!resume || busy}>
                <CirclePlay className="size-4" />
                {work.progress && work.progress.position > 0 ? '继续观看' : '播放'}
              </Button>
              {work.progress && work.progress.position > 0 ? (
                <div className={styles.resumeState}>
                  <ProgressBar
                    value={(work.progress.position / Math.max(work.progress.duration, 1)) * 100}
                    label="演示观看进度"
                    size={4}
                  />
                  <span>
                    {work.progress.episodeCode} 已观看{' '}
                    {Math.round((work.progress.position / Math.max(work.progress.duration, 1)) * 100)}%
                  </span>
                </div>
              ) : null}
              <span title={work.watch.favorite ? '取消收藏' : '加入收藏'} className="inline-flex">
                <Button
                  variant={work.watch.favorite ? 'subtle' : 'outline'}
                  onClick={() =>
                    void service.setFavorite(work.id, !work.watch.favorite).then(refreshLibrary)
                  }
                >
                  <Heart className="size-4" />
                  {work.watch.favorite ? '已收藏' : '收藏'}
                </Button>
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <MoreHorizontal className="size-4" />
                    更多
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => setNotice('已排队重新刮削资料（演示，不会访问在线服务）')}
                  >
                    <RefreshCw className="size-3.5" />
                    重新刮削资料
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setPendingTitle(work.title);
                      setRenameOpen(true);
                    }}
                  >
                    编辑标题
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setNotice(`已请求打开位置（演示）：${work.location}`)}>
                    <FolderOpen className="size-3.5" />
                    打开所在位置
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                    <Trash2 className="size-3.5" />
                    从媒体库移除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {notice ? (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <section className={styles.main} aria-label="季集与版本">
          <Tabs
            value={season?.id ?? ''}
            onValueChange={(value) => {
              const index = work.seasons.findIndex((entry) => entry.id === value);
              setSeasonIndex(index >= 0 ? index : 0);
            }}
          >
            <TabsList>
              {work.seasons.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <ul className={styles.episodes}>
            {(season?.episodes ?? []).map((episode) => (
              <li key={episode.id} className={styles.episode}>
                <button
                  type="button"
                  className={styles.episodeThumb}
                  onClick={() => void play(episode)}
                  aria-label={`播放 ${episode.code} ${episode.title}`}
                >
                  <Artwork
                    artwork={episode.thumb}
                    alt={`${episode.code} 缩略图`}
                    kind="episode"
                    fallbackLabel="暂无分集图片"
                    className={styles.episodeImage}
                  />
                  {episode.position > 0 ? (
                    <span className={styles.episodeProgress}>
                      <ProgressBar
                        value={(episode.position / Math.max(episode.durationSec, 1)) * 100}
                        label={`${episode.code}观看进度`}
                      />
                    </span>
                  ) : null}
                  <span className={styles.episodePlay} aria-hidden="true">
                    <CirclePlay />
                  </span>
                </button>
                <div className={styles.episodeCopy}>
                  <span className={styles.episodeCode}>{episode.code}</span>
                  <span className={styles.episodeTitle} title={episode.title}>
                    {episode.title}
                  </span>
                  <span className={styles.episodeMeta}>
                    {formatDuration(episode.durationSec)} · {episode.assets.length} 个版本
                    {episode.watched ? ' · 已看完' : ''}
                  </span>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="xs">
                      选择版本
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[16rem]">
                    <DropdownMenuLabel>{episode.code} 可用版本</DropdownMenuLabel>
                    {episode.assets.map((asset) => (
                      <DropdownMenuItem key={asset.id} onClick={() => void play(episode, asset.id)}>
                        {asset.label} · {asset.codec} · {asset.sizeLabel} · {asset.source}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>

          <section className={styles.castSection} aria-label="演员">
            <h2 className={styles.blockTitle}>演员与制作</h2>
            <div className={styles.castRow}>
              {work.cast.map((person) => (
                <div key={`${person.name}-${person.role}`} className={styles.castCard}>
                  <span className={styles.castAvatar} aria-hidden="true">
                    {person.name.slice(0, 1)}
                  </span>
                  <span className={styles.castName}>{person.name}</span>
                  <span className={styles.castRole}>{person.role}</span>
                </div>
              ))}
            </div>
          </section>

          {work.related.length > 0 ? (
            <section className={styles.castSection} aria-label="相关推荐">
              <h2 className={styles.blockTitle}>相关作品</h2>
              <div className={styles.relatedRow}>
                {work.related.slice(0, 6).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.relatedCard}
                    onClick={() => navigate(`/work/${item.id}`)}
                  >
                    <span className={styles.relatedMedia}>
                      <Artwork artwork={item.artwork.poster} alt={item.title} className={styles.relatedImage} />
                    </span>
                    <span className={styles.relatedTitle} title={item.title}>
                      {item.title}
                    </span>
                    <span className={styles.relatedMeta}>{item.year}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </section>

        <aside className={styles.side} aria-label="资料与操作">
          <SidePanel title="资料状态">
            <DetailRow label="资料提供方" value={work.metadata.provider} />
            <DetailRow label="提供方 ID" value={work.metadata.providerId} />
            <DetailRow label="状态" value={work.metadata.state} />
            <DetailRow label="资料更新时间" value={work.metadata.updatedAt.slice(0, 10)} />
          </SidePanel>

          <SidePanel title="观看状态">
            <div className={styles.stateRow}>
              {STATUS_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  size="xs"
                  variant={work.watch.status === option.value ? 'subtle' : 'outline'}
                  onClick={() =>
                    void service.setWatchStatus(work.id, option.value).then(refreshLibrary)
                  }
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </SidePanel>

          <SidePanel title="来源与位置">
            <DetailRow label="来源" value={work.sources.join(' / ')} />
            <DetailRow label="位置" value={work.location} />
            {work.collections.length > 0 ? <DetailRow label="合集" value={work.collections.join('、')} /> : null}
          </SidePanel>

          <ManualScrapePanel work={work} />
          <BangumiPanel work={work} />
        </aside>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑标题（演示）</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-1.5 text-[13px]">
            展示标题
            <Input value={pendingTitle} onChange={(event) => setPendingTitle(event.currentTarget.value)} />
          </label>
          <p className={styles.panelHint}>演示模式只修改本机演示偏好，不会改写媒体事实或在线资料。</p>
          <DialogFooter>
            <Button
              onClick={() => {
                setRenameOpen(false);
                setNotice(`已保存演示标题：${pendingTitle}`);
              }}
            >
              <Check className="size-4" />
              保存
            </Button>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从媒体库移除（演示）</DialogTitle>
          </DialogHeader>
          <p className={styles.panelHint}>
            真实实现中，这里只退役受控媒体记录，绝不删除来源媒体文件；演示模式不会写入任何数据。
          </p>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteOpen(false);
                setNotice('演示：已模拟从媒体库移除（不会删除任何文件）');
              }}
            >
              确认移除
            </Button>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}

const STATUS_OPTIONS = [
  { value: 'watching' as const, label: '追更中' },
  { value: 'watched' as const, label: '已看完' },
  { value: 'on_hold' as const, label: '搁置' },
  { value: 'dropped' as const, label: '弃番' },
  { value: '' as const, label: '未标记' },
];

function SidePanel({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>{title}</h2>
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue} title={value}>
        {value}
      </span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export type { WorkDetail };
