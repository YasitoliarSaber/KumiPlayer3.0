import { useEffect, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import { configApi, type TmdbImageDiagnostic, type TmdbImageRepairJob } from '../../api/config'
import { SettingsFeedback } from '../ui/SettingsPrimitives'

/** 设置、首次引导、图片失败进度共用一个入口，不接受命令或系统路径。 */
export default function TmdbImageConnectionPanel({ enabled = true, failureOnly = false, revisionKey = '' }: {
  enabled?: boolean
  failureOnly?: boolean
  revisionKey?: string
}) {
  const [diagnostic, setDiagnostic] = useState<TmdbImageDiagnostic | null>(null)
  const [job, setJob] = useState<TmdbImageRepairJob | null>(null)
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const checkingRef = useRef(false)
  const startingRef = useRef(false)
  const generation = useRef(0)
  const busy = checking || starting || job?.status === 'running'

  const check = async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    const current = ++generation.current
    setChecking(true)
    setError('')
    try {
      const result = await configApi.testTmdbImages()
      if (mounted.current && generation.current === current) setDiagnostic(result)
    } catch {
      if (mounted.current && generation.current === current) setError('图片检测未完成，请重新检测')
    } finally {
      if (generation.current === current) {
        checkingRef.current = false
        if (mounted.current) setChecking(false)
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    checkingRef.current = false
    if (enabled) void check()
    return () => { mounted.current = false; generation.current++ }
    // 每次配置/导入范围变化重新检测，普通进度轮询不重复发请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, revisionKey])

  useEffect(() => {
    if (job?.status !== 'running') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await configApi.getTmdbImageRepair(job.job_id)
        if (cancelled) return
        setJob(next)
        setError('')
        if (next.status !== 'running') { void check(); return }
      } catch {
        if (cancelled) return
        setError('暂时无法读取修复进度，正在重新连接；请勿重复执行')
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500)
    }
    timer = setTimeout(() => void poll(), 500)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.job_id, job?.status])

  const start = async (operation: 'repair' | 'restore') => {
    if (startingRef.current || busy) return
    startingRef.current = true
    setStarting(true)
    setError('')
    try {
      const result = await configApi.repairTmdbImages(operation, diagnostic?.diagnostic_id)
      if (mounted.current) setJob(result)
    } catch {
      if (mounted.current) { setError('操作未开始，请重新检测图片连接后重试'); void check() }
    } finally {
      startingRef.current = false
      if (mounted.current) setStarting(false)
    }
  }

  if (!enabled) return null
  if (failureOnly && diagnostic?.ok && !job && !error) return null
  return <div className="kp-settings-section-body" aria-label="TMDB 图片连接">
    {(checking || diagnostic || job || error) && <SettingsFeedback
      intent={error || (job && ['failed', 'cancelled'].includes(job.status)) || (!busy && diagnostic && !diagnostic.ok) ? 'error' : diagnostic?.ok ? 'success' : 'info'}
      busy={busy}>
      {error || (checking ? '正在检测图片下载…' : diagnostic && !diagnostic.ok && job?.status === 'completed' ? diagnostic.message : job?.message || diagnostic?.message)}
    </SettingsFeedback>}
    <div className="settings-actions">
      <Button appearance="secondary" disabled={busy} onClick={() => { setJob(null); void check() }}>检测图片连接</Button>
      {!diagnostic?.ok && diagnostic?.repair_available && <Button appearance="primary" disabled={busy} onClick={() => void start('repair')}>
        {job?.status === 'running' ? '正在修复…' : '一键修复图片连接'}
      </Button>}
      {(diagnostic?.restore_available || job?.changed) && <Button appearance="secondary" disabled={busy} onClick={() => void start('restore')}>恢复修复前设置</Button>}
    </div>
    {!diagnostic?.ok && diagnostic?.repair_available && <p className="kp-settings-description">
      点击后由 Windows 请求管理员权限。只修复 TMDB 图片域名，自动备份，失败撤回；也会影响其他软件访问同一域名。
    </p>}
  </div>
}
