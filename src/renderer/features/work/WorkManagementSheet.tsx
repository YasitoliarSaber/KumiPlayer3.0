import { useEffect, useState, type ReactNode } from 'react';
import type { WorkDetail } from '@/shared/api/service';
import { useMediaService } from '@/shared/api/service-context';
import { Button } from '@/shared/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/shared/ui/sheet';
import { SOURCE_LABELS } from '@/app/ui-store';
import { BangumiPanel, ManualScrapePanel } from './WorkMetadataPanels';
import styles from './WorkDetailPage.module.css';

const statuses = [
  { value: 'watching' as const, label: '追更中' },
  { value: 'watched' as const, label: '已看完' },
  { value: 'on_hold' as const, label: '搁置' },
  { value: 'dropped' as const, label: '弃番' },
  { value: '' as const, label: '未标记' },
];

/** 次要操作按需展开，主画面保留作品和季集，不再常驻一整列资料卡。 */
export function WorkManagementSheet({ work, open, onOpenChange, onChanged, onReturnFocus }: {
  readonly work: WorkDetail;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChanged: () => Promise<unknown>;
  readonly onReturnFocus?: () => void;
}) {
  const service = useMediaService();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setError(''); }, [work.id]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[min(460px,94vw)] gap-0 p-0" onCloseAutoFocus={onReturnFocus ? (event) => {
        event.preventDefault();
        onReturnFocus();
      } : undefined}>
        <SheetHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
          <SheetTitle>资料与管理</SheetTitle>
          <SheetDescription className="truncate">{work.title}</SheetDescription>
        </SheetHeader>
        <div className={styles.managementContent}>
          {error ? <p role="alert" className="text-[13px] text-destructive">{error}</p> : null}
          <Panel title="观看状态">
            <div className={styles.stateRow}>
              {statuses.map((option) => <Button key={option.value} size="xs"
                aria-pressed={work.watch.status === option.value}
                variant={work.watch.status === option.value ? 'subtle' : 'outline'} disabled={saving}
                onClick={() => {
                  setSaving(true);
                  setError('');
                  void service.setWatchStatus(work.id, option.value).then(onChanged)
                    .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '观看状态未保存'))
                    .finally(() => setSaving(false));
                }}>{option.label}</Button>)}
            </div>
          </Panel>
          <Panel title="资料状态">
            <DetailRow label="资料提供方" value={work.metadata.provider} />
            <DetailRow label="提供方 ID" value={work.metadata.providerId} />
            <DetailRow label="状态" value={work.metadata.state} />
            <DetailRow label="资料更新时间" value={work.metadata.updatedAt.slice(0, 10)} />
          </Panel>
          <Panel title="来源与位置">
            <DetailRow label="来源" value={work.sources.map((source) => SOURCE_LABELS.find((entry) => entry.value === source)?.label ?? source).join(' / ')} />
            <DetailRow label="位置" value={work.location} />
            <DetailRow label="可用版本" value={`${work.assetCount} 个版本`} />
            {work.collections.length > 0 ? <DetailRow label="合集" value={work.collections.join('、')} /> : null}
          </Panel>
          <ManualScrapePanel work={work} />
          <BangumiPanel work={work} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Panel({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className={styles.panel}><h2 className={styles.panelTitle}>{title}</h2><div className={styles.panelBody}>{children}</div></section>;
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return <div className={styles.detailRow}><span className={styles.detailLabel}>{label}</span><span className={styles.detailValue} title={value}>{value}</span></div>;
}
