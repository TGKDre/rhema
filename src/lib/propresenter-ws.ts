/**
 * ProPresenter Remote Control WebSocket client.
 *
 * Supports the ProPresenter 6 / 7 Remote Control protocol that runs on the
 * same port as Stage Display (default 1025). Authentication uses the
 * ProPresenter "Remote" password (Preferences > Network > Enable Remote).
 *
 * Protocol reference: https://github.com/jeffmikels/ProPresenter-API
 */

export type PPWSStatus = "disconnected" | "connecting" | "connected" | "error"

export interface PPSlideInfo {
  uid: string
  index: number
  text: string
  label: string
}

export interface PPPresentationInfo {
  uid: string
  name: string
  slideCount: number
}

export interface PPLibraryEntry {
  uid: string
  name: string
}

export interface PPWSCallbacks {
  onStatusChange: (status: PPWSStatus) => void
  onSlides: (slides: PPSlideInfo[], presentation: PPPresentationInfo) => void
  onSlideIndexChange: (index: number) => void
  onError: (msg: string) => void
  /** Fired once after authentication with the full library list. */
  onLibraryList?: (entries: PPLibraryEntry[]) => void
  /** Fired for every presentation fetched during library indexing. */
  onLibraryPresentation?: (uid: string, slides: PPSlideInfo[]) => void
}

const PROTOCOL_VERSION = 610

export class ProPresenterWSClient {
  private ws: WebSocket | null = null
  private authenticated = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private host: string
  private port: number
  private password: string
  private callbacks: PPWSCallbacks

  /**
   * UIDs queued for background library indexing. We drip-feed one request
   * at a time so we don't flood PP with simultaneous `pre` requests.
   */
  private indexQueue: string[] = []
  private indexingActive = false

  constructor(
    host: string,
    port: number,
    password: string,
    callbacks: PPWSCallbacks
  ) {
    this.host = host
    this.port = port
    this.password = password
    this.callbacks = callbacks
  }

  // -- Public API ------------------------------------------------------------

  connect(): void {
    this.intentionalClose = false
    this._connect()
  }

  disconnect(): void {
    this.intentionalClose = true
    this._clearReconnect()
    this.indexQueue = []
    this.indexingActive = false
    this.ws?.close()
    this.ws = null
    this.authenticated = false
    this.callbacks.onStatusChange("disconnected")
  }

  /**
   * Trigger a specific slide by 0-based index in the current presentation.
   */
  triggerSlide(index: number): void {
    this._send({ acn: "sl", uid: "", num: index })
  }

  /**
   * Switch ProPresenter to the presentation with the given UID and immediately
   * trigger the slide at `slideIndex`.
   */
  switchPresentationAndTrigger(uid: string, slideIndex: number): void {
    // `prl` with a uid focuses the presentation in PP
    this._send({ acn: "pre", uid })
    // Small delay then trigger — PP needs a moment to load the presentation
    setTimeout(() => {
      this._send({ acn: "sl", uid, num: slideIndex })
    }, 150)
  }

  /**
   * Request the presentation list (library) from ProPresenter.
   * Response arrives as `prl` and is forwarded to onLibraryList.
   */
  requestLibrary(): void {
    this._send({ acn: "prl", ptl: PROTOCOL_VERSION })
  }

  /**
   * Request the currently active presentation's slide data.
   * Triggers the `prl` → `pre` waterfall for the active presentation.
   */
  requestCurrentPresentation(): void {
    this._send({ acn: "prl", ptl: PROTOCOL_VERSION })
  }

  // -- Internal --------------------------------------------------------------

  private _connect(): void {
    const url = `ws://${this.host}:${this.port}/remote`
    this.callbacks.onStatusChange("connecting")

    try {
      this.ws = new WebSocket(url)
    } catch (e) {
      this.callbacks.onStatusChange("error")
      this.callbacks.onError(String(e))
      this._scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this._send({
        acn: "ath",
        ptl: PROTOCOL_VERSION,
        pwd: this.password,
      })
    }

    this.ws.onmessage = (event: MessageEvent) => {
      this._handleMessage(event.data as string)
    }

    this.ws.onerror = () => {
      this.callbacks.onStatusChange("error")
      this.callbacks.onError(
        `Could not connect to ProPresenter at ${this.host}:${this.port}. ` +
        `Check that Remote Control is enabled in ProPresenter Preferences > Network.`
      )
    }

    this.ws.onclose = () => {
      this.authenticated = false
      this.indexQueue = []
      this.indexingActive = false
      if (!this.intentionalClose) {
        this.callbacks.onStatusChange("disconnected")
        this._scheduleReconnect()
      }
    }
  }

  private _handleMessage(raw: string): void {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    switch (data.acn as string) {
      case "ath": {
        if (data.ath === true) {
          this.authenticated = true
          this.callbacks.onStatusChange("connected")
          // Kick off full library fetch
          this.requestLibrary()
        } else {
          this.callbacks.onStatusChange("error")
          this.callbacks.onError(
            "ProPresenter authentication failed. Check your Remote Control password."
          )
          this.intentionalClose = true
          this.ws?.close()
        }
        break
      }

      // Presentation list response
      case "prl": {
        const list = (data.ary as Array<Record<string, unknown>>) ?? []

        const entries: PPLibraryEntry[] = list.map((item) => ({
          uid: String(item.uid ?? ""),
          name: String(item.name ?? item.title ?? ""),
        }))

        // Fire library list callback so store can register all UIDs
        this.callbacks.onLibraryList?.(entries)

        if (entries.length > 0) {
          // First entry is the active presentation — request its slides for the main panel
          this._send({ acn: "pre", uid: entries[0].uid })

          // Queue all remaining UIDs for background indexing
          const remainingUids = entries.slice(1).map((e) => e.uid)
          this.indexQueue = remainingUids
          // Start drip-feeding after a short delay so the active `pre` response lands first
          setTimeout(() => this._drainIndexQueue(), 800)
        }
        break
      }

      // Full presentation + slides response
      case "pre": {
        const uid = String(data.uid ?? "")
        const name = String(data.name ?? "")
        const rawSlides = (data.ary as Array<Record<string, unknown>>) ?? []

        const slides: PPSlideInfo[] = rawSlides.map((s, i) => ({
          uid: String(s.uid ?? i),
          index: i,
          text: this._extractSlideText(s),
          label: String(s.lbl ?? s.label ?? ""),
        }))

        // If we were drip-feeding index requests, this might be a library slide
        if (this.indexingActive) {
          // Fire the library-presentation callback for indexing
          this.callbacks.onLibraryPresentation?.(uid, slides)
          this.indexingActive = false
          // Drain next item
          setTimeout(() => this._drainIndexQueue(), 100)
        } else {
          // This is the active presentation — update main panel
          this.callbacks.onSlides(slides, {
            uid,
            name,
            slideCount: slides.length,
          })
          // Also index it
          this.callbacks.onLibraryPresentation?.(uid, slides)
        }
        break
      }

      // ProPresenter advanced to a new slide (user-driven)
      case "sli": {
        this.callbacks.onSlideIndexChange(Number(data.num ?? -1))
        break
      }

      default:
        break
    }
  }

  /** Send the next queued UID for background indexing, one at a time. */
  private _drainIndexQueue(): void {
    if (this.indexQueue.length === 0 || this.intentionalClose) return
    const uid = this.indexQueue.shift()!
    this.indexingActive = true
    this._send({ acn: "pre", uid })
  }

  /**
   * Walk the nested element/run structure PP uses and collect all text runs.
   */
  private _extractSlideText(slide: Record<string, unknown>): string {
    const parts: string[] = []
    const elements = (slide.ary as Array<Record<string, unknown>>) ?? []
    for (const el of elements) {
      if (el.acn === "txe" || el.type === "text") {
        const runs = (el.ary as Array<Record<string, unknown>>) ?? []
        for (const run of runs) {
          if (typeof run.txt === "string") parts.push(run.txt)
        }
      }
    }
    return parts.join(" ").trim()
  }

  private _send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  private _scheduleReconnect(): void {
    this._clearReconnect()
    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalClose) this._connect()
    }, 5000)
  }

  private _clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
