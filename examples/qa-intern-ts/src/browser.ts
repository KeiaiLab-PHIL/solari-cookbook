import { Solari, SolariError, type ReplayUrl } from "@solarisdk/browser"
import type { Page } from "patchright-core"
import { HTTP_NOT_FOUND, REPLAY_POLL_ATTEMPTS, REPLAY_POLL_MS, VIEWPORT } from "./constants.js"
import { sleep } from "./http.js"
import { log } from "./log.js"
import { Collector } from "./signals.js"

/** A recorded Solari browser session with signal collection attached. */
export interface OpenedBrowser {
  page: Page
  collector: Collector
  sessionId: string
  /** Releases the session and returns the replay link once the upload lands. */
  close(): Promise<ReplayUrl | undefined>
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
async function fetchReplay(solari: Solari, sessionId: string): Promise<ReplayUrl | undefined> {
  await solari.sessions.releaseAndWait(sessionId).catch(() => undefined)

  for (let attempt = 1; attempt <= REPLAY_POLL_ATTEMPTS; attempt++) {
    await sleep(REPLAY_POLL_MS)
    try {
      return await solari.sessions.getReplayUrl(sessionId)
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
