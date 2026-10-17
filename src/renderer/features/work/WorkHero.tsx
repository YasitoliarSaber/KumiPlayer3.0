/** 参照归档旧版的单列概要；复用当前控件与图片生命周期，不引入旧 CSS。 */
import { ArrowLeft, ChevronDown, Play, Database, Heart } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { EpisodeEntry, WorkDetail } from '@/shared/api/service';
import { SOURCE_LABELS } from '@/app/ui-store';
import { Artwork } from '@/shared/ui/Artwork';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import styles from './WorkDetailPage.module.css';

interface WorkHeroProps {
  readonly work: WorkDetail;
  readonly resume: EpisodeEntry | null;
  readonly resumePosition: number;
  readonly resumeDuration: number;
  readonly resumePercent: number;
  readonly busy: boolean;
  readonly favoriteBusy: boolean;
  readonly preferredSource: string;
  readonly notice: string;
  readonly onBack: () => void;
  readonly onSourceChange: (source: string) => void;
  readonly onPlay: () => void;
  readonly onFavorite: () => void;
  readonly children: ReactNode;
}

const sourceLabel = (source: string) => SOURCE_LABELS.find((entry) => entry.value === source)?.label ?? source;

export function WorkHero({ work, resume, resumePosition, resumeDuration, resumePercent, busy, favoriteBusy,
  preferredSource, notice, onBack, onSourceChange, onPlay, onFavorite, children }: WorkHeroProps) {
  const [plotExpanded, setPlotExpanded] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [work.artwork.clearlogo?.url]);
  const hasLogo = Boolean(work.artwork.clearlogo && !logoFailed);
  const source = preferredSource || work.sources[0] || '';
  const episodeLabel = resume ? [resume.code, resume.title].filter(Boolean).join(' · ') : '';
  const timeSummary = resumeDuration > 0
    ? `剩余 ${formatPlaybackTime(Math.max(0, resumeDuration - resumePosition))} · 总长 ${formatPlaybackTime(resumeDuration)}`
    : '时长待获取';
  const progressLabel = resumeDuration > 0 ? `${resumePercent}%` : '进度待获取';

  return <header className={styles.hero}>
    <Button variant="ghost" size="sm" className={styles.heroBack} onClick={onBack}>
      <ArrowLeft aria-hidden="true" /><span>返回</span>
    </Button>
    <section className={styles.heroBody} aria-label="作品概要">
      <div className={styles.heroCopy}>
        <h1 className={hasLogo ? styles.logoTitle : styles.heroTitle}>
          {hasLogo ? <>
            <span className="sr-only">{work.title}</span>
            <Artwork artwork={work.artwork.clearlogo} alt="" kind="logo" loading="eager"
              className={styles.heroLogo} onError={() => setLogoFailed(true)} />
          </> : work.title}
        </h1>
        {work.originalTitle && work.originalTitle !== work.title
          ? <p className={styles.heroOriginal}>{work.originalTitle}</p> : null}
        <div className={styles.heroMeta}>
          {work.year > 0 ? <span>{work.year}</span> : null}
          {work.mediaType === 'movie' ? <span>{work.showType === 'anime_movie' ? '动画电影' : '电影'}</span>
            : work.seasonCount > 0 ? <span>{work.seasonCount} 季</span> : null}
          {work.mediaType !== 'movie' && work.episodeCount > 0 ? <span>{work.episodeCount} 集</span> : null}
          {work.rating > 0 ? <span>★ {work.rating.toFixed(1)}</span> : null}
        </div>
        <div className={styles.heroTags}>
          {work.sources.length > 1 ? <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="xs" className={styles.sourcePicker}>
                <Database className="size-3.5" />{sourceLabel(source)}<ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[13rem]">
              <DropdownMenuLabel>作品来源</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={source} onValueChange={onSourceChange}>
                {work.sources.map((entry) => <DropdownMenuRadioItem key={entry} value={entry}>
                  {sourceLabel(entry)}
                </DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu> : source ? <span className={styles.sourceLabel}>
            <Database aria-hidden="true" />{sourceLabel(source)}
          </span> : null}
          <span className={styles.genreList}>{work.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}</span>
        </div>
        {work.plot ? <button type="button" className={styles.heroPlot} aria-expanded={plotExpanded}
          aria-label={plotExpanded ? '收起作品简介' : '展开完整作品简介'}
          onClick={() => setPlotExpanded((expanded) => !expanded)}>{work.plot}</button> : null}
        <div className={styles.heroActions}>
          <Button variant="outline" className={styles.continueButton} onClick={onPlay} disabled={!resume} loading={busy}
            aria-label={resume ? `${resumePosition > 0 ? '继续观看' : '播放'} ${episodeLabel}，${progressLabel}，${timeSummary}` : '暂无可播放剧集'}>
            {resumePosition > 0 ? <span className={styles.continueFill} style={{ width: `${resumePercent}%` }}
              role="progressbar" aria-label="观看进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={resumePercent} /> : null}
            {!busy ? <Play className={styles.continueIcon} size={20} fill="currentColor" /> : null}
            <span className={styles.continueCopy}>
              <strong>{resumePosition > 0 ? '继续观看' : '播放'}</strong>
              {resume ? <small>{episodeLabel}</small> : null}
            </span>
            <span className={styles.continueHover} aria-hidden="true">
              <span>{episodeLabel}</span>
              <span className={styles.continueStats}>
                <b className={styles.continuePercent}>{progressLabel}</b>
                <span>{timeSummary}</span>
              </span>
            </span>
          </Button>
          <Button variant="outline" size="icon" className={styles.onArtworkButton} loading={favoriteBusy}
            aria-label={work.watch.favorite ? '取消收藏' : '收藏'} aria-pressed={work.watch.favorite}
            title={work.watch.favorite ? '取消收藏' : '收藏'} onClick={onFavorite}>
            {!favoriteBusy ? <Heart className="size-6" fill={work.watch.favorite ? 'currentColor' : 'none'} /> : null}
          </Button>
          {children}
        </div>
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      </div>
    </section>
  </header>;
}

function formatPlaybackTime(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  const rest = String(value % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${String(minutes).padStart(2, '0')}:${rest}`;
}
