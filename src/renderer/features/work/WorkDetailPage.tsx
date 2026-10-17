/**
 * 作品详情：背景与海报/标志、简介与元信息、季集切换、缩略图、版本选择、
 * 收藏与更多菜单。布局以最终原型为准，管理操作使用同一套 Radix 抽屉。
 */

import {
  ArrowLeft,
  Check,
  CirclePlay,
  ChevronDown,
  Database,
  FolderOpen,
  Heart,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';

import type { EpisodeEntry, WorkDetail } from '../../shared/api/service';
import { demoQueryKeys, useMediaService, useWorkDetail } from '../../shared/api/service-context';
import { Artwork } from '../../shared/ui/Artwork';
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { Input } from '@/shared/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs';
import { SOURCE_LABELS } from '@/app/ui-store';
import { WorkManagementSheet } from './WorkManagementSheet';
import { EpisodeStrip } from './EpisodeStrip';
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
  const [managementOpen, setManagementOpen] = useState(false);
  const [pendingTitle, setPendingTitle] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [togglingFavorite, setTogglingFavorite] = useState(false);
  // 作品来源选择：真实影响播放使用哪个 Asset，不只是改标签。
  const [preferredSource, setPreferredSource] = useState<string>('');
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  const work = detail.data;
  const season = work?.seasons[Math.min(seasonIndex, Math.max(0, work.seasons.length - 1))];

  useEffect(() => {
    setSeasonIndex(0);
    // 切换作品时清掉上一部作品的临时状态，避免旧提示/旧忙碌态串到新作品。
    setNotice('');
    setBusy(false);
    setTogglingFavorite(false);
    setPreferredSource('');
    setManagementOpen(false);
  }, [workId]);

  const refreshLibrary = useCallback(
    () => Promise.all([
      queryClient.invalidateQueries({ queryKey: demoQueryKeys.library }),
      queryClient.invalidateQueries({ queryKey: demoQueryKeys.detail(workId) }),
    ]),
    [queryClient, workId],
  );

  const play = useCallback(
    async (episode: EpisodeEntry, assetId?: string) => {
      if (!work) {
        return;
      }
      setBusy(true);
      try {
        const target =
          assetId ??
          pickAssetForSource(episode, preferredSource)?.id ??
          episode.assets[0]?.id ??
          '';
        const session = await service.play(work.id, episode.id, target);
        setNotice(`演示播放已开始：${session.episodeCode} · ${session.episodeTitle}`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '演示播放未能开始');
      } finally {
        setBusy(false);
      }
    },
    [preferredSource, service, work],
  );

  const resume = useMemo(() => {
    if (!work) {
      return null;
    }
    const episodes = work.seasons.flatMap((entry) => entry.episodes);
    const recent = episodes.find((episode) => episode.id === work.progress?.episodeId);
    if (recent) {
      if (work.progress?.completed) return episodes.slice(episodes.indexOf(recent) + 1).find((episode) => !episode.watched) ?? recent;
      return recent;
    }
    return episodes.find((episode) => episode.position > 0 && !episode.watched) ?? episodes.find((episode) => !episode.watched) ?? episodes[0] ?? null;
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

  const isRecentEpisode = Boolean(resume && work.progress && resume.id === work.progress.episodeId);
  const resumePosition = isRecentEpisode ? work.progress!.position : resume?.position ?? 0;
  const resumeDuration = isRecentEpisode ? work.progress!.duration : resume?.durationSec ?? 0;
  const resumePercent = resumeDuration > 0 ? Math.min(100, Math.max(0, Math.round(resumePosition / resumeDuration * 100))) : 0;

  return (
    <article className={styles.page} data-route="work-detail">
      <div className={styles.backdrop} aria-hidden="true">
        <Artwork artwork={work.artwork.fanart ?? work.artwork.poster} alt="" loading="eager" className={styles.heroBackdrop} />
      </div>
      <div className={styles.hero}>
        <button type="button" className={styles.heroBack} onClick={() => navigate(-1)}>
          <ArrowLeft aria-hidden="true" />
          <span>返回</span>
        </button>
        <div className={styles.heroBody}>
          <div className={styles.heroPoster}>
            <Artwork artwork={work.artwork.poster} alt={work.title} fallbackLabel={work.title} loading="eager" />
          </div>
          <div className={styles.heroCopy}>
            <h1 className={work.artwork.clearlogo ? styles.logoTitle : styles.heroTitle}>
              {work.artwork.clearlogo ? <>
                <span className="sr-only">{work.title}</span>
                <Artwork artwork={work.artwork.clearlogo} alt="" fallbackLabel={work.title} kind="logo" loading="eager" className={styles.heroLogo} />
              </> : work.title}
            </h1>
            {work.originalTitle && work.originalTitle !== work.title ? (
              <p className={styles.heroOriginal}>{work.originalTitle}</p>
            ) : null}
            <div className={styles.heroMeta}>
              {work.rating > 0 ? <span className={styles.metaItem}>★ {work.rating.toFixed(1)}</span> : null}
              <span className={styles.metaItem}>{work.year}</span>
              <span className={styles.metaItem}>
                {work.mediaType === 'movie' ? '剧场版' : `共 ${work.seasonCount} 季`}
              </span>
              <span className={styles.metaItem}>{work.episodeCount} 集</span>
            </div>
            <div className={styles.heroTags}>
              {/* 作品来源：单一选择器（原型已把多枚来源胶囊收敛为互斥菜单）。 */}
              {work.sources.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="xs" className={styles.sourcePicker}>
                      <Database className="size-4" />
                      {sourceLabel(preferredSource || work.sources[0]!)}
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[13rem]">
                    <DropdownMenuLabel>作品来源</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={preferredSource || work.sources[0]}
                      onValueChange={setPreferredSource}
                    >
                      {work.sources.map((source) => (
                        <DropdownMenuRadioItem key={source} value={source}>
                          {sourceLabel(source)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <span className={styles.genreList}>
                {work.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
              </span>
            </div>
            <p className={styles.heroPlot}>{work.plot}</p>
            <div className={styles.heroActions}>
              <Button className={styles.continueButton} onClick={() => resume && void play(resume)} disabled={!resume || busy}
                title={resume ? `${resume.code} ${resume.title}${resumePercent > 0 ? `，已观看 ${resumePercent}%` : ''}` : undefined}>
                {resumePercent > 0 ? <span className={styles.continueFill} style={{ width: `${resumePercent}%` }} aria-hidden="true" /> : null}
                <CirclePlay className="relative size-4" />
                <span className={styles.continueCopy}>
                  <strong>{resumePosition > 0 ? '继续观看' : '播放'}</strong>
                  {resume ? <small>{resume.code}{resumePercent > 0 ? ` · 已看 ${resumePercent}%` : ''}</small> : null}
                </span>
              </Button>
              <span title={work.watch.favorite ? '取消收藏' : '加入收藏'} className="inline-flex">
                <Button
                  variant={work.watch.favorite ? 'subtle' : 'outline'}
                  className={styles.onArtworkButton}
                  loading={togglingFavorite}
                  aria-busy={togglingFavorite}
                  onClick={() => {
                    // 双击保护：写入期间不再接受第二次点击，避免重复提交。
                    if (togglingFavorite) {
                      return;
                    }
                    setTogglingFavorite(true);
                    void service
                      .setFavorite(work.id, !work.watch.favorite)
                      .then(refreshLibrary)
                      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : '收藏状态未保存'))
                      .finally(() => setTogglingFavorite(false));
                  }}
                >
                  <Heart className="size-4" />
                  {work.watch.favorite ? '已收藏' : '收藏'}
                </Button>
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button ref={moreButtonRef} variant="outline" className={styles.onArtworkButton}>
                    <MoreHorizontal className="size-4" />
                    更多操作
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setManagementOpen(true)}>资料与管理</DropdownMenuItem>
                  <DropdownMenuSeparator />
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
        <section className={styles.main} aria-label="季集">
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
                  <span className="ml-1.5 text-[11.5px] text-muted-foreground">
                    {entry.episodes.length}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <EpisodeStrip episodes={season?.episodes ?? []} seasonId={season?.id ?? ''}
            label={season?.label ?? '全部剧集'} onPlay={(episode) => void play(episode)} />

          {work.related.length > 0 ? (
            <section className={styles.relatedSection} aria-label="相关推荐">
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

      </div>

      <WorkManagementSheet work={work} open={managementOpen} onOpenChange={setManagementOpen} onChanged={refreshLibrary}
        onReturnFocus={() => moreButtonRef.current?.focus({ preventScroll: true })} />

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

function sourceLabel(source: string): string {
  return SOURCE_LABELS.find((entry) => entry.value === source)?.label ?? source;
}

/**
 * 来源选择落到真正的 Asset 上：优先取该来源的版本，
 * 没有匹配版本时交回调用方使用默认版本，不伪造"已切换来源"。
 */
function pickAssetForSource(
  episode: EpisodeEntry,
  source: string,
): EpisodeEntry['assets'][number] | undefined {
  if (source === '') {
    return undefined;
  }
  return episode.assets.find((asset) => asset.source === source);
}

export type { WorkDetail };
