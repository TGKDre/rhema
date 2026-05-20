/**
 * Grace Song Library Store
 *
 * Persists a curated corpus of songs (name + structured lyrics) that Grace
 * uses as a third-stage fallback when neither the active PP presentation nor
 * the full PP library index produces a confident match.
 *
 * Each song has:
 *   - id        unique UUID
 *   - name      display name (e.g. "I Know Who I Am")
 *   - artist    optional (e.g. "Loveworld Singers")
 *   - slides    ordered array of lyric blocks (verse, chorus, bridge, etc.)
 *
 * Persistence: tauri-plugin-store → song-library.json
 */

import { create } from "zustand"
import { load, type Store } from "@tauri-apps/plugin-store"

export interface SongSlide {
  id: string       // uuid
  label: string    // "Verse 1", "Chorus", "Bridge", etc.
  text: string     // full lyric block
}

export interface Song {
  id: string
  name: string
  artist: string
  slides: SongSlide[]
  createdAt: number
  updatedAt: number
}

interface SongLibraryState {
  songs: Song[]
  loaded: boolean

  addSong: (song: Omit<Song, "id" | "createdAt" | "updatedAt">) => Song
  updateSong: (id: string, patch: Partial<Omit<Song, "id" | "createdAt">>) => void
  deleteSong: (id: string) => void
  importSongs: (songs: Song[]) => void
  setLoaded: (loaded: boolean) => void
}

function uuid(): string {
  return crypto.randomUUID()
}

export const useSongLibraryStore = create<SongLibraryState>((set, get) => ({
  songs: [],
  loaded: false,

  addSong: (data) => {
    const now = Date.now()
    const song: Song = {
      ...data,
      id: uuid(),
      createdAt: now,
      updatedAt: now,
    }
    set((s) => ({ songs: [...s.songs, song] }))
    persistLibrary()
    return song
  },

  updateSong: (id, patch) => {
    set((s) => ({
      songs: s.songs.map((song) =>
        song.id === id
          ? { ...song, ...patch, updatedAt: Date.now() }
          : song
      ),
    }))
    persistLibrary()
  },

  deleteSong: (id) => {
    set((s) => ({ songs: s.songs.filter((song) => song.id !== id) }))
    persistLibrary()
  },

  importSongs: (incoming) => {
    set((s) => {
      const existingIds = new Set(s.songs.map((s) => s.id))
      const newSongs = incoming.filter((s) => !existingIds.has(s.id))
      return { songs: [...s.songs, ...newSongs] }
    })
    persistLibrary()
  },

  setLoaded: (loaded) => set({ loaded }),
}))

// -- Persistence --------------------------------------------------------------

let tauriStore: Store | null = null
let hydrating = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

async function getStore(): Promise<Store> {
  if (!tauriStore) {
    tauriStore = await load("song-library.json", { autoSave: false, defaults: {} })
  }
  return tauriStore
}

function persistLibrary() {
  if (hydrating) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      const store = await getStore()
      const songs = useSongLibraryStore.getState().songs
      await store.set("songs", songs)
      await store.save()
    } catch {
      console.warn("[song-library] Failed to persist")
    }
  }, 400)
}

export async function hydrateSongLibrary(): Promise<void> {
  hydrating = true
  try {
    const store = await getStore()
    const songs = await store.get<Song[]>("songs")
    if (Array.isArray(songs) && songs.length > 0) {
      useSongLibraryStore.setState({ songs })
    }
  } catch {
    console.warn("[song-library] Failed to hydrate, starting empty")
  } finally {
    hydrating = false
    useSongLibraryStore.getState().setLoaded(true)
  }
}
