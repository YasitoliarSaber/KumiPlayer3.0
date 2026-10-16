/* 离线 HTML 原型交互。没有 React、API、桌面桥接或业务存储。 */
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('prototype-data').textContent);
  const assets = JSON.parse(document.getElementById('prototype-assets').textContent);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = (node) => (node?.getAttribute('aria-label') || node?.textContent || '').replace(/\s+/g, ' ').trim();
  const file = (key) => data.pages.find((page) => page.key === key)?.file;
  let source = 'all';
  let sort = 'recent';
  let query = data.key === 'search' ? new URLSearchParams(location.search).get('q') ?? 'CLANNAD' : '';
  let popup = null;
  let modal = null;
  let lastFocus = null;
  let setupStep = 0;
  let desiredColumns = 8;
  let heroIndex = 0;
  let heroTimer = null;
  let toastTimer = null;
  const originalCards = $$('[data-prototype-wall] > [data-work-id]');
  const seasons = new Map();
  function hydrate(root = document) {
    $$('img[data-prototype-artwork]', root).forEach((image) => {
      const uri = assets[image.dataset.prototypeArtwork];
      if (uri) image.src = uri;
    });
  }
  function toast(message) {
    $('[data-proto-toast]')?.remove();
    const node = document.createElement('div');
    node.dataset.protoToast = '';
    node.setAttribute('role', 'status');
    node.textContent = message;
    document.body.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 3500);
  }
  function closePopup(restore = true) {
    if (!popup) return;
    popup.trigger?.setAttribute('aria-expanded', 'false');
    popup.node.remove();
    if (restore) popup.trigger?.focus();
    popup = null;
  }
  function closeModal() {
    modal?.remove();
    modal = null;
    $('#root')?.removeAttribute('inert');
    lastFocus?.focus();
    lastFocus = null;
  }
  function showModal(key) {
    closePopup(false);
    if (!modal) lastFocus = document.activeElement;
    modal?.remove();
    const template = document.getElementById(`template-${key}`);
    if (!template) return toast('此操作仅在原型内演示。');
    modal = document.createElement('div');
    modal.dataset.protoLayer = key;
    modal.append(template.content.cloneNode(true));
    const dialog = $('[role="dialog"]', modal);
    if (dialog) {
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', $('h2', dialog)?.textContent ?? '原型对话框');
      dialog.tabIndex = -1;
    }
    document.body.append(modal);
    $('#root')?.setAttribute('inert', '');
    hydrate(modal);
    ( $('input:not([disabled]),button:not([disabled])', dialog ?? modal) ?? dialog)?.focus();
  }
  function showPopup(trigger, key, callback, options) {
    const wasOpen = popup?.trigger === trigger;
    closePopup(false);
    if (wasOpen) return;
    const template = document.getElementById(`template-${key}`);
    if (!template) return;
    const holder = document.createElement('div');
    holder.dataset.protoPopup = key;
    holder.append(template.content.cloneNode(true));
    const menu = $('[role="menu"],[role="listbox"]', holder) ?? holder.firstElementChild;
    if (options) {
      const sample = $('[role="option"],[role^="menuitem"]', menu)?.cloneNode(true);
      menu.replaceChildren();
      options.forEach((label) => {
        const item = sample?.cloneNode(true) ?? document.createElement('div');
        item.setAttribute('role', 'option');
        item.textContent = label;
        item.tabIndex = 0;
        menu.append(item);
      });
    }
    $$('[role="option"],[role^="menuitem"]', holder).forEach((item) => { item.tabIndex = 0; });
    document.body.append(holder);
    trigger.setAttribute('aria-expanded', 'true');
    const bounds = trigger.getBoundingClientRect();
    holder.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - holder.offsetWidth - 8))}px`;
    holder.style.top = `${Math.max(8, Math.min(bounds.bottom + 5, innerHeight - holder.offsetHeight - 8))}px`;
    popup = { node: holder, trigger, callback };
    $('[role="option"],[role^="menuitem"]', holder)?.focus();
  }
  function layout() {
    const wall = $('[data-prototype-wall]');
    if (wall) wall.style.setProperty('--prototype-columns', String(Math.max(2, Math.min(desiredColumns, Math.floor((wall.clientWidth + 18) / 168)))));
  }
  function applyWall() {
    const wall = $('[data-prototype-wall]');
    if (!wall) return;
    const filtered = originalCards.filter((card) => (source === 'all' || card.dataset.workSources.split(',').includes(source))
      && (!query || card.dataset.workSearch.includes(query.toLowerCase())));
    const fields = { 年份: 'workYear', 评分: 'workRating', 集数: 'workEpisodes' };
    filtered.sort((a, b) => sort === '标题' ? a.dataset.workTitle.localeCompare(b.dataset.workTitle, 'zh-Hans-CN')
      : fields[sort] ? Number(b.dataset[fields[sort]]) - Number(a.dataset[fields[sort]]) : b.dataset.workRecent.localeCompare(a.dataset.workRecent));
    wall.replaceChildren(...filtered);
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.dataset.prototypeEmpty = '';
      empty.textContent = '这个筛选下还没有作品';
      wall.append(empty);
    }
    const count = $('[data-route] [class*="_count_"]');
    if (count) count.textContent = `共 ${filtered.length} 部`;
    if (data.key === 'search') {
      const heading = $('main h1');
      if (heading) heading.textContent = `搜索：${query || '全部'}`;
    }
    hydrate(wall);
    layout();
  }
  function play() {
    $('[aria-label="演示播放"]')?.remove();
    const template = document.getElementById('template-playback');
    if (!template) return;
    document.body.append(template.content.cloneNode(true));
    const overlay = $('[aria-label="演示播放"]');
    const work = data.works.find((item) => item.id === data.workId);
    if (work) $('[class*="_title_"]', overlay).textContent = work.title;
    hydrate(overlay);
  }
  function selectSeason(button) {
    const index = $$('[aria-label="季集与版本"] [role="tab"]').indexOf(button) + 1;
    const template = document.getElementById(`template-season-${index}`);
    const current = $('[aria-label="季集与版本"] > ul');
    if (!current || !template) return;
    const active = $('[aria-label="季集与版本"] [aria-selected="true"]');
    const previousIndex = $$('[aria-label="季集与版本"] [role="tab"]').indexOf(active) + 1;
    seasons.set(previousIndex, current);
    const next = seasons.get(index) ?? template.content.firstElementChild.cloneNode(true);
    current.replaceWith(next);
    $$('[aria-label="季集与版本"] [role="tab"]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab === button));
      tab.dataset.state = tab === button ? 'active' : 'inactive';
      tab.tabIndex = tab === button ? 0 : -1;
    });
    hydrate(next);
  }
  function updateHero(index) {
    const pool = data.works.filter((work, i, all) => all.findIndex((candidate) => candidate.title === work.title) === i).slice(0, 6);
    heroIndex = (index + pool.length) % pool.length;
    const work = pool[heroIndex];
    const surface = $('[class*="_featureSurface_"]');
    if (!surface || !work) return;
    $('[class*="_featureTitle_"]', surface).textContent = work.title;
    $('[class*="_featurePlot_"]', surface).textContent = work.plot;
    const image = $('img', surface);
    image.dataset.prototypeArtwork = work.fanart;
    surface.dataset.protoHref = file(work.detailKey);
    surface.setAttribute('aria-label', `打开${work.title}详情`);
    const chips = $$('[class*="_featureChip_"]', surface);
    if (chips[0]) chips[0].textContent = `★ ${work.rating.toFixed(1)}`;
    if (chips[1]) chips[1].textContent = work.seasonCount > 1 ? `共 ${work.seasonCount} 季` : '共 1 季';
    if (chips[2]) chips[2].textContent = work.genres.slice(0, 2).join(' / ');
    $$('[class*="_featureDots_"] button').forEach((dot, i) => dot.setAttribute('aria-pressed', String(i === heroIndex)));
    hydrate(surface);
  }
  function chooseCombo(button, value) {
    const label = text(button);
    const span = $('span', button);
    if (span) span.textContent = value;
    button.dataset.prototypeSelected = value;
    if (label === '主题') {
      const themes = { 浅色: 'fluent', 深色: 'cinema', 纯白: 'mica' };
      document.documentElement.dataset.theme = themes[value] ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'cinema' : 'fluent');
    }
    if (label === '动效') document.documentElement.dataset.motion = value === '减弱' ? 'reduced' : 'standard';
    if (data.key === 'import-2') {
      const ready = $$('main [role="combobox"]').every((node) => node.dataset.prototypeSelected);
      $$('button').filter((node) => text(node) === '确认并执行').forEach((node) => { node.disabled = !ready; });
    }
    toast('原型选项已更新，仅作用于当前 HTML。');
  }
  document.addEventListener('click', (event) => {
    const item = event.target.closest('[role="option"],[role^="menuitem"]');
    if (item && popup?.node.contains(item)) {
      const callback = popup.callback;
      const value = text(item);
      closePopup();
      callback(value);
      return;
    }
    if (popup && !popup.node.contains(event.target) && !popup.trigger.contains(event.target)) closePopup(false);
    if (modal && event.target.parentElement === modal && !event.target.matches('[role="dialog"]')) { closeModal(); return; }
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const label = text(button);
    if (button.dataset.protoHref) { location.href = button.dataset.protoHref; return; }
    if (button.getAttribute('role') === 'switch') {
      const state = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', String(state));
      button.dataset.state = state ? 'checked' : 'unchecked';
      $$('[data-state]', button).forEach((node) => { node.dataset.state = button.dataset.state; });
      return;
    }
    if (button.getAttribute('role') === 'combobox') {
      const options = data.selectOptions[label] ?? ['选项一', '选项二'];
      showPopup(button, 'menu-select', (value) => chooseCombo(button, value), options);
      return;
    }
    if (button.getAttribute('role') === 'tab') {
      if (button.closest('[aria-label="季集与版本"]')) selectSeason(button);
      else {
        $$('[role="tab"]', button.closest('[role="tablist"]')).forEach((tab) => {
          tab.setAttribute('aria-selected', String(tab === button)); tab.dataset.state = tab === button ? 'active' : 'inactive';
        });
        const panel = $('[role="tabpanel"]');
        if (panel) panel.textContent = label === '标签二' ? '面板二' : '面板一';
      }
      return;
    }
    if (label.startsWith('来源筛选')) {
      showPopup(button, 'menu-source', (value) => {
        const labels = ['全部来源', '本地', '115 网盘', '百度网盘', '夸克网盘', 'OpenList', '混合来源'];
        source = ['all', 'local', 'pan115', 'baidu', 'quark', 'openlist', 'hybrid'][labels.indexOf(value)] ?? 'all';
        button.setAttribute('aria-label', `来源筛选，当前${value}`);
        applyWall();
        $$('main button[data-proto-href]').filter((node) => !node.closest('[data-prototype-wall]')).forEach((node) => {
          const work = data.works.find((candidate) => candidate.title === $('img', node)?.alt);
          if (work) node.hidden = source !== 'all' && !work.sources.includes(source);
        });
      }); return;
    }
    if (label === '排序方式') { showPopup(button, 'menu-sort', (value) => { sort = value; button.childNodes.forEach((node) => { if (node.nodeType === 3) node.textContent = value; }); applyWall(); }); return; }
    if (label === '更多') { showPopup(button, 'menu-work', (value) => {
      if (value === '编辑标题') showModal('dialog-rename');
      else if (value === '从媒体库移除') showModal('dialog-delete');
      else if (value === '重新刮削资料') { $('input[aria-label="检索标题"]')?.focus(); toast('请在「元数据与人工覆盖」中搜索演示候选。'); }
      else toast('原型不打开真实文件位置。');
    }); return; }
    if (label === '选择版本') { showPopup(button, 'menu-version', () => play()); return; }
    if (label === '打开导航') { showModal('drawer'); return; }
    if (label === '完全隐藏导航栏' || label === '显示导航栏') {
      const shell = $('[data-sidebar]'); shell.dataset.sidebar = shell.dataset.sidebar === 'hidden' ? 'expanded' : 'hidden';
      button.setAttribute('aria-label', shell.dataset.sidebar === 'hidden' ? '显示导航栏' : '完全隐藏导航栏'); layout(); return;
    }
    if (/收起为图标栏|展开导航栏/.test(label)) {
      const shell = $('[data-sidebar]'); shell.dataset.sidebar = shell.dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed';
      const sidebar = $('aside[class*="_sidebar_"]');
      if (sidebar) sidebar.dataset.expanded = String(shell.dataset.sidebar === 'expanded');
      button.setAttribute('aria-expanded', String(shell.dataset.sidebar === 'expanded'));
      button.setAttribute('aria-label', shell.dataset.sidebar === 'collapsed' ? '展开导航栏' : '收起为图标栏'); layout(); return;
    }
    if (label === '返回上个界面' || label === '返回') { history.back(); return; }
    if (label === '前进到下个界面') { history.forward(); return; }
    if (/^(继续观看|播放)$/.test(label) || /^播放 S/.test(label)) { play(); return; }
    if (label === '停止') { $('[aria-label="演示播放"]')?.remove(); return; }
    if (label === '暂停' || label === '继续') { button.textContent = label === '暂停' ? '继续' : '暂停'; return; }
    if (label === '收藏' || label === '已收藏') { button.textContent = label === '收藏' ? '已收藏' : '收藏'; button.setAttribute('aria-pressed', String(label === '收藏')); return; }
    if (label === '预览') { showModal('dialog-maintenance'); return; }
    if (label === '重置演示数据') { showModal('dialog-reset'); return; }
    if (/继续设置引导|重新运行引导/.test(label)) { setupStep = 0; showModal('setup-0'); return; }
    if (label === '打开对话框') { showModal('dialog-controls'); return; }
    if (modal) {
      if (label === '下一步' || label === '上一步') { setupStep = Math.max(0, Math.min(3, setupStep + (label === '下一步' ? 1 : -1))); showModal(`setup-${setupStep}`); return; }
      if (label === '保存') {
        const value = $('input', modal)?.value.trim();
        if (value) {
          let heading = $('main h1');
          if (!heading) {
            const logo = $('[class*="_heroLogo_"]');
            if (logo) { heading = document.createElement('h1'); heading.className = data.heroTitleClass ?? ''; logo.replaceWith(heading); }
          }
          if (heading) heading.textContent = value;
        }
        closeModal(); toast('已更新原型标题。'); return;
      }
      if (/关闭|取消|稍后设置|完成设置|确认执行|确认移除|确认重置/.test(label)) { closeModal(); if (!/关闭|取消/.test(label)) toast('原型演示完成，未写入任何业务数据。'); return; }
    }
    if (label === '搜索候选' || (label === '搜索' && data.workId)) {
      const key = label === '搜索候选' ? 'metadata-candidates' : 'bangumi-candidates';
      const target = button.closest('section');
      const template = document.getElementById(`template-${key}`);
      if (target && template) { target.replaceWith(template.content.cloneNode(true)); hydrate(); }
      return;
    }
    if (label === '上一部' || label === '下一部') { updateHero(heroIndex + (label === '上一部' ? -1 : 1)); return; }
    if (button.closest('[class*="_featureDots_"]')) { updateHero($$('button', button.parentElement).indexOf(button)); return; }
    if (/轮播|自动推荐/.test(label)) { clearInterval(heroTimer); heroTimer = label.includes('暂停') ? null : setInterval(() => updateHero(heroIndex + 1), 5000); button.setAttribute('aria-label', heroTimer ? '暂停自动推荐' : '恢复自动推荐'); return; }
    if (['追更中', '已看完', '搁置', '弃番', '未标记'].includes(label)) { $$('button', button.parentElement).forEach((node) => node.setAttribute('aria-pressed', String(node === button))); toast(`原型观看状态：${label}`); return; }
    toast(`「${label}」为原型演示，未执行真实操作。`);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showModal('dialog-search'); return; }
    if (event.key === 'Escape') { if (popup) closePopup(); else closeModal(); return; }
    if (popup && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const items = $$('[role="option"],[role^="menuitem"]', popup.node); const index = items.indexOf(document.activeElement);
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); return;
    }
    if (popup && ['Enter', ' '].includes(event.key)) { event.preventDefault(); document.activeElement.click(); return; }
    if (modal && event.key === 'Tab') {
      const nodes = $$('button:not([disabled]),input:not([disabled]),a[href],[tabindex="0"]', modal);
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    }
    if (modal?.dataset.protoLayer === 'dialog-search' && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const options = $$('[role="option"]:not([hidden])', modal);
      const active = options.findIndex((node) => node.getAttribute('aria-selected') === 'true');
      const index = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options.forEach((node, i) => node.setAttribute('aria-selected', String(i === index)));
      options[index]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && event.target.matches('[aria-label="搜索作品"],[aria-label="快捷搜索"]') && !event.isComposing) {
      event.preventDefault();
      const selected = modal?.dataset.protoLayer === 'dialog-search' ? $('[role="option"][aria-selected="true"]:not([hidden])', modal) : null;
      location.href = selected?.dataset.protoHref ?? `${file('search')}?q=${encodeURIComponent(event.target.value.trim())}`;
    }
  });
  document.addEventListener('input', (event) => {
    if (event.target.getAttribute('aria-label') === '快捷搜索') {
      const needle = event.target.value.toLowerCase();
      $$('[data-proto-layer] button[data-proto-href]').forEach((node) => { node.hidden = !text(node).toLowerCase().includes(needle); });
    }
    if (event.target.getAttribute('aria-label') === '海报墙列数') { desiredColumns = Math.max(2, Math.min(10, Number(event.target.value) || 8)); layout(); }
  });
  $$('button[aria-label="返回上个界面"],button[aria-label="前进到下个界面"]').forEach((node) => { node.disabled = false; });
  hydrate(); applyWall(); layout();
  if (typeof ResizeObserver !== 'undefined' && $('[data-prototype-wall]')) new ResizeObserver(layout).observe($('[data-prototype-wall]'));
  if (data.key === 'setup') showModal('setup-0');
  if (data.key === 'playback') play();
  document.documentElement.dataset.prototypeReady = 'true';
})();
