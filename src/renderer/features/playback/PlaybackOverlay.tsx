/**
 * 演示播放态。
 *
 * 明确说明：这里没有启动 mpv、没有打开任何真实媒体文件；它只按剧集时长
 * 推进一个本地计时器，用来展示播放中界面与进度回写交互。
 */

import { Button, Tooltip } from '@mantine/core';
import { Pause, Play, Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { demoQueryKeys, useMediaService } from '../../shared/api/service-context';
import { useDemoState } from '../../mock/demo-store';
import { ProgressBar } from '../../shared/ui/Surface';
import styles from './PlaybackOverlay.module.css';

export function PlaybackOverlay() {
  const session = useDemoState().playback;
  const service = useMediaService();
  const queryClient = useQueryClient();
  const [paused, setPaused] = useState(false);
  const [position, setPosition] = useState(0);
  const tick = useRef<number | null>(null);

  useEffect(() => {
    setPosition(session?.position ?? 0);
    setPaused(session?.paused ?? false);
  }, [session?.episodeId, session?.position, session?.paused]);

  useEffect(() => {
    if (!session || paused) {
      return undefined;
    }
    tick.current = window.setInterval(() => {
      setPosition((value) => Math.min(session.duration, value + 1));
    }, 1000);
    return () => {
      if (tick.current !== null) {
        window.clearInterval(tick.current);
      }
    };
  }, [paused, session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const timer = window.setTimeout(() => {
      void service
        .saveProgress(session.workId, session.episodeId, position, session.duration)
        .then(() => queryClient.invalidateQueries({ queryKey: demoQueryKeys.library }));
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [position, queryClient, service, session]);

  if (!session) {
    return null;
  }

  const percent = session.duration > 0 ? (position / session.duration) * 100 : 0;

  return (
    <aside className={styles.overlay} role="complementary" aria-label="演示播放">
      <div className={styles.head}>
        <span className={styles.badge}>演示播放</span>
        <span className={styles.hint}>未启动 mpv，未打开真实媒体</span>
      </div>
      <div className={styles.title} title={`${session.workTitle} ${session.episodeCode}`}>
        {session.workTitle}
      </div>
      <div className={styles.episode}>
        {session.episodeCode} · {session.episodeTitle}
      </div>
      <div className={styles.progress}>
        <ProgressBar value={percent} label="演示播放进度" size={4} />
      </div>
      <div className={styles.time}>
        {formatTime(position)} / {formatTime(session.duration)}
      </div>
      <div className={styles.actions}>
        <Button
          variant="default"
          size="xs"
          leftSection={paused ? <Play size={14} /> : <Pause size={14} />}
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? '继续' : '暂停'}
        </Button>
        <Tooltip label="停止并保存模拟进度">
          <Button
            variant="default"
            size="xs"
            leftSection={<Square size={13} />}
            onClick={() => {
              void service.stopPlayback().then(() =>
                queryClient.invalidateQueries({ queryKey: demoQueryKeys.library }),
              );
            }}
          >
            停止
          </Button>
        </Tooltip>
        <span className={styles.volume} aria-hidden="true">
          <Volume2 size={15} />
        </span>
      </div>
    </aside>
  );
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
