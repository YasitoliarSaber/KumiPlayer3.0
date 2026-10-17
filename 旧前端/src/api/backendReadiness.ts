import { apiSessionHeaders } from './sessionToken.ts'

const DESKTOP_CONFIG_URL = 'http://127.0.0.1:37821/api/config'
const DEFAULT_ATTEMPTS = 120
const DEFAULT_INTERVAL_MS = 250
const STARTUP_TIMEOUT_MS = 30000
const REQUEST_TIMEOUT_MS = 2000

interface BackendHealthResponse {
  ok: boolean
  json: () => Promise<unknown>
}

interface BackendReadinessOptions {
  attempts?: number
  fetchHealth?: (signal: AbortSignal) => Promise<BackendHealthResponse>
  delay?: (milliseconds: number) => Promise<void>
}

const defaultDelay = (milliseconds: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, milliseconds)
})

const defaultFetchHealth = (signal: AbortSignal) => fetch(DESKTOP_CONFIG_URL, {
  signal,
  cache: 'no-store',
  headers: apiSessionHeaders(),
})

export async function waitForDesktopBackend({
  attempts = DEFAULT_ATTEMPTS,
  fetchHealth = defaultFetchHealth,
  delay = defaultDelay,
}: BackendReadinessOptions = {}): Promise<void> {
  const totalAttempts = Math.max(1, attempts)

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  for (let attempt = 0; attempt < totalAttempts && Date.now() < deadline; attempt += 1) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(false)
      }, Math.min(REQUEST_TIMEOUT_MS, Math.max(0, deadline - Date.now())))
    })
    try {
      const check = (async () => {
        const response = await fetchHealth(controller.signal)
        if (!response.ok) return false
        const body = await response.json() as { setup_completed?: unknown }
        return typeof body?.setup_completed === 'boolean'
      })()
      if (await Promise.race([check, timeout])) return
    } catch {
      // Cold starts briefly reject connections until Uvicorn finishes initialization.
    } finally {
      clearTimeout(timer)
    }
    if (attempt + 1 < totalAttempts && Date.now() < deadline) {
      await delay(Math.min(DEFAULT_INTERVAL_MS, deadline - Date.now()))
    }
  }

  throw new Error('KumiPlayer 后端在 30 秒内未能就绪')
}
