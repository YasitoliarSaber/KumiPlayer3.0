import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('竖版封面在窗口缩放与跨屏切换后仍由固定比例容器统一裁切', () => {
  const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  assert.match(styles, /\.poster-media-vertical\s*\{[^}]*aspect-ratio:\s*2\s*\/\s*3/s);
  assert.match(styles, /\.poster-media img\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*object-fit:\s*cover/s);
  assert.doesNotMatch(styles, /\.poster-media-vertical img\s*\{[^}]*object-fit:\s*contain/s);
});

test('封面网格在滑块、窗口与跨屏尺寸变化后重新测量可用列数', () => {
  const grid = readFileSync(
    new URL('../src/components/library/VirtualizedPosterGrid.tsx', import.meta.url),
    'utf8',
  );

  assert.match(grid, /calculatePosterGridMetrics/);
  assert.match(grid, /useLayoutEffect/);
  assert.match(grid, /window\.addEventListener\('resize', requestMeasure\)/);
  assert.match(grid, /visualViewport\?\.addEventListener\('resize', requestMeasure\)/);
  assert.match(grid, /matchMedia\?\.\(`\(resolution: /);
  assert.match(grid, /observer = new ResizeObserver\(requestMeasure\)[\s\S]*?observer\.observe\(wrapRef\.current\)/);
  // 布局偏好由设置页保存，网格只负责按窗口容量测量实际列数，不再回传容量。
  assert.doesNotMatch(grid, /onColumnCapacityChange/);
  assert.match(grid, /setEffectiveColumns\(\(current\) => current === measuredColumns \? current : measuredColumns\)/);
});

test('海报墙的图片观察器预加载附近视口，网格不监听逐像素滚动', () => {
  const grid = readFileSync(new URL('../src/components/library/VirtualizedPosterGrid.tsx', import.meta.url), 'utf8');
  const lifecycle = readFileSync(new URL('../src/components/library/posterImageLifecycle.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(grid, /addEventListener\('scroll'/);
  assert.match(lifecycle, /new IntersectionObserver/);
  assert.match(lifecycle, /\['visible', 'preload', 'resident'\]/);
  assert.match(lifecycle, /height \* 0\.5/);
  assert.match(lifecycle, /height \* 2/);
  assert.match(lifecycle, /image\.removeAttribute\('src'\)/);
});

test('虚拟海报墙不为每张卡片叠加实时背景模糊', () => {
  const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const marker = '/* Poster wall scroll performance */';

  assert.match(styles, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const performanceLayer = styles.split(marker, 2)[1];
  assert.match(performanceLayer, /\.virtual-poster-grid \.poster-media\s*\{[^}]*backdrop-filter:\s*none\s*!important/s);
  assert.match(performanceLayer, /\.virtual-poster-grid \.rating-badge\s*\{[^}]*backdrop-filter:\s*none\s*!important/s);
});

test('作品墙沿用外层 .app-main 作为唯一滚动容器，不新增嵌套滚动区域', () => {
  const grid = readFileSync(
    new URL('../src/components/library/VirtualizedPosterGrid.tsx', import.meta.url),
    'utf8',
  );
  const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  // 滚动容器仍然是外层 .app-main；网格自己不得变成滚动区域。
  assert.match(grid, /closest<HTMLElement>\('\.app-main'\)/);
  assert.match(grid, /getScrollElement: \(\) => scrollElementRef\.current/);
  assert.doesNotMatch(grid, /getScrollElement: \(\) => wrapRef/);
  assert.doesNotMatch(grid, /(overflow:\s*(auto|scroll))/);

  const gridBlock = styles.match(/\.virtual-poster-(?:grid|rows|row)\s*\{[^}]*\}/g) ?? [];
  assert.ok(gridBlock.length > 0);
  for (const block of gridBlock) assert.doesNotMatch(block, /overflow(-y|-x)?:\s*(auto|scroll)/);
});

test('作品墙起始偏移按真实布局测量，且只补一层纵向间距', () => {
  const grid = readFileSync(
    new URL('../src/components/library/VirtualizedPosterGrid.tsx', import.meta.url),
    'utf8',
  );
  const styles = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  // 列表起点必须来自 rect 差值与 scrollTop，不能写死标题高度。
  assert.match(grid, /rect\.top - containerRect\.top \+ scrollContainer\.scrollTop/);
  assert.match(grid, /scrollMargin: gridOffset/);
  // 行距已含一个 gap，行内只能有 column-gap，否则会出现双重纵向间距。
  const rowBlock = styles.match(/\.virtual-poster-row\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rowBlock, /column-gap:/);
  assert.doesNotMatch(rowBlock, /row-gap:/);
  assert.doesNotMatch(rowBlock, /[^-]gap:\s*var\(--virtual-grid-gap\)/);
});

test('分类、收藏与搜索共用同一个行虚拟化网格并各自传入列数', () => {
  const pages = [
    '../src/pages/CategoryPage.tsx',
    '../src/pages/FavoritesPage.tsx',
    '../src/pages/SearchPage.tsx',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

  for (const page of pages) {
    assert.match(page, /import VirtualizedPosterGrid from '\.\.\/components\/library\/VirtualizedPosterGrid'/);
    assert.match(page, /<VirtualizedPosterGrid[\s\S]{0,200}columns=\{/);
  }
});
