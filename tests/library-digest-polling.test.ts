import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/stores/library.ts', import.meta.url), 'utf8');

test('全库变化检查只用轻量 digest 端点，不再每五秒传输完整投影载荷', () => {
  // 轮询只关心 digest；完整 cards 载荷由真正的 loadLibrary 拉取。
  assert.match(app, /await libraryApi\.getDiagnostics\(\)/);
  assert.doesNotMatch(app, /mediaV4Api\.library\(\)/);
  assert.doesNotMatch(app, /from '\.\/api\/mediaV4'/);
});

test('只有刷新成功才确认 digest，失败保留旧库并可重试', () => {
  // 先刷新、后确认：不允许在发起刷新前就写入 lastDigest。
  assert.match(app, /const refreshed = await loadLibrary\(\{ force: true \}\)/);
  assert.match(app, /if \(!disposed && refreshed\) lastDigest = digest/);
  assert.doesNotMatch(app, /lastDigest = [^;]+;\s*void loadLibrary/);
});

test('loadLibrary 向调用方报告刷新是否成功', () => {
  assert.match(store, /loadLibrary: \(options\?: \{ force\?: boolean \}\) => Promise<boolean>/);
  assert.match(store, /return requestId === libraryLoadRequest/);
});
