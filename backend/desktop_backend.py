"""PyInstaller 桌面后端入口；普通用户无需安装 Python。"""

import os

import uvicorn

from app.main import app


def main() -> None:
    host = os.environ.get("KUMIPLAYER_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("KUMIPLAYER_PORT", "37821"))
    except ValueError:
        port = 37821
    server = uvicorn.Server(
        uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False, use_colors=False)
    )
    # system.shutdown invokes this only after its 202 response has been sent;
    # Uvicorn then runs the app lifespan teardown before the desktop shell reaps it.
    app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
    server.run()


if __name__ == "__main__":
    main()
