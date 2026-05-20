import { create } from "zustand"
import { load, type Store } from "@tauri-apps/plugin-store"
import type { PPSlideInfo } from "@/lib/propresenter-ws"

export type PPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"

export interface PPPresentation {
  uid: string
  name: string
  slideCount: number
}

export interface PPSlide {
  uid: string
  index: number
  text: string
  label: string
}

export interface PPLibraryEntry {
  uid: string
  name: string
}

interface ProPresenterState {
  // Connection config (persisted)
  host: string
  port: number
  password: string
  enabled: boolean

  // Runtime state
  connectionStatus: PPConnectionStatus
  currentPresentation: PPPresentation | null
  slides: PPSlide[]
  activeSlideIndex: number
  lastPushedText: string
  lastPushedAt: number | null

  // Library index — keyed by presentation UID
  libraryEntries: PPLibraryEntry[]        // ordered list from `prl`
  libraryIndex: Record<string, PPSlide[]> // uid -> slides
  libraryLoaded: boolean                  // true once all `pre` responses have landed

  // Actions
  setHost: (host: string) => void
  setPort: (port: number) => void
  setPassword: (password: string) => void
  setEnabled: (enabled: boolean) => void
  setConnectionStatus: (status: PPConnectionStatus) => void
  setCurrentPresentation: (p: PPPresentation | null) => void
  setSlides: (slides: PPSlide[]) => void
  setActiveSlideIndex: (index: number) => void
  setLastPushed: (text: string) => void
  setLibraryEntries: (entries: PPLibraryEntry[]) => void
  indexPresentation: (uid: string, slides: PPSlideInfo[]) => void
  clearLibrary: () => void
}

export const useProPresenterStore = create<ProPresenterState>((set, get) => ({
  host: "127.0.0.1",
  port: 1025,
  password: "",
  enabled: false,

  connectionStatus: "disconnected",
  currentPresentation: null,
  slides: [],
  activeSlideIndex: -1,
  lastPushedText: "",
  lastPushedAt: null,

  libraryEntries: [],
  libraryIndex: {},
  libraryLoaded: false,

  setHost: (host) => set({ host }),
  setPort: (port) => set({ port }),
  setPassword: (password) => set({ password }),
  setEnabled: (enabled) => set({ enabled }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setCurrentPresentation: (currentPresentation) => set({ currentPresentation }),
  setSlides: (slides) => set({ slides }),
  setActiveSlideIndex: (activeSlideIndex) => set({ activeSlideIndex }),
  setLastPushed: (text) =>
    set({ lastPushedText: text, lastPushedAt: Date.now() }),

  setLibraryEntries: (entries) =>
    set({ libraryEntries: entries, libraryLoaded: false }),

  indexPresentation: (uid, slides) => {
    const prev = get().libraryIndex
    const totalEntries = get().libraryEntries.length
    const nextIndex = { ...prev, [uid]: slides }
    // Mark library as loaded once every entry has been indexed
    const loadedCount = Object.keys(nextIndex).length
    set({
      libraryIndex: nextIndex,
      libraryLoaded: totalEntries > 0 && loadedCount >= totalEntries,
    })
  },

  clearLibrary: () =>
    set({ libraryEntries: [], libraryIndex: {}, libraryLoaded: false }),
}))

// -- Persistence (mirrors the pattern in broadcast-store.ts) ------------------

const PERSISTED_KEYS = ["host", "port", "password", "enabled"] as const
type PersistedKey = (typeof PERSISTED_KEYS)[number]

let tauriStore: Store | null = null
let hydrationPromise: Promise<void> | null = null

async function getStore(): Promise<Store> {
  if (!tauriStore) {
    tauriStore = await load("propresenter.json", { autoSave: false, defaults: {} })
  }
  return tauriStore
}

export function hydrateProPresenterSettings(): Promise<void> {
  if (hydrationPromise) return hydrationPromise
  hydrationPromise = (async () => {
    try {
      const store = await getStore()
      const patch: Partial<ProPresenterState> = {}
      for (const key of PERSISTED_KEYS) {
        const value = await store.get(key)
        if (value !== undefined && value !== null) {
          ;(patch as Record<string, unknown>)[key] = value
        }
      }
      if (Object.keys(patch).length > 0) {
        useProPresenterStore.setState(patch)
      }

      let saveTimer: ReturnType<typeof setTimeout> | null = null
      let pendingSave: Promise<void> = Promise.resolve()
      const DEBOUNCE_MS = 300

      useProPresenterStore.subscribe((state, prevState) => {
        const changed = PERSISTED_KEYS.some(
          (k) => state[k as PersistedKey] !== prevState[k as PersistedKey]
        )
        if (!changed) return
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          saveTimer = null
          pendingSave = pendingSave.then(async () => {
            try {
              const s = await getStore()
              const cur = useProPresenterStore.getState()
              for (const key of PERSISTED_KEYS) {
                await s.set(key, cur[key as PersistedKey] as unknown)
              }
              await s.save()
            } catch {
              console.warn("[propresenter] Failed to persist settings")
            }
          })
        }, DEBOUNCE_MS)
      })
    } catch {
      console.warn("[propresenter] Failed to load persisted settings, using defaults")
    }
  })()
  return hydrationPromise
}
