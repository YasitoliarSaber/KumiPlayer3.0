import assert from 'node:assert/strict';
import test from 'node:test';

import { preferredArtworkPath } from '../src/utils/artwork.ts';

test('已发布资源按展示尺寸选取，忽略远程元数据与旧镜像路径', () => {
  const work = {
    poster_path: 'https://image.tmdb.org/t/p/w342/poster.jpg',
    fanart_path: 'https://image.tmdb.org/t/p/w1280/fanart.jpg',
    clearlogo_path: 'https://image.tmdb.org/t/p/w300/logo.png',
    local_poster_path: 'D:/mirror/work/poster.jpg',
    local_fanart_path: 'D:/mirror/work/fanart.jpg',
    local_clearlogo_path: 'D:/mirror/work/clearlogo.png',
    artwork: {
      poster: { state: 'ready', variants: { '192': '/api/assets/artwork/poster/v1/192', '384': '/api/assets/artwork/poster/v1/384', '768': '/api/assets/artwork/poster/v1/768' } },
      fanart: { state: 'ready', variants: { '768': '/api/assets/artwork/fanart/v1/768', '1280': '/api/assets/artwork/fanart/v1/1280' } },
      clearlogo: { state: 'ready', variants: { '512': '/api/assets/artwork/logo/v1/512' } },
    },
  };

  assert.equal(preferredArtworkPath(work, 'poster'), '/api/assets/artwork/poster/v1/384');
  assert.equal(preferredArtworkPath(work, 'poster', 450), '/api/assets/artwork/poster/v1/768');
  assert.equal(preferredArtworkPath(work, 'fanart'), '/api/assets/artwork/fanart/v1/1280');
  assert.equal(preferredArtworkPath(work, 'clearlogo'), '/api/assets/artwork/logo/v1/512');
});

test('未准备资源不回退远程下载或原始文件，保留已发布的旧版本 URL', () => {
  assert.equal(
    preferredArtworkPath({ fanart_path: 'https://image.tmdb.org/t/p/w1280/fanart.jpg' }, 'fanart'),
    '',
  );
  assert.equal(preferredArtworkPath({ local_poster_path: 'D:/mirror/poster.jpg' }, 'poster'), '');
  assert.equal(preferredArtworkPath({ local_poster_path: '/api/assets/artwork/poster/v1/384', artwork: { poster: { state: 'failed', variants: {} } } }, 'poster'), '/api/assets/artwork/poster/v1/384');
});
