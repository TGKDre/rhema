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

export interface PPWSCallbacks {
  onStatusChange: (status: PPWSStatus) => void
  onSlides: (slides: PPSlideInfo[], presentation: PPPresentationInfo) => void
  onSlideIndexChange: (index: number) => void
  onError: (msg: string) => void
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
    this.ws?.close()
    this.ws = null
    this.authenticated = false
    this.callbacks.onStatusChange("disconnected")
  }

  /**
   * Trigger a specific slide by 0-based index in the current presentation.
   * ProPresenter Remote protocol uses the `sl` action.
   */
  triggerSlide(index: number): void {
    this._send({ acn: "sl", uid: "", num: index })
  }

  /**
   * Request the presentation list from ProPresenter.
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
          // Immediately fetch the active presentation's slides
          this.requestCurrentPresentation()
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
        if (list.length > 0) {
          // Request full slide data for the first (active) presentation
          this._send({ acn: "pre", uid: String(list[0].uid ?? "") })
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

        this.callbacks.onSlides(slides, {
          uid,
          name,
          slideCount: slides.length,
        })
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
