import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import MediaManagementPage from '../../src/pages/MediaManagementPage'
import { useUiStore } from '../../src/stores/ui'
import { pickFolder } from '../../src/platform/folderPicker'

const api = vi.hoisted(() => ({
  scan: vi.fn(),
  preview: vi.fn(),
  confirm: vi.fn(),
  status: vi.fn(),
  overrideEvidence: vi.fn(),
  sourceLibraries: vi.fn(),
  sourceScanDirectoryCheck: vi.fn(),
  sourceDiagnostics: vi.fn(),
  openlistStatus: vi.fn(),
  drafts: vi.fn(),
  revisionEvidence: vi.fn(),
  startDurableScan: vi.fn(),
  durableScan: vi.fn(),
  cancelDurableScan: vi.fn(),
  workExecutionDetail: vi.fn(),
}))
const config = vi.hoisted(() => ({ getConfig: vi.fn() }))
const openlist = vi.hoisted(() => ({ browse: vi.fn(), getRoutes: vi.fn() }))
const tasks = vi.hoisted(() => ({ retry: vi.fn() }))

vi.mock('../../src/api/mediaV4', () => ({ mediaV4Api: api }))
vi.mock('../../src/api/config', () => ({ configApi: config }))
vi.mock('../../src/api/openlist', () => ({ openlistApi: openlist }))
vi.mock('../../src/api/tasks', () => ({ tasksApi: tasks }))
vi.mock('../../src/platform/folderPicker', () => ({
  pickDirectoryTreeFile: vi.fn(),
  pickFolder: vi.fn(),
}))
vi.mock('../../src/stores/mediaWorkflow', () => ({
  useMediaWorkflowStore: (selector: (state: unknown) => unknown) => selector({
    pendingDroppedTreePath: '',
    consumeDroppedTreePath: vi.fn(),
  }),
}))

const routes = [
  { route_id: 'route-115', label: '115 网盘', remote_prefix: '/115', provider_id: 'pan115', enabled: true, local_path: 'K:\\115网盘', local_available: true },
  { route_id: 'route-quark', label: '夸克动画', remote_prefix: '/Quark/Anime', provider_id: 'quark', enabled: true, local_path: 'K:\\夸克网盘\\动画', local_available: true },
]

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  api.workExecutionDetail.mockResolvedValue({ has_detail: false })
  useUiStore.setState({ page: 'manage', manageView: 'overview', navigationHistory: [], forwardHistory: [], canGoBack: false, canGoForward: false, query: '' })
  api.scan.mockResolvedValue({ root_id: 'root-local', scan_id: 'scan-1', entries: [] })
  api.preview.mockResolvedValue({
    revision_id: 'rev-preview',
    status: 'draft',
    works: [],
    episodes: [],
    work_assets: [],
    issues: [],
  })
  api.sourceLibraries.mockResolvedValue({ cards: [] })
  api.sourceScanDirectoryCheck.mockResolvedValue({
    scan_id: 'scan-1', state: 'no_samples', sampled_directories: 0,
    reachable_directories: 0, missing_directories: 0,
    message: '没有可抽查的视频目录位置。', scope: '未读取视频文件。',
  })
  api.sourceDiagnostics.mockResolvedValue({ format: 'kumiplayer-source-diagnostics-v1' })
  api.drafts.mockResolvedValue({ drafts: [] })
  api.revisionEvidence.mockResolvedValue({ revision_id: 'rev', status: 'draft', entries: [] })
  api.startDurableScan.mockResolvedValue({ scan_id: 'scan-durable', root_id: 'root', scan_mode: 'full', status: 'running' })
  api.durableScan.mockResolvedValue({ scan_id: 'scan-durable', root_id: 'root', status: 'completed', started_at: '', finished_at: '', error: '', entries: [] })
  api.cancelDurableScan.mockResolvedValue({ scan_id: 'scan-durable', status: 'cancelling' })
  api.openlistStatus.mockResolvedValue({
    root_id: 'root-115-anime',
    remote_root: '/115/Anime',
    source_mode: '',
    last_scan_mode: '',
    has_confirmed_baseline: false,
  })
  api.status.mockResolvedValue({ revision_id: 'rev-existing', status: 'confirmed', jobs: [] })
  config.getConfig.mockResolvedValue({
    pan115_root: 'K:\\115网盘',
    baidu_root: 'K:\\百度网盘',
    local_root: 'D:\\Media',
    openlist_configured: true,
    openlist_remote_root: '/',
    openlist_mount_root: 'K:\\',
    openlist_routes: routes,
  })
  openlist.getRoutes.mockResolvedValue({ routes })
  tasks.retry.mockResolvedValue({ status: 'pending' })
  openlist.browse.mockImplementation(async (path = '') => ({
    path: path || '/',
    parent_path: path && path !== '/' ? '/' : null,
    remote_root: '/',
    entries: path === '/115/Anime'
      ? []
      : [{ name: 'Anime', is_dir: true, size: null, modified: null, remote_path: '/115/Anime' }],
    page: 1,
    per_page: 100,
    total: path === '/115/Anime' ? 0 : 1,
    has_more: false,
    cache: { cached: false, status: 'fresh', refreshing: false, refresh_failed: false, fetched_at: null, expires_at: null },
  }))
})

async function enterImport() {
  fireEvent.click(await screen.findByRole('button', { name: '导入媒体' }))
}

test('百度与115目录树从所选TXT父目录定位，不复用默认挂载根', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), { target: { value: 'K:/115网盘/动画/tree.txt' } })
  expect(await screen.findByLabelText('本地播放位置')).toHaveTextContent('K:/115网盘/动画')
  expect(screen.queryByRole('button', { name: '更改播放位置' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '目录对应方式' })).toBeNull()
  expect(screen.getByRole('button', { name: '扫描并识别' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'tree', source_root: '', tree_file: 'K:/115网盘/动画/tree.txt',
  })))
  await screen.findByRole('heading', { name: '检查识别结果' })
})

test('只有路径不确定时在原预览确认候选，不生成猜测媒体证据', async () => {
  api.startDurableScan.mockResolvedValueOnce({
    scan_id: '', root_id: '', status: 'mapping_required', scan_mode: 'tree_snapshot', evidence_count: 2472,
    path_validation: { requires_confirmation: true, state: 'unverifiable', reason: '挂载暂时无法验证', selected_count: 2472, choices: [
      { id: 'choice-a', root: 'J:/115open', path_samples: ['J:/115open/动画/Show/e.mkv'], selected_count: 2472, skipped_count: 0 },
      { id: 'choice-b', root: 'J:/115open', path_samples: ['J:/115open/Show/e.mkv'], selected_count: 2472, skipped_count: 0 },
    ] },
  })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), { target: { value: 'D:/tree.txt' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  expect(await screen.findByText('播放路径尚未验证')).toBeVisible()
  expect(screen.queryByText('J:/115open/动画/Show/e.mkv')).not.toBeInTheDocument()
  expect(screen.queryByText('J:/115open/Show/e.mkv')).not.toBeInTheDocument()
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.durableScan).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '确认并建立媒体库' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '使用路径 B' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenLastCalledWith(expect.objectContaining({ tree_mapping_choice: 'choice-b' })))
  await screen.findByRole('heading', { name: '检查识别结果' })
})

test('多目录歧义可筛选到后面的挂载分支并确认', async () => {
  api.startDurableScan.mockResolvedValueOnce({
    scan_id: '', root_id: '', status: 'mapping_required', scan_mode: 'tree_snapshot', evidence_count: 35,
    path_validation: { requires_confirmation: true, selected_count: 35, choices: Array.from({ length: 35 }, (_, index) => ({
      id: `choice-${index}`, root: 'Z:/', mapping_scope: `Branch-${index}`, path_samples: [`Z:/Show-${index}/e.mkv`], selected_count: 1, skipped_count: 34,
    })) },
  })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), { target: { value: 'D:/tree.txt' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await screen.findByText('播放路径尚未验证')
  expect(screen.queryByRole('button', { name: '使用路径 35' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: '筛选目录边界' }), { target: { value: 'Branch-34' } })
  fireEvent.click(await screen.findByRole('button', { name: '使用路径 35' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenLastCalledWith(expect.objectContaining({ tree_mapping_choice: 'choice-34' })))
  await screen.findByRole('heading', { name: '检查识别结果' })
})

test('路径选择隐藏技术样本、保留范围数量并提交原映射选择', async () => {
  api.startDurableScan.mockResolvedValue({
    scan_id: '', root_id: '', scan_mode: 'tree_snapshot', status: 'mapping_required',
    path_validation: {
      requires_confirmation: true, state: 'unverifiable', reason: '需要确认挂载边界。', selected_count: 1,
      choices: [{
        id: 'tree-choice-a', root: 'Z:/', path_samples: ['Z:/Show/e.mkv'],
        selected_count: 1, skipped_count: 2,
      }],
    },
  })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), { target: { value: 'D:/tree.txt' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await screen.findByRole('heading', { name: '检查导入预览' })
  expect(screen.queryByText('Z:/Show/e.mkv')).not.toBeInTheDocument()
  expect(screen.getByText(/排除 2 个范围外的文件/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '使用路径 A' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenLastCalledWith(expect.objectContaining({ tree_mapping_choice: 'tree-choice-a' })))
})

test('首次导入选择另一个连接后使用其目录、路由、基线和持久任务身份', async () => {
  const connection = (connection_id: string, name: string, remote: string) => ({
    connection_id, name, openlist_configured: true, openlist_server_url: 'http://localhost:5244',
    openlist_remote_root: remote, openlist_mount_root: 'X:\\', openlist_username_masked: 'f***e',
    openlist_routes: [{ ...routes[0], route_id: `route-${connection_id}`, remote_prefix: remote, local_path: `X:\\${name}` }],
  })
  const a = connection('legacy', '连接甲', '/甲')
  const b = connection('ol-b', '连接乙', '/乙')
  config.getConfig.mockResolvedValue({ ...a, local_root: '', openlist_connections: [a, b] })
  openlist.getRoutes.mockImplementation(async (id?: string) => ({ routes: id === 'ol-b' ? b.openlist_routes : a.openlist_routes }))
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  const selector = await screen.findByRole('combobox', { name: 'OpenList 连接' })
  fireEvent.click(selector)
  fireEvent.click(await screen.findByRole('option', { name: '连接乙' }))
  await waitFor(() => expect(openlist.browse).toHaveBeenLastCalledWith('/乙', 1, true, 100, 'ol-b'))
  await waitFor(() => expect(api.openlistStatus).toHaveBeenLastCalledWith('/乙', 'ol-b'))
  await waitFor(() => expect(screen.getByRole('button', { name: '完整扫描并建立基线' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '完整扫描并建立基线' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    connection_id: 'ol-b', source: 'openlist', root_path: '/乙', source_root: 'X:\\连接乙',
  })))
  await screen.findByRole('heading', { name: '检查识别结果' })
})

test('本地目录读取设置中的默认路径，并以简洁文案表达扫描范围', async () => {
  render(<MediaManagementPage />)
  await enterImport()

  expect(screen.getByRole('navigation', { name: '导入步骤' })).toBeVisible()
  expect(screen.getByRole('button', { name: '本地目录' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByText('扫描本地媒体文件')).not.toBeInTheDocument()
  expect(await screen.findByRole('textbox', { name: '本机媒体文件夹' })).toHaveValue('D:\\Media')
  expect(screen.queryByText('还需要选择媒体目录')).not.toBeInTheDocument()
  expect(screen.queryByText(/已挂载网盘中的媒体文件/)).not.toBeInTheDocument()
})

test('导入默认为已完结，选择新番后所有来源使用同一内容范围', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  expect(screen.getByRole('radio', { name: '已完结' })).toBeChecked()
  fireEvent.click(screen.getByRole('radio', { name: '新番' }))
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  expect(screen.getByRole('radio', { name: '新番' })).toBeChecked()
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), { target: { value: 'D:/Trees/new-export.txt' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'tree', content_scope: 'ongoing',
  })))
  expect(screen.queryByRole('button', { name: '刷新新番' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText(/定时|启动时更新/)).not.toBeInTheDocument()
})

test('本地新番导入明确传递新番范围，重新开始恢复已完结默认值', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('radio', { name: '新番' }))
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'local', content_scope: 'ongoing',
  })))
  await screen.findByRole('heading', { name: '检查识别结果' })
  fireEvent.click(screen.getByRole('button', { name: '重新开始' }))
  expect(screen.getByRole('radio', { name: '已完结' })).toBeChecked()
})

test('OpenList新番与普通导入使用现有扫描入口', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('radio', { name: '新番' }))
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '完整扫描并建立基线' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '完整扫描并建立基线' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'openlist', content_scope: 'ongoing',
  })))
})

test('默认已完结扫描不会携带既有TXT更新目标', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  await screen.findByDisplayValue('D:\\Media')
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({ content_scope: 'completed' })))
  expect(api.startDurableScan.mock.calls[0][0]).not.toHaveProperty('target_root_id')
})

test('新番TXT更新清空旧归档，选择新版后复用目标来源、播放根和显示名', async () => {
  sessionStorage.setItem('kumiplayer.media-v4.ongoing-source-action', JSON.stringify({ root_id: 'ongoing-tree', action: 'new_txt' }))
  api.sourceLibraries.mockResolvedValue({ cards: [{
    root_id: 'ongoing-tree', provider: 'baidu', ingest_method: 'directory_tree', content_scope: 'ongoing',
    source_mode: 'tree_snapshot', source_locator: 'D:/Archive/old.txt', playback_locator: 'J:/新番',
    display_name: '连载专用目录', route_id: '', revision_id: 'old-revision', phase: 'execute',
    work_count: 1, evidence_count: 1, asset_count: 1, can_resume: false, attention_count: 0,
    job_summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
  }] })
  render(<MediaManagementPage />)
  const tree = await screen.findByRole('textbox', { name: '目录树 TXT 文件' })
  expect(tree).toHaveValue('')
  expect(screen.getByRole('radio', { name: '新番' })).toBeChecked()
  expect(api.startDurableScan).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  fireEvent.change(tree, { target: { value: 'D:/Trees/new-export.txt' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'tree', content_scope: 'ongoing', target_root_id: 'ongoing-tree',
    tree_file: 'D:/Trees/new-export.txt', source_root: '', source_display_name: '连载专用目录',
  })))
})

test('新版TXT更新复用原始播放位置和导出目录，避免重复追加子目录', async () => {
  sessionStorage.setItem('kumiplayer.media-v4.ongoing-source-action', JSON.stringify({ root_id: 'ongoing-tree', action: 'new_txt' }))
  api.sourceLibraries.mockResolvedValue({ cards: [{
    root_id: 'ongoing-tree', provider: 'baidu', ingest_method: 'directory_tree', content_scope: 'ongoing',
    source_mode: 'tree_snapshot', source_locator: 'J:/新番/01动画', playback_locator: 'J:/新番/01动画',
    tree_source_root: 'J:/新番', tree_mapping_mode: 'export_subdir', tree_mapping_scope: '01动画',
    tree_file_path: 'D:/Trees/old.txt', display_name: '连载专用目录', route_id: '', phase: 'execute',
    work_count: 1, evidence_count: 1, asset_count: 1, can_resume: false, attention_count: 0,
    job_summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
  }] })
  render(<MediaManagementPage />)
  const input = await screen.findByRole('textbox', { name: '目录树 TXT 文件' })
  expect(screen.queryByRole('textbox', { name: '播放位置下的导出目录' })).toBeNull()
  fireEvent.change(input, { target: { value: 'D:/Trees/new.txt' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source_root: '', tree_file: 'D:/Trees/new.txt', target_root_id: 'ongoing-tree',
  })))
  await screen.findByRole('heading', { name: '检查识别结果' })
})

test('新番待确认跳转复用既有草稿，避免创建第二次扫描', async () => {
  sessionStorage.setItem('kumiplayer.media-v4.ongoing-source-action', JSON.stringify({ root_id: 'ongoing-tree', action: 'review', revision_id: 'new-draft' }))
  api.sourceLibraries.mockResolvedValue({ cards: [{
    root_id: 'ongoing-tree', provider: 'baidu', ingest_method: 'directory_tree', content_scope: 'ongoing',
    source_mode: 'tree_snapshot', source_locator: 'D:/Archive/tree.txt', playback_locator: 'J:/新番',
    display_name: '连载专用目录', route_id: '', revision_id: 'old-revision', phase: 'execute',
    work_count: 1, evidence_count: 1, asset_count: 1, can_resume: false, attention_count: 0,
    job_summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
  }] })
  render(<MediaManagementPage />)
  await screen.findByRole('heading', { name: '检查识别结果' })
  expect(api.revisionEvidence).toHaveBeenCalledWith('new-draft')
  expect(api.preview).toHaveBeenCalledWith(expect.objectContaining({ revision_id: 'new-draft', root_id: 'ongoing-tree' }))
  expect(api.startDurableScan).not.toHaveBeenCalled()
})

test('目录树使用真实网盘提供商与官网入口，百度115按文件位置定位', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))

  expect(await screen.findByRole('button', { name: '115 网盘' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '百度网盘' })).toBeVisible()
  expect(screen.getByRole('button', { name: '夸克网盘' })).toBeVisible()
  expect(screen.queryByRole('combobox', { name: '存储来源' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '本地挂载根目录（可选）' })).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: /前往 115 官网/ })).toHaveAttribute('href', 'https://115.com/')
  expect(screen.getByRole('link', { name: /前往 115 官网/ })).toHaveClass('media-v4-provider-link')
  expect(screen.queryByText(/支持 115、百度、夸克和 OpenList 导出的清单/)).not.toBeInTheDocument()
  expect(screen.getByText('选择 TXT 后自动确定', { selector: 'output' })).toBeVisible()
  expect(screen.queryByRole('textbox', { name: '本次导入的挂载目录' })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '夸克网盘' }))
  expect(screen.getByRole('link', { name: /前往夸克网盘官网/ })).toHaveAttribute('href', 'https://pan.quark.cn/')
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), {
    target: { value: 'K:\\夸克网盘\\动画\\目录树.txt' },
  })
  expect(screen.getByText('目录树.txt')).toBeVisible()
  expect(screen.getByText('K:\\夸克网盘\\动画', { selector: '.media-v4-selected-file span' })).toBeVisible()
  expect(screen.getByRole('button', { name: '选择文件' })).toHaveClass('media-v4-file-picker-button')
  fireEvent.change(screen.getByRole('textbox', { name: '本次导入的挂载目录' }), { target: { value: 'K:\\夸克网盘\\动画' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))

  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'tree',
    provider: 'quark',
    source_root: 'K:\\夸克网盘\\动画',
    source_display_name: '动画',
  })))
})

test('夸克目录树采用独立默认挂载目录，也可为本次导入选择其他盘符', async () => {
  config.getConfig.mockResolvedValue({ pan115_root: 'K:/115', quark_root: 'K:/Quark', openlist_configured: false, openlist_routes: [] })
  vi.mocked(pickFolder).mockResolvedValueOnce('J:/Quark')
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  fireEvent.click(await screen.findByRole('button', { name: '夸克网盘' }))
  expect(screen.getByText('K:/Quark', { selector: 'output' })).toBeVisible()
  expect(screen.queryByRole('textbox', { name: '本次导入的挂载目录' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '更改播放位置' }))
  expect(screen.getByRole('textbox', { name: '本次导入的挂载目录' })).toHaveValue('K:/Quark')
  fireEvent.click(screen.getByRole('button', { name: '选择本次导入的挂载目录' }))
  await screen.findByDisplayValue('J:/Quark')
  fireEvent.click(screen.getByRole('button', { name: '115 网盘' }))
  expect(screen.queryByRole('textbox', { name: '本次导入的挂载目录' })).not.toBeInTheDocument()
  expect(screen.getByText('选择 TXT 后自动确定', { selector: 'output' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '夸克网盘' }))
  expect(screen.getByRole('textbox', { name: '本次导入的挂载目录' })).toHaveValue('J:/Quark')
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), { target: { value: 'D:/Trees/quark.txt' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({ source: 'tree', provider: 'quark', root_path: 'J:/Quark', source_root: 'J:/Quark' })))
})

test('TXT 未配置网盘播放位置时不会静默采用 OpenList 的同提供商路由', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  fireEvent.click(await screen.findByRole('button', { name: '夸克网盘' }))
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), { target: { value: 'D:/Trees/quark.txt' } })
  expect(screen.getByRole('textbox', { name: '本次导入的挂载目录' })).toHaveValue('')
  expect(screen.getByRole('button', { name: '扫描并识别' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: '本次导入的挂载目录' }), { target: { value: 'J:/Quark' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({ source_root: 'J:/Quark' })))
})

test('夸克目录树取消本次位置覆盖后使用设置中的位置扫描', async () => {
  config.getConfig.mockResolvedValue({ quark_root: 'K:/Quark', openlist_routes: [] })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  fireEvent.click(await screen.findByRole('button', { name: '夸克网盘' }))
  fireEvent.click(await screen.findByRole('button', { name: '更改播放位置' }))
  fireEvent.change(screen.getByRole('textbox', { name: '本次导入的挂载目录' }), { target: { value: 'J:/Temporary' } })
  fireEvent.click(screen.getByRole('button', { name: '使用设置中的位置' }))
  expect(screen.queryByRole('textbox', { name: '本次导入的挂载目录' })).not.toBeInTheDocument()
  expect(screen.getByText('K:/Quark', { selector: 'output' })).toBeVisible()
  fireEvent.change(screen.getByRole('textbox', { name: '目录树 TXT 文件' }), { target: { value: 'D:/Trees/tree.txt' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({ provider: 'quark', source_root: 'K:/Quark' })))
})

test('文件夹选择失败可重试，切换来源后丢弃迟到选择', async () => {
  vi.mocked(pickFolder).mockRejectedValueOnce(new Error('dialog unavailable'))
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('无法打开路径选择器')
  let finish!: (value: string) => void
  vi.mocked(pickFolder).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  fireEvent.click(screen.getByRole('button', { name: '目录树 TXT' }))
  await act(async () => finish('J:/Late'))
  expect(screen.getByRole('textbox', { name: '目录树 TXT 文件' })).toHaveValue('')
})

test('OpenList 首次完整扫描建立基线，确认前增量被禁用', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))

  expect(await screen.findByRole('region', { name: 'OpenList 目录浏览器' })).toBeVisible()
  // 无已确认基线：主按钮建立基线，增量禁用，且不再提示改用“目录树 + OpenList”。
  expect(screen.queryByText(/增量更新请使用/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '完整扫描并建立基线' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '增量扫描' })).toBeDisabled()
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await waitFor(() => expect(openlist.browse).toHaveBeenCalledWith('/115/Anime', 1, true, 100))
  await screen.findByText(/当前目录：\/115\/Anime/)
  fireEvent.click(screen.getByRole('button', { name: '完整扫描并建立基线' }))

  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'openlist',
    root_path: '/115/Anime',
    provider: 'pan115',
    scan_mode: 'full',
  })))
  await waitFor(() => expect(api.durableScan).toHaveBeenCalledWith('scan-durable'))
})

test('已确认基线的 OpenList 默认增量扫描，并在完成后进入识别复核', async () => {
  api.openlistStatus.mockResolvedValue({
    root_id: 'root-115-anime',
    remote_root: '/115/Anime',
    source_mode: 'openlist_full',
    last_scan_mode: 'incremental',
    has_confirmed_baseline: true,
  })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await screen.findByText(/当前目录：\/115\/Anime/)

  expect(screen.getByRole('button', { name: '增量扫描' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '完整校验' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '增量扫描' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'openlist',
    root_path: '/115/Anime',
    provider: 'pan115',
    scan_mode: 'incremental',
  })))
  await waitFor(() => expect(api.durableScan).toHaveBeenCalledWith('scan-durable'))

  api.startDurableScan.mockClear()
  expect(await screen.findByRole('heading', { name: '检查识别结果' })).toBeVisible()
  expect(api.startDurableScan).not.toHaveBeenCalled()
})

test('OpenList 未进入内容来源路由时不会猜测默认网盘提供商', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))

  expect(await screen.findByText('请选择下面的网盘目录')).toBeVisible()
  expect(screen.queryByText('未绑定本地播放位置')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '配置播放位置' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '完整扫描并建立基线' })).toBeDisabled()
})

test('未绑定播放位置时显示错误，并直达当前连接的设置分类', async () => {
  const unboundRoutes = routes.map(route => ({ ...route, local_path: '' }))
  openlist.getRoutes.mockResolvedValue({ routes: unboundRoutes })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  expect(await screen.findByText('未绑定本地播放位置')).toBeVisible()
  expect(screen.getByText('未绑定本地播放位置').closest('.media-v4-mapping-note')).toHaveClass('is-error')
  fireEvent.click(screen.getByRole('button', { name: '配置播放位置' }))
  expect(useUiStore.getState()).toMatchObject({ page: 'settings', settingsSection: 'openlist', settingsConnectionId: 'legacy' })
  expect(api.startDurableScan).not.toHaveBeenCalled()
})

test('OpenList 持久扫描未验证路径时停止生成草稿，先恢复挂载重试再提供设置兜底', async () => {
  api.durableScan.mockResolvedValue({
    scan_id: 'scan-durable', root_id: 'root', status: 'failed', started_at: '', finished_at: '',
    error: '没有找到可达的媒体样本', entries: [],
    path_validation: { state: 'invalid', requires_confirmation: true, reason: '请恢复本地挂载后重新检查。', selected_count: 1, choices: [] },
  })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '完整扫描并建立基线' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '完整扫描并建立基线' }))
  expect(await screen.findByText('播放路径尚未验证')).toBeVisible()
  expect(screen.getByText('请恢复本地挂载后重新检查。')).toBeVisible()
  expect(screen.queryByRole('button', { name: /使用路径/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '确认并建立媒体库' })).not.toBeInTheDocument()
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重新检查播放位置' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledTimes(2))
  expect(await screen.findByText('播放路径尚未验证')).toBeVisible()
  expect(api.preview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '到设置调整对应文件夹' }))
  expect(useUiStore.getState()).toMatchObject({ page: 'settings', settingsSection: 'openlist', settingsConnectionId: 'legacy' })
})

test('OpenList 两条可达路径有歧义时显式选择，发送 OpenList 选择且重试失败不继续生成草稿', async () => {
  const ambiguous = {
    state: 'ambiguous', requires_confirmation: true, reason: '两种挂载对应都能访问样本，请核对实际目录。', selected_count: 2,
    choices: [
      { id: 'openlist-a', root: 'K:/', path_samples: ['K:/115/Anime/Show/1.mkv'], selected_count: 2, skipped_count: 0 },
      { id: 'openlist-b', root: 'K:/', path_samples: ['K:/Anime/Show/1.mkv'], selected_count: 2, skipped_count: 0 },
    ],
  }
  api.durableScan.mockResolvedValue({
    scan_id: 'scan-durable', root_id: 'root', status: 'failed', started_at: '', finished_at: '',
    error: ambiguous.reason, entries: [], path_validation: ambiguous,
  })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: 'OpenList' }))
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '完整扫描并建立基线' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '完整扫描并建立基线' }))
  expect(await screen.findByText('播放路径尚未验证')).toBeVisible()
  expect(screen.queryByText('K:/115/Anime/Show/1.mkv')).not.toBeInTheDocument()
  expect(screen.queryByText('K:/Anime/Show/1.mkv')).not.toBeInTheDocument()
  expect(api.preview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '使用路径 B' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledTimes(2))
  const selected = api.startDurableScan.mock.calls[1][0]
  expect(selected).toMatchObject({ source: 'openlist', root_path: '/115/Anime', openlist_mapping_choice: 'openlist-b' })
  expect(selected.tree_mapping_choice || '').toBe('')
  expect(await screen.findByText('播放路径尚未验证')).toBeVisible()
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.confirm).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '确认并建立媒体库' })).not.toBeInTheDocument()
})

test('混合入口首次要求 TXT 基线且未确认前禁用增量', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 + OpenList 增量' }))
  expect(screen.queryByRole('group', { name: '内容来源' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: '首次目录树 TXT 文件' }), {
    target: { value: 'K:\\115网盘\\动画\\目录树.txt' },
  })
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await screen.findByText(/当前目录：\/115\/Anime/)
  // 尚无已确认基线：TXT 是主动作，增量被禁用并说明原因。
  expect(screen.getByRole('button', { name: '增量扫描' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '建立 TXT 基线' }))

  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'hybrid',
    root_path: '/115/Anime',
    tree_file: 'K:\\115网盘\\动画\\目录树.txt',
    provider: 'pan115',
    source_root: 'K:\\115网盘\\Anime',
    scan_mode: 'full',
  })))
})

test('混合入口基线确认后增量扫描发送显式 incremental', async () => {
  api.openlistStatus.mockResolvedValue({
    root_id: 'root-115-anime',
    remote_root: '/115/Anime',
    source_mode: 'tree_openlist',
    last_scan_mode: 'tree_baseline',
    has_confirmed_baseline: true,
  })
  render(<MediaManagementPage />)
  await enterImport()
  fireEvent.click(screen.getByRole('button', { name: '目录树 + OpenList 增量' }))
  fireEvent.click(await screen.findByRole('button', { name: '打开文件夹 Anime' }))
  await screen.findByText(/当前目录：\/115\/Anime/)
  await waitFor(() => expect(screen.getByRole('button', { name: '增量扫描' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '增量扫描' }))
  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'openlist',
    root_path: '/115/Anime',
    provider: 'pan115',
    scan_mode: 'incremental',
  })))
})

test('本地来源路径有效后提交统一 V4 扫描请求', async () => {
  render(<MediaManagementPage />)
  await enterImport()
  const input = await screen.findByRole('textbox', { name: '本机媒体文件夹' })
  fireEvent.change(input, { target: { value: 'D:\\Anime' } })
  fireEvent.click(screen.getByRole('button', { name: '扫描并识别' }))

  await waitFor(() => expect(api.startDurableScan).toHaveBeenCalledWith(expect.objectContaining({
    source: 'local',
    root_path: 'D:\\Anime',
    tree_file: '',
    provider: 'local',
    source_root: 'D:\\Anime',
    scan_mode: 'full',
    revision_id: expect.stringMatching(/^rev-/),
  })))
})

test('来源卡展示持久化进度并可恢复查看任务', async () => {
  api.sourceLibraries.mockResolvedValue({
    cards: [{
      root_id: 'root-baidu-anime', provider: 'baidu', ingest_method: 'directory_tree',
      source_locator: 'K:\\百度网盘\\动画', playback_locator: 'K:\\百度网盘\\动画', route_id: 'route-baidu',
      display_name: '百度动画库', revision_id: 'rev-existing', revision_status: 'confirmed',
      revision_created_at: '2026-08-24T00:00:00Z', confirmed_at: '2026-08-24T00:00:00Z',
      evidence_count: 120, work_count: 30, asset_count: 120, can_resume: true,
      job_summary: { total: 4, queued: 2, running: 1, succeeded: 1, failed: 0, cancelled: 0 },
    }],
  })
  render(<MediaManagementPage />)

  expect(await screen.findByRole('region', { name: '已导入媒体库' })).toBeVisible()
  expect(screen.getByText('百度动画库')).toBeVisible()
  expect(screen.getByText('30 部作品')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '查看进度' }))
  await waitFor(() => expect(api.status).toHaveBeenCalledWith('rev-existing'))
})

test('已终止的执行任务不被误写为扫描取消，并可查看本次执行结果', async () => {
  api.sourceLibraries.mockResolvedValue({
    cards: [{
      root_id: 'root-terminated', provider: 'baidu', ingest_method: 'directory_tree', source_mode: 'tree',
      last_scan_mode: 'full', has_confirmed_baseline: true, overall_status: 'cancelled', phase: 'execute',
      attention_count: 0, last_error: '', source_locator: 'K:\\百度网盘\\动画', playback_locator: 'K:\\百度网盘\\动画', route_id: '',
      display_name: '已终止导入', enabled: 1, added_at: '2026-08-25T00:00:00Z', updated_at: '2026-08-25T00:00:00Z',
      revision_id: 'rev-terminated', latest_revision_id: 'rev-terminated', revision_state: 'confirmed',
      evidence_count: 10, work_count: 1, asset_count: 1, work_previews: [],
      progress: { state: 'cancelled', stage: 'metadata', current_work_id: '', current_work_title: '', completed_work_count: 0, total_work_count: 1, percent: null, message: '任务已终止' },
      active_task: null, available_actions: ['inspect', 'resume'], can_resume: true,
      job_summary: { total: 2, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 1 },
    }],
  })
  render(<MediaManagementPage />)

  expect(await screen.findByRole('region', { name: '已导入媒体库' })).toBeVisible()
  expect(screen.getAllByText('任务已终止')).toHaveLength(2)
  expect(screen.queryByText('扫描已取消')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看执行结果' }))
  await waitFor(() => expect(api.status).toHaveBeenCalledWith('rev-terminated'))
})

test('来源卡可以回到同一 OpenList 来源执行更新', async () => {
  api.sourceLibraries.mockResolvedValue({
    cards: [{
      root_id: 'root-115-anime', provider: 'pan115', ingest_method: 'openlist_api',
      source_mode: 'openlist_full', has_confirmed_baseline: true, last_scan_mode: 'incremental',
      source_locator: '/115/Anime', playback_locator: 'K:\\115网盘\\动画', route_id: 'route-115',
      display_name: '115 动画', revision_id: 'rev-existing', revision_status: 'confirmed',
      revision_created_at: '2026-08-24T00:00:00Z', confirmed_at: '2026-08-24T00:00:00Z',
      evidence_count: 120, work_count: 30, asset_count: 120, can_resume: false,
      job_summary: { total: 3, queued: 0, running: 0, succeeded: 3, failed: 0, cancelled: 0 },
    }],
  })
  api.openlistStatus.mockResolvedValue({
    root_id: 'root-115-anime',
    remote_root: '/115/Anime',
    source_mode: 'openlist_full',
    last_scan_mode: 'incremental',
    has_confirmed_baseline: true,
  })
  render(<MediaManagementPage />)

  fireEvent.click(await screen.findByRole('button', { name: '展开115 动画来源详情' }))
  fireEvent.click(await screen.findByRole('button', { name: '检查更新' }))

  const sourcePicker = screen.getByRole('group', { name: '媒体来源类型' })
  expect(sourcePicker.querySelector('button[aria-label="OpenList"]')).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() => expect(openlist.browse).toHaveBeenCalledWith('/115/Anime', 1, true, 100))
  // 已确认基线：来源卡恢复后默认动作是增量扫描。
  expect(await screen.findByRole('button', { name: '增量扫描' })).toBeEnabled()
})

test('任务进度使用用户阶段标签而不是内部 job type', async () => {
  api.sourceLibraries.mockResolvedValue({
    cards: [{
      root_id: 'root-exec', provider: 'pan115', ingest_method: 'openlist_api', source_mode: 'openlist_full',
      last_scan_mode: 'incremental', has_confirmed_baseline: true, overall_status: 'running',
      attention_count: 0, last_error: '', source_locator: '/Anime', playback_locator: 'K:\Anime',
      route_id: 'route-115', display_name: '执行中媒体库', enabled: 1,
      added_at: '2026-08-25T00:00:00Z', updated_at: '2026-08-25T00:00:00Z',
      revision_id: 'rev-existing', latest_revision_id: 'rev-existing', revision_state: 'running',
      evidence_count: 10, work_count: 1, asset_count: 1,
      work_previews: [], progress: { state: 'running', stage: 'mirror', current_work_id: '', current_work_title: '', completed_work_count: 0, total_work_count: 1, percent: 0, message: '正在生成镜像' },
      available_actions: ['inspect', 'resume'], can_resume: true,
      job_summary: { total: 1, queued: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0 },
    }],
  })
  localStorage.setItem('kumiplayer.media-v4.active-revision', 'rev-existing')
  api.status.mockResolvedValue({
    revision_id: 'rev-existing',
    status: 'confirmed',
    jobs: [{
      job_id: 'job-1',
      job_type: 'scrape_work',
      revision_id: 'rev-existing',
      work_id: 'work-1',
      status: 'succeeded',
      idempotency_key: 'scrape_work:rev-existing:work-1',
    }],
    progress: {
      revision_id: 'rev-existing',
      revision_status: 'confirmed',
      overall_status: 'completed',
      stage_summary: {
        artwork: { status: 'succeeded', total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
        metadata: { status: 'succeeded', total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
        projection: { status: 'succeeded', total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
      },
      work_units: [{
        work_id: 'work-1',
        title: '测试作品',
        media_type: 'tv',
        episode_count: 1,
        asset_count: 1,
        overall_status: 'completed',
        metadata: { job_id: 'job-2', status: 'succeeded', attempts: 1, last_error: '' },
      }],
    },
  })

  render(<MediaManagementPage />)

  // P-005 返工：默认停留来源卡 overview，点击“查看进度”后才进入执行面板。
  fireEvent.click(await screen.findByRole('button', { name: '查看进度' }))

  // 用户阶段只出现一次，不按后端 job 数量重复。
  expect(await screen.findByText('准备本地图片')).toBeVisible()
  expect(screen.getAllByText('准备本地图片')).toHaveLength(1)
  expect(screen.queryByText('生成镜像文件')).not.toBeInTheDocument()
  expect(screen.queryByText('materialize_mirror')).not.toBeInTheDocument()
})

test('失败作品可以从导入进度页精确重试', async () => {
  api.sourceLibraries.mockResolvedValue({
    cards: [{
      root_id: 'root-exec', provider: 'pan115', ingest_method: 'openlist_api', source_mode: 'openlist_full',
      last_scan_mode: 'incremental', has_confirmed_baseline: true, overall_status: 'running',
      attention_count: 0, last_error: '', source_locator: '/Anime', playback_locator: 'K:\Anime',
      route_id: 'route-115', display_name: '执行中媒体库', enabled: 1,
      added_at: '2026-08-25T00:00:00Z', updated_at: '2026-08-25T00:00:00Z',
      revision_id: 'rev-existing', latest_revision_id: 'rev-existing', revision_state: 'running',
      evidence_count: 10, work_count: 1, asset_count: 1,
      work_previews: [], progress: { state: 'running', stage: 'mirror', current_work_id: '', current_work_title: '', completed_work_count: 0, total_work_count: 1, percent: 0, message: '正在生成镜像' },
      available_actions: ['inspect', 'resume'], can_resume: true,
      job_summary: { total: 1, queued: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0 },
    }],
  })
  localStorage.setItem('kumiplayer.media-v4.active-revision', 'rev-existing')
  api.status.mockResolvedValue({
    revision_id: 'rev-existing',
    status: 'confirmed',
    jobs: [{
      job_id: 'job-failed',
      job_type: 'scrape_work',
      revision_id: 'rev-existing',
      work_id: 'work-1',
      status: 'failed',
      idempotency_key: 'scrape_work:rev-existing:work-1',
      last_error: '网络暂时不可用',
    }],
    progress: {
      revision_id: 'rev-existing',
      revision_status: 'confirmed',
      overall_status: 'needs_attention',
      stage_summary: {
        mirror: { status: 'succeeded', total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
        metadata: { status: 'failed', total: 1, queued: 0, running: 0, succeeded: 0, failed: 1, cancelled: 0 },
        projection: { status: 'queued', total: 1, queued: 1, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      },
      work_units: [{
        work_id: 'work-1',
        title: '失败作品',
        media_type: 'tv',
        episode_count: 1,
        asset_count: 1,
        overall_status: 'failed',
        mirror: { job_id: 'job-ok', status: 'succeeded', attempts: 1, last_error: '' },
        metadata: { job_id: 'job-failed', status: 'failed', attempts: 1, last_error: '网络暂时不可用' },
      }],
    },
  })
  render(<MediaManagementPage />)

  fireEvent.click(await screen.findByRole('button', { name: '查看进度' }))
  const card = (await screen.findByText('失败作品')).closest('article')!
  fireEvent.click(within(card).getByRole('button', { name: /失败作品/ }))
  fireEvent.click(await within(card).findByRole('button', { name: /重试/ }))

  await waitFor(() => expect(tasks.retry).toHaveBeenCalledWith('job-failed'))
})

test('只有排队或运行中的来源卡才启动实时轮询', async () => {
  const timeoutSpy = vi.spyOn(window, 'setTimeout')
  api.sourceLibraries.mockResolvedValue({
    cards: [{
      root_id: 'root-failed', provider: 'baidu', ingest_method: 'directory_tree',
      source_locator: 'K:\\tree.txt', playback_locator: 'K:\\百度网盘', route_id: '',
      display_name: '失败的导入', revision_id: 'rev-failed', revision_status: 'confirmed',
      revision_created_at: '2026-08-24T00:00:00Z', confirmed_at: '2026-08-24T00:00:00Z',
      evidence_count: 1, work_count: 1, asset_count: 1, can_resume: true,
      job_summary: { total: 3, queued: 0, running: 0, succeeded: 2, failed: 1, cancelled: 0 },
    }],
  })

  render(<MediaManagementPage />)
  const card = (await screen.findByText('失败的导入')).closest('article')!
  expect(card).toHaveClass('settled')
  expect(card).not.toHaveClass('active')
  expect(timeoutSpy.mock.calls.some((call) => call[1] === 1500)).toBe(false)
  timeoutSpy.mockRestore()
})

test('来源卡只以 active_task 判断当前任务，忽略过期任务摘要', async () => {
  // 只断言"用户看得见的行为"：过期摘要不得让卡片显示处理中。
  //
  // 这里**刻意不**再数"全局 1500ms 定时器"：同文件更早的用例会留下一个仍在
  // 轮询的异步链，它会持续往 1500ms 上排任务，导致该断言在全量跑时无法区分
  // "是不是这张卡在轮询"（单跑必过、全量偶发失败）。待把那处测试隔离泄漏修掉
  // 之后，可以再补一条按来源卡作用域验证"没有轮询"的断言。
  api.sourceLibraries.mockResolvedValue({
    cards: [{
      root_id: 'root-stale-summary', provider: 'baidu', ingest_method: 'directory_tree',
      source_locator: 'K:\\tree.txt', playback_locator: 'K:\\百度网盘', route_id: '',
      display_name: '已完成的目录树', revision_id: 'rev-stale', revision_status: 'confirmed',
      revision_created_at: '2026-08-24T00:00:00Z', confirmed_at: '2026-08-24T00:00:00Z',
      overall_status: 'completed', phase: 'execute', attention_count: 0, last_error: '',
      evidence_count: 1, work_count: 1, asset_count: 1, can_resume: false,
      progress: { state: 'completed', stage: 'idle', current_work_id: '', current_work_title: '', completed_work_count: 1, total_work_count: 1, percent: 100, message: '上次导入已处理完毕' },
      active_task: null,
      // 旧摘要可能在任务已结束后延迟刷新，不能据此让卡片持续显示处理中。
      job_summary: { total: 3, queued: 1, running: 1, succeeded: 1, failed: 0, cancelled: 0 },
    }],
  })

  render(<MediaManagementPage />)

  expect(await screen.findByText('已完成的目录树')).toBeVisible()
  expect(screen.getByText('上次导入已处理完毕')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '展开已完成的目录树来源详情' }))
  expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled()
  // 不得出现"正在处理"这类由过期摘要推导出的忙碌文案
  expect(screen.queryByText(/正在处理|正在获取媒体信息/)).toBeNull()
})
