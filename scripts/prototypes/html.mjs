import { JSDOM } from 'jsdom';

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export const parse = (html) => new JSDOM(html).window.document;

/** 只保留页面 DOM；移除 React/Radix 捕获时的暂态锁和所有外部执行入口。 */
export function clean(document) {
  document.querySelectorAll('script,iframe,object,embed,link,meta,base').forEach((node) => node.remove());
  document.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ['inert', 'data-aria-hidden', 'srcset'].includes(attribute.name)) node.removeAttribute(attribute.name);
    }
    if (node.getAttribute('aria-hidden') === 'true' && (node.id === 'root' || node.contains(document.querySelector('main')))) node.removeAttribute('aria-hidden');
    if (node.style.pointerEvents === 'none' && !node.matches('svg,span')) node.style.removeProperty('pointer-events');
    if (node.matches('[role="dialog"],[role="menu"],[role="listbox"]')) {
      node.removeAttribute('aria-labelledby');
      node.removeAttribute('aria-describedby');
      node.style.removeProperty('animation');
    }
    if (node.matches('input[type="password"]')) node.setAttribute('value', '');
    for (const attribute of ['href', 'src', 'action']) {
      const value = node.getAttribute(attribute);
      if (value && /^(?:https?:|javascript:|file:|[A-Za-z]:[\\/])/i.test(value)) {
        // 图片只允许演示素材；站内 hash 导航在后续映射。
        if (attribute === 'href' && value.includes('/#/')) node.setAttribute(attribute, value.slice(value.indexOf('#')));
        else node.removeAttribute(attribute);
      }
    }
  });
  document.querySelectorAll('button[aria-haspopup],button[role="combobox"]').forEach((node) => {
    node.setAttribute('aria-expanded', 'false');
    node.removeAttribute('aria-controls');
    if (node.dataset.state === 'open') node.dataset.state = 'closed';
  });
  return document;
}

export function restoreInputs(document, snapshot) {
  const fields = [...document.querySelectorAll('input,textarea,select')];
  fields.forEach((node, index) => {
    const input = snapshot.inputs?.[index];
    if (!input) return;
    if (node.tagName === 'TEXTAREA') node.textContent = input.value;
    else if (node.type !== 'password') node.setAttribute('value', input.value);
    if (input.checked) node.setAttribute('checked', '');
    else node.removeAttribute('checked');
  });
}

export function detailKey(id) {
  const slug = id.split('-')[0];
  return slug === 'w01' ? 'detail' : `detail-${slug}`;
}

export function annotate(document, { pages, catalog }) {
  const byKey = Object.fromEntries(pages.map((page) => [page.key, page]));
  document.querySelectorAll('a[href^="#/"]').forEach((node) => {
    const route = node.getAttribute('href').slice(1);
    const page = pages.find((candidate) => candidate.route === route) ?? (route === '/settings' ? byKey['settings-application'] : null);
    if (page) node.setAttribute('href', page.file);
    else if (route.startsWith('/work/')) node.setAttribute('href', byKey[detailKey(route.slice(6))]?.file ?? byKey.detail.file);
    else node.setAttribute('href', 'index.html');
  });
  document.querySelectorAll('[aria-label="设置分类"] button').forEach((node, index) => {
    const page = pages.filter((item) => item.key.startsWith('settings-'))[index];
    if (page) node.dataset.protoHref = page.file;
  });
  const normalize = (text) => text?.replace(/\s+/g, ' ').trim() ?? '';
  document.querySelectorAll('button').forEach((node) => {
    const label = normalize(node.getAttribute('aria-label') || node.textContent);
    const image = node.querySelector('img');
    const work = image && catalog.works.find((item) => item.title === image.alt);
    if (work && !label.startsWith('播放 S')) node.dataset.protoHref = byKey[detailKey(work.id)].file;
    if (/^打开.+详情$/.test(label)) {
      const target = catalog.works.find((item) => label === `打开${item.title}详情`);
      if (target) node.dataset.protoHref = byKey[detailKey(target.id)].file;
    }
    const rowLabel = node.closest('[class*="_row_"]')?.querySelector('[class*="_rowLabel_"]')?.textContent;
    if (node.getAttribute('role') === 'combobox' && rowLabel) node.setAttribute('aria-label', rowLabel);
    const destinations = {
      '任务中心': 'tasks-populated', '打开任务中心': 'tasks-populated', '查看任务详情': 'tasks-populated',
      '前往媒体管理': 'manage', '添加媒体': 'manage', '返回媒体库': 'manage',
      '媒体库维护': 'maintenance', '导入媒体': 'import-0', '新建导入': 'import-0',
      '开始扫描': 'import-1', '跳过等待，直接审核': 'import-2', '确认并执行': 'import-3',
      '返回选择来源': 'import-0', '重新开始': 'import-0', '触发一个新任务': 'import-0',
    };
    if (destinations[label]) node.dataset.protoHref = byKey[destinations[label]].file;
    if (label === '查看识别结果') node.dataset.protoHref = byKey['import-2'].file;
    if (label === '查看全部') {
      const heading = node.closest('section')?.querySelector('h2')?.textContent;
      const target = { 继续观看: 'recent', 番剧: 'library', 动画电影: 'movies', 剧集: 'live-series', 电影: 'live-movies' }[heading];
      if (target) node.dataset.protoHref = byKey[target].file;
    }
  });
  document.querySelectorAll('img').forEach((node) => {
    const src = node.getAttribute('src');
    if (!src) return;
    const match = src.match(/(?:^|\/)__mock\/(.+)$/);
    if (!match) throw new Error(`不是受控演示图片：${src}`);
    node.dataset.prototypeArtwork = decodeURIComponent(match[1]);
    node.removeAttribute('src');
    node.setAttribute('decoding', 'async');
  });
  return document;
}

export function worksForPage(catalog, key) {
  return catalog.works.filter((work) => {
    if (key === 'library') return work.showType === 'anime_series';
    if (key === 'movies') return work.showType === 'anime_movie';
    if (key === 'seasonal') return ['watching', 'on_hold'].includes(work.watch.status);
    if (key === 'favorites') return work.watch.favorite;
    return true;
  }).sort((left, right) => (right.progress?.updatedAt ?? '').localeCompare(left.progress?.updatedAt ?? ''));
}

/** 原型中展开真实 PosterCard；不复制正式应用的虚拟化占位高度。 */
export function expandWall(document, works, renderCard) {
  const wall = document.querySelector('[data-virtual-rows]');
  if (!wall) return;
  wall.removeAttribute('data-virtual-rows');
  wall.className = 'kumi-prototype-grid';
  wall.dataset.prototypeWall = '';
  wall.replaceChildren();
  for (const work of works) {
    const template = document.createElement('template');
    template.innerHTML = renderCard(work);
    const card = template.content.firstElementChild;
    card.dataset.workId = work.id;
    card.dataset.workTitle = work.title;
    card.dataset.workSearch = [work.title, work.originalTitle, ...work.genres, ...work.studios].join(' ').toLowerCase();
    card.dataset.workSources = work.sources.join(',');
    card.dataset.workRating = String(work.rating);
    card.dataset.workYear = String(work.year);
    card.dataset.workEpisodes = String(work.episodeCount);
    card.dataset.workRecent = work.progress?.updatedAt ?? '';
    card.dataset.workFavorite = String(work.watch.favorite);
    wall.append(card);
  }
}

export function portalTemplate(snapshot, selector = '[role="dialog"]') {
  const document = clean(parse(snapshot.portals?.join('\n') ?? ''));
  const content = document.querySelector(selector);
  if (!content) throw new Error(`缺少已采集的弹层：${selector}`);
  if (selector !== '[role="dialog"]') return content.outerHTML;
  const overlay = [...document.body.children].find((node) => node !== content && !node.contains(content));
  return (overlay?.outerHTML ?? '') + content.outerHTML;
}

export const prototypeCss = `
/* 仅用于可编辑 HTML 原型；正式项目仍使用 TanStack Virtual。 */
.kumi-prototype-grid{display:grid;grid-template-columns:repeat(var(--prototype-columns,8),minmax(0,1fr));gap:18px;width:100%}
.kumi-prototype-grid>[hidden]{display:none!important}
[data-proto-layer]{position:fixed;inset:0;z-index:100;pointer-events:none}
[data-proto-layer]>*{pointer-events:auto}
[data-proto-popup]{position:fixed;z-index:110;max-height:min(80vh,600px);overflow:auto}
[data-proto-popup] [role^=menuitem]:hover,[data-proto-popup] [role=option]:hover{background:var(--accent)}
[data-proto-toast]{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:150;max-width:min(90vw,600px);padding:12px 18px;border:1px solid var(--border);border-radius:var(--radius);background:var(--popover);color:var(--popover-foreground);box-shadow:var(--shadow-flyout);font-size:13px}
[data-prototype-empty]{grid-column:1/-1;text-align:center;padding:60px;color:var(--muted-foreground)}
`;
