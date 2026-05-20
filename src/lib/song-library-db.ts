/**
 * Song Library In-Memory Search Index
 *
 * Builds a flat list of searchable slide records from the Grace song corpus
 * and exposes findBestCorpusMatch() for use in use-propresenter.ts.
 */

import type { Song, SongSlide } from "@/stores/song-library-store"

export interface CorpusSlide {
  songId: string
  songName: string
  slideIndex: number
  label: string
  normText: string   // pre-normalised for fast comparison
  rawText: string
}

export interface CorpusMatch {
  songName: string
  songId: string
  slideIndex: number
  label: string
  score: number
}

// -- Text helpers -------------------------------------------------------------

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(" ").filter(Boolean))
  const setB = new Set(b.split(" ").filter(Boolean))
  if (setA.size === 0 || setB.size === 0) return 0
  const intersection = [...setA].filter((w) => setB.has(w)).length
  const union = new Set([...setA, ...setB]).size
  return intersection / union
}

// -- Index builder ------------------------------------------------------------

export function buildCorpusIndex(songs: Song[]): CorpusSlide[] {
  const index: CorpusSlide[] = []
  for (const song of songs) {
    song.slides.forEach((slide: SongSlide, i: number) => {
      if (!slide.text.trim()) return
      index.push({
        songId: song.id,
        songName: song.name,
        slideIndex: i,
        label: slide.label,
        normText: normalise(slide.text),
        rawText: slide.text,
      })
    })
  }
  return index
}

// -- Search -------------------------------------------------------------------

export function findBestCorpusMatch(
  transcript: string,
  index: CorpusSlide[],
  threshold = 0.30
): CorpusMatch | null {
  const normTranscript = normalise(transcript)
  let best: CorpusMatch | null = null

  for (const entry of index) {
    const score = jaccardSimilarity(normTranscript, entry.normText)
    if (score >= threshold && (!best || score > best.score)) {
      best = {
        songId: entry.songId,
        songName: entry.songName,
        slideIndex: entry.slideIndex,
        label: entry.label,
        score,
      }
    }
  }

  return best
}
