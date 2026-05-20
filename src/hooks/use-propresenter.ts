/**
 * useProPresenter
 *
 * Manages the ProPresenter Remote Control WebSocket connection and exposes
 * pushLyric(text) to find and trigger the best-matching slide.
 *
 * Flow:
 *   1. STT pipeline fires `transcript_final` Tauri event.
 *   2. This hook picks it up via useTauriEvent (when autoMode is on).
 *   3. pushLyric() fuzzy-matches the transcript against loaded PP slides.
 *   4. The best match is triggered via ProPresenterWSClient.triggerSlide().
 */

import { useEffect, useRef, useCallback } from "react"
import { toast } from "sonner"
import { ProPresenterWSClient } from "@/lib/propresenter-ws"
import { useProPresenterStore } from "@/stores/propresenter-store"
import { useSettingsStore } from "@/stores/settings-store"
import { useTranscriptStore } from "@/stores/transcript-store"
import { useTauriEvent } from "./use-tauri-event"

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

function findBestSlide(
  transcript: string,
  slides: { index: number; text: string }[],
  threshold = 0.35
): number {
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

  return bestIndex
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
      if (!clientRef.current || connectionStatus !== "connected") {
        toast.warning("ProPresenter not connected", {
          description: "Enable the ProPresenter integration in Settings.",
          id: "pp-not-connected",
        })
        return
      }

      const currentSlides = useProPresenterStore.getState().slides

      if (currentSlides.length === 0) {
        clientRef.current.requestCurrentPresentation()
        toast.info("Fetching ProPresenter slides...", { id: "pp-fetching" })
        return
      }

      const bestIndex = findBestSlide(text, currentSlides)

      if (bestIndex === -1) return

      clientRef.current.triggerSlide(bestIndex)
      useProPresenterStore.getState().setLastPushed(text)
      useProPresenterStore.getState().setActiveSlideIndex(bestIndex)
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
