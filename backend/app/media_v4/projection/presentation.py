"""当前媒体库展示合同；过滤派生视图，不改写历史 confirmed 或资产。"""

PRESENTATION_POLICY_VERSION = "published-details-artwork-4"


def preserve_identity_title(work_id: str, media_type: str, metadata: dict,
                            identity_ids: set[str], shared_tv_ids: set[str]) -> bool:
    """合集/关联关系本身不禁止中文展示；共享 TV 身份仍保留各作品区别。"""
    if work_id in shared_tv_ids:
        return True
    has_specific_online_identity = (
        metadata.get("provider") not in {None, "", "local"}
        and bool(str(metadata.get("provider_id") or "").strip())
        and metadata.get("media_type") == media_type
        and media_type in {"movie", "tv"}
        and bool(str(metadata.get("title") or "").strip())
    )
    return bool(work_id in identity_ids or metadata.get("collections")) and not has_specific_online_identity


def display_work_title(local_title: str, metadata: dict, *, preserve_identity: bool,
                       override: dict | None = None) -> str:
    """统一列表/详情的展示优先级；不修改 Work、ParsedFacts 或 confirmed。"""
    custom = str((override or {}).get("title") or "").strip()
    local = str(local_title or "").strip()
    scraped = str(metadata.get("title") or "").strip()
    preferred, fallback = (local, scraped) if preserve_identity else (scraped, local)
    return custom or preferred or fallback

# 所有来源仍按原 confirmed/root 合同过滤；这里仅判断一条绑定是否可展示。
# 未知类型的独立 Work Asset 保留，不能把缺元数据误当成没有本地视频。
VISIBLE_BINDING_SQL = """
rb.asset_id IS NOT NULL AND (
    rb.episode_id IS NULL OR EXISTS (
        SELECT 1 FROM episodes ve JOIN seasons vs ON vs.season_id = ve.season_id
        WHERE ve.episode_id = rb.episode_id
          AND ve.episode_kind NOT IN ('special', 'auxiliary')
          AND vs.season_kind != 'special'
    )
)
"""
