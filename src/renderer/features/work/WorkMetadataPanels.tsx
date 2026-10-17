/**
 * 详情页的元数据与 Bangumi 面板（N12 / N13），是详情页的次级管理入口。
 *
 * 真实模式（`service.serviceMode === 'real'`）：候选检索、候选确认、手动标题、
 * 手动图片与 Bangumi 匹配/同步都走真实服务。手动图片必须读成 data URL：
 * 真实后端只接受 base64 上传，`blob:` object URL 会被拒绝。
 * 演示模式保留本机演示覆盖层与快捷图片按钮，并在文案中明确标注"演示"。
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, RotateCcw, Search, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';

import type {
  ArtworkRef,
  BangumiCollectionState,
  MetadataCandidate,
  WorkDetail,
} from '@/shared/api/service';
import { demoQueryKeys, useMediaService } from '@/shared/api/service-context';
import { useDemoState } from '@/mock/demo-store';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import { StatusChip } from '@/shared/ui/Surface';
import styles from './WorkDetailPage.module.css';

interface PanelProps {
  readonly work: WorkDetail;
}

type ArtworkRole = 'poster' | 'fanart' | 'clearlogo';

const ARTWORK_ROLE_LABELS: Readonly<Record<ArtworkRole, string>> = {
  poster: '海报',
  fanart: '背景图',
  clearlogo: '标志',
};

const COLLECTION_OPTIONS: ReadonlyArray<{ readonly value: BangumiCollectionState; readonly label: string }> = [
  { value: 'wish', label: '想看' },
  { value: 'collect', label: '看过' },
  { value: 'doing', label: '在看' },
  { value: 'on_hold', label: '搁置' },
  { value: 'dropped', label: '弃番' },
];

function useRefresh(workId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.detail(workId) });
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.library });
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.tasks });
  };
}

/** 演示素材候选：复用已准备的本作海报与背景，避免再引外部图片。 */
function demoArtworkOptions(work: WorkDetail): ReadonlyArray<{ label: string; role: ArtworkRole; ref: ArtworkRef }> {
  const options: Array<{ label: string; role: ArtworkRole; ref: ArtworkRef }> = [];
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
  const real = service.serviceMode === 'real';
  const refresh = useRefresh(work.id);
  const override = useDemoState().overrides[work.id] ?? {};
  const [query, setQuery] = useState(work.title);
  const [candidates, setCandidates] = useState<readonly MetadataCandidate[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [titleDraft, setTitleDraft] = useState(override.manualTitle ?? '');
  const [artworkRole, setArtworkRole] = useState<ArtworkRole>('poster');
  const [dataUrl, setDataUrl] = useState('');
  const artworkOptions = demoArtworkOptions(work);

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
      setMessage(
        found.length === 0
          ? '没有可用候选：请检查标题或稍后重试。'
          : `找到 ${found.length} 个候选${real ? '' : '（演示数据）'}`,
      );
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
      setMessage(real ? '已确认候选：列表与详情会立即反映该覆盖。' : '已确认演示候选：列表与详情会立即反映该覆盖。');
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
      setError('只接受图片文件。');
      return;
    }
    // 真实后端只接受 base64 上传：这里读成 data URL，不使用 blob: object URL。
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result.startsWith('data:image/')) {
        setError('读取到的内容不是可用的图片数据，请重新选择。');
        return;
      }
      setDataUrl(result);
      setError('');
      setMessage(`已读取本地图片「${file.name}」，确认后才会写入覆盖。`);
    };
    reader.onerror = () => setError('读取本地图片失败，请重新选择。');
    reader.readAsDataURL(file);
  };

  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>{real ? '元数据与人工覆盖' : '元数据与人工覆盖（演示）'}</h2>
      <div className={styles.panelBody}>
        <p className={styles.panelHint}>
          {real
            ? '在线检索每次都会请求 TMDB，需要已在设置中配置读取令牌；候选确认、手动标题与手动图片都会写入本机权威覆盖。'
            : '演示模式不访问在线资料，也不会写入任何真实绑定或凭据。'}
        </p>

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
                void service
                  .setManualTitle(work.id, titleDraft)
                  .then(() => {
                    setMessage(real ? '已保存手动标题。' : '已保存手动标题（仅本机演示覆盖）。');
                    setError('');
                    refresh();
                  })
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '标题未保存'));
              }}
            >
              保存标题
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void service
                  .resetManualTitle(work.id)
                  .then(() => {
                    setMessage('已恢复自动标题。');
                    setError('');
                    refresh();
                  })
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '未能恢复自动标题'));
              }}
            >
              <RotateCcw className="size-3.5" />
              恢复自动
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px]">手动图片</span>
          {real ? (
            <p className={styles.panelHint}>
              真实后端只接受图片数据本体：选择本地文件会读成 data URL 上传，不接受图片 URL。
            </p>
          ) : null}
          {!real && artworkOptions.length > 0 ? (
            // 演示模式：真实后端不吃图片 URL，因此这些快捷按钮只在演示模式出现。
            <div className="flex flex-wrap gap-2">
              {artworkOptions.map((option) => (
                <Button
                  key={`${option.role}-${option.ref.url}`}
                  size="xs"
                  variant={override.manualArtwork?.url === option.ref.url ? 'subtle' : 'outline'}
                  onClick={() => {
                    void service
                      .setManualArtwork(work.id, option.role, option.ref)
                      .then(() => {
                        setMessage(`已使用「${option.label}」作为手动图片。`);
                        refresh();
                      })
                      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '图片未保存'));
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex w-32 flex-col gap-1 text-[12.5px]">
              图片角色
              <Select value={artworkRole} onValueChange={(value) => setArtworkRole(value as ArtworkRole)}>
                <SelectTrigger size="sm" aria-label="图片角色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ARTWORK_ROLE_LABELS) as ArtworkRole[]).map((role) => (
                    <SelectItem key={role} value={role}>
                      {ARTWORK_ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <input
              type="file"
              accept="image/*"
              aria-label="选择本地图片"
              className="text-[12px]"
              onChange={(event) => {
                pickFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={dataUrl.length === 0}
              onClick={() => {
                void service
                  .setManualArtwork(work.id, artworkRole, { url: dataUrl, width: 0, height: 0 })
                  .then(() => {
                    setMessage(`已上传为「${ARTWORK_ROLE_LABELS[artworkRole]}」。`);
                    setError('');
                    setDataUrl('');
                    refresh();
                  })
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '图片未保存'));
              }}
            >
              上传这张图片
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void service
                  .resetManualArtwork(work.id, artworkRole)
                  .then(() => {
                    setMessage(`已恢复自动${ARTWORK_ROLE_LABELS[artworkRole]}。`);
                    setError('');
                    refresh();
                  })
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '未能恢复自动图片'));
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
  const real = typeof service.bangumiMatch === 'function';
  const binding = (useDemoState().overrides[work.id] ?? {}).bangumi;
  const [query, setQuery] = useState(work.title);
  const [subjects, setSubjects] = useState<readonly { id: string; title: string; year: number; episodes: number }[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [collection, setCollection] = useState<BangumiCollectionState>('doing');

  const match = useQuery({
    queryKey: ['bangumi-match', work.id],
    enabled: real,
    queryFn: () => service.bangumiMatch!(work.id),
  });

  const search = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const found = await service.bangumiSearch(query);
      setSubjects(found);
      setSelected(found[0]?.id ?? '');
      setMessage(found.length === 0 ? '没有匹配条目，请调整关键词。' : `找到 ${found.length} 个条目${real ? '' : '（演示）'}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '搜索失败');
    } finally {
      setBusy(false);
    }
  };

  const bind = async () => {
    setError('');
    setMessage('');
    try {
      await service.bangumiBind(work.id, selected);
      setMessage('已绑定条目。');
      setSubjects([]);
      refresh();
      void match.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '绑定失败');
    }
  };

  const unbind = async () => {
    setError('');
    setMessage('');
    try {
      await service.bangumiUnbind(work.id);
      setMessage(real ? '已解除 Bangumi 绑定。' : '已解除 Bangumi 绑定（本机演示数据）。');
      setSubjects([]);
      refresh();
      void match.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解除绑定失败');
    }
  };

  // 后端同步端点返回双向摘要（pulled / pushed），不再是任务实体：摘要按真实计数展示。
  const syncProgress = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await service.bangumiSync(work.id);
      setMessage(
        `同步摘要：拉取 ${result.pulled} 集、推送 ${result.pushed} 集` +
          `（远端此前已完成 ${result.remoteDoneBefore} 集，本地此前已完成 ${result.localDoneBefore} 集；状态 ${result.status}）。`,
      );
      refresh();
      void match.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '同步失败');
    } finally {
      setBusy(false);
    }
  };

  const setCollectionState = async () => {
    if (typeof service.bangumiSetCollection !== 'function') {
      setError('当前服务没有收藏同步能力。');
      return;
    }
    setError('');
    setMessage('');
    try {
      await service.bangumiSetCollection(work.id, collection);
      setMessage(`已同步收藏状态：${COLLECTION_OPTIONS.find((entry) => entry.value === collection)?.label ?? collection}。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '收藏状态未同步');
    }
  };

  const searchPanel = (
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
      <Button size="sm" disabled={!selected} onClick={() => void bind()}>
        <Link2 className="size-3.5" />
        绑定条目
      </Button>
    </>
  );

  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>{real ? 'Bangumi 同步' : 'Bangumi 同步（演示）'}</h2>
      <div className={styles.panelBody}>
        <p className={styles.panelHint}>
          {real
            ? 'Bangumi 只参与观看进度同步，不参与本地作品身份；匹配、同步与收藏状态都会走本机后端。'
            : 'Bangumi 只参与观看进度同步，不参与本地作品身份；演示模式不登录、不保存凭据、不发网络请求。'}
        </p>

        {real ? (
          match.isPending ? (
            <p className="text-[12.5px] text-muted-foreground" role="status">
              正在读取 Bangumi 匹配…
            </p>
          ) : match.isError ? (
            <p className="text-[12.5px] text-destructive" role="alert">
              匹配读取失败：{match.error instanceof Error ? match.error.message : '后端拒绝'}
            </p>
          ) : match.data ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <Badge variant="success">已匹配</Badge>
                <span className="font-medium">{match.data.title}</span>
                <span className="text-muted-foreground">
                  {`#${match.data.subjectId} · 已映射 ${match.data.mappedEpisodeCount} 集${
                    match.data.seasonNumber ? ` · 第 ${match.data.seasonNumber} 季` : ''
                  } · ${match.data.updatedAt.slice(0, 16).replace('T', ' ')}`}
                </span>
              </div>
              {match.data.mappedEpisodeCount === 0 ? (
                <p className="text-[12px] text-muted-foreground" role="status">
                  条目已保存，剧集映射待同步：远端条目尚未建立起本地剧集映射。
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" loading={busy} onClick={() => void syncProgress()}>
                  <Link2 className="size-3.5" />
                  同步观看进度
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void unbind()}>
                  <Unlink className="size-3.5" />
                  解除绑定
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex w-32 flex-col gap-1 text-[12.5px]">
                  收藏同步
                  <Select value={collection} onValueChange={(value) => setCollection(value as BangumiCollectionState)}>
                    <SelectTrigger size="sm" aria-label="Bangumi 收藏状态">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COLLECTION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={typeof service.bangumiSetCollection !== 'function'}
                  onClick={() => void setCollectionState()}
                >
                  同步收藏状态
                </Button>
              </div>
            </>
          ) : (
            searchPanel
          )
        ) : binding ? (
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
            {binding.episodeMappingPending ? (
              <p className="text-[12px] text-muted-foreground" role="status">
                条目已保存，剧集映射待同步。
              </p>
            ) : null}
            {binding.error ? <p className="text-[12px] text-destructive">{binding.error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" loading={busy} onClick={() => void syncProgress()}>
                <Link2 className="size-3.5" />
                同步观看进度
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void unbind()}>
                <Unlink className="size-3.5" />
                解除绑定
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex w-32 flex-col gap-1 text-[12.5px]">
                收藏同步
                <Select value={collection} onValueChange={(value) => setCollection(value as BangumiCollectionState)}>
                  <SelectTrigger size="sm" aria-label="Bangumi 收藏状态">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COLLECTION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={typeof service.bangumiSetCollection !== 'function'}
                onClick={() => void setCollectionState()}
              >
                同步收藏状态
              </Button>
            </div>
          </>
        ) : (
          searchPanel
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
