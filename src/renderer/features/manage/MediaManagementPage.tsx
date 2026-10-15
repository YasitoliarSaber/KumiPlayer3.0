/**
 * 媒体管理：来源总览、导入三步流程（来源 → 审核 → 执行）与媒体库维护。
 *
 * 复刻当前应用 `source → review → execute` 的分段语义与来源卡操作；
 * 所有扫描、确认、删除都只作用于演示数据，并明确展示模拟结果。
 */

import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Database, FolderSearch, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import type { SourceCard } from '../../shared/api/service';
import {
  demoQueryKeys,
  useMediaService,
  useReviewIssues,
  useSources,
  useTasks,
} from '../../shared/api/service-context';
import { EmptySurface, ErrorSurface, LoadingSurface, ProgressBar, StatusChip } from '../../shared/ui/Surface';
import styles from './MediaManagementPage.module.css';

type ManageMode = 'overview' | 'import' | 'maintenance';

const MODE_TITLE: Record<ManageMode, string> = {
  overview: '媒体库',
  import: '导入媒体',
  maintenance: '媒体库维护',
};

export function MediaManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const mode = (searchParams.get('view') as ManageMode | null) ?? 'overview';
  const [importSourceId, setImportSourceId] = useState('src-openlist');

  const goMode = useCallback(
    (next: ManageMode) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'overview') {
        params.delete('view');
      } else {
        params.set('view', next);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <section className={styles.page} data-route="manage">
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>{MODE_TITLE[mode]}</h1>
          <p className={styles.subtitle}>
            {mode === 'overview'
              ? '管理已登记的媒体来源；扫描、确认与维护都只作用于演示数据。'
              : mode === 'import'
                ? '选择来源并扫描，审核识别结果后确认执行；离开本页可恢复批次状态。'
                : '缓存预览、显式确认与状态重置；真实实现中源媒体永不被递归删除。'}
          </p>
        </div>
        <div className={styles.headerActions}>
          {mode === 'overview' ? (
            <>
              <Button variant="outline" leftSection={<ShieldCheck size={15} />} onClick={() => goMode('maintenance')}>
                媒体库维护
              </Button>
              <Button leftSection={<FolderSearch size={15} />} onClick={() => goMode('import')}>
                导入媒体
              </Button>
            </>
          ) : (
            <Button variant="outline" leftSection={<ArrowLeft size={15} />} onClick={() => goMode('overview')}>
              返回媒体库
            </Button>
          )}
        </div>
      </header>

      {mode === 'overview' ? <SourceOverview onCreateTasks={() => goMode('import')} onOpenTasks={() => navigate('/tasks')} /> : null}
      {mode === 'import' ? (
        <ImportFlow
          sourceId={importSourceId}
          onSelectSource={setImportSourceId}
          onOpenTasks={() => navigate('/tasks')}
        />
      ) : null}
      {mode === 'maintenance' ? <MaintenancePanel /> : null}
    </section>
  );
}

function SourceOverview({
  onCreateTasks,
  onOpenTasks,
}: {
  readonly onCreateTasks: () => void;
  readonly onOpenTasks: () => void;
}) {
  const sources = useSources();
  const tasks = useTasks();
  const service = useMediaService();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.sources });
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.tasks });
  }, [queryClient]);

  if (sources.isPending) {
    return <LoadingSurface label="正在读取来源" detail="正在读取演示来源卡" />;
  }
  if (sources.isError) {
    return <ErrorSurface detail={sources.error?.message ?? '来源读取失败'} onRetry={() => void sources.refetch()} />;
  }

  const cards = sources.data ?? [];

  return (
    <div className={styles.overview}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarCount}>共 {cards.length} 个来源</span>
        <div className={styles.toolbarActions}>
          <Button size="xs" variant="outline" onClick={onOpenTasks}>
            打开任务中心
          </Button>
          <Button size="xs" variant="outline" onClick={onCreateTasks}>
            新建导入
          </Button>
        </div>
      </div>

      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      {cards.length === 0 ? (
        <EmptySurface
          kicker="来源"
          title="还没有登记来源"
          detail="演示数据当前为空；可以在开发入口切回默认场景后重新查看。"
        />
      ) : (
        <div className={styles.sourceGrid}>
          {cards.map((card) => (
            <SourceCardView
              key={card.id}
              card={card}
              activeTaskTitle={
                tasks.data?.find((task) => task.id === card.activeTaskId)?.title ?? ''
              }
              onScan={() =>
                void service.startScan(card.id).then((task) => {
                  setNotice(`已发起扫描（演示）：${card.name} · 任务 ${task.id.slice(-6)}`);
                  refresh();
                })
              }
              onOpenTasks={onOpenTasks}
              onReview={() => setNotice(`演示：打开来源「${card.name}」的识别结果（前往导入审核步骤）`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceCardView({
  card,
  activeTaskTitle,
  onScan,
  onReview,
  onOpenTasks,
}: {
  readonly card: SourceCard;
  readonly activeTaskTitle: string;
  readonly onScan: () => void;
  readonly onReview: () => void;
  readonly onOpenTasks: () => void;
}) {
  const tone = card.status === 'scanning' ? 'info' : card.status === 'needs_attention' ? 'warning' : 'neutral';
  return (
    <article className={styles.sourceCard}>
      <header className={styles.sourceHead}>
        <div className={styles.sourceName}>
          <Database size={16} aria-hidden="true" />
          <span>{card.name}</span>
        </div>
        <StatusChip tone={tone}>{card.statusLabel}</StatusChip>
      </header>
      <div className={styles.sourceMeta}>
        <span>{card.providerLabel}</span>
        <span>{card.contentScope === 'ongoing' ? '新番来源' : '媒体库来源'}</span>
        <span>{card.workCount} 部作品</span>
      </div>
      <p className={styles.sourceLocation} title={card.location}>
        {card.location}
      </p>
      <p className={styles.sourceMessage}>
        最近扫描：{card.lastScanAt.slice(0, 16).replace('T', ' ')}
        {card.message ? ` · ${card.message}` : ''}
      </p>
      {activeTaskTitle ? (
        <div className={styles.sourceTask}>
          <ProgressBar value={null} label={`${card.name}任务进度`} />
          <span>{activeTaskTitle}</span>
        </div>
      ) : null}
      <div className={styles.sourceActions}>
        {card.canResume ? (
          <Button size="xs" onClick={onReview}>
            查看识别结果
          </Button>
        ) : null}
        {card.activeTaskId ? (
          <Button size="xs" variant="outline" onClick={onOpenTasks}>
            查看进度
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={onScan}>
            开始扫描
          </Button>
        )}
      </div>
    </article>
  );
}

const IMPORT_STEPS = ['选择来源', '扫描来源', '审核识别结果', '确认并执行'] as const;

function ImportFlow({
  sourceId,
  onSelectSource,
  onOpenTasks,
}: {
  readonly sourceId: string;
  readonly onSelectSource: (sourceId: string) => void;
  readonly onOpenTasks: () => void;
}) {
  const sources = useSources();
  const tasks = useTasks();
  const issues = useReviewIssues(sourceId);
  const service = useMediaService();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [scanTaskId, setScanTaskId] = useState('');
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');

  const scanTask = tasks.data?.find((task) => task.id === scanTaskId);
  const blockingIssues = (issues.data ?? []).filter((issue) => issue.severity === 'blocking');
  const allDecided = blockingIssues.every((issue) => decisions[issue.id]);

  useEffect(() => {
    if (step === 1 && scanTask?.status === 'succeeded') {
      setStep(2);
    }
  }, [scanTask?.status, step]);

  const cards = sources.data ?? [];
  const selected = cards.find((card) => card.id === sourceId) ?? cards[0];

  // 来源仍在读取时必须先给出加载态：否则选择列表为空，
  // "开始扫描"按钮会静默无效。
  if (sources.isPending) {
    return <LoadingSurface label="正在读取来源" detail="正在准备可导入的来源列表" />;
  }
  if (sources.isError) {
    return (
      <ErrorSurface
        detail={sources.error?.message ?? '来源读取失败'}
        onRetry={() => void sources.refetch()}
      />
    );
  }

  return (
    <div className={styles.importFlow}>
      <ol className={styles.steps}>
        {IMPORT_STEPS.map((label, index) => (
          <li key={label} className={index === step ? styles.stepActive : index < step ? styles.stepDone : styles.step}>
            <span className={styles.stepIndex}>{index + 1}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      <div className={styles.stepBody}>
        {step === 0 ? (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>选择要导入的来源</h2>
            <fieldset className="flex flex-col gap-2.5">
              <div className={styles.sourceChoices}>
                {cards.map((card) => (
                  <label key={card.id} className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                    <input
                      type="radio"
                      name="import-source"
                      value={card.id}
                      checked={card.id === sourceId}
                      onChange={() => onSelectSource(card.id)}
                      className="mt-1 size-3.5 accent-[var(--primary)]"
                    />
                    <span className="flex flex-col">
                      <span>{`${card.name} · ${card.providerLabel} · ${card.workCount} 部`}</span>
                      <span className="text-[12px] text-muted-foreground">{card.location}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={styles.panelActions}>
              <Button
                onClick={() => {
                  if (!selected) {
                    return;
                  }
                  void service.startScan(selected.id).then((task) => {
                    setScanTaskId(task.id);
                    setStep(1);
                    setNotice(`已发起扫描（演示）：${selected.name}`);
                    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.tasks });
                  });
                }}
                disabled={!selected}
              >
                开始扫描
              </Button>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>正在扫描来源</h2>
            <ProgressBar value={null} label="演示扫描进度" size={4} />
            <p className={styles.panelHint}>
              扫描在演示模式下由本机计时器模拟，不会访问真实来源，也不会写入数据库。
            </p>
            <div className={styles.panelActions}>
              <Button variant="outline" onClick={onOpenTasks}>
                打开任务中心
              </Button>
              <Button variant="outline" onClick={() => setStep(2)}>
                跳过等待，直接审核
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>审核识别结果</h2>
            <p className={styles.panelHint}>
              阻断性问题必须先处理；处理完成后才能确认修订并进入执行。
            </p>
            <ul className={styles.issueList}>
              {(issues.data ?? []).map((issue) => (
                <li key={issue.id} className={styles.issue}>
                  <div className={styles.issueHead}>
                    <StatusChip tone={issue.severity === 'blocking' ? 'danger' : 'warning'}>
                      {issue.severity === 'blocking' ? '阻断' : '提示'}
                    </StatusChip>
                    <strong>{issue.title}</strong>
                  </div>
                  <p className={styles.issueDetail}>{issue.detail}</p>
                  {issue.candidates.length > 0 ? (
                    <Select
                      value={decisions[issue.id] ?? ''}
                      onValueChange={(value) =>
                        setDecisions((current) => ({ ...current, [issue.id]: value }))
                      }
                    >
                      <SelectTrigger size="sm" aria-label={`${issue.title}处理方式`} className="w-full">
                        <SelectValue placeholder="选择处理方式" />
                      </SelectTrigger>
                      <SelectContent>
                        {issue.candidates.map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            {candidate.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className={styles.panelActions}>
              <span
                className="inline-flex"
                title={allDecided ? '确认修订（演示）' : '请先处理所有阻断性识别问题'}
              >
                <Button
                  disabled={!allDecided || !selected}
                  onClick={() => {
                    if (!selected) {
                      return;
                    }
                    void service.confirmRevision(selected.id, decisions).then((task) => {
                      setStep(3);
                      setNotice(`已确认修订（演示）：任务 ${task.id.slice(-6)}`);
                      void queryClient.invalidateQueries({ queryKey: demoQueryKeys.tasks });
                    });
                  }}
                >
                  确认并执行
                </Button>
              </span>
              <Button variant="outline" onClick={() => setStep(0)}>
                返回选择来源
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>执行与发布（演示）</h2>
            <ProgressBar value={null} label="演示执行进度" size={4} />
            <p className={styles.panelHint}>
              真实链路由 confirmed revision 驱动资料快照、图片准备与媒体库投影；
              演示模式只展示同样的状态变化。
            </p>
            <div className={styles.panelActions}>
              <Button variant="outline" onClick={onOpenTasks}>
                查看任务详情
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setStep(0);
                  setDecisions({});
                  setNotice('');
                }}
              >
                重新开始
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MaintenancePanel() {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [result, setResult] = useState('');
  const service = useMediaService();
  const queryClient = useQueryClient();

  const maintenanceRows = useMemo(
    () => [
      { label: '图片派生缓存', detail: '可回收的派生尺寸缓存；手工原图与共享内容永不删除。' },
      { label: '投影重建', detail: '从 SQLite 权威重建可删除的媒体库投影，不改写媒体事实。' },
      { label: '来源移除', detail: '只退役受控记录；未配置时不猜测任何文件删除范围。' },
    ],
    [],
  );

  return (
    <div className={styles.maintenance}>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>维护预览与确认</h2>
        <p className={styles.panelHint}>
          真实实现必须先预览影响范围再执行；演示模式不会触碰任何真实文件或数据库。
        </p>
        <ul className={styles.maintenanceList}>
          {maintenanceRows.map((row) => (
            <li key={row.label} className={styles.maintenanceRow}>
              <div>
                <strong>{row.label}</strong>
                <p className={styles.issueDetail}>{row.detail}</p>
              </div>
              <Button size="xs" variant="outline" onClick={() => setPreviewOpen(true)}>
                预览
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <div className={`${styles.panel} ${styles.dangerPanel}`}>
        <h2 className={styles.panelTitle}>重置演示状态</h2>
        <p className={styles.panelHint}>
          清空本机演示收藏、进度与设置，回到默认场景。不会影响任何真实用户配置。
        </p>
        <div className={styles.panelActions}>
          <Button
            variant="destructive"
            onClick={() => setResetOpen(true)}
            leftSection={<AlertTriangle size={15} />}
          >
            重置演示数据
          </Button>
        </div>
      </div>

      {result ? (
        <p className={styles.notice} role="status">
          {result}
        </p>
      ) : null}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent>
        <DialogHeader>
          <DialogTitle>维护预览（演示）</DialogTitle>
        </DialogHeader>
        <p className={styles.panelHint}>
          演示预览：影响 0 个真实文件、0 条真实记录。真实实现会给出精确的范围、数量与不可恢复项。
        </p>
        <DialogFooter className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setPreviewOpen(false);
              setResult('演示：已确认 1 项维护操作（未写入任何真实数据）');
            }}
          >
            确认执行
          </Button>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
        </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
        <DialogHeader>
          <DialogTitle>确认重置演示数据</DialogTitle>
        </DialogHeader>
        <p className={styles.panelHint}>
          该操作只清除本机演示存储（收藏、进度、设置与场景），不可恢复。
        </p>
        <DialogFooter className="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            onClick={() => {
              void service.resetDemoData().then(() => {
                setResetOpen(false);
                setResult('演示数据已重置：收藏、进度与设置回到默认值');
                void queryClient.invalidateQueries();
              });
            }}
          >
            确认重置
          </Button>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
        </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
