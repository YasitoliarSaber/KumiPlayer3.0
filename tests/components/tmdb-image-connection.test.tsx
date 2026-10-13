import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import TmdbImageConnectionPanel from '../../src/components/settings/TmdbImageConnectionPanel'
import { ApiError } from '../../src/api/client'

const api = vi.hoisted(() => ({ testTmdbImages: vi.fn(), repairTmdbImages: vi.fn(), getTmdbImageRepair: vi.fn() }))
vi.mock('../../src/api/config', () => ({ configApi: api }))
const failed = { ok: false, reason: 'dns', message: '图片解析失败', diagnostic_id: 'a'.repeat(32), repair_available: true, restore_available: false }
const healthy = { ...failed, ok: true, reason: 'ready', message: '图片连接正常', repair_available: false }
const running = { job_id: 'job', operation: 'repair', status: 'running', message: '正在修复', changed: false, queued_images: 0 }

beforeEach(() => {
  vi.resetAllMocks()
  api.testTmdbImages.mockResolvedValue(failed)
  api.repairTmdbImages.mockResolvedValue(running)
  api.getTmdbImageRepair.mockResolvedValue(running)
})
afterEach(() => vi.useRealTimers())

test('图片正常或错误不可修复时不显示一键修复', async () => {
  api.testTmdbImages.mockResolvedValue(healthy)
  const view = render(<TmdbImageConnectionPanel />)
  await screen.findByText('图片连接正常')
  expect(screen.queryByRole('button', { name: '一键修复图片连接' })).toBeNull()
  view.unmount()
  api.testTmdbImages.mockResolvedValue({ ...failed, repair_available: false, reason: 'certificate' })
  render(<TmdbImageConnectionPanel />)
  await screen.findByText('图片解析失败')
  expect(screen.queryByRole('button', { name: '一键修复图片连接' })).toBeNull()
})

test('失败后点击修复只提交固定操作和诊断标识，连点不会重复启动', async () => {
  render(<TmdbImageConnectionPanel />)
  const button = await screen.findByRole('button', { name: '一键修复图片连接' })
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(api.repairTmdbImages).toHaveBeenCalledTimes(1))
  expect(api.repairTmdbImages).toHaveBeenCalledWith('repair', failed.diagnostic_id)
  expect(await screen.findByRole('button', { name: '正在修复…' })).toBeDisabled()
})

test('修复后复检成功隐藏修复按钮，保留恢复入口', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  render(<TmdbImageConnectionPanel />)
  fireEvent.click(await screen.findByRole('button', { name: '一键修复图片连接' }))
  api.getTmdbImageRepair.mockResolvedValue({ ...running, status: 'completed', changed: true, message: '已开始重试图片' })
  api.testTmdbImages.mockResolvedValue({ ...healthy, restore_available: true })
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  await screen.findByText('已开始重试图片')
  expect(screen.queryByRole('button', { name: '一键修复图片连接' })).toBeNull()
  expect(screen.getByRole('button', { name: '恢复修复前设置' })).toBeEnabled()
})

test('取消管理员授权显示取消，卸载后停止轮询', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const view = render(<TmdbImageConnectionPanel />)
  fireEvent.click(await screen.findByRole('button', { name: '一键修复图片连接' }))
  api.getTmdbImageRepair.mockResolvedValue({ ...running, status: 'cancelled', message: '已取消授权，没有修复' })
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  await screen.findByText('已取消授权，没有修复')
  const calls = api.getTmdbImageRepair.mock.calls.length
  view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(api.getTmdbImageRepair).toHaveBeenCalledTimes(calls)
})

test('StrictMode 检测结束后按钮可用，检测失败不会直接允许系统修复', async () => {
  const view = render(<StrictMode><TmdbImageConnectionPanel /></StrictMode>)
  expect(await screen.findByRole('button', { name: '一键修复图片连接' })).toBeEnabled()
  view.unmount()
  api.testTmdbImages.mockRejectedValue(new Error('offline'))
  render(<TmdbImageConnectionPanel />)
  await screen.findByText('图片检测未完成，请重新检测')
  expect(screen.queryByRole('button', { name: '一键修复图片连接' })).toBeNull()
})

test('点击时刷新诊断标识，旧检测不会导致修复被拒绝', async () => {
  api.testTmdbImages.mockResolvedValueOnce(failed).mockResolvedValue({ ...failed, diagnostic_id: 'b'.repeat(32) })
  render(<TmdbImageConnectionPanel />)
  fireEvent.click(await screen.findByRole('button', { name: '一键修复图片连接' }))
  await waitFor(() => expect(api.repairTmdbImages).toHaveBeenCalledWith('repair', 'b'.repeat(32)))
})

test('启动错误不会被自动检测清掉，用户能看到具体失败原因', async () => {
  api.repairTmdbImages.mockRejectedValue(new ApiError(409, '修复组件不可用，请检查安装文件'))
  render(<TmdbImageConnectionPanel />)
  fireEvent.click(await screen.findByRole('button', { name: '一键修复图片连接' }))
  expect(await screen.findByText('修复组件不可用，请检查安装文件')).toBeVisible()
  expect(api.testTmdbImages).toHaveBeenCalledTimes(2)
})

test('实际连接正常后仍可一键重试失败图片', async () => {
  api.testTmdbImages.mockResolvedValue(healthy)
  render(<TmdbImageConnectionPanel failureOnly />)
  fireEvent.click(await screen.findByRole('button', { name: '重新下载失败图片' }))
  await waitFor(() => expect(api.repairTmdbImages).toHaveBeenCalledWith('repair', healthy.diagnostic_id))
})

test('后台重启导致任务消失时结束轮询，允许重新检测', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  api.getTmdbImageRepair.mockRejectedValue(new ApiError(404, 'task expired'))
  render(<TmdbImageConnectionPanel />)
  fireEvent.click(await screen.findByRole('button', { name: '一键修复图片连接' }))
  await screen.findByRole('button', { name: '正在修复…' })
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(await screen.findByText('后台已重启，请重新检测图片连接')).toBeVisible()
  expect(screen.getByRole('button', { name: '检测图片连接' })).toBeEnabled()
})
