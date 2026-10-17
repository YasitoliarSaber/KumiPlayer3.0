/**
 * 媒体管理（真实后端模式）。
 *
 * 四段式与后端合同一一对应：
 *   选择来源/导入方式 → durable SourceScan（可取消、可继续）→ 识别预览（draft revision）
 *   → 确认后写入 V4 jobs（后台执行，离开页面不取消）。
 *
 * 约束：
 * - 扫描 / revision / jobs 是三个独立模型：这里分别展示，不把 jobs 的 0/1 拟合成连续百分比。
 * - 文件可访问性检测不称为完整性校验；页面不新增哈希或解码任务。
 * - TXT（目录树 / 混合）的路径由后端在服务端读取；浏览器不能上传任意文件时如实说明。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, FolderOpen, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';

import type { ImportPreviewSummary, ScanProgress, SourceScanSchedule, TaskEntry } from '../../shared/api/service';
import { demoQueryKeys, useLibrary, useMediaService } from '../../shared/api/service-context';
import { StatusChip } from '../../shared/ui/Surface';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { SegmentedControl } from '@/shared/ui/segmented';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/ui/sheet';
import styles from './MediaManagementPage.module.css';

type ImportMode = 'local' | 'tree' | 'openlist' | 'hybrid';

const MODES: ReadonlyArray<{ value: ImportMode; label: string }> = [
  { value: 'local', label: '本地目录' },
  { value: 'tree', label: '目录树 TXT' },
  { value: 'openlist', label: 'OpenList' },
  { value: 'hybrid', label: 'TXT + OpenList 增量' },
];

const ACTIVE_SCAN_STATES = new Set(['queued', 'running', 'paused']);

export function RealSourceImportView() {
  const service = useMediaService();
  const queryClient = useQueryClient();
  const library = useLibrary();

  const [mode, setMode] = useState<ImportMode>('openlist');
  const [targetRootId, setTargetRootId] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [treePath, setTreePath] = useState('');
  const [scope, setScope] = useState<'library' | 'ongoing'>('library');
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [preview, setPreview] = useState<ImportPreviewSummary | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const schedules = useQuery({
    queryKey: ['scan-schedules'],
    enabled: typeof service.listScanSchedules === 'function',
    queryFn: () => service.listScanSchedules!(),
    refetchInterval: 5000,
  });

  const tasks = useQuery({
    queryKey: ['manage-tasks'],
    enabled: typeof service.listTasks === 'function',
    queryFn: () => service.listTasks!(),
    refetchInterval: 2000,
  });

  // 扫描状态由后端权威提供；只有活跃扫描才轮询，终态停止。
  const activeScanId = scan && ACTIVE_SCAN_STATES.has(scan.status) ? scan.scanId : '';
  const scanQuery = useQuery({
    queryKey: ['source-scan', activeScanId],
    enabled: activeScanId !== '' && typeof service.getSourceScan === 'function',
    queryFn: () => service.getSourceScan!(activeScanId),
    refetchInterval: 1500,
  });
  useEffect(() => {
    if (scanQuery.data) {
      setScan((current) => (current && current.scanId === scanQuery.data!.scanId ? scanQuery.data! : current));
    }
  }, [scanQuery.data]);

  const sourceOptions = useMemo(
    () => (schedules.data ?? []).map((source) => ({ source, label: `${source.displayName}（${source.provider}）` })),
    [schedules.data],
  );

  const run = useCallback(
    async (label: string, action: () => Promise<string>) => {
      setBusy(true);
      try {
        setMessage(await action());
      } catch (error) {
        setMessage(`${label}未完成：${error instanceof Error ? error.message : '后端拒绝'}`);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const scanFor = (
    input: {
      readonly resume?: SourceScanSchedule;
      readonly rootId?: string;
      readonly source?: ImportMode;
      readonly contentScope?: 'library' | 'ongoing';
      readonly path?: string;
      readonly tree?: string;
    } = {},
  ) =>
    run('开始扫描', async () => {
      if (!service.startSourceScan) {
        throw new Error('当前服务没有扫描能力');
      }
      const resume = input.resume;
      const effectiveSource = input.source ?? mode;
      const effectiveRootId = input.rootId ?? targetRootId;
      const effectivePath = input.path ?? rootPath.trim();
      const effectiveTree = input.tree ?? treePath.trim();
      const result = await service.startSourceScan({
        source: effectiveSource,
        contentScope: input.contentScope ?? scope,
        scanMode: 'incremental',
        ...(resume ? { targetRootId: resume.rootId, resumeScanId: resume.scan.scanId } : {}),
        ...(!resume && effectiveRootId ? { targetRootId: effectiveRootId } : {}),
        ...(!resume && effectivePath ? { rootPath: effectivePath } : {}),
        ...(!resume && effectiveTree ? { treeFile: effectiveTree } : {}),
      });
      setScan(result);
      setPreview(null);
      void schedules.refetch();
      return `扫描已创建：${result.stageLabel || result.status}（${result.status}）。离开本页不会取消扫描。`;
    });

  const cancelScan = () =>
    run('取消扫描', async () => {
      if (!scan || !service.cancelSourceScan) {
        throw new Error('没有可取消的扫描');
      }
      const result = await service.cancelSourceScan(scan.scanId);
      setScan(result);
      return '已请求取消扫描。';
    });

  const buildPreview = () =>
    run('识别预览', async () => {
      if (!scan || !service.previewImport) {
        throw new Error('请先完成一次扫描');
      }
      const result = await service.previewImport(scan.scanId);
      setPreview(result);
      return `识别预览已生成：${result.workCount} 部作品 / ${result.episodeCount} 个剧集，阻断问题 ${result.blockingIssueCount} 个。`;
    });

  const confirmImport = () =>
    run('确认导入', async () => {
      if (!preview || !service.confirmImport) {
        throw new Error('请先生成识别预览');
      }
      if (preview.blockingIssueCount > 0) {
        throw new Error('仍有阻断识别问题，先在预览里处理后再确认');
      }
      const result = await service.confirmImport(preview.revisionId);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: demoQueryKeys.library });
      void tasks.refetch();
      return `已确认 revision，派生 ${result.jobCount} 个后台作业（资料与图片在后台执行）。`;
    });

  const cancelImport = () =>
    run('取消导入', async () => {
      if (!preview || !service.cancelImport) {
        throw new Error('没有可取消的导入');
      }
      const result = await service.cancelImport(preview.revisionId);
      setPreview(null);
      return `已取消 ${result.cancelled} 个作业（仍在运行 ${result.running} 个）。`;
    });

  const works = library.data?.works.length ?? 0;
  const runningTasks = (tasks.data ?? []).filter((task) => task.status === 'running' || task.status === 'queued').length;
  const failedTasks = (tasks.data ?? []).filter((task) => task.status === 'failed').length;
  const draftCount = (schedules.data ?? []).filter((source) => source.revision.draftRevisionId !== '').length;

  return (
    <section className={styles.page} data-route="manage">
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>媒体管理</h1>
          <p className={styles.subtitle}>
            扫描 → 识别预览 → 确认导入；扫描与任务都在后端持久执行，离开本页不会取消。
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="outline" size="sm" onClick={() => void schedules.refetch()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            刷新来源
          </Button>
        </div>
      </header>

      {message ? (
        <p className={styles.notice} role="status">
          {message}
        </p>
      ) : null}

      <section className={styles.panel} aria-label="状态摘要">
        <h2 className={styles.panelTitle}>状态摘要</h2>
        <div className="flex flex-wrap gap-6 pt-1 text-[13px]">
          <Metric label="已入库作品" value={works} />
          <Metric label="进行中任务" value={runningTasks} />
          <Metric label="失败任务" value={failedTasks} tone={failedTasks > 0 ? 'danger' : undefined} />
          <Metric label="待识别草稿" value={draftCount} />
        </div>
        <p className={styles.panelHint}>
          这里分开显示扫描、识别草稿与后台作业；数字都来自后端真实行，没有连续进度百分比。
        </p>
      </section>

      <section className={styles.panel} aria-label="导入媒体">
        <h2 className={styles.panelTitle}>导入媒体</h2>
        <div className="flex flex-col gap-3 pt-1">
          <SegmentedControl
            ariaLabel="导入方式"
            value={mode}
            onValueChange={(value) => setMode(value)}
            options={MODES}
          />

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              已登记来源（重扫 / 更新同一来源）
              <select
                className="h-8 min-w-[14rem] rounded-md border border-input bg-card px-2 text-[13px] text-foreground"
                value={targetRootId}
                aria-label="已登记来源"
                onChange={(event) => setTargetRootId(event.currentTarget.value)}
              >
                <option value="">不选择</option>
                {sourceOptions.map((option) => (
                  <option key={option.source.rootId} value={option.source.rootId}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              内容作用域
              <select
                className="h-8 rounded-md border border-input bg-card px-2 text-[13px] text-foreground"
                value={scope}
                aria-label="内容作用域"
                onChange={(event) => setScope(event.currentTarget.value === 'ongoing' ? 'ongoing' : 'library')}
              >
                <option value="library">媒体库（新结果需确认）</option>
                <option value="ongoing">新番（复用追更规则）</option>
              </select>
            </label>
          </div>

          {mode === 'local' || mode === 'hybrid' ? (
            <label className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              本地目录绝对路径（后端在服务端读取）
              <Input
                value={rootPath}
                onChange={(event) => setRootPath(event.currentTarget.value)}
                placeholder="D:\\Media\\Anime"
                aria-label="本地目录路径"
              />
            </label>
          ) : null}

          {mode === 'tree' || mode === 'hybrid' ? (
            <div className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              <label className="flex flex-col gap-1">
                目录树 TXT 路径（后端在服务端读取，浏览器不上传任意文件）
                <Input
                  value={treePath}
                  onChange={(event) => setTreePath(event.currentTarget.value)}
                  placeholder="E:\\export\\115_tree.txt"
                  aria-label="目录树 TXT 路径"
                />
              </label>
              <span>
                整盘 / 祖先目录 / 直接挂载都使用同一套定位规则；纯 TXT 来源刷新需重新导出清单，不把旧归档当网盘新事实。
              </span>
            </div>
          ) : null}

          <div className={styles.panelActions}>
            <Button
              variant="default"
              size="sm"
              loading={busy}
              disabled={typeof service.startSourceScan !== 'function'}
              onClick={() => void scanFor()}
            >
              <Database className="size-3.5" aria-hidden="true" />
              开始扫描
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={busy}
              disabled={!scan || typeof service.previewImport !== 'function'}
              onClick={() => void buildPreview()}
            >
              生成识别预览
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={busy}
              disabled={!scan || !scan.canCancel || typeof service.cancelSourceScan !== 'function'}
              onClick={() => void cancelScan()}
            >
              <XCircle className="size-3.5" aria-hidden="true" />
              取消扫描
            </Button>
          </div>

          {scan ? (
            <div className="flex flex-col gap-1 rounded-md border border-border bg-card px-3 py-2 text-[12.5px]">
              <span className="font-medium text-foreground">扫描 {scan.scanId.slice(0, 12)}…</span>
              <span className="text-muted-foreground">
                状态 {scan.status} · 阶段 {scan.stageLabel || scan.stage || '未开始'}
                {scan.totalCount > 0 ? ` · 已处理 ${scan.processedCount}/${scan.totalCount}` : ''}
                {scan.currentDirectory ? ` · ${scan.currentDirectory}` : ''}
              </span>
              {scan.error ? <span className="text-[var(--destructive)]">{scan.error}</span> : null}
              {scan.resumable ? (
                <span className="flex items-center gap-2">
                  扫描已暂停，可在来源列表中「继续扫描」并在断点续扫。
                </span>
              ) : null}
            </div>
          ) : null}

          {preview ? (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 text-[12.5px]">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">审核识别结果</span>
                <StatusChip tone={preview.blockingIssueCount > 0 ? 'danger' : 'success'}>
                  {preview.blockingIssueCount > 0 ? `${preview.blockingIssueCount} 个阻断问题` : '无阻断问题'}
                </StatusChip>
              </div>
              <span className="text-muted-foreground">
                revision {preview.revisionId.slice(0, 12)}… · 作品 {preview.workCount} · 剧集 {preview.episodeCount} · 问题 {preview.issues.length}
              </span>
              <ul className={styles.issueList}>
                {preview.issues.slice(0, 8).map((issue) => (
                  <li key={issue.id} className={styles.issue}>
                    <div className={styles.issueHead}>
                      <StatusChip tone={issue.severity === 'blocking' ? 'danger' : 'warning'}>
                        {issue.severity === 'blocking' ? '阻断' : '提示'}
                      </StatusChip>
                      <span>{issue.title}</span>
                    </div>
                    <span className={styles.issueDetail}>{issue.detail}</span>
                  </li>
                ))}
              </ul>
              <div className={styles.panelActions}>
                <Button
                  variant="default"
                  size="sm"
                  loading={busy}
                  disabled={preview.blockingIssueCount > 0}
                  onClick={() => void confirmImport()}
                >
                  <FolderOpen className="size-3.5" aria-hidden="true" />
                  确认并执行
                </Button>
                <Button variant="outline" size="sm" loading={busy} onClick={() => void cancelImport()}>
                  取消导入
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className={styles.panel} aria-label="内容来源">
        <h2 className={styles.panelTitle}>内容来源</h2>
        {schedules.isPending ? <p className={styles.panelHint}>正在读取来源…</p> : null}
        {schedules.isError ? (
          <p className={styles.panelHint}>
            来源读取失败：{schedules.error instanceof Error ? schedules.error.message : '后端拒绝'}
          </p>
        ) : null}
        <div className={styles.sourceGrid}>
          {(schedules.data ?? []).map((source) => (
            <article key={source.rootId} className={styles.sourceCard}>
              <div className={styles.sourceHead}>
                <span className={styles.sourceName}>{source.displayName}</span>
                <StatusChip
                  tone={
                    source.status === 'needs_attention' || source.jobs.failed > 0
                      ? 'danger'
                      : source.status === 'running'
                        ? 'info'
                        : 'neutral'
                  }
                >
                  {source.status}
                </StatusChip>
              </div>
              <span className={styles.sourceMeta}>
                {source.provider} · {source.contentScope === 'ongoing' ? '新番' : '媒体库'} · {source.ingestMethod || source.sourceMode}
              </span>
              <span className={styles.sourceLocation}>{source.scan.message || source.reason || '—'}</span>
              <span className={styles.sourceMeta}>
                调度 {source.schedule.enabled ? `每 ${source.schedule.intervalMinutes} 分钟` : '未启用'}
                {source.schedule.nextRunAt ? ` · 下次 ${source.schedule.nextRunAt.slice(5, 16).replace('T', ' ')}` : ''}
              </span>
              <span className={styles.sourceMeta}>
                作业 排队 {source.jobs.queued} · 运行 {source.jobs.running} · 失败 {source.jobs.failed}
                {source.revision.draftRevisionId ? ' · 有待确认草稿' : ''}
              </span>
              <div className={styles.sourceActions}>
                <Button
                  variant="outline"
                  size="xs"
                  loading={busy}
                  onClick={() => {
                    setTargetRootId(source.rootId);
                    setMode(source.provider === 'openlist' ? 'openlist' : 'local');
                    setScope(source.contentScope === 'ongoing' ? 'ongoing' : 'library');
                    void scanFor({
                      rootId: source.rootId,
                      source: source.provider === 'openlist' ? 'openlist' : 'local',
                      contentScope: source.contentScope === 'ongoing' ? 'ongoing' : 'library',
                    });
                  }}
                >
                  开始扫描
                </Button>
                {source.scan.canResume ? (
                  <Button
                    variant="outline"
                    size="xs"
                    loading={busy}
                    onClick={() => void scanFor({ resume: source })}
                  >
                    继续扫描
                  </Button>
                ) : null}
                {source.scan.canCancel ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    loading={busy}
                    onClick={() =>
                      run('取消扫描', async () => {
                        if (!service.cancelSourceScan) {
                          throw new Error('当前服务没有取消能力');
                        }
                        await service.cancelSourceScan(source.scan.scanId);
                        void schedules.refetch();
                        return `已请求取消「${source.displayName}」的扫描。`;
                      })
                    }
                  >
                    取消扫描
                  </Button>
                ) : null}
                {source.status === 'needs_new_txt' ? (
                  <span className="text-[12px] text-muted-foreground">
                    纯 TXT 来源需要重新导出清单后再扫描。
                  </span>
                ) : null}
              </div>
            </article>
          ))}
          {!schedules.isPending && (schedules.data ?? []).length === 0 ? (
            <p className={styles.panelHint}>还没有登记任何来源。先在「设置 → 媒体来源」登记本地目录或 OpenList。</p>
          ) : null}
        </div>
      </section>

      <section className={styles.panel} aria-label="扫描与任务">
        <h2 className={styles.panelTitle}>扫描与任务</h2>
        <p className={styles.panelHint}>
          任务状态来自后端任务表；失败可重试，可取消的任务才显示取消。作业没有连续百分比。
        </p>
        <TaskTable
          tasks={tasks.data ?? []}
          onRetry={(taskId) =>
            run('重试任务', async () => {
              if (!service.retryTask) {
                throw new Error('当前服务没有重试能力');
              }
              await service.retryTask(taskId);
              void tasks.refetch();
              return `已重新排队 ${taskId}。`;
            })
          }
          onCancel={(taskId) =>
            run('取消任务', async () => {
              if (!service.cancelTask) {
                throw new Error('当前服务没有取消能力');
              }
              await service.cancelTask(taskId);
              void tasks.refetch();
              return `已请求取消 ${taskId}。`;
            })
          }
        />
      </section>
    </section>
  );
}

function Metric({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone?: 'danger' }) {
  return (
    <span className="flex flex-col">
      <span
        className="text-[20px] font-semibold tabular-nums"
        style={tone === 'danger' && value > 0 ? { color: 'var(--destructive)' } : undefined}
      >
        {value}
      </span>
      <span className="text-[12px] text-muted-foreground">{label}</span>
    </span>
  );
}

function TaskTable({
  tasks,
  onRetry,
  onCancel,
}: {
  readonly tasks: readonly TaskEntry[];
  readonly onRetry: (taskId: string) => void;
  readonly onCancel: (taskId: string) => void;
}) {
  const [detail, setDetail] = useState<TaskEntry | null>(null);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="text-[12px] text-muted-foreground">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-normal">任务</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">类型</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">状态</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">摘要</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} className="border-t border-border align-top">
                <td className="py-2 pr-3 font-mono text-[12px]">{task.id.slice(0, 14)}…</td>
                <td className="py-2 pr-3">{task.type}</td>
                <td className="py-2 pr-3">
                  <StatusChip
                    tone={
                      task.status === 'failed'
                        ? 'danger'
                        : task.status === 'running' || task.status === 'queued'
                          ? 'info'
                          : task.status === 'cancelled'
                            ? 'warning'
                            : 'success'
                    }
                  >
                    {task.status}
                  </StatusChip>
                </td>
                <td className="max-w-[28rem] py-2 pr-3 text-muted-foreground">
                  {task.error || task.message || '—'}
                </td>
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Button variant="ghost" size="xs" onClick={() => setDetail(task)}>
                      详情
                    </Button>
                    {task.status === 'failed' ? (
                      <Button variant="outline" size="xs" onClick={() => onRetry(task.id)}>
                        重试
                      </Button>
                    ) : null}
                    {task.cancellable ? (
                      <Button variant="ghost" size="xs" onClick={() => onCancel(task.id)}>
                        取消
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tasks.length === 0 ? <p className={styles.panelHint}>还没有任务。</p> : null}
      </div>

      <Sheet open={detail !== null} onOpenChange={(open) => (open ? undefined : setDetail(null))}>
        <SheetContent aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>任务详情</SheetTitle>
            <SheetDescription>真实任务行，不含连续百分比。</SheetDescription>
          </SheetHeader>
          {detail ? (
            <dl className="flex flex-col gap-1.5 text-[13px]">
              <DetailRow label="任务 ID" value={detail.id} />
              <DetailRow label="类型" value={detail.type} />
              <DetailRow label="来源" value={detail.sourceName || detail.sourceId || '—'} />
              <DetailRow label="状态" value={detail.status} />
              <DetailRow label="范围" value={detail.scope || '—'} />
              <DetailRow label="创建" value={detail.createdAt || '—'} />
              <DetailRow label="开始" value={detail.startedAt || '—'} />
              <DetailRow label="结束" value={detail.finishedAt || '—'} />
              <DetailRow label="摘要" value={detail.message || '—'} />
              <DetailRow label="错误" value={detail.error || '—'} />
            </dl>
          ) : null}
          {detail?.status === 'failed' ? (
            <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <ShieldAlert className="size-3.5" aria-hidden="true" />
              失败任务可在列表中重试；重试不会改写已确认的来源证据。
            </p>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  );
}
