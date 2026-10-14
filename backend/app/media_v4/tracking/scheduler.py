"""可选的启动/定时更新，只登记现有持久追更任务。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.core.config import load_config
from app.media_v4.persistence.database import V4Database


def trigger_updates(database: V4Database):
    from app.media_v4.tracking.refresh import refresh_all_sources

    return refresh_all_sources(database)


class OngoingScheduler:
    def __init__(self, database: V4Database):
        self.database = database
        self.startup_checked = False

    def tick(self, *, startup: bool = False, now: datetime | None = None) -> None:
        config = load_config()
        stamp = now or datetime.now(UTC)
        start = startup and not self.startup_checked and config.ongoing_update_on_startup
        if startup:
            self.startup_checked = True
        interval = int(config.ongoing_update_interval_minutes or 0)
        mode = str(getattr(config, "ongoing_update_schedule_mode", "interval") or "interval")
        calendar_key = ""
        if mode in {"daily", "weekly"}:
            local = stamp.astimezone()
            try:
                hour, minute = map(int, str(getattr(config, "ongoing_update_time", "09:00")).split(":"))
                if not 0 <= hour < 24 or not 0 <= minute < 60:
                    return
                weekday = int(getattr(config, "ongoing_update_weekday", 0))
                if not 0 <= weekday <= 6:
                    return
            except (ValueError, TypeError):
                return
            if local >= local.replace(hour=hour, minute=minute, second=0, microsecond=0) and (
                mode == "daily" or local.weekday() == weekday
            ):
                calendar_key = f"{mode}:{local.date().isoformat()}:{hour:02d}:{minute:02d}:{weekday if mode == 'weekly' else ''}"
        scheduled = bool(calendar_key) if mode in {"daily", "weekly"} else mode == "interval" and 15 <= interval <= 10080
        if not start and not scheduled:
            return
        with self.database.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT value FROM v4_meta WHERE key='ongoing_last_scheduled_at'").fetchone()
            try:
                previous = datetime.fromisoformat(row[0]) if row else None
            except (ValueError, TypeError):
                previous = None
            if calendar_key:
                slot = conn.execute("SELECT value FROM v4_meta WHERE key='ongoing_calendar_slot'").fetchone()
                if not start and slot and slot[0] == calendar_key:
                    return
                conn.execute("INSERT INTO v4_meta(key,value) VALUES ('ongoing_calendar_slot',?) "
                             "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (calendar_key,))
            elif not start and previous is not None:
                # 历史时间缺少时区时按 UTC 解释，避免旧记录破坏新调度。
                if previous.tzinfo is None:
                    previous = previous.replace(tzinfo=UTC)
                if stamp < previous + timedelta(minutes=interval):
                    return
            conn.execute("INSERT INTO v4_meta(key,value) VALUES ('ongoing_last_scheduled_at',?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (stamp.isoformat(),))
        trigger_updates(self.database)
