import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { V4RecognitionSummary } from '../../src/components/media/V4RecognitionSummary'
import type { V4Preview } from '../../src/api/mediaV4'

test('同一作品只显示一个修正入口，文件与具体原因在修正窗口逐项查看', () => {
  const issues = [1, 2, 3].map(n => ({ code: 'episode_number_unresolved', evidence_id: `ev${n}`, message: `具体问题${n}` }))
  const preview: V4Preview = { revision_id: 'rev', status: 'draft', works: [{ work_key: 'work', preferred_title: 'Love Live', media_type: 'tv', year: null, source_evidence_ids: ['ev1', 'ev2', 'ev3'] }], episodes: [], work_assets: [], issues }
  render(<V4RecognitionSummary preview={preview} issues={issues} evidenceEntries={[]} overrideDrafts={{}} busy={false} onOverrideChange={vi.fn()} onApplyOverride={vi.fn()} />)
  expect(screen.getAllByRole('button', { name: '修正', exact: true })).toHaveLength(1)
  expect(screen.queryByText('具体问题1')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '修正', exact: true }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('具体问题1')).toBeVisible()
  fireEvent.click(within(dialog).getByRole('button', { name: /待核对文件 3/ }))
  expect(within(dialog).getByText('具体问题3')).toBeVisible()
  expect(within(dialog).queryByText('具体问题1')).not.toBeInTheDocument()
})

test('同一文件的多个问题合并为一个文件入口，并展示全部原因', () => {
  const issues = [
    { code: 'independent_title_candidate', evidence_id: 'ev1', message: '异名无编号文件与正片混放', file_name: 'RTTT Movie.mkv' },
    { code: 'media_type_unresolved', evidence_id: 'ev1', message: '类型需要确认', file_name: 'RTTT Movie.mkv' },
    { code: 'independent_title_candidate', evidence_id: 'ev2', message: '文件范围需要确认', file_name: 'RTTT Complete.mkv' },
    { code: 'media_type_unresolved', evidence_id: 'ev2', message: '类型需要确认', file_name: 'RTTT Complete.mkv' },
  ]
  const preview: V4Preview = { revision_id: 'rev', status: 'draft', works: [{ work_key: 'work', preferred_title: 'RTTT', media_type: 'unknown', year: null, source_evidence_ids: ['ev1', 'ev2'] }], episodes: [], work_assets: [], issues }
  render(<V4RecognitionSummary preview={preview} issues={issues} evidenceEntries={[]} overrideDrafts={{}} busy={false} onOverrideChange={vi.fn()} onApplyOverride={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '修正', exact: true }))
  const dialog = screen.getByRole('dialog')
  const files = within(dialog).getByRole('group', { name: '选择待核对条目' })
  expect(within(files).getAllByRole('button')).toHaveLength(2)
  expect(within(dialog).getByText('异名无编号文件与正片混放')).toBeVisible()
  expect(within(dialog).getByText('类型需要确认')).toBeVisible()
  fireEvent.click(within(files).getByRole('button', { name: /RTTT Complete.mkv/ }))
  expect(within(dialog).getByText('文件范围需要确认')).toBeVisible()
  expect(within(dialog).getByText('类型需要确认')).toBeVisible()
  expect(within(dialog).queryByText('异名无编号文件与正片混放')).not.toBeInTheDocument()
})

test('没有阻断 issue 的类型未定作品也进入醒目的稍后核对清单', () => {
  const preview: V4Preview = {
    revision_id: 'rev', status: 'draft',
    works: [{ work_key: 'unknown-work', preferred_title: '未定位作品', media_type: 'unknown', year: null, source_evidence_ids: ['ev1'] }],
    episodes: [{ work_key: 'unknown-work', episode_key: 'unknown-episode', local_season_number: null, local_episode_number: null, absolute_episode_number: null, season_kind: 'unassigned', episode_kind: 'unknown', special_number: null, edition_key: 'default', asset_evidence_ids: ['ev1'], identity_key: 'unknown-episode' }],
    work_assets: [], issues: [], blocking_issue_count: 0,
  }
  render(<V4RecognitionSummary preview={preview} issues={[]} evidenceEntries={[]} overrideDrafts={{}} busy={false} onOverrideChange={vi.fn()} onApplyOverride={vi.fn()} />)

  expect(screen.getByRole('alert')).toHaveTextContent('类型未定 1 部')
  expect(screen.getByRole('heading', { name: '需要处理或稍后核对' })).toBeVisible()
  expect(screen.getByText('未定位作品')).toBeVisible()
  expect(screen.getByText(/类型未定 · 季号未定 1 组 · 集号未定 1 项/)).toBeVisible()
})
