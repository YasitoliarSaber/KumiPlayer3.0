/**
 * 新 Renderer 入口。只做装配：安全标记读取 + 根组件挂载。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

// 详情 / 媒体管理 / 设置仍在迁移中，暂时保留 Mantine 样式表；
// 这三个页面迁出 Mantine 后与 @mantine 依赖一并移除。
import '@mantine/core/styles.css';
import './styles/tailwind.css';
import './styles/global.css';

import { AppRoot } from './app/AppRoot';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点');
}

createRoot(container).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
