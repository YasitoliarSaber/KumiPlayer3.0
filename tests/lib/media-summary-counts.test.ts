import { expect, test } from 'vitest'
import type { V4ExecutionProgress } from '../../src/api/mediaV4'
import { summarizeExecutionWorks } from '../../src/lib/mediaSummary'

test('作品完成数与资料完整数分开计量，页面统一使用作品完成数', () => {
  const units = Array.from({ length: 41 }, (_, index) => ({
    overall_status: index === 40 ? 'needs_attention' : 'completed',
    metadata_state: index < 34 ? 'ready' : 'local',
    metadata_reason_code: '',
  }))
  const progress = { work_units: units } as unknown as V4ExecutionProgress

  expect(summarizeExecutionWorks(progress)).toEqual({
    total: 41, completed: 40, needsAttention: 1, metadataComplete: 34,
  })
})

test('已就绪作品的在线分集资料缺项仍计入就绪数量', () => {
  const progress = { work_units: [{ overall_status: 'completed', metadata_state: 'ready', metadata_reason_code: 'episode_mapping_incomplete' }] } as unknown as V4ExecutionProgress
  expect(summarizeExecutionWorks(progress)).toEqual({ total: 1, completed: 1, needsAttention: 0, metadataComplete: 1 })
})
