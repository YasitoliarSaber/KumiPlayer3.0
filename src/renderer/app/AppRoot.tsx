/**
 * 根装配：Provider 顺序固定为 Mantine → Query → 恢复边界 → Router。
 * 这里不定义页面结构、导航或配色；页面由后续设计 Skill 提供。
 */

import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router';

import { ServiceProvider } from '../shared/api/service-context';
import { useDemoState } from '../mock/demo-store';
import { useDesktopStatusSubscription } from '../shared/hooks/use-desktop-bridge';
import { createAppQueryClient } from './queryClient';
import { RecoveryBoundary } from './recovery-boundary';
import { appRouter } from './router';
import { applyThemeToDocument, colorSchemeFor, createAppTheme, kumiCssVariablesResolver } from './theme';

export function AppRoot({ styleNonce }: { readonly styleNonce?: string }) {
  const [queryClient] = useState(createAppQueryClient);
  useDesktopStatusSubscription();
  const themeName = useDemoState().settings.appearance.theme;

  useEffect(() => {
    applyThemeToDocument(themeName);
  }, [themeName]);

  return (
    <MantineProvider
      theme={createAppTheme(themeName)}
      forceColorScheme={colorSchemeFor(themeName)}
      cssVariablesResolver={kumiCssVariablesResolver}
      {...(styleNonce ? { getStyleNonce: () => styleNonce } : {})}
    >
      <QueryClientProvider client={queryClient}>
        <ServiceProvider>
          <RecoveryBoundary>
            <RouterProvider router={appRouter} />
          </RecoveryBoundary>
        </ServiceProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
