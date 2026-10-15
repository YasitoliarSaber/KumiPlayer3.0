/**
 * 读取 Main 在受控应用协议中注入的样式 nonce。
 *
 * 开发模式没有该元数据；此时不传 nonce，也不放宽任何策略。
 */

export function readStyleNonce(doc: Document = document): string | undefined {
  const value = doc
    .querySelector('meta[name="kumiplayer-csp-nonce"]')
    ?.getAttribute('content')
    ?.trim();
  return value && value.length > 0 ? value : undefined;
}
