"""KumiPlayer 2.0 FastAPI 应用入口"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.assets import router as assets_router
from app.api.bangumi import router as bangumi_router
from app.api.config import router as config_router
from app.api.error_log import router as error_log_router
from app.api.heartbeat import router as heartbeat_router
from app.api.library_v4 import router as library_router
from app.api.media_v4 import router as media_v4_router
from app.api.openlist_v4 import router as openlist_router
from app.api.playback_v4 import router as playback_router
from app.api.system import router as system_router
from app.api.tasks_v4 import router as tasks_router
from app.api.tracking_v4 import router as tracking_router
from app.core.api_security import ApiSessionMiddleware
from app.core.config import ConfigReadError
from app.media_v4.assets.service import ArtworkService
from app.media_v4.jobs.runner import V4JobRunner
from app.media_v4.projection.refresh import ProjectionRefreshScheduler
from app.media_v4.runtime import initialize_runtime


async def _bounded_thread_call(function, wait_timeout: float, *args, **kwargs) -> bool:
    """Wait briefly for a blocking shutdown hook without extending lifespan."""

    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    done, _pending = await asyncio.wait({task}, timeout=max(0.0, wait_timeout))
    if not done:
        task.cancel()
        return False
    try:
        task.result()
    except Exception:
        logging.getLogger(__name__).warning("桌面后端关闭步骤失败", exc_info=True)
        return False
    return True


async def _stop_background_tasks(tasks: tuple[asyncio.Task, ...], timeout: float = 0.35) -> None:
    done, pending = await asyncio.wait(tasks, timeout=timeout)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    if done:
        await asyncio.gather(*done, return_exceptions=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：初始化 V4 唯一媒体状态源并启动心跳监控。"""
    from app.media_v4.sources.source_scan_runner import get_source_scan_runner
    from app.system.heartbeat import get_heartbeat_manager

    database = initialize_runtime()
    artwork_service = ArtworkService(database)
    artwork_service.start()
    stop_jobs = asyncio.Event()

    async def run_v4_jobs() -> None:
        runner = V4JobRunner(database)
        delay = 0.25
        while not stop_jobs.is_set():
            try:
                results = await asyncio.to_thread(runner.process_available)
                delay = 0.25 if results else min(2, delay * 2)
            except Exception:
                # 单个任务会在自己的 handler 中记录失败；worker 继续消费后续任务。
                pass
            try:
                await asyncio.wait_for(stop_jobs.wait(), timeout=delay)
            except TimeoutError:
                continue

    job_worker = asyncio.create_task(run_v4_jobs())

    async def refresh_library() -> None:
        scheduler = ProjectionRefreshScheduler(database)
        while not stop_jobs.is_set():
            try:
                await asyncio.to_thread(scheduler.tick)
            except Exception:
                logging.getLogger(__name__).warning('媒体库后台刷新未成功，将自动重试', exc_info=True)
            try:
                await asyncio.wait_for(stop_jobs.wait(), timeout=1)
            except TimeoutError:
                continue

    projection_worker = asyncio.create_task(refresh_library())
    # 来源扫描 worker：启动时先回收失联行，再串行领取 queued 扫描；
    # 退出时在安全边界收口，不遗留 daemon 孤儿线程。
    source_scan_worker = get_source_scan_runner(database)
    source_scan_worker.start()
    async def run_ongoing_updates() -> None:
        from app.media_v4.tracking.scheduler import OngoingScheduler

        scheduler = OngoingScheduler(database)
        startup = True
        while not stop_jobs.is_set():
            try:
                await asyncio.to_thread(scheduler.tick, startup=startup)
            except Exception:
                logging.getLogger(__name__).warning("追更调度未成功，请在新番分类查看来源状态")
            startup = False
            try:
                await asyncio.wait_for(stop_jobs.wait(), timeout=30)
            except TimeoutError:
                continue

    ongoing_worker = asyncio.create_task(run_ongoing_updates())
    manager = get_heartbeat_manager()
    manager.start_monitor()
    try:
        yield
    finally:
        stop_jobs.set()
        from app.media_v4.playback.session import get_v4_playback_manager

        # Playback owns the most recent user-visible state. Persist its latest
        # monitor sample and request MPV's normal quit before waiting on providers.
        await _bounded_thread_call(
            get_v4_playback_manager(database).stop,
            2.5,
            timeout=2.25,
        )
        await _stop_background_tasks((job_worker, projection_worker, ongoing_worker))
        await _bounded_thread_call(artwork_service.stop, 0.35)
        await _bounded_thread_call(source_scan_worker.stop, 0.35, timeout=0.25)
        await _bounded_thread_call(manager.stop_monitor, 0.25)


_BUNDLED_RUNTIME = os.environ.get("KUMIPLAYER_RUNTIME_KIND") == "bundled"

app = FastAPI(
    title="KumiPlayer",
    version="2.0.0",
    lifespan=lifespan,
    docs_url=None if _BUNDLED_RUNTIME else "/docs",
    redoc_url=None if _BUNDLED_RUNTIME else "/redoc",
    openapi_url=None if _BUNDLED_RUNTIME else "/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://tauri.localhost",
        "tauri://localhost",
        "http://127.0.0.1:1420",
        "http://localhost:1420",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-KumiPlayer-Token"],
)
app.add_middleware(ApiSessionMiddleware)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "testserver"],
)

# V4 是媒体导入、执行和投影的唯一运行时入口。
app.include_router(library_router)
app.include_router(heartbeat_router)
app.include_router(config_router)
app.include_router(bangumi_router)
app.include_router(error_log_router)
app.include_router(assets_router)
app.include_router(media_v4_router)
app.include_router(playback_router)
app.include_router(tracking_router)
app.include_router(tasks_router)
app.include_router(openlist_router)
app.include_router(system_router)


@app.exception_handler(ConfigReadError)
async def config_read_error(_request: Request, exc: ConfigReadError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/api/health")
def health():
    """健康检查"""
    return {
        "status": "ok",
        "app": "KumiPlayer",
        "runtime_kind": os.environ.get("KUMIPLAYER_RUNTIME_KIND", "source"),
        "runtime_id": os.environ.get("KUMIPLAYER_RUNTIME_ID", ""),
        "instance_id": os.environ.get("KUMIPLAYER_INSTANCE_ID", ""),
    }


# ============================================================
# 前端静态文件托管
# ============================================================

# 前端构建产物目录（Tauri / Vite 构建输出）
_FRONTEND_DIST = Path(__file__).parent.parent.parent / "dist"


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    """根路径返回前端 index.html"""
    index_path = _FRONTEND_DIST / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return HTMLResponse(
        "<h1>KumiPlayer 2.0</h1>"
        "<p>前端未构建。请运行 <code>npm run build</code></p>"
        "<p>后端 API 已就绪：<a href='/docs'>/docs</a></p>"
    )


# 挂载前端静态资源
if _FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(_FRONTEND_DIST / "assets")), name="static-assets")


@app.exception_handler(404)
async def spa_fallback(request: Request, exc):
    """SPA 路由回退：非 API 路径返回 index.html"""
    path = request.url.path
    # API 和 WebSocket 路径不回退
    if path.startswith("/api") or path.startswith("/ws") or path.startswith("/docs") or path.startswith("/openapi"):
        # 不要把业务接口原本可操作的错误（例如“媒体库预设不存在”）
        # 覆盖成没有上下文的 Not Found，同时确保 API 始终返回 JSON。
        detail = getattr(exc, "detail", "请求的接口不存在")
        return JSONResponse(status_code=404, content={"detail": detail})
    # 前端路由回退到 index.html
    index_path = _FRONTEND_DIST / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return HTMLResponse(
        "<h1>KumiPlayer 2.0</h1>"
        "<p>前端未构建。请运行 <code>npm run build</code></p>"
    )
