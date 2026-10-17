import { useMemo, type ReactNode } from 'react';
import type { WorkDetail, WorkSummary } from '@/shared/api/service';
import { useLibrary } from '@/shared/api/service-context';
import { Artwork } from '@/shared/ui/Artwork';
import { Button } from '@/shared/ui/button';
import { selectRecommendations } from './recommendations';
import styles from './WorkDetailPage.module.css';

export function WorkSuggestions({ work, onOpen }: {
  readonly work: WorkDetail;
  readonly onOpen: (workId: string) => void;
}) {
  // 与外壳、媒体库共用 Query 缓存；不另建索引、轮询或逐作品详情请求。
  const library = useLibrary();
  const recommendations = useMemo(() => selectRecommendations(work, library.data?.works ?? []), [work, library.data]);
  return <>
    {work.related.length > 0 ? <WorkShelf title="相关作品" works={work.related} onOpen={onOpen} /> : null}
    <WorkShelf title="相关推荐" works={recommendations} onOpen={onOpen}>
      {recommendations.length === 0 ? <p className={styles.suggestionsHint} role="status">
        {library.isPending ? '正在读取相关推荐…' : library.isError ? '暂时无法读取相关推荐。' : '媒体库中暂时没有相近作品。'}
        {library.isError ? <Button variant="ghost" size="xs" onClick={() => void library.refetch()}>重试</Button> : null}
      </p> : null}
    </WorkShelf>
  </>;
}

function WorkShelf({ title, works, onOpen, children }: {
  readonly title: string;
  readonly works: readonly WorkSummary[];
  readonly onOpen: (workId: string) => void;
  readonly children?: ReactNode;
}) {
  return <section className={styles.relatedSection} aria-label={title}>
    <h2 className={styles.blockTitle}>{title}</h2>
    <div className={styles.relatedRow}>
      {works.slice(0, 6).map((item) => <Button key={item.id} variant="ghost" className={styles.relatedCard}
        aria-label={`打开${item.title}详情`} onClick={() => onOpen(item.id)}>
        <span className={styles.relatedMedia}>
          <Artwork artwork={item.artwork.poster} alt="" className={styles.relatedImage} />
        </span>
        <span className={styles.relatedTitle} title={item.title}>{item.title}</span>
        {item.year > 0 ? <span className={styles.relatedMeta}>{item.year}</span> : null}
      </Button>)}
    </div>
    {children}
  </section>;
}
