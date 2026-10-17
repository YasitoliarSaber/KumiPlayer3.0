/**
 * 快捷搜索面板（Ctrl/Cmd+K）。
 *
 * 版式对齐「KumiPlayer-原型精修」的顶部搜索浮层：单行搜索头、
 * 作品分组、海报缩略图与底部键盘提示。只搜索作品，不把页面名称
 * 混入结果。面板本身不持有媒体事实，只消费传入的作品索引。
 */

import { Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { ArtworkRef, LibrarySearchHit, WorkSummary } from '@/shared/api/service';
import { searchWorks } from '@/shared/api/search';
import { useMediaService } from '@/shared/api/service-context';
import { Artwork } from '@/shared/ui/Artwork';
import { Input } from '@/shared/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/shared/ui/dialog';
import { cn } from '@/shared/lib/utils';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly works: readonly WorkSummary[];
  readonly onOpenWork: (workId: string) => void;
}

interface Row {
  readonly key: string;
  readonly label: string;
  /** 行尾的简要资料，对应原型的 `small`（类型 / 季数 / 评分）。 */
  readonly meta: string;
  readonly workId: string;
  readonly poster: ArtworkRef | null;
}

export function CommandPalette({ open, onOpenChange, works, onOpenWork }: CommandPaletteProps) {
  const service = useMediaService();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  /** 后端轻量搜索索引的结果；只有真实服务提供该能力时才使用。 */
  const [remoteHits, setRemoteHits] = useState<readonly LibrarySearchHit[]>([]);
  /** 后端在命中数超过 limit 时给出的截断标记：界面如实提示，不假装结果完整。 */
  const [remoteTruncated, setRemoteTruncated] = useState(false);
  const [remotePending, setRemotePending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  // 面板由快捷键唤起，没有触发元素；关闭时把焦点还给打开前的元素。
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const listId = useId();

  // 查询标记：切换查询时重置高亮；同步搜索也按同一规则丢弃旧结果。
  const canRemoteSearch = typeof service.searchLibrary === 'function';
  const trimmedQuery = query.trim();

  // 真实后端搜索：输入法与组合期间不查询，组合结束后按最终文本查一次；
  // 过期响应通过查询标记丢弃，避免旧结果覆盖新输入。
  useEffect(() => {
    if (!open || !canRemoteSearch || composing) {
      return undefined;
    }
    if (trimmedQuery.length === 0) {
      setRemoteHits([]);
      setRemoteTruncated(false);
      setRemotePending(false);
      return undefined;
    }
    let cancelled = false;
    // 新查询先清空旧命中，避免把上一条查询的结果当成当前结果。
    setRemoteHits([]);
    setRemoteTruncated(false);
    setRemotePending(true);
    const timer = window.setTimeout(() => {
      void service
        .searchLibrary!(trimmedQuery, 30)
        .then((result) => {
          if (!cancelled) {
            setRemoteHits(result.hits);
            setRemoteTruncated(result.truncated);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRemoteHits([]);
            setRemoteTruncated(false);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setRemotePending(false);
          }
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canRemoteSearch, composing, open, service, trimmedQuery]);

  // 空查询时展示最近观看/库内作品，与原型打开即见作品一致；不混入导航项。
  const recentWorks = useMemo(() => {
    const watching = works.filter((work) => work.progress);
    const rest = works.filter((work) => !work.progress);
    return [...watching, ...rest].slice(0, 8);
  }, [works]);

  const rows = useMemo<readonly Row[]>(() => {
    const byId = new Map(works.map((work) => [work.id, work]));
    if (trimmedQuery.length === 0) {
      return recentWorks.map(rowFromWork);
    }
    if (!canRemoteSearch) {
      return searchWorks(works, trimmedQuery, { limit: 8 }).map((hit) => rowFromWork(hit.work));
    }
    return remoteHits.map((hit) => {
      const work = byId.get(hit.workId);
      return {
        key: `work-${hit.workId}`,
        label: work?.title || hit.title,
        meta: work ? workMeta(work) : hitMeta(hit),
        workId: hit.workId,
        poster: work?.artwork.poster ?? null,
      };
    });
  }, [canRemoteSearch, recentWorks, remoteHits, trimmedQuery, works]);

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmedQuery]);

  useEffect(() => {
    if (activeIndex >= rows.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, rows.length]);

  useEffect(() => {
    // jsdom 不实现 scrollIntoView；真实浏览器里保证键盘高亮项可见。
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
      return;
    }
    restoreFocusRef.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const activate = (row: Row | undefined) => {
    if (!row) {
      return;
    }
    onOpenChange(false);
    onOpenWork(row.workId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        aria-label="搜索作品"
        className="top-[12vh] flex max-h-none w-[min(620px,calc(100vw-2rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden rounded-[calc(var(--radius-card)+2px)] border-border bg-popover p-0 shadow-[var(--shadow-flyout)]"
      >
        <DialogTitle className="sr-only">搜索作品</DialogTitle>
        <DialogDescription className="sr-only">检索标题、别名、标签或制作公司</DialogDescription>

        <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
          <Search className="size-[17px] shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={inputRef}
            type="text"
            value={query}
            className="h-auto flex-1 rounded-none border-0 bg-transparent p-0 text-[15px] shadow-none focus-visible:border-0 focus-visible:ring-0"
            placeholder="搜索作品、标签、制作公司"
            aria-label="快捷搜索"
            aria-autocomplete="list"
            autoComplete="off"
            aria-controls={listId}
            aria-activedescendant={rows[activeIndex] ? `${listId}-${activeIndex}` : undefined}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false);
              setQuery(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, Math.max(rows.length - 1, 0)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                activate(rows[activeIndex]);
              }
            }}
          />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="关闭搜索"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground focus-visible:bg-[var(--surface-hover)] focus-visible:text-foreground focus-visible:outline-none"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="max-h-[min(52vh,420px)] overflow-y-auto p-2">
          <p className="px-2.5 pt-2 pb-1 text-[11.5px] tracking-[0.08em] text-muted-foreground uppercase">
            作品 · {rows.length} 项
          </p>
          {rows.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-[13px] text-muted-foreground">
              {trimmedQuery.length === 0
                ? '输入标题、别名、标签或制作公司开始搜索'
                : remotePending
                  ? `正在检索「${trimmedQuery}」…`
                  : `没有匹配「${trimmedQuery}」的结果`}
            </p>
          ) : (
            <ul id={listId} role="listbox" aria-label="搜索结果" className="flex flex-col">
              {rows.map((row, index) => (
                <li key={row.key}>
                  <button
                    ref={index === activeIndex ? activeRef : undefined}
                    type="button"
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] outline-none',
                      index === activeIndex ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-hover)]',
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => activate(row)}
                  >
                    <Artwork
                      artwork={row.poster}
                      alt=""
                      kind="poster"
                      fallbackLabel={row.label.slice(0, 1)}
                      className="h-9 w-[26px] shrink-0 rounded-[5px] object-cover"
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground">{row.label}</span>
                    <small className="shrink-0 text-[12px] text-muted-foreground">{row.meta}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {remoteTruncated ? (
            // 后端有界查询：命中多于上限时如实说明，不假装已经全部列出。
            <p className="px-2.5 py-2 text-[11.5px] text-muted-foreground" role="status">
              命中过多，仅显示前 {remoteHits.length} 条，请补充关键词缩小范围。
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3.5 py-[9px] text-[12px] text-muted-foreground">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span className="ml-auto">Esc 关闭</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const SHOW_TYPE_LABELS: Record<WorkSummary['showType'], string> = {
  anime_series: '番剧',
  anime_movie: '动画电影',
  live_series: '剧集',
  live_movie: '电影',
};

function rowFromWork(work: WorkSummary): Row {
  return {
    key: `work-${work.id}`,
    label: work.title,
    meta: workMeta(work),
    workId: work.id,
    poster: work.artwork.poster,
  };
}

/** 行尾只保留原型同类的简要资料，不铺开后端命中字段。 */
function workMeta(work: WorkSummary): string {
  const parts = [SHOW_TYPE_LABELS[work.showType]];
  if (work.mediaType !== 'movie' && work.seasonCount > 0) {
    parts.push(`${work.seasonCount} 季`);
  }
  if (work.rating > 0) {
    parts.push(work.rating.toFixed(1));
  } else if (work.year > 0 && parts.length === 1) {
    parts.push(String(work.year));
  }
  return parts.join(' · ');
}

/** 搜索索引命中但本地卡片索引尚未加载时，仍给出可读的类型与年份。 */
function hitMeta(hit: LibrarySearchHit): string {
  const parts = [hit.mediaType === 'movie' ? '电影' : '番剧'];
  if (hit.year) {
    parts.push(String(hit.year));
  }
  return parts.join(' · ');
}
