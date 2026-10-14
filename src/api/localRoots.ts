import type { LocalRootRecord, PublicConfig } from './config';

export function localRootRecords(config: Pick<PublicConfig, 'local_root' | 'local_roots'> | null): LocalRootRecord[] {
  if (config?.local_roots?.length) return config.local_roots;
  return config?.local_root ? [{ root_id: 'legacy-local', name: '本地媒体库', path: config.local_root }] : [];
}

/** 只作 Windows 路径词法比较，不访问目录。写入仍由后端校验。 */
export function localPathKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').toLocaleLowerCase();
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length > 1) parts.pop();
    else parts.push(part);
  }
  return `${normalized.startsWith('//') ? '//' : normalized.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}
