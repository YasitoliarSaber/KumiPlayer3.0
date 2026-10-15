#!/usr/bin/env node
/**
 * 抓取真实后端响应夹具（T0-2 / P02）。
 *
 * 后端路由当前没有显式 response_model，因此响应形状必须有真实证据。
 * 本脚本在**临时数据目录**启动源码后端（不是用户正在运行的应用），
 * 用固定会话令牌读取实际响应并落盘到 tests/desktop/fixtures/。
 *
 * 安全边界：不使用项目 data/、不读取凭据、不访问真实媒体、不修改用户配置。
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const fixturesDir = path.join(projectRoot, 'tests', 'desktop', 'fixtures');
const PORT = Number.parseInt(process.env.KUMI_FIXTURE_PORT ?? '37899', 10);
const TOKEN = 'fixture-session-token';
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      const payload = await response.json();
      if (payload && payload.app === 'KumiPlayer') {
        return payload;
      }
    } catch {
      // 继续等待
    }
    await delay(300);
  }
  throw new Error('后端在期限内未就绪');
}

async function capture(name, pathAndQuery, { token = TOKEN } = {}) {
  const headers = token ? { 'X-KumiPlayer-Token': token } : {};
  const response = await fetch(`${BASE}${pathAndQuery}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { __non_json: text.slice(0, 200) };
  }
  const file = path.join(fixturesDir, `${name}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ status: response.status, body: payload }, null, 2)}\n`,
    'utf8',
  );
  console.log(`${name}.json  status=${response.status}`);
  return payload;
}

async function main() {
  fs.mkdirSync(fixturesDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kumi-dto-fixtures-'));
  const backendDir = path.join(projectRoot, 'backend');

  const backend = spawn('python', ['desktop_backend.py'], {
    cwd: backendDir,
    env: {
      ...process.env,
      KUMIPLAYER_HOST: HOST,
      KUMIPLAYER_PORT: String(PORT),
      KUMIPLAYER_DATA_DIR: dataDir,
      KUMIPLAYER_RUNTIME_KIND: 'source',
      KUMIPLAYER_RUNTIME_ID: 'fixture-runtime',
      KUMIPLAYER_INSTANCE_ID: 'fixture-instance',
      KUMIPLAYER_API_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  backend.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    const health = await waitForHealth(30000);
    fs.writeFileSync(
      path.join(fixturesDir, 'health.json'),
      `${JSON.stringify({ status: 200, body: health }, null, 2)}\n`,
      'utf8',
    );
    console.log('health.json  status=200');

    await capture('config', '/api/config');
    await capture('library', '/api/library');
    await capture('library-changes', '/api/library/changes?after=0&limit=128');
    await capture('library-cards', '/api/library/cards?work_ids=fixture-missing');
    await capture('tasks', '/api/tasks?limit=20');
    await capture('playback-status', '/api/playback/status');
    // 错误包络：未鉴权与未发布详情。
    await capture('error-unauthorized', '/api/config', { token: '' });
    await capture('error-not-found', '/api/library/works/fixture-missing');
  } finally {
    try {
      await fetch(`${BASE}/api/system/shutdown`, {
        method: 'POST',
        headers: { 'X-KumiPlayer-Token': TOKEN },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // 后端可能已经退出
    }
    const deadline = Date.now() + 8000;
    while (backend.exitCode === null && Date.now() < deadline) {
      await delay(100);
    }
    if (backend.exitCode === null) {
      backend.kill();
    }
    if (stderr.trim().length > 0) {
      console.log(`--- 后端 stderr ---\n${stderr.trim().slice(0, 2000)}`);
    }
    // 临时数据目录只包含合成空库；不触碰项目 data/。
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
