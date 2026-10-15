import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from '../../src/main/protocols/app-protocol';
import { parseArtworkUrl } from '../../src/main/protocols/artwork';

const resource = 'a'.repeat(64);
const version = `${'b'.repeat(64)}-webp-v1`;

describe('受限图片协议', () => {
  it('只接受规范的资源/版本/尺寸三元组', () => {
    expect(parseArtworkUrl(`kumiplayer-artwork://artwork/${resource}/${version}/384`)).toEqual({
      resourceId: resource,
      contentVersion: version,
      width: 384,
    });
  });

  it('拒绝路径穿越、任意尺寸与错误来源', () => {
    expect(parseArtworkUrl('kumiplayer-artwork://artwork/../secret/384')).toBeNull();
    expect(parseArtworkUrl(`kumiplayer-artwork://artwork/${resource}/${version}/1024`)).toBeNull();
    expect(parseArtworkUrl(`kumiplayer-artwork://evil/${resource}/${version}/384`)).toBeNull();
    expect(parseArtworkUrl(`https://image.tmdb.org/${resource}/${version}/384`)).toBeNull();
    // 旧镜像版本标识不属于已发布内容版本。
    expect(parseArtworkUrl(`kumiplayer-artwork://artwork/${resource}/${'b'.repeat(64)}-webp-v99/384`)).toBeNull();
  });
});

describe('生产内容安全策略', () => {
  const policy = buildContentSecurityPolicy('TESTNONCE');

  it('脚本与样式都要求同源或 nonce，且不允许任何网络连接', () => {
    expect(policy).toContain("script-src 'self' 'nonce-TESTNONCE'");
    expect(policy).toContain("style-src 'self' 'nonce-TESTNONCE'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain("script-src 'unsafe");
  });

  it('图片只允许同源、data 与受限图片协议', () => {
    expect(policy).toContain('img-src \'self\' data: kumiplayer-artwork:');
  });
});
