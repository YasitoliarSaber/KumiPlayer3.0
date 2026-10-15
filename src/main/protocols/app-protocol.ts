/**
 * 受控应用协议：只提供随包 Renderer 资源（B 9.1、P04 的 CSP/nonce 前提）。
 *
 * Renderer 因此不需要 `file://`、不需要 Node，也不需要连外部 HTTP。
 * 每次文档加载生成新的 nonce，写进 CSP 与 Mantine 的注入接口。
 */

import { protocol } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { APP_PROTOCOL } from '@shared/contracts/desktop';

export const APP_ORIGIN = `${APP_PROTOCOL}://app`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/**
 * 生产策略：脚本与样式都要求同源或 nonce，且不允许 Renderer 发起任何网络连接
 * （业务只经具名 IPC；图片经受限图片协议）。
 */
export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: kumiplayer-artwork:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');
}

export interface AppProtocolOptions {
  readonly rendererRoot: string;
  /**
   * 额外的受限挂载（例如演示素材目录）。
   * 只按前缀映射到固定根目录，仍然拒绝路径越界，不提供任意文件访问。
   */
  readonly extraMounts?: readonly AppProtocolMount[];
  /** 允许注入替身资源，便于验证路径穿越与 MIME 行为。 */
  readonly readFile?: (file: string) => Promise<Buffer>;
}

export interface AppProtocolMount {
  /** 形如 `/__mock/` 的路径前缀。 */
  readonly prefix: string;
  readonly root: string;
}

export function registerAppProtocol(options: AppProtocolOptions): void {
  const readFile = options.readFile ?? ((file: string) => fs.promises.readFile(file));
  const root = path.resolve(options.rendererRoot);
  const mounts = (options.extraMounts ?? []).map((mount) => ({
    prefix: mount.prefix.endsWith('/') ? mount.prefix : `${mount.prefix}/`,
    root: path.resolve(mount.root),
  }));

  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') {
      return new Response('未知资源来源', { status: 403 });
    }
    const pathname = decodeURIComponent(url.pathname);
    let base = root;
    let requested = pathname.replace(/^\/+/, '');
    for (const mount of mounts) {
      if (pathname.startsWith(mount.prefix)) {
        base = mount.root;
        requested = pathname.slice(mount.prefix.length);
        break;
      }
    }
    const resolved = path.resolve(base, requested === '' ? 'index.html' : requested);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return new Response('路径越界', { status: 403 });
    }
    let body: Buffer;
    try {
      body = await readFile(resolved);
    } catch {
      return new Response('资源不存在', { status: 404 });
    }
    const extension = path.extname(resolved).toLowerCase();
    const isDocument = extension === '.html';
    if (isDocument) {
      const nonce = crypto.randomBytes(16).toString('base64');
      const html = body.toString('utf8').replace(
        '<head>',
        '<head>\n' +
          `<meta http-equiv="Content-Security-Policy" content="${buildContentSecurityPolicy(nonce)}">\n` +
          `<meta name="kumiplayer-csp-nonce" content="${nonce}">`,
      );
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES['.html'],
          'Cache-Control': 'no-store',
        },
      });
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      },
    });
  });
}

/**
 * 生产模式下 Renderer 资源只在自定义协议内可见；
 * 这里保留一处显式入口，避免出现第二个 file:// 加载路径。
 */
export function appDocumentUrl(): string {
  return `${APP_ORIGIN}/index.html`;
}
