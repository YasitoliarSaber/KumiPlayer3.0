/** P-004 专项回归：来源图标映射、draft 恢复、OpenList 缓存与竞态保护。 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import MediaManagementPage from '../../src/pages/MediaManagementPage'
import OpenListFolderBrowser from '../../src/components/media/OpenListFolderBrowser'
import { useUiStore } from '../../src/stores/ui'

const api = vi.hoisted(() => ({
  scan: vi.fn(),
  preview: vi.fn(),
  confirm: vi.fn(),
  status: vi.fn(),
  overrideEvidence: vi.fn(),
  sourceLibraries: vi.fn(),
  openlistStatus: vi.fn(),
  drafts: vi.fn(),
  revisionEvidence: vi.fn(),
  startDurableScan: vi.fn(),
  durableScan: vi.fn(),
  cancelDurableScan: vi.fn(),
  sourceLibraryDeletionPreview: vi.fn(),
  workExecutionDetail: vi.fn(),
}))
const config = vi.hoisted(() => ({ getConfig: vi.fn() }))
const openlist = vi.hoisted(() => ({ browse: vi.fn(), getRoutes: vi.fn() }))
const tasks = vi.hoisted(() => ({ retry: vi.fn() }))

vi.mock('../../src/api/mediaV4', () => ({ mediaV4Api: api }))
vi.mock('../../src/api/config', () => ({ configApi: config }))
vi.mock('../../src/api/openlist', () => ({ openlistApi: openlist }))
vi.mock('../../src/api/tasks', () => ({ tasksApi: tasks }))
vi.mock('../../src/platform/folderPicker', () => ({ pickDirectoryTreeFile: vi.fn(), pickFolder: vi.fn() }))
vi.mock('../../src/stores/mediaWorkflow', () => ({
  useMediaWorkflowStore: (selector: (state: unknown) => unknown) => selector({
    pendingDroppedTreePath: '',
    consumeDroppedTreePath: vi.fn(),
  }),
}))

const routes = [
  { route_id: 'route-115', label: '115 网盘', remote_prefix: '/115', provider_id: 'pan115', enabled: true, local_path: 'K:\\115网盘', local_available: true },
]

function browseResult(path: string, cacheStatus: 'fresh' | 'stale' | 'none' = 'none') {
  return {
    path,
    parent_path: path === '/' ? null : '/',
    remote_root: '/',
    entries: [{ name: 'Anime', is_dir: true, size: null, modified: null, remote_path: '/115/Anime' }],
    page: 1,
    per_page: 100,
    total: 1,
    has_more: false,
    cache: { cached: cacheStatus !== 'none', status: cacheStatus, refreshing: false, refresh_failed: false, fetched_at: Date.now(), expires_at: null },
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  api.workExecutionDetail.mockResolvedValue({ has_detail: false })
  useUiStore.setState({ page: 'manage', manageView: 'overview', navigationHistory: [], forwardHistory: [], canGoBack: false, canGoForward: false, query: '' })
  api.scan.mockResolvedValue({ root_id: 'root-local', scan_id: 'scan-1', entries: [] })
  api.preview.mockResolvedValue({ revision_id: 'rev', status: 'draft', works: [], episodes: [], work_assets: [], issues: [] })
  api.status.mockResolvedValue({ revision_id: 'rev', status: 'confirmed', jobs: [] })
  api.sourceLibraries.mockResolvedValue({ cards: [] })
  api.drafts.mockResolvedValue({ drafts: [] })
  api.revisionEvidence.mockResolvedValue({ revision_id: 'rev-draft', status: 'draft', entries: [{ evidence_id: 'ev-1', scan_id: 'scan-draft', root_id: 'root-draft', source_key: 'Show/Show.S01E01.mkv', relative_path: 'Show/Show.S01E01.mkv', entry_kind: 'video', provider: 'pan115', source_locator: 'Show/Show.S01E01.mkv', playback_locator: 'K:\\115网盘\\Show\\Show.S01E01.mkv', ingest_method: 'openlist_api' }] })
  api.startDurableScan.mockResolvedValue({ scan_id: 'scan-d', root_id: 'root-d', scan_mode: 'full', status: 'running' })
  api.durableScan.mockResolvedValue({ scan_id: 'scan-d', root_id: 'root-d', status: 'completed', started_at: '', finished_at: '', error: '', entries: [] })
  api.cancelDurableScan.mockResolvedValue({ scan_id: 'scan-d', status: 'cancelling' })
  api.openlistStatus.mockResolvedValue({ root_id: 'root-115', remote_root: '/115/Anime', source_mode: '', last_scan_mode: '', has_confirmed_baseline: false })
  config.getConfig.mockResolvedValue({
    pan115_root: 'K:\\115网盘', baidu_root: 'K:\\百度网盘', local_root: 'D:\\Media',
    openlist_configured: true, openlist_remote_root: '/', openlist_mount_root: 'K:\\', openlist_routes: routes,
  })
  openlist.getRoutes.mockResolvedValue({ routes })
  openlist.browse.mockImplementation(async (path: string) => browseResult(path || '/'))
})

test('提供商选择使用各自的本地品牌图标，不再渲染文字占位或远程资源', async () => {
  render(<MediaManagementPage />)
  fireEvent.click(await screen.findByRole('button', { name: '导入媒体' }))
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  await screen.findByRole('button', { name: '115 网盘' })

  expect(screen.queryByText('115')).not.toBeInTheDocument()
  expect(screen.queryByText('百')).not.toBeInTheDocument()
  expect(screen.queryByText('夸')).not.toBeInTheDocument()
  const icons = Array.from(document.querySelectorAll<HTMLImageElement>('.media-provider-brand-image'))
  expect(icons.length).toBe(3)
  expect(new Set(icons.map((icon) => icon.src)).size).toBe(3)
  expect(icons.every((icon) => {
    const source = icon.getAttribute('src') || ''
    return source.startsWith('data:image/') || source.includes('/src/assets/provider-icons/')
  })).toBe(true)
  expect(icons.every((icon) => !/^https?:\/\//.test(icon.getAttribute('src') || ''))).toBe(true)
  // 可访问名称仍来自可见文字，而不是图标文件名。
  expect(screen.getByRole('button', { name: '115 网盘' })).toBeVisible()
})

test('来源卡使用图标与状态徽标，不再出现文字方块', async () => {
  api.sourceLibraries.mockResolvedValue({
    cards: [{
      root_id: 'root-115', provider: 'pan115', ingest_method: 'openlist_api', source_mode: 'openlist_full',
      last_scan_mode: 'full', has_confirmed_baseline: true, overall_status: 'needs_attention', attention_count: 2,
      last_error: '磁盘写入失败', source_locator: '/115/Anime', playback_locator: 'K:\\115网盘\\动画', route_id: 'route-115',
      display_name: '115 动画', revision_id: 'rev-card', revision_status: 'confirmed',
      revision_created_at: '2026-08-24T00:00:00Z', confirmed_at: '2026-08-24T00:00:00Z',
      evidence_count: 120, work_count: 30, asset_count: 120, can_resume: true,
      job_summary: { total: 3, queued: 0, running: 0, succeeded: 2, failed: 1, cancelled: 0 },
    }],
  })
  render(<MediaManagementPage />)

  expect(await screen.findByText('115 动画')).toBeVisible()
  expect(screen.getByText('需要处理')).toBeVisible()
  expect(screen.getByText('磁盘写入失败')).toBeVisible()
  expect(screen.getByText('有 2 个待处理事项')).toBeVisible()
  expect(document.querySelector('.media-provider-icon.provider-pan115')).not.toBeNull()
  expect(screen.queryByText('115', { selector: '.media-v4-provider-mark' })).not.toBeInTheDocument()
})

test('未确认草稿不进入媒体库概览，只有确认后的来源才建立来源卡', async () => {
  api.drafts.mockResolvedValue({
    drafts: [{
      revision_id: 'rev-draft', root_id: 'root-draft', scan_id: 'scan-draft', created_at: '2026-08-25T00:00:00Z',
      provider: 'pan115', source_mode: 'openlist_full', source_locator: '/115/Anime', playback_locator: 'K:\\115网盘\\动画',
      evidence_count: 12, issue_count: 1,
    }],
  })
  render(<MediaManagementPage />)

  expect(await screen.findByText('还没有导入任何媒体库')).toBeVisible()
  expect(screen.queryByText('待继续导入')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '继续检查识别结果' })).not.toBeInTheDocument()
  expect(api.drafts).not.toHaveBeenCalled()
  expect(api.revisionEvidence).not.toHaveBeenCalled()
})

test('OpenList 缓存过期时隐藏历史列表且显式检查可恢复', async () => {
  openlist.browse.mockImplementation(async (path: string) => browseResult(path || '/', 'stale'))
  render(<OpenListFolderBrowser configured initialPath="/" onPathChange={() => undefined} onGoSettings={() => undefined} />)
  expect(await screen.findByText(/连接未验证/)).toBeVisible()
  expect(screen.queryByRole('button', { name: '打开文件夹 Anime' })).not.toBeInTheDocument()

  openlist.browse.mockImplementation(async (path: string) => browseResult(path || '/', 'none'))
  fireEvent.click(screen.getByRole('button', { name: '检查当前目录' }))
  await waitFor(() => expect(openlist.browse).toHaveBeenCalledWith('/', 1, true, 100))
  expect(await screen.findByText(/本次读取成功/)).toBeVisible()
})

test('OpenList 有效缓存不会冒充远端最新', async () => {
  openlist.browse.mockImplementation(async (path: string) => browseResult(path || '/', 'fresh'))
  render(<OpenListFolderBrowser configured initialPath="/" onPathChange={() => undefined} onGoSettings={() => undefined} />)

  expect(await screen.findByText(/连接未验证/)).toBeVisible()
  expect(screen.queryByRole('button', { name: '打开文件夹 Anime' })).not.toBeInTheDocument()
  expect(screen.queryByText(/本次读取成功/)).not.toBeInTheDocument()
})

test('OpenList 慢响应不覆盖新目录（最新请求获胜）', async () => {
  let resolveSlow: (value: ReturnType<typeof browseResult>) => void = () => undefined
  const slow = new Promise<ReturnType<typeof browseResult>>((resolve) => { resolveSlow = resolve })
  openlist.browse
    .mockReturnValueOnce(Promise.resolve(browseResult('/115', 'none'))) // 初始浏览（快，返回 /115）
    .mockReturnValueOnce(slow)                                           // 打开 Anime（慢）
    .mockReturnValueOnce(Promise.resolve(browseResult('/', 'none')))    // 面包屑返回根（快）
  render(<OpenListFolderBrowser configured initialPath="/" onPathChange={() => undefined} onGoSettings={() => undefined} />)
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await waitFor(() => expect(openlist.browse).toHaveBeenCalledTimes(2))
  // 慢目录尚未返回时用户点击面包屑返回根目录；快请求先到达。
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  await waitFor(() => expect(openlist.browse).toHaveBeenCalledTimes(3))
  await screen.findByText(/当前目录：\//)
  // 慢响应迟到：不得覆盖当前路径。
  resolveSlow(browseResult('/115/Anime-old', 'none'))
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(screen.getByText(/当前目录：\//)).toBeVisible()
  expect(screen.queryByText(/Anime-old/)).not.toBeInTheDocument()
})

test('OpenList 扫描进行中提供取消入口', async () => {
  api.startDurableScan.mockResolvedValue({ scan_id: 'scan-c', root_id: 'root-c', scan_mode: 'full', status: 'running' })
  api.durableScan.mockResolvedValue({ scan_id: 'scan-c', root_id: 'root-c', status: 'running', started_at: '', finished_at: '', error: '', entries: [] })
  render(<MediaManagementPage />)
  fireEvent.click(await screen.findByRole('button', { name: '导入媒体' }))
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await screen.findByText(/当前目录：\/115\/Anime/)
  fireEvent.click(screen.getByRole('button', { name: '完整扫描并建立基线' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalled())
  const cancel = await screen.findByRole('button', { name: '取消扫描' })
  fireEvent.click(cancel)
  await waitFor(() => expect(api.cancelDurableScan).toHaveBeenCalledWith('scan-c'))
})

function configureQuarkScan() {
  const quarkRoutes = [{ ...routes[0], route_id: 'route-quark', remote_prefix: '/Quark', provider_id: 'quark', local_path: 'K:/Quark' }]
  config.getConfig.mockResolvedValue({
    local_root: 'D:/Media', openlist_configured: true, openlist_remote_root: '/',
    openlist_mount_root: 'K:/', openlist_routes: quarkRoutes,
  })
  openlist.getRoutes.mockResolvedValue({ routes: quarkRoutes })
  openlist.browse.mockImplementation(async (path = '/') => ({
    ...browseResult(path),
    entries: [{ name: 'Anime', is_dir: true, remote_path: '/Quark/Anime' }],
  }))
}

function scanningCard() {
  return {
    root_id: 'root-c', provider: 'quark', ingest_method: 'openlist_scan', source_mode: 'openlist_full',
    last_scan_mode: 'full', has_confirmed_baseline: false, source_locator: '/Quark/Anime',
    playback_locator: 'K:/Quark/Anime', route_id: 'route-quark', display_name: '正在扫描的夸克来源',
    enabled: 1, revision_id: '', phase: 'scan', overall_status: 'running', attention_count: 0,
    evidence_count: 0, work_count: null, asset_count: null, counts_scope: 'scan', can_resume: true,
    scan: { scan_id: 'scan-c', status: 'running', stage: 'reading_source', stage_label: '正在读取媒体来源' },
    active_task: { kind: 'scan', scan_id: 'scan-c', status: 'running', label: '正在读取媒体来源', can_cancel: true },
  }
}

async function beginOpenlistScan() {
  fireEvent.click(await screen.findByRole('button', { name: '导入媒体' }))
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await screen.findByText(/当前目录：\/Quark\/Anime/)
  fireEvent.click(screen.getByRole('button', { name: '完整扫描并建立基线' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalled())
}

test('离开扫描页面后迟到完成不抢导航，返回来源卡继续使用同一任务', async () => {
  configureQuarkScan()
  let finishPoll!: (value: unknown) => void
  const poll = new Promise((resolve) => { finishPoll = resolve })
  api.startDurableScan.mockImplementation(async () => {
    api.sourceLibraries.mockResolvedValue({ cards: [scanningCard()] })
    return { scan_id: 'scan-c', root_id: 'root-c', scan_mode: 'full', status: 'running' }
  })
  api.durableScan.mockReturnValueOnce(poll)
  const first = render(<MediaManagementPage />)
  await beginOpenlistScan()
  await waitFor(() => expect(api.durableScan).toHaveBeenCalledWith('scan-c'))
  first.unmount()
  act(() => useUiStore.getState().goHome())
  await act(async () => { finishPoll({ scan_id: 'scan-c', root_id: 'root-c', status: 'completed', evidence_count: 1 }) })
  expect(useUiStore.getState().page).toBe('home')
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.cancelDurableScan).not.toHaveBeenCalled()

  api.durableScan.mockResolvedValue({ scan_id: 'scan-c', root_id: 'root-c', status: 'running' })
  act(() => useUiStore.getState().goManage())
  const returned = render(<MediaManagementPage />)
  expect(await screen.findByText('正在扫描的夸克来源')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '查看进度' }))
  expect(await screen.findByRole('button', { name: '取消扫描' })).toBeVisible()
  await waitFor(() => expect(api.durableScan).toHaveBeenCalledTimes(2))
  expect(api.durableScan).toHaveBeenLastCalledWith('scan-c')
  expect(api.startDurableScan).toHaveBeenCalledTimes(1)
  expect(api.cancelDurableScan).not.toHaveBeenCalled()
  returned.unmount()
})

test('创建扫描的响应在页面离开后返回，不得取消已登记任务', async () => {
  configureQuarkScan()
  let finishStart!: (value: unknown) => void
  api.startDurableScan.mockReturnValueOnce(new Promise((resolve) => { finishStart = resolve }))
  const view = render(<MediaManagementPage />)
  await beginOpenlistScan()
  view.unmount()
  act(() => useUiStore.getState().goHome())
  await act(async () => { finishStart({ scan_id: 'scan-c', root_id: 'root-c', status: 'queued' }) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1000)) })
  expect(api.cancelDurableScan).not.toHaveBeenCalled()
  expect(api.durableScan).not.toHaveBeenCalled()
  expect(useUiStore.getState().page).toBe('home')
})

test('扫描中返回概览后查看同一来源卡不会终止扫描', async () => {
  configureQuarkScan()
  api.startDurableScan.mockImplementation(async () => {
    api.sourceLibraries.mockResolvedValue({ cards: [scanningCard()] })
    return { scan_id: 'scan-c', root_id: 'root-c', scan_mode: 'full', status: 'running' }
  })
  api.durableScan.mockResolvedValue({ scan_id: 'scan-c', root_id: 'root-c', status: 'running' })
  const view = render(<MediaManagementPage />)
  await beginOpenlistScan()
  await screen.findByRole('button', { name: '取消扫描' })
  fireEvent.click(screen.getByRole('button', { name: '返回媒体管理' }))
  expect(await screen.findByText('正在扫描的夸克来源')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '查看进度' }))
  expect(await screen.findByRole('button', { name: '取消扫描' })).toBeVisible()
  expect(api.cancelDurableScan).not.toHaveBeenCalled()
  expect(api.startDurableScan).toHaveBeenCalledTimes(1)
  view.unmount()
})

test('显式重新开始后即使离开页面，迟到登记的旧扫描仍会被取消', async () => {
  configureQuarkScan()
  let finishStart!: (value: unknown) => void
  api.startDurableScan.mockReturnValueOnce(new Promise((resolve) => { finishStart = resolve }))
  const view = render(<MediaManagementPage />)
  await beginOpenlistScan()
  fireEvent.click(screen.getByRole('button', { name: '重新开始' }))
  view.unmount()
  act(() => useUiStore.getState().goHome())
  await act(async () => { finishStart({ scan_id: 'scan-c', root_id: 'root-c', status: 'queued' }) })
  expect(api.cancelDurableScan).toHaveBeenCalledWith('scan-c')
  expect(api.durableScan).not.toHaveBeenCalled()
  expect(useUiStore.getState().page).toBe('home')
})

test.each(['queued', 'running', 'failed', 'cancelled'])('重扫卡保留旧清理状态%s，同时可查看扫描', async (status) => {
  configureQuarkScan()
  api.sourceLibraries.mockResolvedValue({ cards: [{ ...scanningCard(),
    pending_cleanup: { status, revision_id: 'rev-cleanup' },
    deletion_retry_required: status === 'failed' || status === 'cancelled',
  }] })
  api.sourceLibraryDeletionPreview.mockResolvedValue({ blockers: ['该来源仍有进行中的扫描，请先取消或等待结束'] })
  render(<MediaManagementPage />)
  expect(await screen.findByText('正在扫描的夸克来源')).toBeVisible()
  expect(screen.getByRole('button', { name: '查看进度' })).toBeEnabled()
  if (status === 'failed' || status === 'cancelled') {
    fireEvent.click(screen.getByRole('button', { name: '重试清理' }))
    await waitFor(() => expect(api.sourceLibraryDeletionPreview).toHaveBeenCalledWith('root-c'))
    expect(await screen.findByText(/该来源仍有进行中的扫描/)).toBeVisible()
    expect(screen.queryByRole('button', { name: '确认删除媒体库' })).not.toBeInTheDocument()
  } else {
    expect(screen.getByRole('button', { name: '清理中' })).toBeDisabled()
  }
})
