/**
 * 客户端 Hash 路由（ADR-06）。
 *
 * 无 URL Router 只服务本地桌面文档；这里使用 Data Mode 组合与懒加载，
 * 不引入 SSR，也不把 Loader 当作第二份服务端状态仓库。
 */

import { lazy } from 'react';
import { createHashRouter, Navigate } from 'react-router';

const SessionPage = lazy(async () => {
  const module = await import('../features/session/SessionPage');
  return { default: module.SessionPage };
});

const ControlsFixturePage = lazy(async () => {
  const module = await import('../features/dev/ControlsFixturePage');
  return { default: module.ControlsFixturePage };
});

export const appRouter = createHashRouter([
  {
    path: '/',
    element: <SessionPage />,
  },
  {
    // 组件库验证夹具：中性控件，不承担任何产品页面职责。
    path: '/dev/controls',
    element: <ControlsFixturePage />,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
]);
