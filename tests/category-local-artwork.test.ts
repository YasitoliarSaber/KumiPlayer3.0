import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


test('分类页海报网格只请求后台已发布的资源尺寸', () => {
  const category = readFileSync(new URL('../src/pages/CategoryPage.tsx', import.meta.url), 'utf8');
  const grid = readFileSync(new URL('../src/components/library/VirtualizedPosterGrid.tsx', import.meta.url), 'utf8');
  const poster = readFileSync(new URL('../src/components/library/PosterCard.tsx', import.meta.url), 'utf8');

  assert.match(category, /<VirtualizedPosterGrid[\s\S]*?localArtworkOnly/);
  assert.match(grid, /localArtworkOnly/);
  assert.match(grid, /<PosterCard[\s\S]*?localArtworkOnly=\{localArtworkOnly\}/);
  assert.match(poster, /localArtworkOnly/);
  assert.match(poster, /preferredArtworkPath\(work, artworkKind, thumbnailWidth \|\| undefined\)/);
  assert.doesNotMatch(poster, /isRemoteAssetPath|cacheOnly:|\/api\/assets\/thumbnail|prepareThumbnails/);
});


test('搜索收藏与候选预览均无远程回退', () => {
  const search = readFileSync(new URL('../src/pages/SearchPage.tsx', import.meta.url), 'utf8');
  const favorites = readFileSync(new URL('../src/pages/FavoritesPage.tsx', import.meta.url), 'utf8');
  const assets = readFileSync(new URL('../src/api/assets.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(search, /localArtworkOnly/);
  assert.doesNotMatch(favorites, /localArtworkOnly/);
  assert.doesNotMatch(assets, /\/remote\?url=|image\.tmdb\.org|anilist\.co|prepareThumbnail/);
  assert.match(assets, /withApiSessionToken\(API_BASE \+ path\)/);
});
