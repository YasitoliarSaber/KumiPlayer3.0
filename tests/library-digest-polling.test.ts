import test from 'node:assert/strict';
import { test as check } from 'node:test';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/stores/library.ts', import.meta.url), 'utf8');

check('全局刷新桥只请求变化游标，图片事件不触发全库强刷', () => {
  test.match(app, /await syncChanges\(\)/);
  test.doesNotMatch(app, /getDiagnostics\(\)/);
  test.doesNotMatch(app, /loadLibrary\(\{ force: true \}\)/);
});
check('增量失败保留游标，过期变化才回退明确全同步', () => {
  test.match(store, /libraryApi\.getChanges\(cursor\)/);
  test.match(store, /page\.reset_required/);
  test.match(store, /changeSequence: cursor/);
  test.match(store, /catch \{ return false \}/);
});
