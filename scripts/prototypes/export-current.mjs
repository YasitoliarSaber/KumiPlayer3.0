import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import ts from 'typescript';
import { pages, templateKeys } from './pages.mjs';
import { annotate, clean, detailKey, escapeHtml, expandWall, parse, portalTemplate, prototypeCss, restoreInputs, safeJson, worksForPage } from './html.mjs';
import { designBrief, usage } from './brief.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const snapshotsPath = path.resolve(root, process.argv[2] ?? '.context/prototype-export-2026-10-16');
const output = path.resolve(root, process.argv[3] ?? 'output/OpenDesign-HTML-2026-10-16');
if (!output.startsWith(root + path.sep) || !output.includes(`${path.sep}output${path.sep}`)) throw new Error('导出目标必须位于项目 output 子目录');
const read = (name) => fs.readFile(path.join(root, name), 'utf8');
const snapshot = async (key) => JSON.parse(await fs.readFile(path.join(snapshotsPath, `${key}.json`), 'utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
const sourceChanges = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src/renderer', 'src/main', 'src/preload', 'src/shared', 'backend', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim();
const builtIndex = await read('.build/web/index.html');
const assetsDir = path.join(root, '.build/web/assets');
const indexCss = builtIndex.match(/href="([^" ]+\.css)"/)?.[1]?.split('/').at(-1);
const cssFiles = (await fs.readdir(assetsDir)).filter((name) => name.endsWith('.css'));
cssFiles.sort((a, b) => a === indexCss ? -1 : b === indexCss ? 1 : a.localeCompare(b));
let css = (await Promise.all(cssFiles.map((name) => fs.readFile(path.join(assetsDir, name), 'utf8')))).join('\n');
if (/@import\s|url\(\s*["']?(?:https?:|\/)/i.test(css)) throw new Error('样式含外部资源，不能生成离线原型');
css = css.replace(/\/\*# sourceMappingURL=.*?\*\//g, '') + prototypeCss;
const runtime = await fs.readFile(new URL('./runtime.js', import.meta.url), 'utf8');
const server = await createServer({ configFile: path.join(root, 'vite.web.config.ts'), server: { middlewareMode: true }, appType: 'custom' });
try {
  const catalogModule = await server.ssrLoadModule('/mock/catalog.ts');
  const cardModule = await server.ssrLoadModule('/shared/ui/PosterCard.tsx');
  const themeModule = await server.ssrLoadModule('/app/theme.ts');
  const catalog = catalogModule.buildMockCatalog();
  const renderCard = (work) => renderToStaticMarkup(React.createElement(cardModule.PosterCard, { work, onOpen: () => {} }));
  const selectOptions = await readSelectOptions(themeModule.THEME_LABELS);
  const manifest = { format: 1, generatedAt: new Date().toISOString(), branch, commit, cssSha256: sha(css), runtimeSha256: sha(runtime),
    sourceUnmodified: sourceChanges.length === 0, runtime: 'static DOM + offline prototype JavaScript; no React runtime or API',
    scope: 'current src/renderer browser mock only', dependencies: {}, pages: [],
    limitations: ['跨页状态不共享', '240 条目映射 7 个代表详情', '海报墙静态展开，正式工程保留虚拟化', '原型操作不写业务数据'] };
  for (const name of ['react', 'typescript', 'vite', 'react-router', '@tanstack/react-query', 'zustand', '@tanstack/react-virtual', 'radix-ui', 'tailwindcss', 'lucide-react', 'class-variance-authority', 'clsx', 'tailwind-merge']) {
    manifest.dependencies[name] = JSON.parse(await read(`node_modules/${name}/package.json`)).version;
  }
  await fs.mkdir(output, { recursive: true });
  const templates = {};
  for (const key of [...templateKeys, 'dialog-controls']) {
    const snap = await snapshot(key);
    let html;
    if (key === 'playback') html = parse(snap.html).querySelector('[aria-label="演示播放"]')?.outerHTML;
    else if (key.endsWith('-candidates')) {
      const document = parse(snap.html);
      const heading = [...document.querySelectorAll('h2')].find((node) => node.textContent.includes(key.startsWith('metadata') ? '元数据与人工覆盖' : 'Bangumi 同步'));
      html = heading?.closest('section')?.outerHTML;
    } else html = portalTemplate(snap, key.startsWith('menu-') ? '[role="menu"],[role="listbox"]' : '[role="dialog"]');
    if (!html) throw new Error(`模板为空：${key}`);
    const document = clean(parse(html));
    if (key === 'dialog-search') {
      const list = document.querySelector('[role="listbox"]');
      const sample = list.querySelector('li');
      const unique = catalog.works.filter((work, index, all) => all.findIndex((item) => item.title === work.title) === index);
      list.replaceChildren(...unique.map((work, index) => {
        const node = sample.cloneNode(true);
        const button = node.querySelector('button');
        button.id = `prototype-result-${index}`;
        button.dataset.protoHref = pages.find((page) => page.key === detailKey(work.id)).file;
        const labels = node.querySelectorAll('button > span > span');
        if (labels[0]) labels[0].textContent = work.title;
        if (labels[1]) labels[1].textContent = `代表作品 · ${work.year}`;
        return node;
      }));
      document.querySelector('input').setAttribute('value', '');
    }
    annotate(document, { pages, catalog });
    templates[key] = document.body.innerHTML;
  }
  const sourceMap = {
    浏览: 'src/renderer/features/library/PosterWallPage.tsx', 详情: 'src/renderer/features/work/WorkDetailPage.tsx',
    管理: 'src/renderer/features/manage/MediaManagementPage.tsx', 设置: 'src/renderer/features/settings/SettingsPage.tsx', 弹层: 'src/renderer/features/setup/FirstRunSetup.tsx',
  };
  for (const page of pages) {
    const snap = await snapshot(page.key);
    const document = clean(parse(snap.html));
    restoreInputs(document, snap);
    document.querySelectorAll('[aria-label="演示播放"]').forEach((node) => node.remove());
    if (page.key === 'controls') {
      const fixture = [...document.querySelectorAll('h3')].find((node) => node.textContent === '控件夹具')?.parentElement;
      const container = document.querySelector('[data-route="dev"]');
      if (!fixture || !container) throw new Error('共享控件夹具结构已变化');
      container.replaceChildren(fixture);
    }
    expandWall(document, worksForPage(catalog, page.key), renderCard);
    annotate(document, { pages, catalog });
    // 搜索快照使用完整目录，初始化时按 query 过滤，后续可搜索其他作品。
    const workId = page.route.match(/^\/work\/([^?]+)/)?.[1];
    const localTemplates = { ...templates };
    if (workId) {
      const detail = catalogModule.buildMockDetail(catalog.works.find((work) => work.id === workId), catalog);
      for (let season = 1; season <= detail.seasons.length; season++) {
        const seasonSnap = season === 1 ? snap : await snapshot(`${page.key === 'playback' ? 'detail' : page.key}-season-${season}`);
        const episodeDocument = clean(parse(seasonSnap.html));
        const episodes = episodeDocument.querySelector('[aria-label="季集与版本"] > ul');
        if (!episodes) throw new Error(`${page.key} 第 ${season} 季缺失`);
        annotate(episodeDocument, { pages, catalog });
        localTemplates[`season-${season}`] = episodes.outerHTML;
      }
    }
    const renderedTemplates = Object.entries(localTemplates).map(([key, html]) => `<template id="template-${key}">${html}</template>`).join('\n');
    const body = document.body.innerHTML + '\n' + renderedTemplates;
    const artworkDocument = parse(body);
    // querySelectorAll 不会进入 template.content，需要显式扫描每个片段。
    const keys = new Set();
    for (const html of [document.body.innerHTML, ...Object.values(localTemplates)]) {
      parse(html).querySelectorAll('img[data-prototype-artwork]').forEach((node) => keys.add(node.dataset.prototypeArtwork));
    }
    if (page.key === 'home') catalog.works.slice(0, 7).forEach((work) => {
      const url = work.artwork.fanart?.url ?? work.artwork.poster?.url;
      if (url) keys.add(url.split('/__mock/')[1]);
    });
    const images = {};
    for (const key of keys) {
      if (!key || key.includes('..') || path.isAbsolute(key)) throw new Error('图片路径越界');
      const bytes = await fs.readFile(path.join(root, '.build/mock-assets/__mock', key));
      const mime = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      images[key] = `data:${mime};base64,${bytes.toString('base64')}`;
    }
    const data = { key: page.key, workId, heroTitleClass: css.match(/\.(_heroTitle_[\w]+)/)?.[1], pages: pages.map(({ key, file, route }) => ({ key, file, route })), selectOptions,
      works: catalog.works.map((work) => ({ id: work.id, title: work.title, plot: work.plot, rating: work.rating,
        seasonCount: work.seasonCount, genres: work.genres, sources: work.sources, detailKey: detailKey(work.id),
        fanart: (work.artwork.fanart?.url ?? work.artwork.poster?.url ?? '').split('/__mock/')[1] })) };
    const html = `<!doctype html>\n<html lang="zh-CN" data-theme="${escapeHtml(snap.theme ?? 'fluent')}" data-motion="${escapeHtml(snap.motion ?? 'standard')}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>${escapeHtml(page.title)} · KumiPlayer 原型</title><style>${css}</style></head><body>${body}<script type="application/json" id="prototype-data">${safeJson(data)}</script><script type="application/json" id="prototype-assets">${safeJson(images)}</script><script>${runtime.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
    await fs.writeFile(path.join(output, page.file), html, 'utf8');
    manifest.pages.push({ ...page, source: page.source || sourceMap[page.group], snapshotViewport: [snap.width, snap.height],
      sha256: sha(html), bytes: Buffer.byteLength(html), imageCount: keys.size,
      templateKeys: Object.keys(localTemplates), cards: artworkDocument.querySelectorAll('[data-work-id]').length });
    console.log(`${page.key}: ${Math.round(Buffer.byteLength(html) / 1024)} KiB, ${keys.size} 图片`);
  }
  const index = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KumiPlayer HTML 原型目录</title><style>body{margin:0;background:#f5f5f5;color:#202020;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:40px auto;padding:24px}h1{font-size:30px}p{color:#555}section{margin:32px 0}nav{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}a{display:block;border:1px solid #ddd;border-radius:10px;background:white;padding:14px;color:inherit;text-decoration:none}a:hover{border-color:#777}small{display:block;color:#777}code{font-size:13px}</style></head><body><main><h1>KumiPlayer 当前界面 · HTML 原型</h1><p>34 个页面与状态入口，可点击、可编辑、可离线打开。先在浏览器查看，再把要精修的编号 HTML 交给 OpenDesign Cloud。</p><p>基线 <code>${commit.slice(0, 12)}</code> · 交互为离线模拟 · 正式新前端未改动</p><nav><a href="使用说明.md">使用说明</a><a href="OpenDesign精修提示词.md">完整精修提示词</a><a href="manifest.json">页面与正式组件映射</a></nav>${['浏览', '详情', '管理', '设置', '弹层', '组件'].map((group) => `<section><h2>${group}</h2><nav>${pages.filter((page) => page.group === group).map((page) => `<a href="${escapeHtml(page.file)}">${escapeHtml(page.title)}<small>${escapeHtml(page.route)}</small></a>`).join('')}</nav></section>`).join('')}</main></body></html>`;
  await fs.writeFile(path.join(output, 'index.html'), index, 'utf8');
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(output, '使用说明.md'), usage(manifest), 'utf8');
  await fs.writeFile(path.join(output, 'OpenDesign精修提示词.md'), designBrief(manifest), 'utf8');
  console.log(`已导出 ${pages.length} 个原型；正式源码未改动。`);
} finally { await server.close(); }

/** 从真实 Select JSX 的常量数组读取标签，不执行字符串代码。 */
async function readSelectOptions(themes) {
  const result = { 主题: themes.map((item) => item.label),
    无法确定作品身份处理方式: ['示例候选作品 A（2024）', '示例候选作品 B（2023）', '保留为本地作品'],
    播放路径不可达处理方式: ['使用在线扫描结果', '手动指定挂载根'] };
  for (const name of ['src/renderer/features/settings/SettingsPage.tsx', 'src/renderer/features/setup/FirstRunSetup.tsx']) {
    const source = ts.createSourceFile(name, await read(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === 'Select') {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const data = attributes.find((item) => item.name.text === 'data')?.initializer;
        const label = attributes.find((item) => item.name.text === 'label')?.initializer;
        let title = label && ts.isStringLiteral(label) ? label.text : null;
        let ancestor = node.parent;
        while (!title && ancestor && ancestor !== source) {
          if (ts.isJsxElement(ancestor) && ancestor.openingElement.tagName.getText(source) === 'Row') {
            const attribute = ancestor.openingElement.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.text === 'label');
            if (attribute?.initializer && ts.isStringLiteral(attribute.initializer)) title = attribute.initializer.text;
          }
          ancestor = ancestor.parent;
        }
        if (title && data && ts.isJsxExpression(data) && data.expression && ts.isArrayLiteralExpression(data.expression)) {
          result[title] = data.expression.elements.filter(ts.isObjectLiteralExpression).flatMap((object) => object.properties
            .filter((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === 'label' && ts.isStringLiteral(item.initializer))
            .map((item) => item.initializer.text));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result;
}
