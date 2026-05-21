/**
 * useProPresenter
 *
 * Manages the ProPresenter Remote Control WebSocket connection and exposes
 * pushLyric(text) for autonomous slide matching.
 *
 * 3-stage matching priority:
 *   1. Active PP presentation slides (fastest — already loaded in memory)
 *   2. Full PP library index (cross-song — fetched in background on connect)
 *   3. Grace internal song corpus (persistent — survives PP restarts)
 *
 * Library indexing:
 *   On every successful connection the WS client fetches the full `prl`
 *   list, then drip-feeds `pre` requests in the background.
 *
 * Corpus indexing:
 *   Built from useSongLibraryStore on hook mount and whenever songs change.
 *   Uses a lower threshold (0.30) since the corpus is curated and lyrics
 *   are clean, unlike live transcripts matched against PP slide text.
 *
 * Auto-advance sync:
 *   When autoMode changes, the hook calls `pp_set_auto_advance` on the
 *   Rust side so the STT pipeline's `check_reading_mode` can fire
 *   `trigger_next` on every ReadingAdvance without any JS involvement.
 */

import { useEffect, useRef, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { ProPresenterWSClient } from "@/lib/propresenter-ws"
import { useProPresenterStore } from "@/stores/propresenter-store"
import { useSettingsStore } from "@/stores/settings-store"
import { useTranscriptStore } from "@/stores/transcript-store"
import { useSongLibraryStore } from "@/stores/song-library-store"
import { buildCorpusIndex, findBestCorpusMatch } from "@/lib/song-library-db"
import { useTauriEvent } from "./use-tauri-event"
import type { PPSlide } from "@/stores/propresenter-store"
import type { CorpusSlide } from "@/lib/song-library-db"

// -- PP slide matching helpers -----------------------------------------------

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function similarity(a: string, b: string): number {
  const setA = new Set(a.split(" ").filter(Boolean))
  const setB = new Set(b.split(" ").filter(Boolean))
  if (setA.size === 0 || setB.size === 0) return 0
  const intersection = [...setA].filter((w) => setB.has(w))
  return intersection.length / Math.max(setA.size, setB.size)
}

export function useProPresenter() {
  const wsRef = useRef<ProPresenterWSClient | null>(null)
  const songs = useSongLibraryStore((s) => s.songs)
  const corpusRef = useRef<CorpusSlide[]>([])

  const {
    host,
    port,
    password,
    enabled,
    setConnectionStatus,
    setCurrentPresentation,
    setSlides,
    setActiveSlideIndex,
    setLastPushed,
    setLibraryEntries,
    indexPresentation,
    clearLibrary,
    libraryIndex,
  } = useProPresenterStore()

  const autoMode = useSettingsStore((s) => s.autoMode)
  const lastTranscript = useTranscriptStore((s) => s.lastFinalTranscript)

  // -- Corpus index -----------------------------------------------------------
  // Rebuilt whenever the song library changes.
  useEffect(() => {
    corpusRef.current = buildCorpusIndex(songs)
  }, [songs])

  // -- Auto-advance Rust-side sync --------------------------------------------
  // Mirror every autoMode change to the Rust AppState so `check_reading_mode`
  // in stt.rs knows whether to fire `trigger_next` on ReadingAdvance events.
  useEffect(() => {
    invoke("pp_set_auto_advance", { enabled: autoMode }).catch((err) => {
      // Non-fatal — PP may not be connected yet. Log but don't toast.
      console.warn("[PP] pp_set_auto_advance failed:", err)
    })
  }, [autoMode])

  // -- WS connection lifecycle ------------------------------------------------
  useEffect(() => {
    if (!enabled) {
      wsRef.current?.disconnect()
      wsRef.current = null
      setConnectionStatus("disconnected")
      clearLibrary()
      return
    }

    const ws = new ProPresenterWSClient(host, port, password)
    wsRef.current = ws

    ws.onStatusChange = (status) => {
      setConnectionStatus(status)
      if (status === "connected") {
        toast.success("ProPresenter connected")
        // Start background library indexing
        ws.fetchLibraryIndex().then((entries) => {
          setLibraryEntries(entries)
          for (const entry of entries) {
            ws.fetchPresentation(entry.uid).then((slides) => {
              indexPresentation(entry.uid, slides)
            })
          }
        })
      } else if (status === "disconnected") {
        toast.info("ProPresenter disconnected")
        clearLibrary()
      } else if (status === "error") {
        toast.error("ProPresenter connection error")
      }
    }

    ws.onPresentationChange = (presentation, slides) => {
      setCurrentPresentation({
        uid: presentation.uid,
        name: presentation.name,
        slideCount: slides.length,
      })
      setSlides(
        slides.map((s, i) => ({
          uid: s.uid ?? `slide-${i}`,
          index: s.index ?? i,
          text: s.slideText ?? "",
          label: s.label ?? "",
        }))
      )
      setActiveSlideIndex(0)
    }

    ws.onSlideChange = (index) => {
      setActiveSlideIndex(index)
    }

    ws.connect()

    return () => {
      ws.disconnect()
      wsRef.current = null
      setConnectionStatus("disconnected")
    }
  }, [enabled, host, port, password])

  // -- pushLyric --------------------------------------------------------------
  const pushLyric = useCallback(
    (text: string) => {
      const ws = wsRef.current
      if (!ws) return

      const norm = normalise(text)
      if (!norm) return

      const { slides, libraryIndex: index } = useProPresenterStore.getState()

      // Stage 1: active presentation
      let best: { uid: string; index: number } | null = null
      let bestScore = 0.45

      for (const slide of slides) {
        const score = similarity(norm, normalise(slide.text))
        if (score > bestScore) {
          bestScore = score
          best = { uid: slide.uid, index: slide.index }
        }
      }

      // Stage 2: library index
      if (!best) {
        for (const [uid, libSlides] of Object.entries(index)) {
          for (const slide of libSlides as PPSlide[]) {
            const score = similarity(norm, normalise(slide.text))
            if (score > bestScore) {
              bestScore = score
              best = { uid: slide.uid, index: slide.index }
            }
          }
        }
      }

      // Stage 3: corpus
      if (!best) {
        const match = findBestCorpusMatch(corpusRef.current, norm, 0.3)
        if (match) {
          best = { uid: match.uid, index: match.index }
        }
      }

      if (best) {
        ws.triggerSlide(best.uid, best.index)
        setLastPushed(text)
      }
    },
    [setLastPushed]
  )

  // -- refreshSlides ----------------------------------------------------------
  const refreshSlides = useCallback(() => {
    wsRef.current?.refreshPresentation()
  }, [])

  // -- Auto-push on transcript ------------------------------------------------
  useEffect(() => {
    if (!autoMode || !lastTranscript) return
    pushLyric(lastTranscript)
  }, [lastTranscript, autoMode, pushLyric])

  return { pushLyric, refreshSlides }
}
