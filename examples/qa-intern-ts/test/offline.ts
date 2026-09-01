/**
 * Offline smoke — no Solari, no Claude.
 *
 * Runs the demo app locally, drives it with a local headless Chromium through
 * the same page driver and signal collector the intern uses, and asserts that
 * the machine-detectable planted bugs (B1, B4, B5, B6) leave the evidence the
 * intern relies on.
 *
 *   npm run test:offline
 *   QA_INTERN_CHROME=/path/to/chrome npm run test:offline   # pin a browser binary
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "patchright-core"
import { HTTP_NOT_FOUND, HTTP_SERVER_ERROR, VIEWPORT } from "../src/constants.js"
import { waitForHttp } from "../src/http.js"
import { checkLinks, click, navigate, snapshot, Submit, typeText } from "../src/page.js"
import { Collector } from "../src/signals.js"

const PORT = 8765
const BASE = `http://127.0.0.1:${PORT}`
const STARTUP_TIMEOUT_MS = 15_000
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

let checks = 0
function ok(condition: boolean, what: string): void {
  assert.ok(condition, what)
  checks += 1
  console.log(`  ✓ ${what}`)
}

const server = spawn("python3", ["demo-app/server.py", "--port", String(PORT)], { cwd: root, stdio: ["ignore", "ignore", "pipe"] })
let serverLog = ""
server.stderr.on("data", (chunk) => {
  serverLog += String(chunk)
})

try {
  await waitForHttp(`${BASE}/`, STARTUP_TIMEOUT_MS)
  const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_INTERN_CHROME })
  try {
    const page = await browser.newPage()
    await page.setViewportSize(VIEWPORT)
    const collector = new Collector()
    await collector.attach(page)

    await navigate(page, `${BASE}/`)
    const home = await snapshot(page)
    ok(home.elements.some((e) => e.tag === "button" && e.label === "Add note"), "snapshot lists the Add note button with a ref")
    ok(home.text.includes("3 notes"), "B5: the off-by-one count is in the visible text")

    const links = await checkLinks(page)
    ok(links.some((l) => l.url.endsWith("/changelog") && l.status === HTTP_NOT_FOUND), "B1: check_links flags /changelog as 404")
    await collector.drain()

    const title = home.elements.find((e) => e.placeholder === "Title")
    const add = home.elements.find((e) => e.label === "Add note")
    assert.ok(title && add, "title field and add button present")
    await typeText(page, title.ref, "héllo 🚀", Submit.None)
    await click(page, add.ref)
    const afterAdd = await collector.drain()
    ok(afterAdd.some((s) => s.kind === "http.error" && s.detail.startsWith(String(HTTP_SERVER_ERROR))), "B4: a non-ASCII title yields an http.error 500 signal")
    ok(serverLog.includes("UnicodeEncodeError"), "B4: the server log carries the traceback")

    await navigate(page, `${BASE}/settings`)
    ok((await collector.drain()).some((s) => s.kind === "page.error"), "B6: the settings page raises a page.error signal")

    console.log(`offline smoke: ok (${checks} checks)`)
  } finally {
    await browser.close()
  }
} finally {
  server.kill()
}
