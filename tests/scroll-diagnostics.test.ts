import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clearScrollDiagnostics,
  disableScrollDiagnostics,
  dumpScrollDiagnostics,
  enableScrollDiagnostics,
  isScrollDiagnosticsEnabled,
  recordScrollDiagnostic,
} from '../src/utils/scrollDiagnostics.ts';

const BUFFER_LIMIT = 4000;

test('诊断采样默认关闭，未开启时不记录任何事件', () => {
  disableScrollDiagnostics({ persist: false });
  clearScrollDiagnostics();
  assert.equal(isScrollDiagnosticsEnabled(), false);
  recordScrollDiagnostic('scroll', { scrollTop: 100 });
  assert.equal(dumpScrollDiagnostics().eventCount, 0);
});

test('开启后记录归一化事件并汇总丢帧与长任务', () => {
  enableScrollDiagnostics({ persist: false });
  clearScrollDiagnostics();
  recordScrollDiagnostic('scroll', { scrollTop: 120, scrollEvents: 3, wheelEvents: 2 });
  recordScrollDiagnostic('frame-gap', { ms: 120 });
  recordScrollDiagnostic('frame-gap', { ms: 48 });
  recordScrollDiagnostic('long-task', { ms: 260 });
  const dump = dumpScrollDiagnostics();
  assert.equal(dump.enabled, true);
  assert.equal(dump.eventCount, 4);
  assert.deepEqual(dump.counts, { scroll: 1, 'frame-gap': 2, 'long-task': 1 });
  assert.equal(dump.worstFrameGapMs, 120);
  assert.equal(dump.slowFrameCount, 2);
  assert.equal(dump.longTaskCount, 1);
  assert.equal(dump.worstLongTaskMs, 260);
  assert.equal(dump.recordCalls, 4);
  disableScrollDiagnostics({ persist: false });
});

test('环形缓冲有上限，覆盖最旧事件且不无限增长', () => {
  enableScrollDiagnostics({ persist: false });
  clearScrollDiagnostics();
  for (let index = 0; index < BUFFER_LIMIT + 50; index += 1) {
    recordScrollDiagnostic('scroll', { scrollTop: index });
  }
  const dump = dumpScrollDiagnostics();
  assert.equal(dump.bufferLimit, BUFFER_LIMIT);
  assert.equal(dump.eventCount, BUFFER_LIMIT);
  assert.equal(dump.overwritten, 50);
  // 保留最近窗口：首条是被覆盖后的第 51 次写入，末条是最后一次写入。
  assert.equal(dump.events[0]?.data?.scrollTop, 50);
  assert.equal(dump.events[BUFFER_LIMIT - 1]?.data?.scrollTop, BUFFER_LIMIT + 49);
  disableScrollDiagnostics({ persist: false });
});

test('事件只携带归一化数值，不含 URL、路径或令牌', () => {
  enableScrollDiagnostics({ persist: false });
  clearScrollDiagnostics();
  recordScrollDiagnostic('wheel', { deltaY: -240, scrollTop: 800 });
  const [event] = dumpScrollDiagnostics().events;
  assert.deepEqual(Object.keys(event).sort(), ['data', 'kind', 't']);
  for (const value of Object.values(event.data ?? {})) {
    assert.ok(typeof value === 'number' || typeof value === 'boolean');
  }
  assert.doesNotMatch(JSON.stringify(event), /https?:\/|token|bearer|\.mkv|\.mp4/i);
  disableScrollDiagnostics({ persist: false });
});

test('关闭后不再记录，dump 仍可读取关闭前的缓冲', () => {
  enableScrollDiagnostics({ persist: false });
  clearScrollDiagnostics();
  recordScrollDiagnostic('scroll', { scrollTop: 1 });
  disableScrollDiagnostics({ persist: false });
  recordScrollDiagnostic('scroll', { scrollTop: 2 });
  const dump = dumpScrollDiagnostics();
  assert.equal(dump.enabled, false);
  assert.equal(dump.eventCount, 1);
});

test('关键链路埋点避开 React 状态，只在开启后挂滚动监听', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const shell = read('../src/components/shell/AppShell.tsx');
  const app = read('../src/App.tsx');
  const store = read('../src/stores/library.ts');
  const posterCard = read('../src/components/library/PosterCard.tsx');
  const lifecycle = read('../src/components/library/posterImageLifecycle.ts');

  // 采样器默认关闭：滚动监听必须先判断开关再挂载，并使用被动监听。
  assert.match(shell, /if \(!isScrollDiagnosticsEnabled\(\)\) return undefined;/);
  assert.match(shell, /addEventListener\('scroll', onScroll, \{ passive: true \}\)/);
  // 采样不进入 React 更新队列。
  assert.doesNotMatch(shell, /recordScrollDiagnostic[\s\S]{0,200}setState\(/);
  // 主链路埋点：投影检测、作品/历史应用与缓存写入、详情预热、图片 src 生命周期。
  assert.match(app, /recordScrollDiagnostic\('library-check'/);
  assert.match(store, /recordScrollDiagnostic\('works-applied'/);
  assert.match(store, /recordScrollDiagnostic\('library-cache-write'/);
  assert.match(posterCard, /recordScrollDiagnostic\('detail-prewarm-start'/);
  assert.match(lifecycle, /recordScrollDiagnostic\('image-src-set'/);
  assert.match(lifecycle, /recordScrollDiagnostic\('image-src-cleared'/);
});
