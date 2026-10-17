import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { EpisodeEntry } from '@/shared/api/service';
import { Artwork } from '@/shared/ui/Artwork';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { ProgressBar } from '@/shared/ui/Surface';
import styles from './WorkDetailPage.module.css';

export function EpisodeStrip({ episodes, seasonId, label, onPlay }: {
  readonly episodes: readonly EpisodeEntry[];
  readonly seasonId: string;
  readonly label: string;
  readonly onPlay: (episode: EpisodeEntry) => void;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const drag = useRef({ active: false, startX: 0, startLeft: 0, moved: 0 });
  useLayoutEffect(() => { if (viewport) viewport.scrollLeft = 0; }, [viewport, seasonId]);
  const bindViewport = useCallback((node: HTMLDivElement | null) => {
    setViewport(node);
    if (!node) return;
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      drag.current = { active: true, startX: event.clientX, startLeft: node.scrollLeft, moved: 0 };
    };
    const move = (event: PointerEvent) => {
      if (!drag.current.active) return;
      const delta = event.clientX - drag.current.startX;
      drag.current.moved = Math.max(drag.current.moved, Math.abs(delta));
      if (drag.current.moved > 6) {
        if (!node.hasPointerCapture(event.pointerId)) node.setPointerCapture(event.pointerId);
        node.dataset.dragging = 'true';
        node.scrollLeft = drag.current.startLeft - delta;
      }
    };
    const up = (event: PointerEvent) => {
      drag.current.active = false;
      node.dataset.dragging = 'false';
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    };
    const click = (event: MouseEvent) => {
      if (drag.current.moved > 6) { event.preventDefault(); event.stopPropagation(); drag.current.moved = 0; }
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('lostpointercapture', up);
    node.addEventListener('click', click, true);
    return () => {
      node.removeEventListener('pointerdown', down); node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up);
      node.removeEventListener('lostpointercapture', up); node.removeEventListener('click', click, true);
    };
  }, []);

  return <div className={styles.episodeRail}>
    <ScrollArea orientation="horizontal" type="auto" className={styles.episodeScroll} viewportRef={bindViewport}
      viewportProps={{ tabIndex: 0, 'aria-label': `${label}分集列表，可左右滚动`, className: styles.episodeViewport }}>
      <ul className={styles.episodes}>
        {episodes.map((episode) => <li key={episode.id}>
          <Button variant="ghost" className={styles.episode} onClick={() => onPlay(episode)}
            aria-label={`播放 ${episode.code} ${episode.title}`}>
            <span className={styles.episodeThumb}>
              <Artwork artwork={episode.thumb} alt="" kind="episode" fallbackLabel="暂无分集图片" className={styles.episodeImage} />
              {episode.position > 0 && episode.durationSec > 0 ? <span className={styles.episodeProgress}>
                <ProgressBar value={episode.position / Math.max(episode.durationSec, 1) * 100} label={`${episode.code}观看进度`} />
              </span> : null}
            </span>
            <span className={styles.episodeCopy}>
              <span className={styles.episodeCode}>{episode.code}</span>
              <span className={styles.episodeTitle} title={episode.title}>{episode.title}</span>
            </span>
          </Button>
        </li>)}
      </ul>
    </ScrollArea>
  </div>;
}
