/**
 * 任务中心：等待 / 进行 / 成功 / 失败 / 已取消 的模拟状态汇总。
 * 后端只提供 0/1 进度，这里不伪造百分比，只区分"进行中"与"终态"。
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import type { TaskEntry, TaskStatus } from '../../shared/api/service';
import { demoQueryKeys, useMediaService, useTasks } from '../../shared/api/service-context';
import { EmptySurface, ErrorSurface, LoadingSurface, ProgressBar, StatusChip } from '../../shared/ui/Surface';
import { Button } from '@/shared/ui/button';
import { SegmentedControl } from '@/shared/ui/segmented';
import styles from './TaskCenter.module.css';

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '等待执行',
  paused: '已暂停（可继续）',
  queued: '等待中',
  running: '进行中',
  succeeded: '已完成',
  failed: '已失败',
  cancelled: '已取消',
  cancelling: '正在终止',
  unknown: '状态未知',
};

const STATUS_TONE: Record<TaskStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  pending: 'neutral',
  paused: 'warning',
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'warning',
  cancelling: 'warning',
  unknown: 'warning',
};

/**
 * 未开始的任务（后端 `pending`，见 `backend/app/api/tasks_v4.py:21`）属于"当前任务"，
 * 不是历史记录；状态未知时同样不当作终态，避免把仍在排队/运行的任务归入历史。
 */
const ACTIVE_STATUSES: readonly TaskStatus[] = ['pending', 'paused', 'queued', 'running', 'cancelling', 'unknown'];
const HISTORY_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];

export function TaskCenter() {
  const tasks = useTasks();
  const service = useMediaService();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [view, setView] = useState<'active' | 'history'>('active');
  const [notice, setNotice] = useState('');
  const real = typeof service.startSourceScan === 'function';

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: demoQueryKeys.tasks }),
    [queryClient],
  );

  const counts = useMemo(() => {
    const base: Record<TaskStatus, number> = {
      pending: 0,
      paused: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      cancelling: 0,
      unknown: 0,
    };
    for (const task of tasks.data ?? []) {
      base[task.status] += 1;
    }
    return base;
  }, [tasks.data]);

  if (tasks.isPending) {
    return <LoadingSurface label="正在读取任务" />;
  }
  if (tasks.isError) {
    return <ErrorSurface detail={tasks.error?.message ?? '任务读取失败'} onRetry={() => void tasks.refetch()} />;
  }

  const all = tasks.data ?? [];
  const items = all.filter((task) => (view === 'active'
    ? ACTIVE_STATUSES.includes(task.status)
    : !ACTIVE_STATUSES.includes(task.status)));
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); await refresh(); setNotice(''); }
    catch (error) { setNotice(error instanceof Error ? error.message : '操作未完成'); }
  };

  return (
    <section className={styles.page} data-route="tasks">
      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>任务中心</h1>
          <p className={styles.subtitle}>
            {real ? '当前任务与历史记录分开查看；离开页面不会取消后台操作。' : '测试数据中的任务；不会操作真实媒体库。'}
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate('/manage')}>
          返回媒体管理
        </Button>
      </header>

      <SegmentedControl ariaLabel="任务视图" value={view} onValueChange={setView}
        options={[{ value: 'active', label: '当前任务' }, { value: 'history', label: '历史记录' }]} />
      {notice ? <p role="alert">{notice}</p> : null}

      <div className={styles.summary}>
        {(view === 'active' ? ACTIVE_STATUSES : HISTORY_STATUSES).map((status) => (
          <span key={status} className={styles.summaryItem}>
            <StatusChip tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusChip>
            <strong>{counts[status]}</strong>
          </span>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptySurface
          kicker="任务"
          title={all.length === 0 ? '还没有任务' : view === 'active' ? '当前没有运行中的任务' : '还没有历史记录'}
          detail={view === 'active' ? '已结束的任务收在历史记录中。' : '这里保留已完成、失败和取消的任务，便于查阅与恢复。'}
          action={<Button variant="outline" onClick={() => navigate('/manage')}>前往媒体管理</Button>}
        />
      ) : (
        <ul className={styles.list}>
          {items.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onCancel={() => void run(() => service.cancelTask(task.id))}
              onRetry={() => void run(() => service.retryTask(task.id))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskRow({
  task,
  onCancel,
  onRetry,
}: {
  readonly task: TaskEntry;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}) {
  const active = ACTIVE_STATUSES.includes(task.status);
  return (
    <li className={styles.task}>
      <div className={styles.taskHead}>
        <span className={styles.taskTitle}>{task.title}</span>
        <StatusChip tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</StatusChip>
      </div>
      {task.status === 'unknown' ? (
        // 未登记的状态如实展示后端原文，不猜成"已完成"。
        <p className={styles.taskMessage}>后端返回未知状态「{task.rawStatus || '未提供'}」，请在诊断信息中核对。</p>
      ) : null}
      <div className={styles.taskMeta}>
        <span>来源：{task.sourceName}</span>
        <span>类型：{task.type}</span>
        <span>作用域：{task.scope}</span>
      </div>
      <p className={styles.taskMessage}>{task.error || task.message}</p>
      <div className={styles.taskProgress}>
        <ProgressBar
          value={active ? null : task.progress === 1 ? 100 : 0}
          label={`${task.title}进度`}
        />
      </div>
      <div className={styles.taskFoot}>
        <span className={styles.timestamp}>
          创建 {formatTime(task.createdAt)}
          {task.startedAt ? ` · 开始 ${formatTime(task.startedAt)}` : ''}
          {task.finishedAt ? ` · 结束 ${formatTime(task.finishedAt)}` : ''}
        </span>
        <div className={styles.taskActions}>
          {task.cancellable ? (
            <Button
              size="xs"
              variant="outline"
              title="终止可能影响同一批导入的后续任务"
              onClick={onCancel}
              disabled={task.status === 'cancelling'}
            >
              终止任务
            </Button>
          ) : null}
          {task.status === 'failed' || task.status === 'cancelled' ? (
            <Button size="xs" variant="outline" onClick={onRetry}>
              重试
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function formatTime(value: string): string {
  if (!value) {
    return '-';
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return '-';
  }
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(
    at.getSeconds(),
  ).padStart(2, '0')}`;
}
