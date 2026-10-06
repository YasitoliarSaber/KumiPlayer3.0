import VirtualizedPosterGrid from '../components/library/VirtualizedPosterGrid';
import { normalizePosterColumns } from '../components/library/posterGridMetrics';
import type { WorkIndex } from '../api/types';
import { useLibraryStore } from '../stores/library';
import { useUiStore } from '../stores/ui';
import { matchesSourceFilter } from '../utils/sourceFilter';

export default function FavoritesPage() {
  const works = useLibraryStore((state) => state.works);
  const loading = useLibraryStore((state) => state.loading);
  const error = useLibraryStore((state) => state.error);
  const goHome = useUiStore((state) => state.goHome);
  const source = useUiStore((state) => state.source);
  const posterSize = useUiStore((state) => state.posterSize);

  if (loading && works.length === 0) {
    return <PageState message="加载中..." />;
  }

  if (error && works.length === 0) {
    return <PageState message={error} />;
  }

  const sourceWorks = works.filter((work) => matchesSourceFilter(work, source));
  const favoriteWorks = selectFavoriteWorks(sourceWorks);
  const targetColumns = normalizePosterColumns(posterSize);

  return (
    <div className="recent-page favorites-page">
      <div className="favorites-head">
        <header className="page-title-block">
          <h1>我的收藏</h1>
          <p>已收藏 {favoriteWorks.length} 部</p>
        </header>
      </div>

      {favoriteWorks.length === 0 ? (
        <div className="empty-state empty-state-recent">
          <div className="empty-state-kicker">我的收藏</div>
          <div className="empty-state-title">还没有收藏作品</div>
          <div className="empty-state-subtext">在作品详情页点击心形按钮，即可把作品保存到这里。</div>
          <button className="empty-state-action" onClick={goHome}>回到首页</button>
        </div>
      ) : (
        <div className="category-grid-wrap favorites-grid-wrap">
          <VirtualizedPosterGrid
            works={favoriteWorks}
            columns={targetColumns}
            recentLabel="已收藏"
          />
        </div>
      )}
    </div>
  );
}

function PageState({ message }: { message: string }) {
  return <div className="page-loading-wrap"><div className="page-loading-message">{message}</div></div>;
}

export function selectFavoriteWorks(works: WorkIndex[]) {
  return works
    .filter((work) => Boolean(work.watch_status?.favorite))
    .sort((left, right) => {
      const rightUpdatedAt = Date.parse(right.watch_status?.updated_at || '') || 0;
      const leftUpdatedAt = Date.parse(left.watch_status?.updated_at || '') || 0;
      return rightUpdatedAt - leftUpdatedAt || left.title.localeCompare(right.title, 'zh-Hans-CN');
    });
}
