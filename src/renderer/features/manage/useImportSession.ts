import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ImportPreviewSummary,
  ScanMappingChoice,
  ScanProgress,
  SourceScanRequest,
} from '@/shared/api/service';
import { demoQueryKeys, useMediaService, useSources } from '@/shared/api/service-context';

export type ImportMode = 'local' | 'tree' | 'openlist' | 'hybrid';
const ACTIVE = new Set(['queued', 'running', 'cancelling']);

const STARTED_NOTICE = '已开始扫描。可以返回总览，稍后从导入卡片继续查看。';
const STALE_MAPPING_NOTICE = '路径选择已过期，请核对当前候选';

/**
 * 路径多解：后端 HTTP 200 返回 `status='mapping_required'` + 空 `scan_id` + `path_validation`
 * （`backend/app/api/media_v4.py:541-549`），这次调用**没有登记任何扫描、没有启动 runner**
 * （`backend/app/api/media_v4.py:1865-1867` 就在 return），所以不能当成"已开始扫描"。
 */
export interface ImportMappingState {
  readonly choices: readonly ScanMappingChoice[];
  readonly reason: string;
  readonly mappingMode: string;
  readonly mappingScope: string;
  readonly root: string;
  readonly pathSamples: readonly string[];
}

/** 多解分支的判定：状态为 `mapping_required`，或响应带回了可选候选。 */
function requiresMapping(result: ScanProgress): boolean {
  // `mapping` 缺省时按"没有候选"处理，不能因为字段缺失就抛错。
  return result.status === 'mapping_required' || (result.mapping?.choices ?? []).length > 0;
}

function toMappingState(result: ScanProgress): ImportMappingState {
  return {
    choices: result.mapping?.choices ?? [],
    reason: result.mapping?.reason ?? '',
    mappingMode: result.mapping?.mappingMode ?? '',
    mappingScope: result.mapping?.mappingScope ?? '',
    root: result.mapping?.root ?? '',
    pathSamples: result.mapping?.pathSamples ?? [],
  };
}

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
  const [mapping, setMapping] = useState<ImportMappingState | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const epoch = useRef(0);
  const initializedRoot = useRef('');
  // 多解重发必须原样复现第一次提交：快照放 ref，表单后续改动不影响已提交的请求。
  const pendingRequest = useRef<SourceScanRequest | null>(null);
  const card = imports.data?.find((entry) => entry.id === rootId);
  const schedules = useQuery({
    queryKey: ['scan-schedules'], enabled: enabled && !!rootId,
    queryFn: () => service.listScanSchedules!(),
  });
  const selected = schedules.data?.find((entry) => entry.rootId === rootId);
  const restoredScanId = selected?.scan.scanId ?? '';

  useEffect(() => {
    epoch.current += 1;
    pendingRequest.current = null;
    setScan(null); setPreview(null); setMapping(null); setMessage(''); setError(false);
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
  // 多解分支没有登记任何扫描：等用户选择期间不借用旧扫描的编号去轮询。
  const scanId = scan?.scanId || (mapping ? '' : restoredScanId);
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
    if (epoch.current !== current) return STARTED_NOTICE;
    if (requiresMapping(result)) {
      // 这次调用没有创建扫描：保存候选与请求快照，保留全部表单输入，等用户显式选择。
      pendingRequest.current = request;
      setScan(null); setPreview(null); setMapping(toMappingState(result));
      return '需要选择目录映射后才能开始扫描：请确认这份 TXT / 来源目录对应的本地挂载位置。';
    }
    pendingRequest.current = null;
    setMapping(null); setScan(result); setPreview(null);
    return STARTED_NOTICE;
  });
  // 选定候选后用同一份请求快照重发；只有拿到非空 scan_id 才算真的开始。
  const chooseMapping = (choiceId: string) => run(async () => {
    const snapshot = pendingRequest.current;
    if (!snapshot) throw new Error('没有可提交的映射请求：请重新开始扫描。');
    const current = epoch.current;
    const result = await service.startSourceScan!({ ...snapshot, treeMappingChoice: choiceId });
    if (epoch.current !== current) return STARTED_NOTICE;
    if (requiresMapping(result)) {
      // 候选已过期（后端对失效选择返回 `state='ambiguous'` + 过期原因，
      // `backend/app/media_v4/sources/tree_root.py:380-383`）或仍未消歧：保留最新候选，绝不自动重发。
      setScan(null); setPreview(null); setMapping(toMappingState(result));
      return result.mapping?.reason.trim() || STALE_MAPPING_NOTICE;
    }
    if (!result.scanId) throw new Error('后端没有返回扫描编号：请重新开始扫描。');
    pendingRequest.current = null;
    setMapping(null); setScan(result); setPreview(null);
    return STARTED_NOTICE;
  });
  const cancelMapping = () => {
    if (!mapping) return;
    pendingRequest.current = null;
    setMapping(null); setError(false);
    setMessage('已取消映射选择，输入已保留。');
  };
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
    pendingRequest.current = null;
    setMode(next); setScan(null); setPreview(null); setMapping(null);
    setMessage(''); setRootPath(''); setTreePath('');
  };
  return { card, mode, setMode: chooseMode, rootPath, setRootPath, treePath, setTreePath, name, setName,
    provider, setProvider, connectionId, setConnectionId, scope, setScope, scan, preview, message, error, busy,
    mapping, chooseMapping, cancelMapping,
    restoreError: schedules.error ?? scanQuery.error, start, cancel, review, confirm };
}
