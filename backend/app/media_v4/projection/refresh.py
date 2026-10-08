"""投影后台刷新：请求只读，缺失/过期/失败恢复不依赖浏览器访问。"""

import logging
import time

from app.media_v4.projection.library import V4LibraryProjection

_LOGGER = logging.getLogger(__name__)


class ProjectionRefreshScheduler:
    def __init__(self, database):
        self.database = database
        self._retry_at = 0.0
        self._failures = 0

    def tick(self, *, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        if now < self._retry_at:
            return False
        projection = V4LibraryProjection(self.database)
        try:
            snapshot = projection.refresh_if_needed()
        except Exception:
            self._failures += 1
            self._retry_at = now + min(30, 2 ** min(self._failures, 5))
            _LOGGER.warning('媒体库投影刷新失败，保留已发布数据并稍后重试', exc_info=True)
            return False
        self._failures = 0
        self._retry_at = 0
        if snapshot is None:
            return False
        # 旧图片补齐只在后台发布后执行；可见图片仍由有界准备接口提权。
        from app.api.assets import queue_library_artwork

        queue_library_artwork([card.get('metadata', {}) for card in snapshot.cards])
        return True
