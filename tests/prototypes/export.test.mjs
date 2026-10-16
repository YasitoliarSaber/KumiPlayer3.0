import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { clean, parse, safeJson, worksForPage } from '../../scripts/prototypes/html.mjs';
import { pages } from '../../scripts/prototypes/pages.mjs';

const output = path.resolve(process.env.KUMI_PROTOTYPE_OUTPUT ?? 'output/OpenDesign-HTML-2026-10-16');
const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
const load = async (key, execute = false) => {
  const page = pages.find((item) => item.key === key);
  let html = await fs.readFile(path.join(output, page.file), 'utf8');
  // 此处测试行为，不让 jsdom 解析不支持的 Tailwind 4 CSS 语法。
  html = html.replace(/<style>[\s\S]*?<\/style>/, '');
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(html, { runScripts: execute ? 'dangerously' : undefined, url: `http://localhost/${encodeURIComponent(page.file)}`, virtualConsole: console,
    beforeParse(window) { window.matchMedia = () => ({ matches: false }); } });
  return { dom, document: dom.window.document, errors };
};
const click = (document, label, root = document) => {
  const node = [...root.querySelectorAll('button,[role="option"],[role^="menuitem"]')].find((item) => (item.getAttribute('aria-label') || item.textContent).replace(/\s+/g, ' ').trim() === label);
  assert.ok(node, `找不到 ${label}`); node.click(); return node;
};

test('导出覆盖 34 个入口，文件摘要、内部链接和离线资源完整', async () => {
  assert.equal(manifest.pages.length, 34);
  const names = new Set(['index.html', ...pages.map((page) => page.file)]);
  for (const page of manifest.pages) {
    const html = await fs.readFile(path.join(output, page.file), 'utf8');
    assert.equal(createHash('sha256').update(html).digest('hex'), page.sha256, page.key);
    const document = parse(html);
    assert.ok(document.querySelector('main'), page.key);
    assert.equal(document.querySelectorAll('script[src],link[href],iframe').length, 0);
    const data = JSON.parse(document.getElementById('prototype-assets').textContent);
    const fragments = [document, ...[...document.querySelectorAll('template')].map((node) => node.content)];
    for (const fragment of fragments) {
      for (const node of fragment.querySelectorAll('[href],[data-proto-href]')) {
        const target = node.getAttribute('href') ?? node.dataset.protoHref;
        assert.ok(names.has(target.split('?')[0]), `${page.key}: ${target}`);
      }
      for (const image of fragment.querySelectorAll('img')) {
        assert.ok(image.dataset.prototypeArtwork && data[image.dataset.prototypeArtwork], `${page.key}: 缺图片`);
        assert.match(data[image.dataset.prototypeArtwork], /^data:image\/(jpeg|png|webp);base64,/);
      }
      for (const input of fragment.querySelectorAll('input[type="password"]')) assert.equal(input.getAttribute('value') ?? '', '');
    }
    assert.ok(!html.includes('127.0.0.1:5274') && !html.includes('D:\\KumiPlayer2.0'));
    assert.match(html, /connect-src 'none'/);
    assert.equal(document.getElementById('root').hasAttribute('aria-hidden'), false);
  }
});

test('导出后的海报墙没有虚拟空洞，保留预期分类和空态', async () => {
  for (const [key, count] of [['library', 206], ['movies', 34], ['seasonal', 92], ['search', 240]]) {
    const { dom, document } = await load(key);
    assert.equal(document.querySelectorAll('[data-work-id]').length, count, key);
    assert.equal(document.querySelectorAll('[data-virtual-rows]').length, 0);
    dom.window.close();
  }
  const { dom, document } = await load('tasks');
  assert.match(document.querySelector('main').textContent, /还没有任务/);
  dom.window.close();
});

test('菜单排序与来源筛选实际改变卡片顺序和集合', async () => {
  const { dom, document, errors } = await load('library', true);
  click(document, '排序方式'); click(document, '评分');
  const ratings = [...document.querySelectorAll('[data-work-id]')].map((node) => Number(node.dataset.workRating));
  assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a));
  const source = document.querySelector('button[aria-label^="来源筛选"]'); source.click(); click(document, '本地');
  assert.ok(document.querySelectorAll('[data-work-id]').length < 206);
  assert.ok([...document.querySelectorAll('[data-work-id]')].every((node) => node.dataset.workSources.split(',').includes('local')));
  assert.equal(errors.length, 0); dom.window.close();
});

test('详情的季集、收藏、编辑弹窗及键盘关闭可操作', async () => {
  const { dom, document, errors } = await load('detail', true);
  const first = document.querySelector('[aria-label="季集与版本"] > ul').textContent;
  click(document, '第 2 季');
  assert.notEqual(document.querySelector('[aria-label="季集与版本"] > ul').textContent, first);
  assert.match(document.querySelector('[aria-label="季集与版本"] > ul').textContent, /^S02E01/);
  click(document, '第 1 季'); assert.equal(document.querySelector('[aria-label="季集与版本"] > ul').textContent, first);
  const favorite = click(document, '收藏'); assert.equal(favorite.textContent, '已收藏');
  click(document, '更多'); click(document, '编辑标题');
  const dialog = document.querySelector('[data-proto-layer] [role="dialog"]'); assert.ok(dialog);
  dialog.querySelector('input').value = '原型新标题'; click(document, '保存', dialog);
  assert.equal(document.querySelector('main h1').textContent, '原型新标题');
  click(document, '更多'); click(document, '编辑标题');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('[data-proto-layer]'), null);
  assert.equal(document.getElementById('root').hasAttribute('inert'), false);
  assert.equal(errors.length, 0); dom.window.close();
});

test('快捷搜索和播放浮层具有独立的原型交互', async () => {
  const { dom, document, errors } = await load('detail', true);
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  const dialog = document.querySelector('[data-proto-layer="dialog-search"]');
  assert.ok(dialog);
  assert.equal(dialog.querySelectorAll('button[data-proto-href]').length, 7);
  const input = dialog.querySelector('input'); input.value = 'Hyouka'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dialog.querySelectorAll('button[data-proto-href]:not([hidden])').length, 1);
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  click(document, '继续观看'); assert.ok(document.querySelector('[aria-label="演示播放"]'));
  click(document, '暂停'); assert.ok([...document.querySelectorAll('button')].some((node) => node.textContent === '继续'));
  click(document, '停止'); assert.equal(document.querySelector('[aria-label="演示播放"]'), null);
  assert.equal(errors.length, 0); dom.window.close();
});

test('主题、开关、审核阻断与引导四步真实切换', async () => {
  let result = await load('settings-appearance', true);
  click(result.document, '主题'); click(result.document, '深色');
  assert.equal(result.document.documentElement.dataset.theme, 'cinema'); result.dom.window.close();
  result = await load('settings-application', true);
  const toggle = result.document.querySelector('[role="switch"]');
  const checked = toggle.getAttribute('aria-checked'); toggle.click(); assert.notEqual(toggle.getAttribute('aria-checked'), checked); result.dom.window.close();
  result = await load('import-2', true);
  const confirm = [...result.document.querySelectorAll('button')].find((node) => node.textContent === '确认并执行');
  assert.equal(confirm.disabled, true);
  click(result.document, '无法确定作品身份处理方式'); click(result.document, '保留为本地作品');
  assert.equal(confirm.disabled, true);
  click(result.document, '播放路径不可达处理方式'); click(result.document, '使用在线扫描结果');
  assert.equal(confirm.disabled, false); result.dom.window.close();
  result = await load('setup', true);
  for (let index = 0; index < 3; index++) click(result.document, '下一步');
  assert.match(result.document.querySelector('[data-proto-layer]').textContent, /资料账号（可选）/);
  click(result.document, '完成设置'); assert.equal(result.document.querySelector('[data-proto-layer]'), null);
  assert.equal(result.errors.length, 0); result.dom.window.close();
});

test('清洗拒绝执行入口，JSON 不会提前结束 script', () => {
  const document = clean(parse('<div id="root" aria-hidden="true"><main><script>bad()</script><img src="https://example.com/a" onerror="bad()"><input type="password" value="private"><a href="javascript:bad()">link</a></main></div>'));
  assert.equal(document.querySelector('script'), null);
  assert.equal(document.querySelector('img').hasAttribute('onerror'), false);
  assert.equal(document.querySelector('img').hasAttribute('src'), false);
  assert.equal(document.querySelector('input').getAttribute('value'), '');
  assert.ok(!safeJson({ value: '</script>' }).includes('</script>'));
  assert.deepEqual(worksForPage({ works: [{ showType: 'anime_series', watch: { status: 'on_hold' } }] }, 'seasonal').length, 1);
});
