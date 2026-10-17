import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportPreviewSummary, ScanProgress, SourceScanRequest } from '@/shared/api/service';
import { demoQueryKeys, useMediaService, useSources } from '@/shared/api/service-context';

export type ImportMode = 'local' | 'tree' | 'openlist' | 'hybrid';
const ACTIVE = new Set(['queued', 'running', 'cancelling']);

/** 表单与扫描控制留在功能内；离开视图不取消后台扫描，按卡片身份恢复。 */
export function useImportSession(rootId: string, enabled: boolean) {
  const service = useMediaService();
  const queryClient = useQueryClient();
  const imports = useSources();
  const [mode, setMode] = useState<ImportMode>('local');
  const [rootPath, setRootPath] = useState('');
  const [treePath, setTreePath] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<'pan115' | 'baidu' | 'quark'>('pan115');
  const [connectionId, setConnectionId] = useState('');
  const [scope, setScope] = useState<'library' | 'ongoing'>('library');
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [preview, setPreview] = useState<ImportPreviewSummary | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const epoch = useRef(0);
  const initializedRoot = useRef('');
  const card = imports.data?.find((entry) => entry.id === rootId);
  const schedules = useQuery({
    queryKey: ['scan-schedules'], enabled: enabled && !!rootId,
    queryFn: () => service.listScanSchedules!(),
  });
  const selected = schedules.data?.find((entry) => entry.rootId === rootId);
  const restoredScanId = selected?.scan.scanId ?? '';

  useEffect(() => {
    epoch.current += 1;
    setScan(null); setPreview(null); setMessage(''); setError(false);
    setRootPath(''); setTreePath(''); setName(''); setConnectionId(''); setMode('local');
    initializedRoot.current = '';
  }, [rootId, enabled]);
  useEffect(() => {
    if (!selected || !card || initializedRoot.current === rootId) return;
    initializedRoot.current = rootId;
    const selectedMode = selected.sourceMode.includes('tree_openlist') ? 'hybrid'
      : selected.ingestMethod.includes('tree') || selected.sourceMode.includes('tree') ? 'tree'
      : selected.ingestMethod.includes('openlist') || selected.sourceMode.includes('openlist') ? 'openlist' : 'local';
    setMode(selectedMode);
    setScope(selected.contentScope === 'ongoing' ? 'ongoing' : 'library');
    if (selectedMode !== 'tree') setRootPath(card.scanPath ?? '');
    setConnectionId(card.connectionId === 'legacy' ? '' : card.connectionId ?? '');
    if (selected.provider === 'baidu' || selected.provider === 'pan115' || selected.provider === 'quark') setProvider(selected.provider);
  }, [selected, card, rootId, enabled]);
  const scanId = scan?.scanId || restoredScanId;
  const scanQuery = useQuery({
    queryKey: ['source-scan', scanId], enabled: enabled && !!scanId,
    queryFn: () => service.getSourceScan!(scanId),
    refetchInterval: (query) => ACTIVE.has(query.state.data?.status ?? 'queued') ? 1500 : false,
  });
  useEffect(() => { if (scanQuery.data) setScan(scanQuery.data); }, [scanQuery.data]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.sources });
    void queryClient.invalidateQueries({ queryKey: ['scan-schedules'] });
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.library });
  }, [queryClient]);
  const run = async (action: () => Promise<string>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(false); setMessage('');
    const current = epoch.current;
    try {
      const text = await action();
      if (epoch.current === current) setMessage(text);
    } catch (cause) {
      if (epoch.current === current) { setError(true); setMessage(cause instanceof Error ? cause.message : '操作未完成'); }
    } finally { lock.current = false; setBusy(false); refresh(); }
  };
  const start = (resume = false) => run(async () => {
    if (mode === 'local' && !rootPath.trim()) throw new Error('请填写要扫描的本地目录。');
    if ((mode === 'tree' || mode === 'hybrid') && !resume && !treePath.trim()) throw new Error('请提供这次导入或更新的目录树 TXT 文件。');
    const request: SourceScanRequest = {
      source: mode, contentScope: scope, scanMode: card?.hasConfirmedBaseline ? 'incremental' : 'full',
      ...(rootId ? { targetRootId: rootId } : {}),
      ...(resume && scanId ? { resumeScanId: scanId } : {}),
      ...(rootPath.trim() ? { rootPath: rootPath.trim() } : {}),
      ...(treePath.trim() ? { treeFile: treePath.trim() } : {}),
      ...(name.trim() ? { sourceDisplayName: name.trim() } : {}),
      ...(mode === 'tree' ? { provider } : {}),
      ...(connectionId ? { connectionId } : {}),
    };
    const current = epoch.current;
    const result = await service.startSourceScan!(request);
    if (epoch.current === current) { setScan(result); setPreview(null); }
    return '已开始扫描。可以返回总览，稍后从导入卡片继续查看。';
  });
  const cancel = () => run(async () => {
    if (!scanId) throw new Error('没有可取消的扫描');
    const current = epoch.current;
    const result = await service.cancelSourceScan!(scanId);
    if (current === epoch.current) setScan(result);
    return '已请求取消扫描。';
  });
  const review = () => run(async () => {
    if (!scanId) throw new Error('请先完成扫描');
    const current = epoch.current;
    const result = await service.previewImport!(scanId);
    if (current === epoch.current) setPreview(result);
    return '识别结果已准备好，请核对后确认。';
  });
  const confirm = () => run(async () => {
    if (!preview || preview.blockingIssueCount > 0) throw new Error('请先处理阻断问题');
    const current = epoch.current;
    const result = await service.confirmImport!(preview.revisionId);
    if (current === epoch.current) setPreview(null);
    return `已确认导入，派生 ${result.jobCount} 个后台作业，正在准备资料与图片。`;
  });
  const chooseMode = (next: ImportMode) => {
    if (next === mode) return;
    epoch.current += 1;
    setMode(next); setScan(null); setPreview(null); setMessage(''); setRootPath(''); setTreePath('');
  };
  return { card, mode, setMode: chooseMode, rootPath, setRootPath, treePath, setTreePath, name, setName,
    provider, setProvider, connectionId, setConnectionId, scope, setScope, scan, preview, message, error, busy,
    restoreError: schedules.error ?? scanQuery.error, start, cancel, review, confirm };
}
