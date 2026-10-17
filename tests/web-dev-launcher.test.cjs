'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { portNumber, availablePort } = require('../scripts/desktop/start-web-dev.cjs');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/desktop/start-web-dev.cjs');

function requestOnce(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (data) => { body += data; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
  });
}

// 当前测试机的纯 Node 回环服务器也会偶发 ECONNRESET，独立于 Vite/后端；
// 重试连接错误及代理 502，不重试鉴权错误或应用响应，仍核对实际状态和内容。
async function get(url) {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await requestOnce(url);
      if (response.status !== 502) return response;
      last = new Error('proxy 502');
    } catch (error) { last = error; }
    await delay(100);
  }
  throw last;
}

function launch(env, wrapper = false) {
  const command = wrapper ? process.env.ComSpec ?? 'cmd.exe' : process.execPath;
  const args = wrapper ? ['/d', '/c', path.join(root, '启动网页开发版.cmd')] : [script, '--no-open'];
  const child = spawn(command, args, { cwd: root, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString('utf8'); });
  child.stderr.on('data', (data) => { output += data.toString('utf8'); });
  const finished = once(child, 'exit');
  return { child, finished, output: () => output };
}

test('Windows 入口保持 UTF-8、CRLF 与编码初始化', () => {
  const bytes = fs.readFileSync(path.join(root, '启动网页开发版.cmd'));
  assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(text.startsWith('@echo off\r\nchcp 65001 >nul\r\n'));
  assert.ok(!text.replaceAll('\r\n', '').includes('\n'));
  assert.equal(portNumber(undefined, 5273), 5273);
  assert.throws(() => portNumber('0', 5273));
});

test('真实源码后端隔离启动、同源鉴权、重复启动与退出回收', { timeout: 90000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kumi-web-launcher-'));
  const backendPort = await availablePort(37990);
  const webPort = await availablePort(5290);
  const env = { ...process.env, KUMIPLAYER_DATA_DIR: dataDir, KUMIPLAYER_PORT: String(backendPort),
    KUMIPLAYER_WEB_DEV_PORT: String(webPort), KUMIPLAYER_WEB_DEV_NO_OPEN: '1' };
  delete env.KUMIPLAYER_API_TOKEN;
  const first = launch(env, true);
  try {
    const deadline = Date.now() + 60000;
    while (!first.output().includes('网页开发版已就绪') && first.child.exitCode === null && Date.now() < deadline) await delay(200);
    assert.ok(first.output().includes('网页开发版已就绪'), `隔离启动应在期限内就绪：${first.output()}`);
    const base = `http://127.0.0.1:${webPort}`;
    const unauthorized = await get(`http://127.0.0.1:${backendPort}/api/config`);
    assert.equal(unauthorized.status, 401);
    const statuses = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const response = await get(`${base}/api/config`);
        statuses.push(response.status);
      }
    } catch (error) { throw new Error(`${statuses.join(',')} / ${error.cause?.code}: ${first.output()}`); }
    assert.deepEqual(statuses, Array(10).fill(200), first.output());
    const html = (await get(base)).body;
    assert.match(html, /"apiBase":""/);
    const stateFile = path.join(root, '.context', `web-dev-${backendPort}.json`);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(Object.keys(state).sort(), ['instanceId', 'pid', 'url']);
    const second = launch(env);
    assert.equal((await second.finished)[0], 0);
    assert.match(second.output(), /网页开发版已在运行/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid, state.pid);
    first.child.stdin.write('q\n');
    assert.equal((await first.finished)[0], 0);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(await availablePort(backendPort), backendPort);
    assert.equal(await availablePort(webPort), webPort);
  } finally {
    if (first.child.exitCode === null) { first.child.stdin.write('q\n'); await first.finished; }
    // 仅清理由本用例创建的系统临时目录，路径从 mkdtemp 返回。
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('kumi-web-launcher-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('拒绝占用后端端口的其他服务并保留它', { timeout: 10000 }, async () => {
  const port = await availablePort(37990);
  const blocker = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ app: 'OtherService' }));
  });
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  try {
    const run = launch({ ...process.env, KUMIPLAYER_PORT: String(port) });
    assert.equal((await run.finished)[0], 1);
    assert.match(run.output(), /其他服务占用/);
    assert.equal((await get(`http://127.0.0.1:${port}/api/health`)).status, 200);
  } finally { await new Promise((resolve) => blocker.close(resolve)); }
});
