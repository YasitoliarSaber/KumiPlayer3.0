/**
 * 最近观看：继续播放入口（不是播放日志）。
 * 卡片三层结构沿用当前实现：作品名 / 集号与剩余时间 / 播放时间。
 */

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';

import type { WorkSummary } from '../../shared/api/service';
import { useLibrary } from '../../shared/api/service-context';
import { Artwork } from '../../shared/ui/Artwork';
import { remainingLabel } from '../../shared/ui/PosterCard';
import { EmptySurface, ErrorSurface, LoadingSurface, ProgressBar } from '../../shared/ui/Surface';
import { useUiStore } from '../../app/ui-store';
import styles from './RecentPage.module.css';

export function RecentPage() {
  const library = useLibrary();
  const navigate = useNavigate();
  const source = useUiStore((state) => state.source);
  const items = useMemo(
    () =>
      (library.data?.works ?? [])
        .filter((work) => source === 'all' || work.sources.includes(source))
        .filter((work) => work.progress !== null)
        .sort((left, right) => (right.progress?.updatedAt ?? '').localeCompare(left.progress?.updatedAt ?? '')),
    [library.data?.works, source],
  );

  const open = useCallback((workId: string) => navigate(`/work/${workId}`), [navigate]);

  if (library.isPending) {
    return <LoadingSurface label="正在载入观看记录" detail="正在读取演示数据" />;
  }
  if (library.isError) {
    return (
      <ErrorSurface detail={library.error?.message ?? '演示数据读取失败'} onRetry={() => void library.refetch()} />
    );
  }
  if (items.length === 0) {
    return (
      <EmptySurface
        kicker="观看记录"
        title="还没有最近观看记录"
        detail="开始播放作品后，这里会保留最近或高频打开的内容。"
        action={<button type="button" className={styles.backLink} onClick={() => navigate('/')}>回到首页</button>}
      />
    );
  }

  return (
    <section className={styles.page} data-route="recent">
      <header className={styles.head}>
        <h1 className={styles.title}>最近观看</h1>
        <p className={styles.count}>{items.length} 个项目</p>
      </header>
      <div className={styles.grid}>
        {items.map((work) => (
          <RecentCard key={work.id} work={work} onOpen={open} />
        ))}
      </div>
    </section>
  );
}

function RecentCard({ work, onOpen }: { readonly work: WorkSummary; readonly onOpen: (workId: string) => void }) {
  const progress = work.progress;
  const percent = progress
    ? progress.completed
      ? 100
      : progress.duration > 0
        ? Math.min(100, Math.max(0, (progress.position / progress.duration) * 100))
        : 0
    : 0;
  const code = work.mediaType === 'movie' ? '电影' : (progress?.episodeCode ?? '集号待定');
  const status = progress ? remainingLabel(work) : '继续观看';

  return (
    <button
      type="button"
      className={styles.card}
      onClick={() => onOpen(work.id)}
      aria-label={`${work.title} · ${code} · ${status}`}
    >
      <span className={styles.media}>
        <Artwork
          artwork={work.artwork.episodeThumbs[0] ?? work.artwork.fanart ?? work.artwork.poster}
          alt={`${work.title} · ${code}`}
          kind="episode"
          fallbackLabel="暂无分集图片"
          className={styles.image}
        />
        {percent > 0 ? (
          <span className={styles.progress}>
            <ProgressBar value={percent} label={`${work.title}播放进度`} />
          </span>
        ) : null}
      </span>
      <span className={styles.copy}>
        <span className={styles.cardTitle} title={work.title}>
          {work.title}
        </span>
        <span className={styles.position}>
          <span className={styles.code}>{code}</span>
          <span className={styles.separator} aria-hidden="true">
            ·
          </span>
          <span className={styles.status}>{status}</span>
        </span>
        <time className={styles.time} dateTime={progress?.updatedAt}>
          {timeLabel(progress?.updatedAt ?? '')}
        </time>
      </span>
    </button>
  );
}

/** 今天 / 昨天 / 月日 + 时刻（与当前实现一致）。 */
export function timeLabel(value: string, now: Date = new Date()): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (at.toDateString() === now.toDateString()) {
    return `今天 ${clock}`;
  }
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (at.toDateString() === yesterday.toDateString()) {
    return `昨天 ${clock}`;
  }
  return `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${clock}`;
}
