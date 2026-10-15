/**
 * 新 Renderer 入口。只做装配：安全标记读取 + 根组件挂载。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

import '@mantine/core/styles.css';
import './styles/tailwind.css';
import './styles/global.css';

import { AppRoot } from './app/AppRoot';
import { readStyleNonce } from './app/csp';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点');
}

createRoot(container).render(
  <React.StrictMode>
    <AppRoot styleNonce={readStyleNonce()} />
  </React.StrictMode>,
);
