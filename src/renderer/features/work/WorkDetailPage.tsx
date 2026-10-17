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
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';

import type { EpisodeEntry, WorkDeletePreview, WorkDetail } from '../../shared/api/service';
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
  const [renameError, setRenameError] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  // 删除是两段式：先取服务端影响预览，再用预览身份确认；失败后必须重新预览。
  const [deletePreview, setDeletePreview] = useState<WorkDeletePreview | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  // 更多菜单里的真实操作共用一次加载态，不劫持播放按钮的忙碌态。
  const [actionBusy, setActionBusy] = useState(false);
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
    setActionBusy(false);
    setRenameError('');
    setRenameBusy(false);
    setDeletePreview(null);
    setDeleteError('');
    setDeleteBusy(false);
    setTogglingFavorite(false);
    setPreferredSource('');
    setManagementOpen(false);
  }, [workId]);

  const refreshLibrary = useCallback(
    () => Promise.all([
      queryClient.invalidateQueries({ queryKey: demoQueryKeys.library }),
      queryClient.invalidateQueries({ queryKey: demoQueryKeys.detail(workId) }),
      queryClient.invalidateQueries({ queryKey: demoQueryKeys.tasks }),
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

  // 重新刮削：真实走后端 job 队列；方法不存在时如实说明演示模式不执行真实操作。
  const rescrape = async () => {
    if (typeof service.scrapeWork !== 'function') {
      setNotice('演示模式不执行真实操作：当前服务没有重新刮削能力。');
      return;
    }
    setActionBusy(true);
    setNotice('');
    try {
      const result = await service.scrapeWork(work.id);
      setNotice(`已排队重新刮削，作业 ${result.jobId}`);
      void refreshLibrary();
    } catch (error) {
      // 失败只显示后端真实原因，绝不显示成功。
      setNotice(error instanceof Error ? error.message : '重新刮削未能排队');
    } finally {
      setActionBusy(false);
    }
  };

  const saveTitle = async () => {
    setRenameError('');
    setRenameBusy(true);
    try {
      await service.setManualTitle(work.id, pendingTitle);
      setRenameOpen(false);
      setNotice(`已保存手动标题：${pendingTitle}`);
      void refreshLibrary();
    } catch (error) {
      // 失败保留输入并显示后端原因，不关闭成成功。
      setRenameError(error instanceof Error ? error.message : '标题未保存');
    } finally {
      setRenameBusy(false);
    }
  };

  const restoreTitle = async () => {
    setRenameError('');
    setRenameBusy(true);
    try {
      await service.resetManualTitle(work.id);
      setRenameOpen(false);
      setNotice('已恢复自动标题。');
      void refreshLibrary();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : '未能恢复自动标题');
    } finally {
      setRenameBusy(false);
    }
  };

  // 打开所在位置：只提交身份 ID，由后端宿主进程真正执行；浏览器承载时如实说明未打开。
  const openFolder = async () => {
    if (typeof service.openWorkFolder !== 'function') {
      setNotice('演示模式不执行真实操作：当前服务没有打开所在位置的能力。');
      return;
    }
    setActionBusy(true);
    setNotice('');
    try {
      const result = await service.openWorkFolder({ workId: work.id });
      if (result.opened) {
        setNotice(`已在资源管理器中打开：${result.folderPath}`);
      } else if (result.exists) {
        setNotice(`后端未打开窗口（当前由浏览器承载，无法直接打开文件夹）：${result.folderPath}`);
      } else {
        setNotice(`该作品没有可打开的已确认媒体目录：${result.folderPath || '后端未返回路径'}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '打开所在位置失败');
    } finally {
      setActionBusy(false);
    }
  };

  const loadDeletePreview = async () => {
    if (typeof service.previewWorkDelete !== 'function') {
      setDeleteError('演示模式不执行真实操作：当前服务没有删除预览能力。');
      return;
    }
    setDeleteBusy(true);
    setDeleteError('');
    setDeletePreview(null);
    try {
      setDeletePreview(await service.previewWorkDelete(work.id));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除预览未能生成');
    } finally {
      setDeleteBusy(false);
    }
  };

  const openDelete = async () => {
    if (typeof service.previewWorkDelete !== 'function' || typeof service.confirmWorkDelete !== 'function') {
      setNotice('演示模式不执行真实操作：当前服务没有从媒体库移除的能力。');
      return;
    }
    setDeleteOpen(true);
    await loadDeletePreview();
  };

  const confirmDelete = async () => {
    if (!deletePreview || typeof service.confirmWorkDelete !== 'function') {
      return;
    }
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const result = await service.confirmWorkDelete(work.id, {
        previewId: deletePreview.previewId,
        digest: deletePreview.digest,
      });
      setDeleteOpen(false);
      setDeletePreview(null);
      setNotice(
        `已从媒体库移除：受控生成物移除 ${result.removedArtifacts} 项、被阻塞 ${result.blockedArtifacts} 项、失败 ${result.failedArtifacts} 项；真实影片文件未被删除。`,
      );
      void refreshLibrary();
      navigate(-1);
    } catch (error) {
      // 409（digest 变化）等失败必须丢弃旧预览并要求重新生成，绝不假装已移除。
      setDeletePreview(null);
      setDeleteError(error instanceof Error ? error.message : '移除未执行，请重新生成删除预览');
    } finally {
      setDeleteBusy(false);
    }
  };

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
                  <DropdownMenuItem disabled={actionBusy} onClick={() => void rescrape()}>
                    <RefreshCw className="size-3.5" />
                    重新刮削资料
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setPendingTitle(work.title);
                      setRenameError('');
                      setRenameOpen(true);
                    }}
                  >
                    编辑标题
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={actionBusy} onClick={() => void openFolder()}>
                    <FolderOpen className="size-3.5" />
                    打开所在位置
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => void openDelete()}>
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

      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open);
          if (!open) {
            setRenameError('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑标题</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-1.5 text-[13px]">
            展示标题
            <Input
              value={pendingTitle}
              aria-label="展示标题"
              onChange={(event) => setPendingTitle(event.currentTarget.value)}
            />
          </label>
          <p className={styles.panelHint}>
            只写入 KumiPlayer 的手动标题覆盖：不改动真实文件名、识别证据或线上资料。
          </p>
          {renameError ? (
            <p role="alert" className="text-[12.5px] text-destructive">
              {renameError}
            </p>
          ) : null}
          <DialogFooter>
            <Button loading={renameBusy} onClick={() => void saveTitle()}>
              <Check className="size-4" />
              保存
            </Button>
            <Button variant="outline" disabled={renameBusy} onClick={() => void restoreTitle()}>
              <RotateCcw className="size-4" />
              恢复自动标题
            </Button>
            <DialogClose asChild>
              <Button variant="ghost">取消</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) {
            setDeletePreview(null);
            setDeleteError('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从媒体库移除</DialogTitle>
          </DialogHeader>
          <p className={styles.panelHint}>
            只退役 KumiPlayer 的库记录与受控生成物，绝不删除真实影片文件，也不改动来源目录。
          </p>
          {deletePreview ? (
            <ul className="flex flex-col gap-1 text-[12.5px]">
              <li>{`受控生成物：${deletePreview.artifactCount} 项`}</li>
              <li>{`播放记录：${deletePreview.playbackCount} 条`}</li>
              <li>{`追更记录：${deletePreview.trackingCount} 条`}</li>
              <li>
                {deletePreview.blocked
                  ? `存在后台任务：${deletePreview.blockedJobCount} 个${
                      deletePreview.blockedJobTypes.length > 0
                        ? `（${deletePreview.blockedJobTypes.join('、')}）`
                        : ''
                    }；请等待任务结束后重试。`
                  : '当前没有排队或运行中的后台任务。'}
              </li>
            </ul>
          ) : null}
          {deleteBusy && !deletePreview ? (
            <p className="text-[12.5px] text-muted-foreground" role="status">
              正在读取服务端影响预览…
            </p>
          ) : null}
          {deleteError ? (
            <p role="alert" className="text-[12.5px] text-destructive">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="destructive"
              loading={deleteBusy}
              disabled={!deletePreview || deletePreview.blocked}
              onClick={() => void confirmDelete()}
            >
              确认移除
            </Button>
            {deleteError ? (
              <Button variant="outline" disabled={deleteBusy} onClick={() => void loadDeletePreview()}>
                重新生成预览
              </Button>
            ) : null}
            <DialogClose asChild>
              <Button variant="ghost">取消</Button>
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
