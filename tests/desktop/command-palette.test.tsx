/**
 * 快捷搜索的真实后端分支：命中只来自作品搜索索引，结果行必须
 * 复用已加载作品卡片的海报与标题，不把页面导航混入列表。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { createMockMediaService } from '../../src/renderer/mock/service';
import type { MediaService } from '../../src/renderer/shared/api/service';
import { ServiceProvider } from '../../src/renderer/shared/api/service-context';
import { CommandPalette } from '../../src/renderer/shell/CommandPalette';

const catalog = buildMockCatalog();
const base = createMockMediaService({ latencyMs: 0, catalog });
const works = catalog.works.filter((item) => item.artwork.poster).slice(0, 2);
const work = works[0]!;
const titlePattern = new RegExp(work.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const service: MediaService = {
  ...base,
  searchLibrary: async () => ({
    hits: [
      {
        workId: work.id,
        title: work.title,
        originalTitle: work.originalTitle,
        year: work.year,
        mediaType: work.mediaType,
        matchedFields: ['aliases'],
        aliases: [],
        tags: [],
        studios: [],
      },
    ],
    truncated: false,
  }),
};

function renderPalette(onOpenWork = vi.fn()) {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ServiceProvider service={service}>
        <MemoryRouter>
          <CommandPalette open onOpenChange={() => undefined} works={works} onOpenWork={onOpenWork} />
        </MemoryRouter>
      </ServiceProvider>
    </QueryClientProvider>,
  );
  return onOpenWork;
}

describe('快捷搜索面板', () => {
  it('空查询展示最近作品，结果带海报且不混入页面导航', async () => {
    renderPalette();

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(works.length);
    expect(screen.getByText(`作品 · ${works.length} 项`)).toBeTruthy();
    for (const option of options) {
      expect(option.querySelector('img')).not.toBeNull();
    }
    expect(screen.queryByRole('option', { name: /^首页/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /^设置/ })).toBeNull();
  });

  it('后端命中复用作品卡片海报，作品名可见且 Enter 可打开', async () => {
    const onOpenWork = renderPalette();
    const input = screen.getByRole('textbox', { name: '快捷搜索' });
    fireEvent.change(input, {
      target: { value: work.title.slice(0, 2) },
    });

    const option = await screen.findByRole('option', { name: titlePattern });
    expect(within(option).getByText(work.title)).toBeTruthy();
    expect(option.querySelector('img')).not.toBeNull();
    expect(option.querySelector('img')?.getAttribute('src')).toBe(work.artwork.poster?.url);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpenWork).toHaveBeenCalledWith(work.id);
  });
});
