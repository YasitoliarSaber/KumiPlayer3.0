import { create } from 'zustand'
import { libraryApi } from '../api/library'
import { playbackApi } from '../api/playback'
import { useUiStore, type SourceId } from './ui'
import { matchesSourceFilter } from '../utils/sourceFilter'
import type { WorkIndex, PlaybackHistoryItem } from '../api/types'
import { mainEpisodeCount } from '../utils/workStats'
import { isWorkInLibraryView } from '../utils/libraryCategories'
import { recordScrollDiagnostic } from '../utils/scrollDiagnostics'
import { isScrollRecentlyActive } from '../utils/scrollGesture'

const LIBRARY_CACHE_KEY = 'kumiplayer-library-cache-required-artwork-v5'
const LIBRARY_CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 7
const LIBRARY_CACHE_MAX_BYTES = 1_500_000
const LIBRARY_CACHE_MAX_WORKS = 500

interface LibraryCachePayload {
  savedAt: number
  works: WorkIndex[]
}

interface LibraryState {
  works: WorkIndex[]
  history: PlaybackHistoryItem[]
  loading: boolean
  updating: boolean
  backgroundActive: boolean
  generationId: string
  error: string | null
  loaded: boolean
  changeSequence: number | null

  selectedWorkDetail: WorkIndex | null
  detailLoading: boolean
  detailError: string | null

  filteredWorks: () => WorkIndex[]
  sortedWorks: () => WorkIndex[]
  selectedWork: () => WorkIndex | null
  librarySummary: () => { workCount: number; episodeCount: number }

  loadLibrary: (options?: { force?: boolean }) => Promise<boolean>
  syncChanges: () => Promise<boolean>
  openWorkDetail: (workId: string) => Promise<void>
  closeWorkDetail: () => void
  refreshHistory: () => Promise<void>
  updateWorkWatchStatus: (workId: string, watchStatus: WorkIndex['watch_status']) => void
  peekWorkDetail: (workId: string) => WorkIndex | null
  getWorkDetail: (workId: string) => Promise<any>
  invalidateWork: (workId: string) => void
  refreshWork: (workId: string) => Promise<WorkIndex>
}

const detailCache = new Map<string, WorkIndex>()
const detailRequests = new Map<string, Promise<WorkIndex>>()
const detailVersions = new Map<string, number>()
let changeRequest: Promise<boolean> | null = null
let pendingDetailRefreshId: string | null = null
let detailNavigationRequest = 0
let libraryLoadRequest = 0
let libraryCacheGeneration = 0

type WorkIndexWithLocalClearlogo = WorkIndex & { local_clearlogo_path?: string }

function mergeWorkDetailIntoCompact(previous: WorkIndex, detail: WorkIndex): WorkIndex {
  const compact = previous as WorkIndexWithLocalClearlogo
  const next = detail as WorkIndexWithLocalClearlogo
  return {
    ...previous,
    ...detail,
    // 详情返回值缺少 local_* 时保留 compact 卡片中的本地图片路径，避免返回分类页后丢失本地图。
    local_poster_path: next.local_poster_path || compact.local_poster_path,
    local_fanart_path: next.local_fanart_path || compact.local_fanart_path,
    local_clearlogo_path: next.local_clearlogo_path || compact.local_clearlogo_path,
  } as WorkIndex
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown
}

function commitDetailNavigation(workId: string) {
  const update = () => {
    useUiStore.getState().goDetail(workId)
    document.querySelector<HTMLElement>('.app-main')?.scrollTo({ top: 0, behavior: 'auto' })
  }
  const documentWithTransition = document as ViewTransitionDocument
  const reduceMotion = document.documentElement.dataset.motion === 'reduced'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (reduceMotion || !documentWithTransition.startViewTransition) {
    update()
    return
  }

  documentWithTransition.startViewTransition(update)
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  works: [],
  history: [],
  loading: false,
  updating: false,
  backgroundActive: false,
  generationId: '',
  error: null,
  loaded: false,
  changeSequence: null,
  selectedWorkDetail: null,
  detailLoading: false,
  detailError: null,

  filteredWorks: () => {
    const ui = useUiStore.getState()
    let result = [...get().works]

    if (ui.source !== 'all') {
      const activeSource = ui.source as Exclude<SourceId, 'all'>
      result = result.filter((w) => matchesSourceFilter(w, activeSource))
    }

    if (ui.activeCategory) {
      result = result.filter((w) => isWorkInLibraryView(w, ui.activeCategory!))
    }

    if (ui.query) {
      const q = ui.query.toLowerCase()
      result = result.filter(
        (w) =>
          w.title.toLowerCase().includes(q) ||
          w.original_title.toLowerCase().includes(q) ||
          (w.related_works?.some((r) => r.title.toLowerCase().includes(q)) ?? false)
      )
    }

    return result
  },

  sortedWorks: () => {
    const ui = useUiStore.getState()
    const list = [...get().filteredWorks()]

    switch (ui.sort) {
      case 'recent': {
        const historyMap = new Map<string, number>()
        get().history.forEach((h, i) => {
          if (!historyMap.has(h.work_id)) historyMap.set(h.work_id, i)
        })
        return list.sort((a, b) => {
          const ra = historyMap.get(a.work_id) ?? Infinity
          const rb = historyMap.get(b.work_id) ?? Infinity
          return ra - rb
        })
      }
      case 'ratingDesc':
        return list.sort((a, b) => (b.rating || 0) - (a.rating || 0))
      case 'ratingAsc':
        return list.sort((a, b) => (a.rating || 0) - (b.rating || 0))
      case 'episodesDesc':
        return list.sort((a, b) => mainEpisodeCount(b) - mainEpisodeCount(a))
      case 'episodesAsc':
        return list.sort((a, b) => mainEpisodeCount(a) - mainEpisodeCount(b))
      case 'yearAsc':
        return list.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
      case 'yearDesc':
        return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
      default:
        return list
    }
  },

  selectedWork: () => {
    const st = get()
    if (st.selectedWorkDetail) return st.selectedWorkDetail
    const ui = useUiStore.getState()
    if (!ui.selectedWorkId) return null
    return st.works.find((w) => w.work_id === ui.selectedWorkId) ?? null
  },

  librarySummary: () => {
    const works = get().filteredWorks()
    return {
      workCount: works.length,
      episodeCount: works.reduce((sum, w) => sum + mainEpisodeCount(w), 0),
    }
  },

  loadLibrary: async (options) => {
    const force = options?.force === true
    if (get().loading && !force) return false
    const requestId = ++libraryLoadRequest
    pendingDetailRefreshId = null
    const diagnosticStartedAt = performance.now()
    recordScrollDiagnostic('load-library-start', { force: force ? 1 : 0 })

    if (!force) {
      hydrateLibraryCache(set, get)
    } else {
      detailCache.clear()
      for (const id of detailRequests.keys()) detailVersions.set(id, (detailVersions.get(id) || 0) + 1)
      detailRequests.clear()
    }

    const hasUsableContent = get().works.length > 0
    set({ loading: !hasUsableContent, error: null })

    const libraryRequest = libraryApi.getLibrary().then((libraryRes) => {
      if (requestId !== libraryLoadRequest) return

      // SQLite projection 已经保证一 Work 一卡片；前端只按 work_id 消费，不再二次合卡。
      const works = libraryRes.works
      set({
        works,
        loaded: true,
        loading: false,
        updating: libraryRes.updating ?? false,
        backgroundActive: libraryRes.background_active ?? false,
        generationId: libraryRes.generation_id ?? libraryRes.generated_at ?? '',
        error: null,
        changeSequence: libraryRes.change_sequence ?? 0,
      })
      saveLibraryCache(works)
      recordScrollDiagnostic('works-applied', { works: works.length })
    })
    const historyRequest = playbackApi.getHistory(20).then((historyRes) => {
      if (requestId !== libraryLoadRequest) return
      set({ history: historyRes.items })
      recordScrollDiagnostic('history-applied', { items: historyRes.items.length })
    }).catch(() => {
      // 播放历史是首页增强信息；失败时保留已有历史和可用媒体库内容。
      return undefined
    })

    void historyRequest
    try {
      await libraryRequest
      recordScrollDiagnostic('load-library-done', { ms: Math.round(performance.now() - diagnosticStartedAt) })
      return requestId === libraryLoadRequest
    } catch (cause: unknown) {
      if (requestId !== libraryLoadRequest) return false
      recordScrollDiagnostic('load-library-error', { ms: Math.round(performance.now() - diagnosticStartedAt) })
      set({
        error: cause instanceof Error ? cause.message : '加载失败',
        loading: false,
      })
      return false
    }
  },

  syncChanges: async () => {
    if (changeRequest) return changeRequest
    if (get().changeSequence === null || get().loading) return false
    const generation = libraryLoadRequest
    const run = async () => {
      let cursor = get().changeSequence!
      const changed = new Map<string, 'work_upsert' | 'work_remove' | 'artwork' | 'watch'>()
      const cards = new Map<string, WorkIndex>()
      let updating = get().updating
      let backgroundActive = get().backgroundActive
      let generationId = get().generationId
      try {
        let hasMore = true
        while (hasMore) {
          const page = await libraryApi.getChanges(cursor)
          updating = page.updating ?? updating
          backgroundActive = page.background_active ?? false
          generationId = page.generation_id ?? generationId
          if (generation !== libraryLoadRequest) return false
          if (page.reset_required || page.changes.some((event) => !['work_upsert', 'work_remove', 'artwork', 'watch'].includes(event.kind))) return get().loadLibrary({ force: true })
          const ids = [...new Set(page.changes.map((event) => event.work_id).filter(Boolean))]
          if (ids.length) {
            const response = await libraryApi.getCards(ids)
            if (generation !== libraryLoadRequest) return false
            const currentCards = new Map(response.works.map((work) => [work.work_id, work]))
            for (const event of page.changes) {
              if (event.kind === 'reset') continue
              // 结构变化不能被后续图片通知降为仅图片更新。
              const prior = changed.get(event.work_id)
              changed.set(event.work_id, prior && prior !== 'artwork' ? prior : event.kind)
              const card = currentCards.get(event.work_id)
              if (card) cards.set(event.work_id, card)
              else cards.delete(event.work_id)
            }
          }
          if (page.next_sequence < cursor || (page.has_more && page.next_sequence === cursor)) throw new Error('Invalid library change cursor')
          cursor = page.next_sequence
          hasMore = page.has_more
        }
        if (generation !== libraryLoadRequest) return false
        const selectedId = get().selectedWorkDetail?.work_id
        // 分集、演员及关联图片不在精简卡片内，任何资源变化都需废弃该作品详情缓存。
        for (const id of changed.keys()) get().invalidateWork(id)
        const state = get()
        const works = state.works.filter((work) => !changed.has(work.work_id) || cards.has(work.work_id))
          .map((work) => {
            const next = cards.get(work.work_id)
            return next && JSON.stringify(work) !== JSON.stringify(next) ? next : work
          })
        const existing = new Set(works.map((work) => work.work_id))
        for (const card of cards.values()) if (!existing.has(card.work_id)) works.push(card)
        let detail = state.selectedWorkDetail
        for (const id of changed.keys()) {
          const card = cards.get(id)
          if (detail?.work_id === id && !card) detail = null
        }
        set({ works: changed.size ? works : state.works, selectedWorkDetail: detail, changeSequence: cursor, updating, backgroundActive, generationId })
        if (changed.size) saveLibraryCache(works)
        if ([...changed.values()].includes('watch') || state.history.some((item) => changed.has(item.work_id))) void get().refreshHistory()
        // 先提交轻量变化；慢详情不能阻塞海报、游标及下一轮图片通知。
        if (selectedId && changed.has(selectedId)) pendingDetailRefreshId = cards.has(selectedId) ? selectedId : null
        if (pendingDetailRefreshId !== get().selectedWorkDetail?.work_id) pendingDetailRefreshId = null
        if (selectedId && pendingDetailRefreshId === selectedId) {
          const version = detailVersions.get(selectedId) || 0
          const navigation = detailNavigationRequest
          const isCurrent = () => generation === libraryLoadRequest
            && version === (detailVersions.get(selectedId) || 0)
            && navigation === detailNavigationRequest
            && get().selectedWorkDetail?.work_id === selectedId
          void get().getWorkDetail(selectedId).then((updated) => {
            if (isCurrent()) {
              pendingDetailRefreshId = null
              set({ selectedWorkDetail: updated, detailError: null })
            }
          }).catch((cause: unknown) => {
            if (isCurrent()) set({ detailError: cause instanceof Error ? cause.message : '加载详情失败' })
          })
        }
        return true
      } catch { return false }
    }
    changeRequest = run()
    try { return await changeRequest } finally { changeRequest = null }
  },

  openWorkDetail: async (workId) => {
    const requestId = ++detailNavigationRequest
    set({ detailError: null, detailLoading: true })

    try {
      const work = await get().getWorkDetail(workId)
      if (requestId !== detailNavigationRequest) return
      set({ selectedWorkDetail: work, detailLoading: false })
      commitDetailNavigation(workId)

      const works = get().works
      const index = works.findIndex((w) => w.work_id === workId)
      if (index >= 0) {
        const newWorks = [...works]
        newWorks[index] = mergeWorkDetailIntoCompact(works[index], work)
        set({ works: newWorks })
      }
    } catch (e: unknown) {
      if (requestId !== detailNavigationRequest) return
      set({
        detailError: e instanceof Error ? e.message : '加载详情失败',
        detailLoading: false,
      })
      // 网络失败时仍允许用媒体库索引中的精简信息进入详情页并展示错误提示。
      commitDetailNavigation(workId)
    }
  },

  closeWorkDetail: () => {
    useUiStore.getState().goHome()
    set({ selectedWorkDetail: null, detailError: null })
  },

  refreshHistory: async () => {
    try {
      const res = await playbackApi.getHistory(20)
      set({ history: res.items })
    } catch {
      // ignore
    }
  },

  updateWorkWatchStatus: (workId, watchStatus) => {
    set((state) => ({
      works: state.works.map((work) => work.work_id === workId ? { ...work, watch_status: watchStatus } : work),
      selectedWorkDetail: state.selectedWorkDetail?.work_id === workId
        ? { ...state.selectedWorkDetail, watch_status: watchStatus }
        : state.selectedWorkDetail,
    }))
  },

  peekWorkDetail: (workId) => detailCache.get(workId) || get().works.find((work) => work.work_id === workId) || null,

  getWorkDetail: async (workId: string) => {
    const cached = detailCache.get(workId)
    if (cached) return cached
    const version = detailVersions.get(workId) || 0

    let request = detailRequests.get(workId)
    if (!request) {
      request = libraryApi.getWorkDetail(workId)
      detailRequests.set(workId, request)
    }

    try {
      const work = await request
      if (detailRequests.get(workId) === request) detailRequests.delete(workId)
      if (version !== (detailVersions.get(workId) || 0)) return get().getWorkDetail(workId)
      if (version === (detailVersions.get(workId) || 0)) detailCache.set(workId, work)
      return work
    } catch (e) {
      if (detailRequests.get(workId) === request) detailRequests.delete(workId)
      if (version !== (detailVersions.get(workId) || 0)) return get().getWorkDetail(workId)
      throw e
    }
  },

  invalidateWork: (workId) => {
    detailCache.delete(workId)
    detailRequests.delete(workId)
    detailVersions.set(workId, (detailVersions.get(workId) || 0) + 1)
  },

  refreshWork: async (workId) => {
    get().invalidateWork(workId)
    const work = await get().getWorkDetail(workId)
    const works = [...get().works]
    const index = works.findIndex((item) => item.work_id === workId)
    if (index >= 0) works[index] = mergeWorkDetailIntoCompact(works[index], work)
    else works.push(work)
    set({ works, selectedWorkDetail: work })
    saveLibraryCache(works)
    return work
  },
}))

function hydrateLibraryCache(
  set: (partial: Partial<LibraryState>) => void,
  get: () => LibraryState
) {
  if (get().loaded || get().works.length > 0 || typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY)
    if (!raw) return
    if (raw.length > LIBRARY_CACHE_MAX_BYTES) {
      localStorage.removeItem(LIBRARY_CACHE_KEY)
      return
    }
    const cached = JSON.parse(raw) as LibraryCachePayload
    if (!cached?.works?.length) return
    if (cached.works.length > LIBRARY_CACHE_MAX_WORKS) {
      localStorage.removeItem(LIBRARY_CACHE_KEY)
      return
    }
    if (Date.now() - cached.savedAt > LIBRARY_CACHE_MAX_AGE) return
    set({ works: cached.works, loaded: true })
  } catch {
    localStorage.removeItem(LIBRARY_CACHE_KEY)
  }
}

function saveLibraryCache(works: WorkIndex[]) {
  const generation = ++libraryCacheGeneration
  if (typeof localStorage === 'undefined') return
  if (works.length === 0) {
    try { localStorage.removeItem(LIBRARY_CACHE_KEY) } catch { /* 缓存失败不影响媒体事实。 */ }
    return
  }
  if (works.length > LIBRARY_CACHE_MAX_WORKS) {
    try { localStorage.removeItem(LIBRARY_CACHE_KEY) } catch { /* 缓存失败不影响媒体事实。 */ }
    return
  }
  const write = () => {
    if (generation !== libraryCacheGeneration) return
    // idle timeout 不代表用户已经停止操作；缓存是可选加速，不应抢占正在滚动的主线程。
    if (isScrollRecentlyActive()) {
      globalThis.setTimeout(schedule, 200)
      return
    }
    try {
      const startedAt = performance.now()
      const payload: LibraryCachePayload = { savedAt: Date.now(), works }
      const serialized = JSON.stringify(payload)
      recordScrollDiagnostic('library-cache-stringify', {
        works: works.length, ms: Math.round(performance.now() - startedAt), chars: serialized.length,
      })
      if (serialized.length > LIBRARY_CACHE_MAX_BYTES) {
        localStorage.removeItem(LIBRARY_CACHE_KEY)
        recordScrollDiagnostic('library-cache-skipped', { works: works.length })
        return
      }
      const writeStartedAt = performance.now()
      localStorage.setItem(LIBRARY_CACHE_KEY, serialized)
      recordScrollDiagnostic('library-cache-write', {
        works: works.length, ms: Math.round(performance.now() - writeStartedAt),
      })
    } catch {
      // 回调发生在原请求之后，必须在回调内捕获存储配额/权限异常。
      recordScrollDiagnostic('library-cache-error')
    }
  }
  const schedule = () => {
    if (generation !== libraryCacheGeneration) return
    const idleWindow = window as Window & typeof globalThis & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
    }
    if (idleWindow.requestIdleCallback) {
      idleWindow.requestIdleCallback(write, { timeout: 1000 })
    } else {
      globalThis.setTimeout(write, 0)
    }
  }
  schedule()
}
