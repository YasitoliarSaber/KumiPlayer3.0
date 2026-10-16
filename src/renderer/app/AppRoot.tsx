/**
 * 根装配：Query → 服务注入 → 恢复边界 → Router。
 * 不再有组件库 Provider：主题由 data-theme 与语义变量驱动。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router';

import { useDemoState } from '@/mock/demo-store';
import { ServiceProvider } from '@/shared/api/service-context';
import { createAppQueryClient } from './queryClient';
import { RecoveryBoundary } from './recovery-boundary';
import { appRouter } from './router';
import { applyThemeToDocument, resolveTheme } from './theme';

export function AppRoot() {
  const [queryClient] = useState(createAppQueryClient);
  const { theme: preference, motion } = useDemoState().settings.appearance;

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  useEffect(() => {
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    const sync = () => applyThemeToDocument(resolveTheme(preference, media?.matches ?? false));
    sync();
    media?.addEventListener('change', sync);
    return () => media?.removeEventListener('change', sync);
  }, [preference]);

  return (
    <QueryClientProvider client={queryClient}>
      <ServiceProvider>
        <RecoveryBoundary>
          <RouterProvider router={appRouter} />
        </RecoveryBoundary>
      </ServiceProvider>
    </QueryClientProvider>
  );
}
