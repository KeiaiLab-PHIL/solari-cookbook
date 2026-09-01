import { gunzipSync } from "node:zlib"
import { Solari, SolariError } from "@solarisdk/browser"
import type { Page } from "patchright-core"
import { HTTP_FORBIDDEN, HTTP_NOT_FOUND, NAV_TIMEOUT_MS, REPLAY_POLL_ATTEMPTS, REPLAY_POLL_MS, HTTP_UNAUTHORIZED, VIEWPORT } from "./constants.js"
import { sleep, withoutPreviewToken } from "./http.js"
import { log } from "./log.js"
import { Collector } from "./signals.js"

const GZIP_MAGIC = [0x1f, 0x8b]

/** The session recording: a short-lived download link plus the rrweb events themselves. */
export interface Replay {
  url: string
  expiresInSeconds: number
  /** rrweb events, one JSON object per line. Undefined when the download failed. */
  ndjson?: Uint8Array
}

/** A recorded Solari browser session with signal collection attached. */
export interface OpenedBrowser {
  page: Page
  collector: Collector
  sessionId: string
  /** Open the target once so its cookie is set, before the intern gets a turn. */
  prime(url: string): Promise<void>
  /** Releases the session and returns the replay once the upload lands. */
  close(): Promise<Replay | undefined>
}

export async function openBrowser(apiKey: string): Promise<OpenedBrowser> {
  const solari = new Solari({ apiKey })
  const browser = await solari.launch({ recording: true })
  log.step(`browser session ${browser.id} (${browser.version()}), recording on`)

  const page = await browser.newPage()
  await page.setViewportSize(VIEWPORT)
  const collector = new Collector()
  await collector.attach(page)

  return {
    page,
    collector,
    sessionId: browser.id,
    prime: async (url: string) => {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
      const status = response?.status() ?? 0
      if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
        throw new Error(`the preview gateway answered ${status} for ${withoutPreviewToken(url)} — the sandbox is serving, but the browser was not let in`)
      }
      await collector.drain()
    },
    close: async () => {
      await browser.close()
      const replay = await fetchReplay(solari, browser.id)
      // The client keeps a loopback proxy open; without this the process never exits.
      await solari.close()
      return replay
    },
  }
}

/** The replay uploads asynchronously after release, so the first polls usually 404. */
async function fetchReplay(solari: Solari, sessionId: string): Promise<Replay | undefined> {
  await solari.sessions.releaseAndWait(sessionId).catch(() => undefined)

  for (let attempt = 1; attempt <= REPLAY_POLL_ATTEMPTS; attempt++) {
    await sleep(REPLAY_POLL_MS)
    try {
      const link = await solari.sessions.getReplayUrl(sessionId)
      const ndjson = await downloadEvents(solari, sessionId)
      return { url: link.url, expiresInSeconds: link.expiresInSeconds, ndjson }
    } catch (err) {
      if (err instanceof SolariError && err.status === HTTP_NOT_FOUND) {
        continue
      }
      log.warn(`replay lookup failed: ${(err as Error).message}`)
      return undefined
    }
  }

  log.warn(`replay not available after ${(REPLAY_POLL_ATTEMPTS * REPLAY_POLL_MS) / 1000}s`)
  return undefined
}

/** The object is stored gzipped; the HTTP client usually inflates it, but not always. */
async function downloadEvents(solari: Solari, sessionId: string): Promise<Uint8Array | undefined> {
  try {
    const bytes = await solari.sessions.downloadReplay(sessionId)
    const isGzip = bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]
    return isGzip ? new Uint8Array(gunzipSync(bytes)) : bytes
  } catch (err) {
    log.warn(`replay download failed: ${(err as Error).message}`)
    return undefined
  }
}
