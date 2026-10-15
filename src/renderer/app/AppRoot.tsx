/**
 * 根装配：Provider 顺序固定为 Mantine → Query → 恢复边界 → Router。
 * 这里不定义页面结构、导航或配色；页面由后续设计 Skill 提供。
 */

import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';

import { useDesktopStatusSubscription } from '../shared/hooks/use-desktop-bridge';
import { createAppQueryClient } from './queryClient';
import { RecoveryBoundary } from './recovery-boundary';
import { appRouter } from './router';

export function AppRoot({ styleNonce }: { readonly styleNonce?: string }) {
  const [queryClient] = useState(createAppQueryClient);
  useDesktopStatusSubscription();

  return (
    <MantineProvider
      defaultColorScheme="auto"
      {...(styleNonce ? { getStyleNonce: () => styleNonce } : {})}
    >
      <QueryClientProvider client={queryClient}>
        <RecoveryBoundary>
          <RouterProvider router={appRouter} />
        </RecoveryBoundary>
      </QueryClientProvider>
    </MantineProvider>
  );
}
