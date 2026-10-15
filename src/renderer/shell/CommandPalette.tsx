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

import type { WorkSummary } from '@/shared/api/service';
import { searchNav, searchWorks } from '@/shared/api/search';
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
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // 面板由快捷键唤起，没有触发元素；关闭时把焦点还给打开前的元素。
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const listId = useId();

  // 查询标记：切换查询时重置高亮；同步搜索也按同一规则丢弃旧结果。
  const rows = useMemo<readonly Row[]>(() => {
    const hits = searchWorks(works, query).map<Row>((hit) => ({
      kind: 'work',
      key: `work-${hit.work.id}`,
      label: hit.work.title,
      hint: `${hit.reason} · ${hit.work.year || '年份未知'}`,
      workId: hit.work.id,
    }));
    const nav = searchNav(query).map<Row>((item) => ({
      kind: 'nav',
      key: `nav-${item.to}`,
      label: item.label,
      hint: '前往',
      to: item.to,
    }));
    return [...hits, ...nav];
  }, [query, works]);

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
              {query.trim().length === 0 ? '输入作品名或页面名开始搜索' : `没有匹配「${query.trim()}」的结果`}
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

        <p className="text-[11.5px] text-muted-foreground">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p>
      </DialogContent>
    </Dialog>
  );
}
