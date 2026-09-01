/**
 * Live smoke — Solari only, no Claude.
 *
 * Builds the demo app in a sandbox, opens a recorded browser, runs the same
 * checks as the offline smoke through the real products, reads the server log
 * from inside the sandbox, releases everything and prints the replay link.
 *
 *   npm run test:live
 */
import assert from "node:assert/strict"
import { openBrowser } from "../src/browser.js"
import { DEMO_TARGET, HTTP_NOT_FOUND, HTTP_SERVER_ERROR } from "../src/constants.js"
import { loadDotEnv } from "../src/env.js"
import { log } from "../src/log.js"
import { checkLinks, click, navigate, snapshot, Submit, typeText } from "../src/page.js"
import { buildApp } from "../src/sandbox.js"

loadDotEnv()
const apiKey = process.env.SOLARI_API_KEY
assert.ok(apiKey, "SOLARI_API_KEY is required")

let checks = 0
function ok(condition: boolean, what: string): void {
  assert.ok(condition, what)
  checks += 1
  console.log(`  ✓ ${what}`)
}

const app = await buildApp(apiKey, { kind: "repo", ...DEMO_TARGET })
try {
  const browser = await openBrowser(apiKey)
  let replayUrl: string | undefined
  try {
    const { page, collector } = browser
    await navigate(page, app.url)
    const home = await snapshot(page)
    ok(home.elements.some((e) => e.tag === "button" && e.label === "Add note"), "snapshot lists the Add note button through the preview URL")
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
    ok((await app.logs()).includes("UnicodeEncodeError"), "B4: server_logs reads the traceback from inside the sandbox")

    await navigate(page, new URL("/settings", app.url).toString())
    ok((await collector.drain()).some((s) => s.kind === "page.error"), "B6: the settings page raises a page.error signal")
  } finally {
    replayUrl = (await browser.close())?.url
  }
  ok(Boolean(replayUrl), "a replay link is available after release")
  log.step(`replay: ${replayUrl}`)
} finally {
  await app.close()
  log.step("sandbox killed")
}

console.log(`live smoke: ok (${checks} checks)`)
