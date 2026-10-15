/**
 * 客户端 Hash 路由。
 *
 * 页面按业务域懒加载（详情、设置、媒体管理、任务中心），
 * 首页/媒体库/最近观看保持即时可用；公共框架由布局路由统一承载。
 */

import { lazy, Suspense, type ReactNode } from 'react';
import { createHashRouter, Navigate, Outlet } from 'react-router';

import { HomePage } from '../features/home/HomePage';
import { PosterWallPage } from '../features/library/PosterWallPage';
import { RecentPage } from '../features/recent/RecentPage';
import { PlaybackOverlay } from '../features/playback/PlaybackOverlay';
import { AppShell } from '../shell/AppShell';
import { LoadingSurface } from '../shared/ui/Surface';

const WorkDetailPage = lazy(async () => {
  const module = await import('../features/work/WorkDetailPage');
  return { default: module.WorkDetailPage };
});
const MediaManagementPage = lazy(async () => {
  const module = await import('../features/manage/MediaManagementPage');
  return { default: module.MediaManagementPage };
});
const TaskCenter = lazy(async () => {
  const module = await import('../features/tasks/TaskCenter');
  return { default: module.TaskCenter };
});
const SettingsPage = lazy(async () => {
  const module = await import('../features/settings/SettingsPage');
  return { default: module.SettingsPage };
});
const ControlsFixturePage = lazy(async () => {
  const module = await import('../features/dev/ControlsFixturePage');
  return { default: module.ControlsFixturePage };
});
const SessionPage = lazy(async () => {
  const module = await import('../features/session/SessionPage');
  return { default: module.SessionPage };
});

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<LoadingSurface label="正在打开页面" />}>{node}</Suspense>;
}

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
      <PlaybackOverlay />
    </AppShell>
  );
}

export const appRouter = createHashRouter([
  {
    element: <ShellLayout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/library/:view', element: <PosterWallPage mode={{ kind: 'view' }} /> },
      { path: '/favorites', element: <PosterWallPage mode={{ kind: 'favorites' }} /> },
      { path: '/recent', element: <RecentPage /> },
      { path: '/search', element: <PosterWallPage mode={{ kind: 'search' }} /> },
      { path: '/work/:workId', element: withSuspense(<WorkDetailPage />) },
      { path: '/manage', element: withSuspense(<MediaManagementPage />) },
      { path: '/tasks', element: withSuspense(<TaskCenter />) },
      { path: '/settings', element: withSuspense(<SettingsPage />) },
      // 开发入口：组件库夹具与真实桌面链路自检页。
      { path: '/dev/controls', element: withSuspense(<ControlsFixturePage />) },
      { path: '/dev/session', element: withSuspense(<SessionPage />) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
