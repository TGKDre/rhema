import { useCallback, useState } from "react"
import { Wifi, WifiOff, Loader2, RefreshCw, SkipForward, Zap, ZapOff } from "lucide-react"
import { useProPresenterStore } from "@/stores/propresenter-store"
import { useSettingsStore } from "@/stores/settings-store"
import { useProPresenter } from "@/hooks/use-propresenter"
import { cn } from "@/lib/utils"

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map = {
    connected: { icon: Wifi, label: "Connected", cls: "text-green-500" },
    connecting: { icon: Loader2, label: "Connecting…", cls: "text-yellow-500 animate-spin" },
    disconnected: { icon: WifiOff, label: "Disconnected", cls: "text-muted-foreground" },
    error: { icon: WifiOff, label: "Error", cls: "text-destructive" },
  } as const

  const entry = map[status as keyof typeof map] ?? map.disconnected
  const Icon = entry.icon

  return (
    <span className={cn("flex items-center gap-1 text-xs font-medium", entry.cls)}>
      <Icon className="h-3.5 w-3.5" />
      {entry.label}
    </span>
  )
}

// ── Slide row ─────────────────────────────────────────────────────────────────

function SlideRow({
  text,
  label,
  index,
  active,
  onTrigger,
}: {
  text: string
  label: string
  index: number
  active: boolean
  onTrigger: (index: number) => void
}) {
  return (
    <button
      onClick={() => onTrigger(index)}
      className={cn(
        "w-full rounded px-2 py-1.5 text-left text-xs transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "hover:bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      <span className="mr-1.5 opacity-50">{index + 1}.</span>
      {label || text || <span className="italic opacity-40">(empty)</span>}
    </button>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function ProPresenterPanel() {
  const connectionStatus = useProPresenterStore((s) => s.connectionStatus)
  const slides = useProPresenterStore((s) => s.slides)
  const activeSlideIndex = useProPresenterStore((s) => s.activeSlideIndex)
  const currentPresentation = useProPresenterStore((s) => s.currentPresentation)
  const enabled = useProPresenterStore((s) => s.enabled)
  const setEnabled = useProPresenterStore((s) => s.setEnabled)
  const libraryEntries = useProPresenterStore((s) => s.libraryEntries)
  const libraryLoaded = useProPresenterStore((s) => s.libraryLoaded)

  const autoMode = useSettingsStore((s) => s.autoMode)
  const setAutoMode = useSettingsStore((s) => s.setAutoMode)

  const { pushLyric, refreshSlides } = useProPresenter()

  const [filter, setFilter] = useState("")

  const handleTrigger = useCallback(
    (index: number) => {
      // Directly trigger by index using the store's WS client via pushLyric
      // on the slide text, or fall back to the slide label
      const slide = slides.find((s) => s.index === index)
      if (slide) pushLyric(slide.text || slide.label)
    },
    [slides, pushLyric]
  )

  const handleNext = useCallback(() => {
    const nextIndex = activeSlideIndex + 1
    const slide = slides.find((s) => s.index === nextIndex)
    if (slide) pushLyric(slide.text || slide.label)
  }, [activeSlideIndex, slides, pushLyric])

  const filteredSlides = filter
    ? slides.filter(
        (s) =>
          s.text.toLowerCase().includes(filter.toLowerCase()) ||
          s.label.toLowerCase().includes(filter.toLowerCase())
      )
    : slides

  const isConnected = connectionStatus === "connected"

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">ProPresenter</span>
          <StatusBadge status={connectionStatus} />
        </div>
        <div className="flex items-center gap-1">
          {/* Auto-Advance toggle */}
          <button
            onClick={() => setAutoMode(!autoMode)}
            title={autoMode ? "Auto-advance ON" : "Auto-advance OFF"}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
              autoMode
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            {autoMode ? <Zap className="h-3.5 w-3.5" /> : <ZapOff className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{autoMode ? "Auto" : "Manual"}</span>
          </button>

          {/* Manual Next */}
          <button
            onClick={handleNext}
            disabled={!isConnected || activeSlideIndex >= slides.length - 1}
            title="Next slide"
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SkipForward className="h-4 w-4" />
          </button>

          {/* Refresh */}
          <button
            onClick={refreshSlides}
            disabled={!isConnected}
            title="Refresh slides"
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>

          {/* Enable toggle */}
          <button
            onClick={() => setEnabled(!enabled)}
            title={enabled ? "Disable ProPresenter" : "Enable ProPresenter"}
            className={cn(
              "rounded px-2 py-1 text-xs transition-colors",
              enabled
                ? "bg-destructive/20 text-destructive hover:bg-destructive/30"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            {enabled ? "Disable" : "Enable"}
          </button>
        </div>
      </div>

      {/* Presentation info */}
      {currentPresentation && (
        <div className="shrink-0 border-b bg-muted/40 px-3 py-1.5">
          <p className="truncate text-xs font-medium">{currentPresentation.name}</p>
          <p className="text-[10px] text-muted-foreground">
            {currentPresentation.slideCount} slide{currentPresentation.slideCount !== 1 ? "s" : ""}
            {libraryLoaded && (
              <span className="ml-2 text-green-500">
                · {libraryEntries.length} songs indexed
              </span>
            )}
          </p>
        </div>
      )}

      {/* Slide filter */}
      {slides.length > 0 && (
        <div className="shrink-0 border-b px-3 py-1.5">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter slides…"
            className="w-full rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      )}

      {/* Slide list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!enabled ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <WifiOff className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              Enable ProPresenter integration above,
              <br />or configure it in Settings.
            </p>
          </div>
        ) : !isConnected ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            {connectionStatus === "connecting" ? (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/40" />
            ) : (
              <WifiOff className="h-8 w-8 text-muted-foreground/40" />
            )}
            <p className="text-xs text-muted-foreground">
              {connectionStatus === "connecting"
                ? "Connecting to ProPresenter…"
                : "Not connected. Check host/port in Settings."}
            </p>
          </div>
        ) : slides.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-xs text-muted-foreground">
              No slides loaded.
              <br />
              Open a presentation in ProPresenter.
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredSlides.map((slide) => (
              <SlideRow
                key={slide.uid || slide.index}
                text={slide.text}
                label={slide.label}
                index={slide.index}
                active={slide.index === activeSlideIndex}
                onTrigger={handleTrigger}
              />
            ))}
            {filteredSlides.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">No matches</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
