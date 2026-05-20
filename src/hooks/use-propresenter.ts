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
 */

import { useEffect, useRef, useCallback } from "react"
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
  const intersection = [...setA].filter((w) => setB.has(w)).length
  const union = new Set([...setA, ...setB]).size
  return intersection / union
}

interface SlideMatch {
  slideIndex: number
  score: number
}

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
  const librarySongs = useSongLibraryStore((s) => s.songs)

  const clientRef = useRef<ProPresenterWSClient | null>(null)
  const lastActedSegmentId = useRef<string | null>(null)
  // Rebuild corpus index whenever songs change
  const corpusIndexRef = useRef<CorpusSlide[]>([])

  useEffect(() => {
    corpusIndexRef.current = buildCorpusIndex(librarySongs)
  }, [librarySongs])

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

      onLibraryList: (entries) => {
        store.setLibraryEntries(entries)
      },

      onLibraryPresentation: (uid, ppSlides) => {
        store.indexPresentation(uid, ppSlides)
        const { libraryLoaded, libraryEntries } = useProPresenterStore.getState()
        if (libraryLoaded) {
          toast.success("Library indexed", {
            id: "pp-library",
            description: `${libraryEntries.length} song${
              libraryEntries.length === 1 ? "" : "s"
            } ready for autonomous matching`,
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

  // -- Push logic (3 stages) ------------------------------------------------

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

      // Stage 1: active presentation fast path
      if (currentSlides.length > 0) {
        const match = findBestSlide(text, currentSlides)
        if (match) {
          client.triggerSlide(match.slideIndex)
          store.setLastPushed(text)
          store.setActiveSlideIndex(match.slideIndex)
          return
        }
      } else {
        client.requestCurrentPresentation()
        toast.info("Fetching ProPresenter slides...", { id: "pp-fetching" })
        return
      }

      // Stage 2: full PP library index
      const { libraryIndex, libraryEntries } = store
      if (Object.keys(libraryIndex).length > 0) {
        const libMatch = findBestLibraryMatch(text, libraryIndex, libraryEntries)
        if (libMatch) {
          client.switchPresentationAndTrigger(libMatch.uid, libMatch.slideIndex)
          store.setLastPushed(text)
          toast.info(`Switched to "${libMatch.name}"`, {
            id: "pp-switch",
            description: `Slide ${libMatch.slideIndex + 1} — ${Math.round(libMatch.score * 100)}% match`,
          })
          return
        }
      }

      // Stage 3: Grace internal song corpus
      const corpusIndex = corpusIndexRef.current
      if (corpusIndex.length === 0) return

      const corpusMatch = findBestCorpusMatch(text, corpusIndex)
      if (!corpusMatch) return

      // Find the PP library UID whose name most closely matches the corpus song name
      const normCorpusName = corpusMatch.songName.toLowerCase()
      const ppEntry = store.libraryEntries.find(
        (e) => e.name.toLowerCase().includes(normCorpusName) ||
               normCorpusName.includes(e.name.toLowerCase())
      )

      if (ppEntry) {
        // We know which PP presentation this is — switch and trigger
        client.switchPresentationAndTrigger(ppEntry.uid, corpusMatch.slideIndex)
        store.setLastPushed(text)
        toast.info(`Corpus match: "${corpusMatch.songName}"`, {
          id: "pp-corpus-switch",
          description: `${corpusMatch.label} — ${Math.round(corpusMatch.score * 100)}% match`,
        })
      } else {
        // Song is in the Grace corpus but not found in PP library by name —
        // alert the operator so they can manually load it
        toast.warning(`Load "${corpusMatch.songName}" in ProPresenter`, {
          id: "pp-load-prompt",
          description: `Grace matched this song but it isn't open in ProPresenter.`,
          duration: 8000,
        })
      }
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
