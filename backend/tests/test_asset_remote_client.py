"""图片 GET 仅暴露已发布的本地 artwork 派生资源。"""


def test_asset_router_has_no_retired_proxy_or_file_routes():
    from app.api import assets as assets_module

    paths = {route.path for route in assets_module.router.routes}
    assert paths == {"/api/assets/artwork/{resource_id}/{content_version}/{width}"}
    assert not hasattr(assets_module, "_get_remote_asset_client")
    assert not hasattr(assets_module, "close_remote_asset_client")
