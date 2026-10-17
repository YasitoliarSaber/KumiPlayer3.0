/** 双击网页开发入口：复用 Vite 配置和源码后端，不构建桌面应用。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createInterface } = require('node:readline');

const root = path.resolve(__dirname, '../..');
const noOpen = process.argv.includes('--no-open') || process.env.KUMIPLAYER_WEB_DEV_NO_OPEN === '1';
const contextDir = path.join(root, '.context');

function portNumber(value, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error('开发端口必须在 1024–65535 之间。');
  return number;
}

async function jsonAt(url, token = '') {
  // 本机网络过滤或服务冷启动可瞬时重置回环连接；只读探测有界重试，401 不重试。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: token ? { 'X-KumiPlayer-Token': token } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return await response.json();
      await response.arrayBuffer();
      if (response.status !== 502 && response.status !== 503) return null;
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return null;
    }
    await delay(150);
  }
  return null;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function availablePort(start) {
  for (let port = start; port <= Math.min(start + 20, 65535); port += 1) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('没有可用的网页开发端口，请关闭不再使用的开发服务后重试。');
}

function openBrowser(url) {
  if (noOpen) return;
  // 固定回环 URL，通过系统默认浏览器打开，不把用户输入拼入 shell。
  const env = { ...process.env };
  delete env.KUMIPLAYER_API_TOKEN;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], {
    stdio: 'ignore', windowsHide: true, env,
  });
  child.on('error', () => console.error(`浏览器未能自动打开，请打开 ${url}`));
  child.on('exit', (code) => { if (code) console.error(`浏览器未能自动打开，请打开 ${url}`); });
}

async function acquire(lockFile) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, url: '' }), 'utf8');
      fs.closeSync(fd);
      return null;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let state;
    try { state = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { await delay(250); continue; }
    if (!alive(state.pid)) { fs.unlinkSync(lockFile); continue; }
    // 不接收任意文件中的 URL，防止损坏状态打开其他站点。
    if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(state.url)) {
      const health = await jsonAt(`${state.url}api/health`);
      if (health?.app === 'KumiPlayer' && health.instance_id === state.instanceId) return state.url;
    }
    await delay(300);
  }
  throw new Error('另一个网页启动窗口还未就绪。请查看该窗口的提示，不要重复启动后端。');
}

async function main() {
  if (!fs.existsSync(path.join(root, 'node_modules/vite/package.json'))) {
    throw new Error('缺少网页依赖，请先在项目中完成依赖安装；此入口不会自动安装或升级依赖。');
  }
  const backendPort = portNumber(process.env.KUMIPLAYER_PORT, 37821);
  const preferredWebPort = portNumber(process.env.KUMIPLAYER_WEB_DEV_PORT, 5273);
  const backendBase = `http://127.0.0.1:${backendPort}`;
  fs.mkdirSync(contextDir, { recursive: true });
  const lockFile = path.join(contextDir, `web-dev-${backendPort}.json`);
  const existingUrl = await acquire(lockFile);
  if (existingUrl) {
    console.log(`网页开发版已在运行：${existingUrl}`);
    openBrowser(existingUrl);
    return;
  }

  let backend;
  let server;
  let stopping = false;
  let token = process.env.KUMIPLAYER_API_TOKEN?.trim() ?? '';
  let lines;
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  const requestStop = () => { stopping = true; resolveStop(); };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  try {
    let health = await jsonAt(`${backendBase}/api/health`);
    if (health && health.app !== 'KumiPlayer') throw new Error('后端端口被其他服务占用，请关闭冲突服务或更换开发端口。');
    if (health && !await jsonAt(`${backendBase}/api/config`, token)) {
      throw new Error('已有后端的会话不可复用。请先正常关闭已运行的 KumiPlayer，再双击此入口；不会结束现有应用。');
    }
    // 已有可工作的 Vite 可以直接复用；健康检查与配置请求均需通过代理。
    const candidate = `http://127.0.0.1:${preferredWebPort}/`;
    const webHealth = health ? await jsonAt(`${candidate}api/health`) : null;
    let url;
    if (webHealth?.app === 'KumiPlayer' && webHealth.instance_id === health.instance_id
      && await jsonAt(`${candidate}api/config`)) {
      url = candidate;
    } else {
      const webPort = await availablePort(preferredWebPort);
      url = `http://127.0.0.1:${webPort}/`;
      if (!health) {
        if (await availablePort(backendPort) !== backendPort) throw new Error('后端端口已被占用，不会启动第二个后端。');
        token ||= randomBytes(32).toString('hex');
        const python = [path.join(root, 'backend/.venv/Scripts/python.exe'), path.join(root, '.venv/Scripts/python.exe')]
          .find((file) => fs.existsSync(file)) ?? 'python';
        const instanceId = randomUUID();
        const logFile = path.join(contextDir, 'web-dev-backend.log');
        const log = fs.openSync(logFile, 'a');
        console.log('正在启动本机后端……');
        backend = spawn(python, ['desktop_backend.py'], {
          cwd: path.join(root, 'backend'), windowsHide: true,
          env: { ...process.env, PYTHONUTF8: '1', KUMIPLAYER_HOST: '127.0.0.1',
            KUMIPLAYER_PORT: String(backendPort), KUMIPLAYER_API_TOKEN: token,
            KUMIPLAYER_RUNTIME_KIND: 'source', KUMIPLAYER_RUNTIME_ID: root,
            KUMIPLAYER_INSTANCE_ID: instanceId, KUMIPLAYER_PARENT_PID: String(process.pid),
            KUMIPLAYER_DEV_ORIGINS: url.slice(0, -1) },
          stdio: ['ignore', log, log],
        });
        fs.closeSync(log);
        let spawnError;
        backend.on('error', (error) => { spawnError = error; requestStop(); });
        backend.on('exit', () => { if (!stopping) { console.error('本机后端已退出，请查看 .context/web-dev-backend.log。'); process.exitCode = 1; requestStop(); } });
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline && !stopping) {
          health = await jsonAt(`${backendBase}/api/health`);
          if (health?.instance_id === instanceId) break;
          await delay(300);
        }
        if (spawnError || health?.instance_id !== instanceId) throw new Error('后端启动失败，请检查 Python 依赖及 .context/web-dev-backend.log。');
      }
      if (stopping) return;
      // 沿用唯一网页配置；会话只传给本进程与后端，不写入状态文件或 URL。
      process.env.KUMIPLAYER_API_BASE = backendBase;
      process.env.KUMIPLAYER_API_TOKEN = token;
      process.env.KUMIPLAYER_WEB_SAME_ORIGIN = '1';
      delete process.env.VITE_RENDERER_SERVICE;
      const { createServer } = await import('vite');
      server = await createServer({ configFile: path.join(root, 'vite.web.config.ts'),
        mode: 'development', server: { host: '127.0.0.1', port: webPort, strictPort: true, open: false } });
      await server.listen();
    }
    if (stopping) return;
    // 首次配置读取与开发服务初始化可能有短暂延迟，只重试只读就绪探测。
    let connected = false;
    const readyDeadline = Date.now() + 15000;
    while (!stopping && Date.now() < readyDeadline) {
      if (await jsonAt(`${url}api/config`)) { connected = true; break; }
      await delay(300);
    }
    if (!connected) throw new Error('网页服务已启动，但没有接通本机后端。请检查原启动窗口的会话配置。');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, url, instanceId: health.instance_id }), 'utf8');
    console.log(`网页开发版已就绪：${url}`);
    console.log('已连接真实媒体库。保持此窗口运行；停止时按 Ctrl+C，或输入 q 后回车。');
    openBrowser(url);
    lines = createInterface({ input: process.stdin });
    lines.on('line', (line) => { if (line.trim().toLowerCase() === 'q') requestStop(); });
    await stopped;
  } finally {
    stopping = true;
    lines?.close();
    await server?.close();
    // 只关闭本入口创建的后端，复用的用户应用不受影响。
    if (backend && backend.exitCode === null && backend.pid) {
      try { await fetch(`${backendBase}/api/system/shutdown`, { method: 'POST',
        headers: { 'X-KumiPlayer-Token': token }, signal: AbortSignal.timeout(3000) }); } catch { /* 可能已退出 */ }
      const deadline = Date.now() + 10000;
      while (backend.exitCode === null && Date.now() < deadline) await delay(100);
      if (backend.exitCode === null) backend.kill();
    }
    try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
  }
}

if (require.main === module) {
  // Windows cmd 管道可能继续持有标准输入；清理完成后明确结束本启动器。
  main().then(() => process.exit(process.exitCode ?? 0), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
module.exports = { portNumber, jsonAt, availablePort };
