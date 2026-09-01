import type { Page } from "patchright-core"
import { HTTP_BAD_REQUEST } from "./constants.js"

/**
 * Machine-collected evidence. These fire without any model involvement and are
 * handed to the intern after every action as leads to reproduce.
 *
 * Console errors and uncaught exceptions are captured *inside the page* by an
 * init script, not by Playwright's `console`/`pageerror` events: stealth
 * browsers (Patchright, Solari with stealth on) leave CDP `Runtime.enable`
 * off, and without it those events never arrive. Network signals come from
 * the Network domain and are unaffected.
 */
export type SignalKind = "console.error" | "page.error" | "request.failed" | "http.error" | "dialog"

export interface Signal {
  kind: SignalKind
  detail: string
  /** Page the browser was on when the signal fired. */
  pageUrl: string
  at: string
}

interface PageSignal {
  kind: "console.error" | "page.error"
  detail: string
}

const IGNORED_PATHS = ["/favicon.ico"]
const ATTR = "data-qa-signals"

/**
 * Runs before every document's own scripts, in the page's main world. Signals
 * are parked on the <html> element: the DOM is shared between JS worlds while
 * `window` is not, and `page.evaluate` in stealth browsers runs in an isolated
 * world. Plain JS on purpose — it is shipped as source.
 */
const INIT_SCRIPT = `(() => {
  const push = (kind, detail) => {
    const root = document.documentElement
    if (!root) { return }
    let list = []
    try { list = JSON.parse(root.getAttribute("${ATTR}") || "[]") } catch {}
    list.push({ kind, detail })
    root.setAttribute("${ATTR}", JSON.stringify(list))
  }
  window.addEventListener("error", (e) => push("page.error", e.message + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : "")))
  window.addEventListener("unhandledrejection", (e) => push("page.error", "Unhandled rejection: " + ((e.reason && e.reason.message) || String(e.reason))))
  const original = console.error.bind(console)
  console.error = (...args) => { push("console.error", args.map(String).join(" ")); original(...args) }
})()`

export class Collector {
  private readonly all: Signal[] = []
  private cursor = 0
  private page?: Page

  async attach(page: Page): Promise<void> {
    this.page = page
    await page.addInitScript(INIT_SCRIPT)

    // Playwright DISMISSES dialogs when nothing handles them, which makes every
    // `onclick="return confirm(...)"` button look broken: the handler returns
    // false and the form never submits. An intern that clicked Delete meant to
    // delete, so accept - and record it, because "a confirm appeared" is itself
    // something the report should say.
    page.on("dialog", (dialog) => {
      this.push("dialog", `${dialog.type()}: ${dialog.message()} - accepted`, page.url())
      void dialog.accept().catch(() => undefined)
    })

    page.on("requestfailed", (req) => {
      this.push("request.failed", `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "failed"}`, page.url())
    })
    page.on("response", (res) => {
      if (res.status() < HTTP_BAD_REQUEST || IGNORED_PATHS.some((p) => res.url().endsWith(p))) {
        return
      }
      this.push("http.error", `${res.status()} ${res.request().method()} ${res.url()}`, page.url())
    })
  }

  /**
   * Move the page's in-memory store into ours. The store dies with the
   * document, so call this before an action (to keep the old document's
   * signals) and after it (to read the new one's).
   */
  async pull(): Promise<void> {
    if (!this.page) {
      return
    }
    const fresh = await this.page
      .evaluate((attr) => {
        const root = document.documentElement
        const raw = root?.getAttribute(attr)
        if (!raw) {
          return [] as PageSignal[]
        }
        root.removeAttribute(attr)
        try {
          return JSON.parse(raw) as PageSignal[]
        } catch {
          return [] as PageSignal[]
        }
      }, ATTR)
      .catch(() => [] as PageSignal[])
    for (const s of fresh) {
      this.push(s.kind, s.detail, this.page.url())
    }
  }

  /** Signals since the previous drain — what the intern sees after one action. */
  async drain(): Promise<Signal[]> {
    await this.pull()
    const fresh = this.all.slice(this.cursor)
    this.cursor = this.all.length
    return fresh
  }

  recent(count: number): Signal[] {
    return this.all.slice(-count)
  }

  history(): readonly Signal[] {
    return this.all
  }

  private push(kind: SignalKind, detail: string, pageUrl: string): void {
    this.all.push({ kind, detail, pageUrl, at: new Date().toISOString() })
  }
}

export function renderSignals(signals: Signal[]): string {
  if (signals.length === 0) {
    return "(none)"
  }
  return signals.map((s) => `- ${s.kind} @ ${s.pageUrl}: ${s.detail}`).join("\n")
}
