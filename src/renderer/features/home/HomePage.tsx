/**
 * 首页：媒体展示橱窗 + 继续观看 + 分类分区。
 * 结构、比例、分区留白遵循精修原型，领域数据继续来自统一服务。
 */

import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import type { WorkSummary } from '../../shared/api/service';
import { useLibrary } from '../../shared/api/service-context';
import { Artwork } from '../../shared/ui/Artwork';
import { Button } from '@/shared/ui/button';
import { PosterCard } from '../../shared/ui/PosterCard';
import { EmptySurface, ErrorSurface, LoadingSurface, SectionHeading } from '../../shared/ui/Surface';
import { matchView } from '../../shell/AppShell';
import { useUiStore } from '../../app/ui-store';
import { useDemoState } from '@/mock/demo-store';
import styles from './HomePage.module.css';

const SECTIONS: ReadonlyArray<{ view: 'anime_series' | 'anime_movie' | 'live_series' | 'live_movie'; label: string }> = [
  { view: 'anime_series', label: '番剧' },
  { view: 'anime_movie', label: '动画电影' },
  { view: 'live_series', label: '剧集' },
  { view: 'live_movie', label: '电影' },
];

export function HomePage() {
  const library = useLibrary();
  const navigate = useNavigate();
  const source = useUiStore((state) => state.source);
  const [index, setIndex] = useState(0);
  // 悬停暂停是原型的唯一暂停入口：不提供常驻播放/暂停按钮。
  const [hovered, setHovered] = useState(false);
  const appearance = useDemoState().settings.appearance;
  const prefersReducedMotion = usePrefersReducedMotion();
  const reducedMotion = prefersReducedMotion || appearance.motion === 'reduced';

  const works = useMemo(
    () => (library.data?.works ?? []).filter((work) => source === 'all' || work.sources.includes(source)),
    [library.data?.works, source],
  );

  // 橱窗按作品名去重：同一个基作的几十个演示条目不应全部占满首屏。
  const showcasePool = useMemo(() => dedupeByTitle(works), [works]);
  const featured = useMemo(() => showcasePool.slice(0, 6), [showcasePool]);
  const sideFeatured = useMemo(() => showcasePool.slice(6, 9), [showcasePool]);
  const continueWatching = useMemo(
    () =>
      works
        .filter((work) => work.progress && !work.progress.completed)
        .sort((left, right) => (right.progress?.updatedAt ?? '').localeCompare(left.progress?.updatedAt ?? ''))
        .slice(0, 6),
    [works],
  );

  useEffect(() => {
    if (featured.length <= 1 || reducedMotion || hovered) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % featured.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [hovered, featured.length, reducedMotion]);

  useEffect(() => {
    setIndex(0);
  }, [source]);

  const open = useCallback((workId: string) => navigate(`/work/${workId}`), [navigate]);

  if (library.isPending) {
    return <LoadingSurface label="正在载入媒体库" detail="正在从本机后端读取作品索引" />;
  }
  // 失败但已有快照时保留最后有效视图，只提示"可能不是最新"。
  if (library.isError && !library.data) {
    return (
      <ErrorSurface
        detail={library.error?.message ?? '演示数据读取失败'}
        onRetry={() => void library.refetch()}
      />
    );
  }
  if (works.length === 0) {
    return (
      <EmptySurface
        kicker="媒体库"
        title="还没有作品"
        detail="演示场景当前为空。可以前往媒体管理添加媒体，或在开发入口切回默认场景。"
        action={
          <Button variant="outline" onClick={() => navigate('/manage')}>
            添加媒体
          </Button>
        }
      />
    );
  }

  const current = featured[index % featured.length] ?? featured[0]!;

  return (
    <div className={styles.page} data-route="home">
      {library.isRefetchError ? (
        <p
          className="m-0 rounded-md border border-border bg-card px-3 py-2 text-[12.5px] text-muted-foreground"
          role="status"
        >
          刷新失败，当前显示上一次成功的数据：{library.error?.message ?? '未知错误'}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => void library.refetch()}
          >
            重试
          </button>
        </p>
      ) : null}
      <section className={styles.showcase} aria-label="媒体展示" data-has-side={sideFeatured.length > 0}>
        <div
          className={styles.feature}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusCapture={() => setHovered(true)}
          onBlurCapture={() => setHovered(false)}
        >
          <button
            type="button"
            className={styles.featureSurface}
            onClick={() => open(current.id)}
            aria-label={`打开${current.title}详情`}
          >
            <Artwork artwork={current.artwork.fanart ?? current.artwork.poster} alt="" className={styles.featureBackdrop} />
            <span className={styles.featureShade} aria-hidden="true" />
            <span className={styles.featureCopy}>
              <span className={styles.featureChips}>
                {current.rating > 0 ? <span className={styles.featureChip}>★ {current.rating.toFixed(1)}</span> : null}
                <span className={styles.featureChip}>{metaLine(current)}</span>
                <span className={styles.featureChip}>{current.genres.slice(0, 2).join(' / ')}</span>
              </span>
              <span className={styles.featureTitle}>{current.title}</span>
              <span className={styles.featurePlot}>{current.plot}</span>
            </span>
          </button>

          {featured.length > 1 ? (
            <>
              <button
                type="button"
                className={`${styles.featureNav} ${styles.featureNavLeft}`}
                aria-label="上一部"
                onClick={() => setIndex((value) => (value - 1 + featured.length) % featured.length)}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`${styles.featureNav} ${styles.featureNavRight}`}
                aria-label="下一部"
                onClick={() => setIndex((value) => (value + 1) % featured.length)}
              >
                <ChevronRight aria-hidden="true" />
              </button>
              <div className={styles.featureDots} aria-label="随机推荐切换">
                {featured.map((work, dotIndex) => (
                  <button
                    key={work.id}
                    type="button"
                    className={dotIndex === index % featured.length ? styles.dotActive : styles.dot}
                    aria-label={`显示${work.title}`}
                    onClick={() => setIndex(dotIndex)}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>

        <div className={styles.sideList}>
          {sideFeatured.map((work) => (
            <button
              key={work.id}
              type="button"
              className={styles.tile}
              onClick={() => open(work.id)}
              aria-label={`打开${work.title}详情`}
            >
              <Artwork artwork={work.artwork.fanart ?? work.artwork.poster} alt={work.title} className={styles.tileImage} />
              <span className={styles.tileShade} aria-hidden="true" />
              <span className={styles.tileMeta}>
                <strong>{work.title}</strong>
                <small>
                  {metaLine(work)}
                  {work.rating > 0 ? ` · ★ ${work.rating.toFixed(1)}` : ''}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>

      {continueWatching.length > 0 ? (
        <section className={styles.section}>
          <SectionHeading
            title="继续观看"
            meta={`${continueWatching.length} 个项目`}
            action={
              <button type="button" className={styles.sectionLink} onClick={() => navigate('/recent')}>
                <span>查看全部</span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            }
          />
          <div className={styles.continueRow}>
            {continueWatching.map((work) => (
              <PosterCard key={work.id} work={work} variant="wide" onOpen={open} />
            ))}
          </div>
        </section>
      ) : null}

      {SECTIONS.map((section) => {
        const sectionWorks = works.filter((work) => matchView(work, section.view));
        if (sectionWorks.length === 0) {
          return null;
        }
        return (
          <section className={styles.section} key={section.view}>
            <SectionHeading
              title={section.label}
              meta={`共 ${sectionWorks.length} 部`}
              action={
                <button
                  type="button"
                  className={styles.sectionLink}
                  onClick={() => navigate(`/library/${section.view}`)}
                >
                  <span>查看全部</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              }
            />
            <div className={styles.grid}>
              {sectionWorks.slice(0, 8).map((work) => (
                <PosterCard key={work.id} work={work} onOpen={open} imageMode={appearance.cardImageMode} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function metaLine(work: WorkSummary): string {
  if (work.mediaType === 'movie') {
    return work.year ? String(work.year) : '剧场版';
  }
  return `共 ${work.seasonCount} 季`;
}

/** 每个作品名只保留第一个条目，用作文档橱窗的代表。 */
function dedupeByTitle(works: readonly WorkSummary[]): readonly WorkSummary[] {
  const seen = new Set<string>();
  const result: WorkSummary[] = [];
  for (const work of works) {
    if (seen.has(work.title)) {
      continue;
    }
    seen.add(work.title);
    result.push(work);
  }
  return result;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}
