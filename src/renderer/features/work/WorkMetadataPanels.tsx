/**
 * 详情页的元数据与 Bangumi 面板（N12 / N13）。
 *
 * 模拟边界：候选检索、确认、标题/图片覆盖与 Bangumi 绑定都只写本机演示覆盖层，
 * 不访问在线服务、不保存凭据、不改写不可变证据；失败路径保留原值。
 * 浏览器本地选取的图片仅在内存中通过 object URL 使用，并在替换或卸载时释放。
 */

import { useQueryClient } from '@tanstack/react-query';
import { Link2, RotateCcw, Search, Unlink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { ArtworkRef, MetadataCandidate, WorkDetail } from '@/shared/api/service';
import { demoQueryKeys, useMediaService } from '@/shared/api/service-context';
import { useDemoState } from '@/mock/demo-store';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { StatusChip } from '@/shared/ui/Surface';
import styles from './WorkDetailPage.module.css';

interface PanelProps {
  readonly work: WorkDetail;
}

function useRefresh(workId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.detail(workId) });
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.library });
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.tasks });
  };
}

/** 演示素材候选：复用已准备的本作海报与背景，避免再引外部图片。 */
function demoArtworkOptions(work: WorkDetail): ReadonlyArray<{ label: string; role: 'poster' | 'fanart'; ref: ArtworkRef }> {
  const options: Array<{ label: string; role: 'poster' | 'fanart'; ref: ArtworkRef }> = [];
  if (work.artwork.poster) {
    options.push({ label: '本作海报', role: 'poster', ref: work.artwork.poster });
  }
  if (work.artwork.fanart) {
    options.push({ label: '本作背景图', role: 'fanart', ref: work.artwork.fanart });
  }
  const thumb = work.artwork.episodeThumbs[0];
  if (thumb) {
    options.push({ label: '首集缩略图', role: 'poster', ref: thumb });
  }
  return options;
}

export function ManualScrapePanel({ work }: PanelProps) {
  const service = useMediaService();
  const refresh = useRefresh(work.id);
  const override = useDemoState().overrides[work.id] ?? {};
  const [query, setQuery] = useState(work.title);
  const [candidates, setCandidates] = useState<readonly MetadataCandidate[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [titleDraft, setTitleDraft] = useState(override.manualTitle ?? '');
  const [objectUrl, setObjectUrl] = useState('');
  const objectUrlRef = useRef('');
  const artworkOptions = demoArtworkOptions(work);

  // 浏览器选取的本地文件只通过 object URL 使用；替换或卸载时立即释放。
  useEffect(
    () => () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setTitleDraft(override.manualTitle ?? '');
  }, [override.manualTitle]);

  const runSearch = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const found = await service.metadataCandidates(work.id, query);
      setCandidates(found);
      setSelected(found[0]?.id ?? '');
      setMessage(found.length === 0 ? '没有可用候选：请检查标题或稍后重试。' : `找到 ${found.length} 个候选（演示数据）`);
    } catch (cause) {
      setCandidates([]);
      setError(cause instanceof Error ? cause.message : '候选检索失败');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError('');
    setMessage('');
    try {
      await service.confirmCandidate(work.id, selected);
      setMessage('已确认演示候选：列表与详情会立即反映该覆盖。');
      refresh();
    } catch (cause) {
      // 失败保留原值，并给出手工兜底建议。
      setError(`${cause instanceof Error ? cause.message : '确认失败'}；可改用「手动标题」或「手动图片」。`);
    }
  };

  const pickFile = (file: File | undefined) => {
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      setError('只接受图片文件（演示环境仅在本机内存中使用）。');
      return;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setObjectUrl(url);
    setError('');
    setMessage(`已读取本地图片「${file.name}」，应用后立即释放内存副本。`);
  };

  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>元数据与人工覆盖（演示）</h2>
      <div className={styles.panelBody}>
        <p className={styles.panelHint}>演示模式不访问在线资料，也不会写入任何真实绑定或凭据。</p>

        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[12.5px]">
            检索标题
            <Input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              aria-label="检索标题"
            />
          </label>
          <Button size="sm" variant="outline" loading={busy} onClick={() => void runSearch()}>
            <Search className="size-3.5" />
            搜索候选
          </Button>
        </div>

        {candidates.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2.5 py-2 text-[12.5px]">
                  <input
                    type="radio"
                    name={`candidate-${work.id}`}
                    className="mt-1 size-3.5 accent-[var(--primary)]"
                    checked={selected === candidate.id}
                    onChange={() => setSelected(candidate.id)}
                  />
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <strong>{candidate.title}</strong>
                      <StatusChip tone={candidate.failing ? 'danger' : 'success'}>
                        置信度 {candidate.confidence}
                      </StatusChip>
                    </span>
                    <span className="text-muted-foreground">
                      {candidate.mediaType === 'movie' ? '电影' : '剧集'} · {candidate.year || '年份未知'} ·{' '}
                      {candidate.provider} · {candidate.providerId}
                    </span>
                    {candidate.failing ? (
                      <span className="text-destructive">该候选用作演示失败路径：确认会失败并保留原资料</span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!selected || candidates.length === 0} onClick={() => void confirm()}>
            确认候选
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCandidates([]);
              setSelected('');
              setError('');
              setMessage('已取消本次检索，原资料未改变。');
            }}
          >
            取消检索
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1 text-[12.5px]">
            手动标题
            <Input
              value={titleDraft}
              placeholder={work.title}
              aria-label="手动标题"
              onChange={(event) => setTitleDraft(event.currentTarget.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void service.setManualTitle(work.id, titleDraft).then(() => {
                  setMessage('已保存手动标题（仅本机演示覆盖）。');
                  refresh();
                });
              }}
            >
              保存标题
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void service.resetManualTitle(work.id).then(() => {
                  setMessage('已恢复自动标题。');
                  refresh();
                });
              }}
            >
              <RotateCcw className="size-3.5" />
              恢复自动
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px]">手动图片</span>
          <div className="flex flex-wrap gap-2">
            {artworkOptions.map((option) => (
              <Button
                key={`${option.role}-${option.ref.url}`}
                size="xs"
                variant={
                  override.manualArtwork?.url === option.ref.url ? 'subtle' : 'outline'
                }
                onClick={() => {
                  void service.setManualArtwork(work.id, option.role, option.ref).then(() => {
                    setMessage(`已使用「${option.label}」作为手动图片。`);
                    refresh();
                  });
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept="image/*"
              aria-label="选择本地图片"
              className="text-[12px]"
              onChange={(event) => pickFile(event.currentTarget.files?.[0])}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={objectUrl.length === 0}
              onClick={() => {
                void service
                  .setManualArtwork(work.id, 'poster', { url: objectUrl, width: 0, height: 0 })
                  .then(() => {
                    setMessage('已应用本机选取的图片（内存副本已释放）。');
                    refresh();
                  });
              }}
            >
              应用这张图片
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void service.resetManualArtwork(work.id).then(() => {
                  setMessage('已恢复自动图片。');
                  refresh();
                });
              }}
            >
              <RotateCcw className="size-3.5" />
              恢复自动
            </Button>
          </div>
        </div>

        {message ? (
          <p className="text-[12px] text-muted-foreground" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function BangumiPanel({ work }: PanelProps) {
  const service = useMediaService();
  const refresh = useRefresh(work.id);
  const binding = (useDemoState().overrides[work.id] ?? {}).bangumi;
  const [query, setQuery] = useState(work.title);
  const [subjects, setSubjects] = useState<readonly { id: string; title: string; year: number; episodes: number }[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const search = async () => {
    setBusy(true);
    setError('');
    try {
      const found = await service.bangumiSearch(query);
      setSubjects(found);
      setSelected(found[0]?.id ?? '');
      setMessage(found.length === 0 ? '没有匹配条目，请调整关键词。' : `找到 ${found.length} 个条目（演示）`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '搜索失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>Bangumi 同步（演示）</h2>
      <div className={styles.panelBody}>
        <p className={styles.panelHint}>
          Bangumi 只参与观看进度同步，不参与本地作品身份；演示模式不登录、不保存凭据、不发网络请求。
        </p>

        {binding ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <Badge variant={binding.status === 'matched' ? 'success' : 'danger'}>
                {binding.status === 'matched' ? '已匹配' : '同步失败'}
              </Badge>
              <span className="font-medium">{binding.title}</span>
              <span className="text-muted-foreground">
                #{binding.subjectId} · 已同步 {binding.syncedEpisodes} 集 ·{' '}
                {binding.lastSyncAt.slice(0, 16).replace('T', ' ')}
              </span>
            </div>
            {binding.error ? <p className="text-[12px] text-destructive">{binding.error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void service
                    .bangumiSync(work.id)
                    .then((task) => {
                      setMessage(`已发起同步任务（演示）：${task.id.slice(-6)}`);
                      setError('');
                      refresh();
                    })
                    .catch((cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : '同步失败');
                    });
                }}
              >
                <Link2 className="size-3.5" />
                同步观看进度
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void service.bangumiUnbind(work.id).then(() => {
                    setMessage('已解除 Bangumi 绑定（本机演示数据）。');
                    setSubjects([]);
                    refresh();
                  });
                }}
              >
                <Unlink className="size-3.5" />
                解除绑定
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-[12.5px]">
                Bangumi 关键词
                <Input value={query} aria-label="Bangumi 关键词" onChange={(event) => setQuery(event.currentTarget.value)} />
              </label>
              <Button size="sm" variant="outline" loading={busy} onClick={() => void search()}>
                搜索
              </Button>
            </div>
            {subjects.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {subjects.map((subject) => (
                  <li key={subject.id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2.5 py-2 text-[12.5px]">
                      <input
                        type="radio"
                        name={`bgm-${work.id}`}
                        className="mt-1 size-3.5 accent-[var(--primary)]"
                        checked={selected === subject.id}
                        onChange={() => setSelected(subject.id)}
                      />
                      <span className="flex flex-col">
                        <span className="font-medium">{subject.title}</span>
                        <span className="text-muted-foreground">
                          {subject.year} · {subject.episodes} 集 · #{subject.id}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              size="sm"
              disabled={!selected}
              onClick={() => {
                void service
                  .bangumiBind(work.id, selected)
                  .then(() => {
                    setMessage('已绑定条目（演示）。');
                    setError('');
                    refresh();
                  })
                  .catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : '绑定失败');
                  });
              }}
            >
              <Link2 className="size-3.5" />
              绑定条目
            </Button>
          </>
        )}

        {message ? (
          <p className="text-[12px] text-muted-foreground" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
