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
import { HTTP_NOT_FOUND, HTTP_SERVER_ERROR } from "../src/constants.js"
import { checkLinks, click, navigate, snapshot, Submit, typeText } from "../src/page.js"
import { checker, DEMO_BASE, openLocalBrowser, startDemoApp } from "./harness.js"

const { ok, count } = checker()
const app = await startDemoApp()
try {
  const local = await openLocalBrowser()
  try {
    const { page, collector } = local

    await navigate(page, `${DEMO_BASE}/`)
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
    ok(app.log().includes("UnicodeEncodeError"), "B4: the server log carries the traceback")

    await navigate(page, `${DEMO_BASE}/settings`)
    ok((await collector.drain()).some((s) => s.kind === "page.error"), "B6: the settings page raises a page.error signal")

    console.log(`offline smoke: ok (${count()} checks)`)
  } finally {
    await local.close()
  }
} finally {
  app.stop()
}
