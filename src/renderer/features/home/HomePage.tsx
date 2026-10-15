/**
 * 首页：媒体展示橱窗 + 继续观看 + 分类分区。
 * 结构、信息密度与分区顺序复刻当前应用首页，不做新的视觉设计。
 */

import { Button } from '@mantine/core';
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import type { WorkSummary } from '../../shared/api/service';
import { useLibrary } from '../../shared/api/service-context';
import { Artwork } from '../../shared/ui/Artwork';
import { PosterCard } from '../../shared/ui/PosterCard';
import { EmptySurface, ErrorSurface, LoadingSurface, SectionHeading } from '../../shared/ui/Surface';
import { matchView } from '../../shell/AppShell';
import { useUiStore } from '../../app/ui-store';
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
  const [autoPaused, setAutoPaused] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

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
    if (featured.length <= 1 || reducedMotion || autoPaused) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % featured.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoPaused, featured.length, reducedMotion]);

  useEffect(() => {
    setIndex(0);
  }, [source]);

  const open = useCallback((workId: string) => navigate(`/work/${workId}`), [navigate]);

  if (library.isPending) {
    return <LoadingSurface label="正在载入媒体库" detail="正在整理演示作品" />;
  }
  if (library.isError) {
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
          <Button variant="default" onClick={() => navigate('/manage')}>
            添加媒体
          </Button>
        }
      />
    );
  }

  const current = featured[index % featured.length] ?? featured[0]!;

  return (
    <div className={styles.page} data-route="home">
      <section className={styles.showcase} aria-label="媒体展示">
        <div className={styles.feature}>
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
              {!reducedMotion ? (
                <button
                  type="button"
                  className={styles.autoPlay}
                  aria-label={autoPaused ? '恢复自动推荐' : '暂停自动推荐'}
                  aria-pressed={autoPaused}
                  onClick={() => setAutoPaused((value) => !value)}
                >
                  {autoPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                </button>
              ) : null}
            </>
          ) : null}
        </div>

        <div className={styles.sideList}>
          {sideFeatured.map((work, tileIndex) => (
            <button
              key={work.id}
              type="button"
              className={tileIndex === 0 ? `${styles.tile} ${styles.tileWide}` : styles.tile}
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
                <PosterCard key={work.id} work={work} onOpen={open} />
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
