"""当前媒体库展示合同；过滤派生视图，不改写历史 confirmed 或资产。"""

PRESENTATION_POLICY_VERSION = "regular-only-2"

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
