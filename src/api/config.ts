// KumiPlayer 2.0 配置 API

import { api } from './client';
import type { OpenListRoute } from './types';

export interface OpenListConnectionConfig {
  connector_type?: 'openlist'
  connection_id: string
  name: string
  openlist_server_url: string
  openlist_remote_root: string
  openlist_mount_root: string
  openlist_configured: boolean
  openlist_username_masked: string
  openlist_cache_ttl_minutes: number
  openlist_prefetch_limit: number
  openlist_routes: OpenListRoute[]
}

export interface PublicConfig {
  openlist_connections?: OpenListConnectionConfig[]
  openlist_connection_name?: string
  openlist_connection_id?: string
  setup_completed: boolean
  setup_deferred?: boolean
  setup_version: number
  mpv_path: string
  /** 播放模式：internal = KumiPlayer 内置干净 MPV；external = 用户自备 MPV 整合包。 */
  player_mode: 'internal' | 'external'
  /** 外部整合包的 MPV 可执行文件路径；external 模式下必填。 */
  external_mpv_path: string
  server_port: number
  mirror_dir: string
  pan115_root: string
  baidu_root: string
  quark_root?: string
  local_root: string
  /**
   * 本地来源登记条目：一个分类下可保存多条本地目录（动画库 / 影视库等）。
   * 旧后端不返回该字段，因此保持可选。
   */
  local_roots?: LocalRootRecord[]
  directory_tree_dir: string
  ongoing_update_on_startup?: boolean
  ongoing_update_interval_minutes?: number
  openlist_server_url: string
  openlist_remote_root: string
  openlist_mount_root: string
  /** OpenList 用户名与密码是否已配置（凭据本身绝不回传前端） */
  openlist_configured: boolean
  /** 已保存用户名的打码形式（首尾字符），用于界面确认当前账号 */
  openlist_username_masked: string
  /** KumiPlayer 本地浏览缓存时长（分钟） */
  openlist_cache_ttl_minutes: number
  /** 单层目录浏览的有界预取直接子目录数量上限 */
  openlist_prefetch_limit: number
  /** OpenList 提供商路由（远端前缀 -> provider） */
  openlist_routes: OpenListRoute[]
  tmdb_bearer_token: string
  tmdb_language: string
  tmdb_certification_regions: string
  artwork_storage_mode: 'remote' | 'local' | 'auto'
  anilist_enabled: boolean
  anilist_rate_limit: number
  anilist_timeout: number
  deepseek_api_key: string
  deepseek_configured?: boolean
  tmdb_configured?: boolean
  bangumi_configured?: boolean
  alias_web_recovery_enabled?: boolean
  websearch_api_key?: string
  websearch_configured?: boolean
  tmdb_rate_limit: number
  tmdb_max_retries: number
  tmdb_timeout: number
  bangumi_access_token: string
  bangumi_user_agent: string
  auto_play_next_episode: boolean
  mpv_anime4k_mode: 'off' | 'a' | 'b' | 'c' | 'a+a' | 'b+b' | 'c+a'
  mpv_anime4k_quality: 'fast' | 'light' | 'balanced' | 'high'
  series_card_image_mode: 'poster' | 'fanart'
  poster_size: number
  heartbeat_enabled: boolean
  heartbeat_timeout: number
  auto_shutdown_on_heartbeat_timeout: boolean
  proxy_url: string
}

export interface MpvRuntimeStatus {
  available: boolean
  version: string
  architecture: string
  target_triple: string
  manifest_valid: boolean
  files_valid: boolean
  configuration_available: boolean
  scripts_available: boolean
  distribution_status: string
  message: string
  runtime_dir: string
  config_dir: string
}

export interface MpvValidationResult {
  ok: boolean
  message: string
  version?: string
  executable_path?: string
  integration_dir: string
  integration_available: boolean
  plugin_available: boolean
  plugin_path: string
  mpv_available?: boolean
  manifest_valid?: boolean
  files_valid?: boolean
  distribution_status?: string
}

export interface SetupCompletePayload {
  player_mode?: PublicConfig['player_mode']
  external_mpv_path?: string
  mpv_path?: string
  mirror_dir?: string
  pan115_root?: string
  baidu_root?: string
  local_root?: string
  directory_tree_dir?: string
  tmdb_bearer_token?: string
  bangumi_access_token?: string
}

export type SetupSourcesPayload = Pick<SetupCompletePayload, 'pan115_root' | 'baidu_root' | 'local_root' | 'directory_tree_dir'>

export interface LocalRootRecord {
  /** 由后端按路径推导的稳定标识；提交时以路径为准。 */
  root_id: string
  /** 展示名称；留空由后端回退到目录名。 */
  name: string
  path: string
}

export interface MediaPathValidationItem {
  source: string
  /** 已登记本地来源的展示名；旧来源无此字段时前端回退到内置标签。 */
  label?: string
  ok: boolean
  status: 'verified' | 'unavailable' | 'mismatch'
  configured_root: string
  resolved_root: string
  checked_count: number
  existing_count: number
  example_path: string
  message: string
}

export interface MediaPathValidationResponse {
  ok: boolean
  sources: MediaPathValidationItem[]
}

export const configApi = {
  getConfig: () => api.get<PublicConfig>('/api/config'),
  patchConfig: (patch: Partial<PublicConfig>) => api.patch<PublicConfig>('/api/config', patch),
  getMpvRuntime: () => api.get<MpvRuntimeStatus>('/api/config/mpv-runtime'),
  openMpvConfigDir: (playerMode?: PublicConfig['player_mode']) => api.post<{ ok: boolean; config_dir: string }>('/api/config/mpv-runtime/open-config', playerMode ? { player_mode: playerMode } : undefined),
  testMpv: (mpvPath?: string, playerMode?: PublicConfig['player_mode']) => mpvPath !== undefined || playerMode
    ? api.post<MpvValidationResult>('/api/config/test/mpv-path', { mpv_path: mpvPath || '', player_mode: playerMode || 'internal' })
    : api.post<MpvValidationResult>('/api/config/test/mpv'),
  testMpvPath: (mpvPath: string, playerMode?: PublicConfig['player_mode']) => api.post<MpvValidationResult>('/api/config/test/mpv-path', { mpv_path: mpvPath, ...(playerMode ? { player_mode: playerMode } : {}) }),
  deferSetup: () => api.post<PublicConfig>('/api/config/setup/defer'),
  saveSetupPlayer: (payload: Pick<SetupCompletePayload, 'player_mode' | 'external_mpv_path'>) => api.post<PublicConfig>('/api/config/setup/player', payload),
  saveSetupSources: (payload: SetupSourcesPayload) => api.post<PublicConfig>('/api/config/setup/sources', payload),
  saveTmdbCredential: (token: string) => api.post<PublicConfig>('/api/config/setup/credentials/tmdb', { tmdb_bearer_token: token }),
  completeSetup: (payload: SetupCompletePayload) => api.post<PublicConfig>('/api/config/setup/complete', payload),
  testTmdb: () => api.post<{ ok: boolean; message: string }>('/api/config/test/tmdb'),
  testTmdbImages: () => api.post<TmdbImageDiagnostic>('/api/config/test/tmdb-images'),
  repairTmdbImages: (operation: 'repair' | 'restore', diagnosticId = '') =>
    api.post<TmdbImageRepairJob>('/api/config/tmdb-images/repair', { operation, diagnostic_id: diagnosticId }),
  getTmdbImageRepair: (jobId: string) =>
    api.get<TmdbImageRepairJob>('/api/config/tmdb-images/repair/' + encodeURIComponent(jobId)),
  testDeepseek: () => api.post<{ ok: boolean; message: string }>('/api/config/test/deepseek'),
  testMediaPaths: () => api.post<MediaPathValidationResponse>('/api/config/test/media-paths'),
}

export interface TmdbImageDiagnostic {
  ok: boolean
  reason: string
  message: string
  diagnostic_id: string
  repair_available: boolean
  restore_available: boolean
}

export interface TmdbImageRepairJob {
  job_id: string
  operation: 'repair' | 'restore'
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  message: string
  changed: boolean
  queued_images: number
}
