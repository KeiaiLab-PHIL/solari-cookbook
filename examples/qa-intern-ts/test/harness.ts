/** Shared plumbing for the offline tests: the demo app on a local port and a local headless Chromium. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "patchright-core"
import { VIEWPORT } from "../src/constants.js"
import { waitForHttp } from "../src/http.js"
import { Collector } from "../src/signals.js"

export const DEMO_PORT = 8765
export const DEMO_BASE = `http://127.0.0.1:${DEMO_PORT}`
const STARTUP_TIMEOUT_MS = 15_000
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export interface DemoApp {
  /** Everything the server wrote to stderr so far — what `server_logs` would return. */
  log(): string
  stop(): void
}

export async function startDemoApp(): Promise<DemoApp> {
  const server = spawn("python3", ["demo-app/server.py", "--port", String(DEMO_PORT)], { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] })
  let log = ""
  server.stderr.on("data", (chunk) => {
    log += String(chunk)
  })
  await waitForHttp(`${DEMO_BASE}/`, STARTUP_TIMEOUT_MS)
  return { log: () => log, stop: () => void server.kill() }
}

export interface LocalBrowser {
  page: Page
  collector: Collector
  close(): Promise<void>
}

/** `QA_INTERN_CHROME` pins a binary; otherwise Patchright's own Chromium is used. */
export async function openLocalBrowser(): Promise<LocalBrowser> {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_INTERN_CHROME })
  const page = await browser.newPage()
  await page.setViewportSize(VIEWPORT)
  const collector = new Collector()
  await collector.attach(page)
  return { page, collector, close: () => browser.close() }
}

/** Counting assertions with a printed line per check. */
export function checker() {
  let checks = 0
  return {
    ok(condition: boolean, what: string): void {
      assert.ok(condition, what)
      checks += 1
      console.log(`  ✓ ${what}`)
    },
    count: () => checks,
  }
}
