import { useQueryClient } from '@tanstack/react-query';
import { Database, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import type { SourceCard } from '@/shared/api/service';
import { demoQueryKeys, useLibrary, useMediaService, useSources } from '@/shared/api/service-context';
import { Button } from '@/shared/ui/button';
import { PosterCard } from '@/shared/ui/PosterCard';
import { EmptySurface, ErrorSurface, LoadingSurface, StatusChip } from '@/shared/ui/Surface';
import styles from './MediaManagementPage.module.css';

/** 真实与测试数据共用的总览；不展示扫描表单、全局任务表或调度配置。 */
export function ManageOverview({ onOpenImport }: { readonly onOpenImport: (rootId: string) => void }) {
  const library = useLibrary();
  const imports = useSources();
  const service = useMediaService();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pendingId, setPendingId] = useState('');
  const [notice, setNotice] = useState('');
  const real = typeof service.startSourceScan === 'function';
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.sources });
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.library });
  };

  return <div className={styles.overview}>
    <section className={styles.overviewSection} aria-label="已入库作品">
      <header className={styles.sectionHead}>
        <h2 className={styles.panelTitle}>已入库作品
          {library.data ? <span className={styles.sectionCount}>{library.data.works.length} 部</span> : null}
        </h2>
      </header>
      {library.isPending ? <LoadingSurface label="正在读取作品" /> : library.isError
        ? <ErrorSurface detail={library.error.message} onRetry={() => void library.refetch()} />
        : library.data?.works.length ? <div className={styles.workPreview}>
          {library.data.works.slice(0, 6).map((work) => <PosterCard key={work.id} work={work}
            onOpen={(id) => navigate(`/work/${id}`)} />)}
        </div> : <p className={styles.panelHint}>还没有已入库作品。完成导入后，作品会显示在这里。</p>}
    </section>

    <section className={styles.overviewSection} aria-label="导入">
      <header className={styles.sectionHead}>
        <h2 className={styles.panelTitle}>导入
          {imports.data ? <span className={styles.sectionCount}>{imports.data.length} 项</span> : null}
        </h2>
        <Button variant="ghost" size="sm" aria-label="刷新导入" onClick={refresh}>
          <RefreshCw size={14} />刷新
        </Button>
      </header>
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {imports.isPending ? <LoadingSurface label="正在读取导入" /> : imports.isError
        ? <ErrorSurface title="导入读取失败" detail={imports.error.message} onRetry={() => void imports.refetch()} />
        : !imports.data?.length ? <EmptySurface title="还没有导入记录"
          detail="从右上角导入媒体；每个导入目录或清单会保留一张卡片，方便查看和更新。" />
        : <div className={styles.sourceGrid}>
          {imports.data.map((card) => <ImportCard key={card.id} card={card} real={real} pending={pendingId === card.id}
            onOpen={() => onOpenImport(card.id)} onScan={() => {
              if (real) { onOpenImport(card.id); return; }
              if (pendingId) return;
              setPendingId(card.id);
              void service.startScan(card.id).then(() => { setNotice(`已开始扫描：${card.name}`); refresh(); })
                .catch((error: unknown) => setNotice(error instanceof Error ? error.message : '扫描未完成'))
                .finally(() => setPendingId(''));
            }} />)}
        </div>}
    </section>
  </div>;
}

function ImportCard({ card, real, pending, onOpen, onScan }: {
  readonly card: SourceCard; readonly real: boolean; readonly pending: boolean;
  readonly onOpen: () => void; readonly onScan: () => void;
}) {
  const attention = card.status === 'needs_attention' || card.status === 'failed';
  return <article className={styles.sourceCard} aria-label={`${card.name}导入`}>
    <header className={styles.sourceHead}>
      <div className={styles.sourceName}><Database size={17} /><span>{card.name}</span></div>
      <StatusChip tone={attention ? 'warning' : card.activeTaskId ? 'info' : 'neutral'}>{card.statusLabel}</StatusChip>
    </header>
    <div className={styles.sourceDetails}>
      <span className={styles.sourceMeta}>{card.providerLabel}</span>
      <p className={styles.sourceLocation} title={card.location}>{card.location || '未提供路径'}</p>
      {card.workCountKnown === false ? <p className={styles.panelHint}>尚无已确认作品</p>
        : <strong className={styles.importWorkCount}>{card.workCount} <span>部作品</span></strong>}
      <p className={styles.sourceMessage}>{card.lastScanAt
        ? `最近更新 ${card.lastScanAt.slice(0, 16).replace('T', ' ')}` : '尚未完成首次导入'}</p>
      {attention && card.message ? <p className={styles.sourceMessage}>{card.message}</p> : null}
    </div>
    <div className={styles.sourceActions}>
      <Button size="sm" variant="outline" onClick={onOpen}>{card.canResume ? '继续导入' : '查看导入'}</Button>
      {!real ? <Button size="sm" variant="ghost" loading={pending} onClick={onScan}>开始扫描</Button> : null}
    </div>
  </article>;
}
