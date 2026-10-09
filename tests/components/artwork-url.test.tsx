import { afterEach, expect, test, vi } from 'vitest';
import { buildAssetUrl } from '../../src/api/assets';
import { setApiSessionToken } from '../../src/api/sessionToken';

vi.mock('../../src/api/client', () => ({ API_BASE: 'http://127.0.0.1:37821' }));
afterEach(() => setApiSessionToken(''));

test('已发布资源保留版本与尺寸，并附带当前会话身份', () => {
  setApiSessionToken('local test');
  expect(buildAssetUrl('/api/assets/artwork/resource/v2/384')).toBe('http://127.0.0.1:37821/api/assets/artwork/resource/v2/384?api_token=local%20test');
});

test('普通展示和候选都不回退到远程代理、裸文件或临时缩图', () => {
  for (const path of ['https://image.tmdb.org/t/p/w342/poster.jpg', 'https://s4.anilist.co/file/anilistcdn/poster.jpg', '/poster.jpg', 'D:/mirror/poster.jpg', '/api/assets/thumbnail?path=poster.jpg', '/api/assets/artwork/resource/v2/384?path=poster.jpg']) {
    expect(buildAssetUrl(path)).toBe('');
    expect(buildAssetUrl(path, { kind: 'candidate' })).toBe('');
  }
});
