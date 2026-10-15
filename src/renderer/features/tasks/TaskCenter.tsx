/**
 * 任务中心：等待 / 进行 / 成功 / 失败 / 已取消 的模拟状态汇总。
 * 后端只提供 0/1 进度，这里不伪造百分比，只区分"进行中"与"终态"。
 */

import { Button, Tooltip } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';

import type { TaskEntry, TaskStatus } from '../../shared/api/service';
import { demoQueryKeys, useMediaService, useTasks } from '../../shared/api/service-context';
import { EmptySurface, ErrorSurface, LoadingSurface, ProgressBar, StatusChip } from '../../shared/ui/Surface';
import styles from './TaskCenter.module.css';

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '等待中',
  running: '进行中',
  succeeded: '已完成',
  failed: '已失败',
  cancelled: '已取消',
  cancelling: '正在终止',
};

const STATUS_TONE: Record<TaskStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'warning',
  cancelling: 'warning',
};

export function TaskCenter() {
  const tasks = useTasks();
  const service = useMediaService();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: demoQueryKeys.tasks }),
    [queryClient],
  );

  const counts = useMemo(() => {
    const base: Record<TaskStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      cancelling: 0,
    };
    for (const task of tasks.data ?? []) {
      base[task.status] += 1;
    }
    return base;
  }, [tasks.data]);

  if (tasks.isPending) {
    return <LoadingSurface label="正在读取任务" detail="演示任务来自本机内存状态" />;
  }
  if (tasks.isError) {
    return <ErrorSurface detail={tasks.error?.message ?? '任务读取失败'} onRetry={() => void tasks.refetch()} />;
  }

  const items = tasks.data ?? [];

  return (
    <section className={styles.page} data-route="tasks">
      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>任务中心</h1>
          <p className={styles.subtitle}>
            演示任务完全在本机模拟：不启动后台 worker、不访问来源、不写入数据库。
          </p>
        </div>
        <Button variant="default" onClick={() => navigate('/manage')}>
          触发一个新任务
        </Button>
      </header>

      <div className={styles.summary}>
        {(['queued', 'running', 'succeeded', 'failed', 'cancelled'] as TaskStatus[]).map((status) => (
          <span key={status} className={styles.summaryItem}>
            <StatusChip tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusChip>
            <strong>{counts[status]}</strong>
          </span>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptySurface
          kicker="任务"
          title="还没有任务"
          detail="在媒体管理里发起一次扫描或确认，这里就会出现对应的等待、进行与终态记录。"
          action={<Button variant="default" onClick={() => navigate('/manage')}>前往媒体管理</Button>}
        />
      ) : (
        <ul className={styles.list}>
          {items.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onCancel={() => void service.cancelTask(task.id).then(refresh)}
              onRetry={() => void service.retryTask(task.id).then(refresh)}
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
  const active = task.status === 'queued' || task.status === 'running' || task.status === 'cancelling';
  return (
    <li className={styles.task}>
      <div className={styles.taskHead}>
        <span className={styles.taskTitle}>{task.title}</span>
        <StatusChip tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</StatusChip>
      </div>
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
            <Tooltip label="取消作用于整个修订（演示）">
              <Button size="xs" variant="default" onClick={onCancel} disabled={task.status === 'cancelling'}>
                终止任务
              </Button>
            </Tooltip>
          ) : null}
          {task.status === 'failed' || task.status === 'cancelled' ? (
            <Button size="xs" variant="default" onClick={onRetry}>
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
