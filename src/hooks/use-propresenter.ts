/**
 * useProPresenter
 *
 * Manages the ProPresenter Remote Control WebSocket connection and exposes
 * pushLyric(text) for autonomous slide matching.
 *
 * Matching priority:
 *   1. Search the currently active presentation's slides (fast path).
 *   2. If no match found, search the full library index and switch
 *      ProPresenter to the best-matching song before triggering the slide.
 *
 * Library indexing:
 *   On every successful connection the WS client fetches the full `prl`
 *   list, then drip-feeds `pre` requests one-at-a-time in the background.
 *   The store accumulates them in libraryIndex. Once all presentations have
 *   been fetched, libraryLoaded flips to true.
 */

import { useEffect, useRef, useCallback } from "react"
import { toast } from "sonner"
import { ProPresenterWSClient } from "@/lib/propresenter-ws"
import { useProPresenterStore } from "@/stores/propresenter-store"
import { useSettingsStore } from "@/stores/settings-store"
import { useTranscriptStore } from "@/stores/transcript-store"
import { useTauriEvent } from "./use-tauri-event"
import type { PPSlide } from "@/stores/propresenter-store"

// -- Lyric matching helpers --------------------------------------------------

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
  const intersection = [...setA].filter((w) => setB.has(w)).length
  const union = new Set([...setA, ...setB]).size
  return intersection / union
}

interface SlideMatch {
  slideIndex: number
  score: number
}

/** Find the best matching slide within a single presentation's slide list. */
function findBestSlide(
  transcript: string,
  slides: PPSlide[],
  threshold = 0.35
): SlideMatch | null {
  const normTranscript = normalise(transcript)
  let bestIndex = -1
  let bestScore = threshold

  for (const slide of slides) {
    if (!slide.text) continue
    const score = similarity(normTranscript, normalise(slide.text))
    if (score > bestScore) {
      bestScore = score
      bestIndex = slide.index
    }
  }

  return bestIndex === -1 ? null : { slideIndex: bestIndex, score: bestScore }
}

interface LibraryMatch {
  uid: string
  name: string
  slideIndex: number
  score: number
}

/**
 * Search the entire library index for the best-matching slide across all songs.
 * Returns null if nothing clears the threshold.
 */
function findBestLibraryMatch(
  transcript: string,
  libraryIndex: Record<string, PPSlide[]>,
  libraryEntries: { uid: string; name: string }[],
  threshold = 0.35
): LibraryMatch | null {
  let best: LibraryMatch | null = null

  for (const entry of libraryEntries) {
    const slides = libraryIndex[entry.uid]
    if (!slides) continue
    const match = findBestSlide(transcript, slides, threshold)
    if (match && (!best || match.score > best.score)) {
      best = {
        uid: entry.uid,
        name: entry.name,
        slideIndex: match.slideIndex,
        score: match.score,
      }
    }
  }

  return best
}

// -- Hook --------------------------------------------------------------------

export function useProPresenter() {
  const enabled = useProPresenterStore((s) => s.enabled)
  const host = useProPresenterStore((s) => s.host)
  const port = useProPresenterStore((s) => s.port)
  const password = useProPresenterStore((s) => s.password)
  const connectionStatus = useProPresenterStore((s) => s.connectionStatus)
  const slides = useProPresenterStore((s) => s.slides)
  const autoMode = useSettingsStore((s) => s.autoMode)

  const clientRef = useRef<ProPresenterWSClient | null>(null)
  const lastActedSegmentId = useRef<string | null>(null)

  // -- Connection lifecycle --------------------------------------------------

  useEffect(() => {
    if (!enabled) {
      clientRef.current?.disconnect()
      clientRef.current = null
      useProPresenterStore.getState().clearLibrary()
      return
    }

    const store = useProPresenterStore.getState()

    const client = new ProPresenterWSClient(host, port, password, {
      onStatusChange: (status) => {
        store.setConnectionStatus(status)
        if (status === "connected") {
          toast.success("ProPresenter connected", {
            id: "pp-connection",
            description: `${host}:${port}`,
          })
        } else if (status === "disconnected") {
          toast.info("ProPresenter disconnected", { id: "pp-connection" })
          store.clearLibrary()
        }
      },

      onSlides: (ppSlides, presentation) => {
        store.setSlides(ppSlides)
        store.setCurrentPresentation(presentation)
      },

      onSlideIndexChange: (index) => {
        store.setActiveSlideIndex(index)
      },

      onError: (msg) => {
        toast.error("ProPresenter error", { description: msg, id: "pp-error" })
      },

      /** Receive the full library list and register all UIDs in the store. */
      onLibraryList: (entries) => {
        store.setLibraryEntries(entries)
      },

      /** Each presentation fetched during background indexing lands here. */
      onLibraryPresentation: (uid, ppSlides) => {
        store.indexPresentation(uid, ppSlides)
        // Once every song is indexed, fire a subtle toast
        const { libraryLoaded, libraryEntries } = useProPresenterStore.getState()
        if (libraryLoaded) {
          toast.success("Library indexed", {
            id: "pp-library",
            description: `${libraryEntries.length} song${libraryEntries.length === 1 ? "" : "s"} ready for autonomous matching`,
          })
        }
      },
    })

    clientRef.current = client
    client.connect()

    return () => {
      client.disconnect()
      clientRef.current = null
    }
  }, [enabled, host, port, password])

  // -- Auto-push on transcript_final ----------------------------------------

  useTauriEvent<{ text: string; is_final: boolean; confidence: number }>(
    "transcript_final",
    (payload) => {
      if (!autoMode || !enabled) return
      if (connectionStatus !== "connected") return

      const segments = useTranscriptStore.getState().segments
      const latest = segments[segments.length - 1]
      if (!latest || latest.id === lastActedSegmentId.current) return

      lastActedSegmentId.current = latest.id
      pushLyric(payload.text)
    }
  )

  // -- Manual / programmatic push -------------------------------------------

  const pushLyric = useCallback(
    (text: string) => {
      const client = clientRef.current
      if (!client || connectionStatus !== "connected") {
        toast.warning("ProPresenter not connected", {
          description: "Enable the ProPresenter integration in Settings.",
          id: "pp-not-connected",
        })
        return
      }

      const store = useProPresenterStore.getState()
      const currentSlides = store.slides

      // 1. Fast path: try matching against the active presentation
      if (currentSlides.length > 0) {
        const match = findBestSlide(text, currentSlides)
        if (match) {
          client.triggerSlide(match.slideIndex)
          store.setLastPushed(text)
          store.setActiveSlideIndex(match.slideIndex)
          return
        }
      } else {
        // No slides loaded yet — request them and bail
        client.requestCurrentPresentation()
        toast.info("Fetching ProPresenter slides...", { id: "pp-fetching" })
        return
      }

      // 2. Cross-song library search
      const { libraryIndex, libraryEntries, libraryLoaded } = store

      if (!libraryLoaded && Object.keys(libraryIndex).length === 0) {
        // Library hasn't started indexing yet — nothing we can do
        return
      }

      const libraryMatch = findBestLibraryMatch(text, libraryIndex, libraryEntries)

      if (!libraryMatch) return

      // Switch PP to the matching song and trigger the right slide
      client.switchPresentationAndTrigger(libraryMatch.uid, libraryMatch.slideIndex)
      store.setLastPushed(text)

      toast.info(`Switched to "${libraryMatch.name}"`, {
        id: "pp-switch",
        description: `Slide ${libraryMatch.slideIndex + 1} — ${Math.round(libraryMatch.score * 100)}% match`,
      })
    },
    [connectionStatus]
  )

  const refreshSlides = useCallback(() => {
    clientRef.current?.requestCurrentPresentation()
  }, [])

  return {
    connectionStatus,
    pushLyric,
    refreshSlides,
    slides,
  }
}
