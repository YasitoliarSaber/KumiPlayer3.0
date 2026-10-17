/**
 * 新 Renderer 入口。只做装配：安全标记读取 + 根组件挂载。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tailwind.css';
import '@fontsource-variable/manrope';

import { AppRoot } from './app/AppRoot';
import { resolveAppConfig } from './transport/api-config';
import { setApiSessionToken } from './transport/session';

if (import.meta.env.DEV && new URLSearchParams(location.search).get('profile') === '1') {
  void import('./features/dev/scroll-profile').then(({ installScrollProfile }) => installScrollProfile());
}

// 开发期由本机开发服务器注入的同源/直连配置与短期会话令牌：只写入内存，
// 之后所有请求都带上它；没有注入时保持空串（同源代理或后端自身托管场景）。
const runtimeConfig = resolveAppConfig();
if (runtimeConfig.apiToken) {
  setApiSessionToken(runtimeConfig.apiToken);
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点');
}

createRoot(container).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
