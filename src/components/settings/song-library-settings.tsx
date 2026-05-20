/**
 * Song Library Settings Panel
 *
 * Lets the user manage Grace's internal song corpus:
 *   - Add songs manually (name, artist, lyric blocks)
 *   - Edit or delete existing songs
 *   - Import from JSON or plain-text CSV
 *   - Export the full library to JSON
 */

import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  PlusIcon,
  Trash2Icon,
  PencilIcon,
  UploadIcon,
  DownloadIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CheckIcon,
  XIcon,
} from "lucide-react"
import { useSongLibraryStore } from "@/stores/song-library-store"
import type { Song, SongSlide } from "@/stores/song-library-store"

function uuid() {
  return crypto.randomUUID()
}

// -- Slide editor used inside the song form ----------------------------------

function SlideEditor({
  slides,
  onChange,
}: {
  slides: SongSlide[]
  onChange: (slides: SongSlide[]) => void
}) {
  const addSlide = () =>
    onChange([
      ...slides,
      { id: uuid(), label: `Section ${slides.length + 1}`, text: "" },
    ])

  const updateSlide = (id: string, field: keyof SongSlide, value: string) =>
    onChange(slides.map((s) => (s.id === id ? { ...s, [field]: value } : s)))

  const removeSlide = (id: string) =>
    onChange(slides.filter((s) => s.id !== id))

  const moveSlide = (id: string, dir: -1 | 1) => {
    const idx = slides.findIndex((s) => s.id === id)
    if (idx + dir < 0 || idx + dir >= slides.length) return
    const next = [...slides]
    ;[next[idx], next[idx + dir]] = [next[idx + dir], next[idx]]
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-2">
      {slides.map((slide, idx) => (
        <div key={slide.id} className="rounded-lg border border-border bg-muted/20 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              value={slide.label}
              onChange={(e) => updateSlide(slide.id, "label", e.target.value)}
              placeholder="Label (e.g. Verse 1, Chorus)"
              className="h-7 text-xs flex-1"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => moveSlide(slide.id, -1)}
              disabled={idx === 0}
            >
              <ChevronUpIcon className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => moveSlide(slide.id, 1)}
              disabled={idx === slides.length - 1}
            >
              <ChevronDownIcon className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-destructive hover:text-destructive"
              onClick={() => removeSlide(slide.id)}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
          <textarea
            value={slide.text}
            onChange={(e) => updateSlide(slide.id, "text", e.target.value)}
            placeholder="Paste lyric block here..."
            rows={3}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="text-xs w-full mt-1"
        onClick={addSlide}
      >
        <PlusIcon className="size-3 mr-1.5" />
        Add Section
      </Button>
    </div>
  )
}

// -- Add / Edit song form ----------------------------------------------------

function SongForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Song
  onSave: (data: { name: string; artist: string; slides: SongSlide[] }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [artist, setArtist] = useState(initial?.artist ?? "")
  const [slides, setSlides] = useState<SongSlide[]>(
    initial?.slides ?? [{ id: uuid(), label: "Verse 1", text: "" }]
  )

  const valid = name.trim().length > 0 && slides.some((s) => s.text.trim())

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground">
              Song Name *
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. I Know Who I Am"
              className="h-8 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground">
              Artist
            </label>
            <Input
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              placeholder="e.g. Loveworld Singers"
              className="h-8 text-xs"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground">
            Lyric Sections
          </label>
          <SlideEditor slides={slides} onChange={setSlides} />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!valid} onClick={() => onSave({ name, artist, slides })}>
          <CheckIcon className="size-3 mr-1.5" />
          {initial ? "Save Changes" : "Add Song"}
        </Button>
      </div>
    </div>
  )
}

// -- Song row ----------------------------------------------------------------

function SongRow({ song }: { song: Song }) {
  const [editing, setEditing] = useState(false)
  const updateSong = useSongLibraryStore((s) => s.updateSong)
  const deleteSong = useSongLibraryStore((s) => s.deleteSong)

  if (editing) {
    return (
      <SongForm
        initial={song}
        onSave={(data) => {
          updateSong(song.id, data)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5 gap-3">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-xs font-medium truncate">{song.name}</span>
        <div className="flex items-center gap-2">
          {song.artist && (
            <span className="text-[0.625rem] text-muted-foreground truncate">
              {song.artist}
            </span>
          )}
          <Badge variant="outline" className="text-[0.5rem] h-3.5 px-1 shrink-0">
            {song.slides.length} section{song.slides.length !== 1 ? "s" : ""}
          </Badge>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setEditing(true)}
        >
          <PencilIcon className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-destructive hover:text-destructive"
          onClick={() => deleteSong(song.id)}
        >
          <Trash2Icon className="size-3" />
        </Button>
      </div>
    </div>
  )
}

// -- Main settings panel -----------------------------------------------------

export function SongLibrarySettings() {
  const songs = useSongLibraryStore((s) => s.songs)
  const addSong = useSongLibraryStore((s) => s.addSong)
  const importSongs = useSongLibraryStore((s) => s.importSongs)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const filtered = songs.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.artist.toLowerCase().includes(search.toLowerCase())
  )

  // -- JSON export
  const handleExport = () => {
    const json = JSON.stringify(songs, null, 2)
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "grace-song-library.json"
    a.click()
    URL.revokeObjectURL(url)
  }

  // -- JSON / CSV import
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string
        if (file.name.endsWith(".json")) {
          const parsed = JSON.parse(text) as Song[]
          if (Array.isArray(parsed)) importSongs(parsed)
        } else if (file.name.endsWith(".csv") || file.name.endsWith(".txt")) {
          // Simple CSV: song_name,artist,label,lyric_text
          const lines = text.split("\n").filter(Boolean)
          const songMap = new Map<string, { artist: string; slides: SongSlide[] }>()
          for (const line of lines) {
            const [songName, artist, label, ...rest] = line.split(",")
            const text = rest.join(",").trim()
            if (!songName || !text) continue
            if (!songMap.has(songName)) {
              songMap.set(songName, { artist: artist ?? "", slides: [] })
            }
            songMap.get(songName)!.slides.push({
              id: uuid(),
              label: label ?? `Section ${songMap.get(songName)!.slides.length + 1}`,
              text,
            })
          }
          const now = Date.now()
          const imported: Song[] = [...songMap.entries()].map(([name, data]) => ({
            id: uuid(),
            name,
            artist: data.artist,
            slides: data.slides,
            createdAt: now,
            updatedAt: now,
          }))
          importSongs(imported)
        }
      } catch (err) {
        console.error("[song-library] Import failed", err)
      }
    }
    reader.readAsText(file)
    // reset so same file can be re-imported
    e.target.value = ""
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search songs..."
          className="h-8 text-xs flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          className="text-xs shrink-0"
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadIcon className="size-3 mr-1.5" />
          Import
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-xs shrink-0"
          onClick={handleExport}
          disabled={songs.length === 0}
        >
          <DownloadIcon className="size-3 mr-1.5" />
          Export
        </Button>
        <Button
          size="sm"
          className="text-xs shrink-0"
          onClick={() => setAdding(true)}
          disabled={adding}
        >
          <PlusIcon className="size-3 mr-1.5" />
          Add Song
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv,.txt"
          className="hidden"
          onChange={handleImportFile}
        />
      </div>

      {/* Stats */}
      <p className="text-[0.625rem] text-muted-foreground">
        {songs.length} song{songs.length !== 1 ? "s" : ""} in library
        {songs.length > 0 && ` · ${songs.reduce((acc, s) => acc + s.slides.length, 0)} total sections indexed`}
      </p>

      {/* Add form */}
      {adding && (
        <SongForm
          onSave={(data) => {
            addSong(data)
            setAdding(false)
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {/* Song list */}
      <div className="flex flex-col gap-2">
        {filtered.length === 0 && !adding && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-xs text-muted-foreground">
              {songs.length === 0
                ? "No songs yet. Add songs manually or import a JSON / CSV file."
                : "No songs match your search."}
            </p>
          </div>
        )}
        {filtered.map((song) => (
          <SongRow key={song.id} song={song} />
        ))}
      </div>
    </div>
  )
}
