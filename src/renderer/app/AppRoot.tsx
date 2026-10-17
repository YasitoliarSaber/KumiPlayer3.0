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
import { applyMaterialToDocument, applyThemeToDocument, resolveTheme } from './theme';
import { AppearanceController } from './appearance-controller';
import { PlaybackRefresh } from '@/features/playback/PlaybackRefresh';

export function AppRoot() {
  const [queryClient] = useState(createAppQueryClient);
  const { theme: preference, motion, material } = useDemoState().settings.appearance;

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  useEffect(() => {
    applyMaterialToDocument(material);
  }, [material]);

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
      <AppearanceController />
      <ServiceProvider>
        <PlaybackRefresh />
        <RecoveryBoundary>
          <RouterProvider router={appRouter} />
        </RecoveryBoundary>
      </ServiceProvider>
    </QueryClientProvider>
  );
}
