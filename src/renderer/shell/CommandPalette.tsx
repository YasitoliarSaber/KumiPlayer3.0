/**
 * 快捷搜索面板（Ctrl/Cmd+K）。
 *
 * 组合键盘导航与作品分组结果；查询是同步的本地演示搜索，
 * 通过"当前查询标记"丢弃迟到结果，避免旧输入覆盖新结果。
 * 面板本身不持有媒体事实，只消费传入的索引与导航表。
 */

import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import type { LibrarySearchHit, WorkSummary } from '@/shared/api/service';
import { searchNav, searchWorks } from '@/shared/api/search';
import { useMediaService } from '@/shared/api/service-context';
import { Input } from '@/shared/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { cn } from '@/shared/lib/utils';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly works: readonly WorkSummary[];
  readonly onOpenWork: (workId: string) => void;
}

type Row =
  | { readonly kind: 'work'; readonly key: string; readonly label: string; readonly hint: string; readonly workId: string }
  | { readonly kind: 'nav'; readonly key: string; readonly label: string; readonly hint: string; readonly to: string };

export function CommandPalette({ open, onOpenChange, works, onOpenWork }: CommandPaletteProps) {
  const navigate = useNavigate();
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

  const rows = useMemo<readonly Row[]>(() => {
    const byId = new Map(works.map((work) => [work.id, work]));
    const hits = (canRemoteSearch ? remoteHits : searchWorks(works, query)).map<Row>((hit) => {
      const isRemote = 'workId' in hit;
      const work = isRemote ? byId.get(hit.workId) : hit.work;
      const label = work?.title ?? (isRemote ? hit.title : '');
      const hint = isRemote
        ? remoteHint(hit)
        : hit.reason;
      return {
        kind: 'work',
        key: `work-${(isRemote ? hit.workId : hit.work.id)}`,
        label,
        hint,
        workId: isRemote ? hit.workId : hit.work.id,
      };
    });
    const nav = searchNav(query).map<Row>((item) => ({
      kind: 'nav',
      key: `nav-${item.to}`,
      label: item.label,
      hint: '前往',
      to: item.to,
    }));
    return [...hits, ...nav];
  }, [canRemoteSearch, query, remoteHits, works]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

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
    if (row.kind === 'work') {
      onOpenWork(row.workId);
      return;
    }
    navigate(row.to);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12%] translate-y-0 gap-3 p-4" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="sr-only">快捷搜索</DialogTitle>
          <DialogDescription className="sr-only">搜索作品或前往页面</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            className="h-9 pl-8"
            placeholder="搜索作品，或输入页面名称"
            aria-label="快捷搜索"
            aria-controls={listId}
            aria-activedescendant={rows[activeIndex] ? `${listId}-${activeIndex}` : undefined}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false);
              setQuery(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
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
        </div>

        <ul id={listId} role="listbox" aria-label="搜索结果" className="flex max-h-[46vh] flex-col gap-0.5 overflow-y-auto">
          {rows.length === 0 ? (
            <li className="px-2 py-6 text-center text-[13px] text-muted-foreground">
              {trimmedQuery.length === 0
                ? '输入标题、别名、标签或制作公司开始搜索'
                : remotePending
                  ? `正在检索「${trimmedQuery}」…`
                  : `没有匹配「${trimmedQuery}」的结果`}
            </li>
          ) : (
            rows.map((row, index) => (
              <li key={row.key}>
                <button
                  type="button"
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-[13.5px]',
                    index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => activate(row)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{row.label}</span>
                    <span className="truncate text-[12px] text-muted-foreground">{row.hint}</span>
                  </span>
                  {row.kind === 'nav' ? <CornerDownLeft className="size-3.5 opacity-60" aria-hidden="true" /> : null}
                </button>
              </li>
            ))
          )}
        </ul>

        <p className="text-[11.5px] text-muted-foreground">
          ↑ ↓ 选择 · Enter 打开 · Esc 关闭
          {canRemoteSearch ? ' · 检索标题 / 别名 / 标签 / 制作公司' : ' · 检索标题 / 原名 / 类型 / 制作公司'}
        </p>
        {remoteTruncated ? (
          // 后端有界查询：命中多于上限时如实说明，不假装已经全部列出。
          <p className="text-[11.5px] text-muted-foreground" role="status">
            命中过多，仅显示前 {remoteHits.length} 条，请补充关键词缩小范围。
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** 命中原因来自后端返回的 matched_fields，界面据实说明为什么匹配。 */
function remoteHint(hit: LibrarySearchHit): string {
  const fields: Record<string, string> = {
    title: '标题',
    original_title: '原名',
    aliases: '别名',
    tags: '标签',
    studios: '制作公司',
    year: '年份',
  };
  const matched = hit.matchedFields.map((field) => fields[field] ?? field).join('/');
  const extra = hit.aliases.length > 0 ? ` · ${hit.aliases.slice(0, 2).join('、')}` : '';
  return `${matched || '索引命中'}${hit.year ? ` · ${hit.year}` : ''}${extra}`;
}
