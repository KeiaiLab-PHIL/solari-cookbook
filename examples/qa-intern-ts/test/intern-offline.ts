/**
 * Intern wiring, scripted — no Solari, no Claude.
 *
 * Drives the intern's tools directly in the order a model would (open,
 * check_links, type, click, server_logs, screenshot, report_issue, finish)
 * against the demo app in a local Chromium, then renders the report. What it
 * proves: tool dispatch, the budget guard, evidence capture and the report
 * format. What it does not prove: the model's judgment — that needs
 * `npm run demo`.
 *
 * Output: runs/sample/report.md (+ screenshots), a scripted sample of the
 * report format.
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { OUTPUT_ROOT, SCREENSHOT_DIR } from "../src/constants.js"
import { InternSession, type InternDeps } from "../src/intern.js"
import { renderReport } from "../src/report.js"
import { checker, DEMO_BASE, openLocalBrowser, startDemoApp } from "./harness.js"

type ToolOutput = string | Array<{ type: string; text?: string }>
/** The runnable tools share a `run`, but their input types intersect into `never` — widen for scripting. */
type AnyTool = { name: string; run: (input: unknown) => Promise<ToolOutput> | ToolOutput }

const outDir = path.join(OUTPUT_ROOT, "sample")
const { ok, count } = checker()
const startedAt = new Date()

await fs.rm(outDir, { recursive: true, force: true })
await fs.mkdir(path.join(outDir, SCREENSHOT_DIR), { recursive: true })

const app = await startDemoApp()
try {
  const local = await openLocalBrowser()
  try {
    const deps: InternDeps = {
      page: local.page,
      collector: local.collector,
      targetUrl: DEMO_BASE,
      serverLogs: async () => app.log(),
      outDir,
      model: "scripted",
      effort: "high",
      maxSteps: 12,
    }
    const session = new InternSession(deps)
    const tools = new Map(session.tools().map((tool) => [tool.name, tool as unknown as AnyTool]))
    const call = async (name: string, input: Record<string, unknown> = {}): Promise<ToolOutput> => {
      const tool = tools.get(name)
      assert.ok(tool, `tool ${name} exists`)
      return tool.run(input)
    }
    const text = (out: ToolOutput): string => (typeof out === "string" ? out : out.map((b) => b.text ?? "[image]").join("\n"))

    const home = text(await call("open", { url: DEMO_BASE }))
    ok(home.includes("[e") && home.includes('"Add note"'), "open returns a page state with refs")

    const links = text(await call("check_links"))
    ok(links.includes("404") && links.includes("/changelog"), "check_links lists the broken Changelog link")

    const titleRef = refOf(home, /\[(e\d+)\] input\[text\][^\n]*placeholder="Title"/)
    const addRef = refOf(home, /\[(e\d+)\] button "Add note"/)
    await call("type", { ref: titleRef, text: "héllo 🚀" })
    const afterClick = text(await call("click", { ref: addRef }))
    ok(afterClick.includes("http.error") && afterClick.includes("500"), "the click result carries the http.error 500 signal")

    ok(text(await call("server_logs")).includes("UnicodeEncodeError"), "server_logs returns the traceback")

    const shot = await call("screenshot")
    ok(Array.isArray(shot) && shot.some((b) => b.type === "image"), "screenshot returns an image block")

    const first = text(
      await call("report_issue", {
        title: "Non-ASCII note title fails with HTTP 500 and no feedback",
        severity: "critical",
        confidence: "high",
        kind: "error",
        steps: ['Type "héllo 🚀" in Title', "Click Add note"],
        expected: "The note is saved, or a validation message explains what is wrong",
        actual: "POST /api/notes returns 500 (UnicodeEncodeError in the server log); the form stays as it was",
      }),
    )
    ok(first.startsWith("Recorded issue #1"), "report_issue records issue #1")

    const settings = text(await call("open", { url: "/settings" }))
    ok(settings.includes("page.error"), "opening /settings carries the page.error signal")
    await call("report_issue", {
      title: "Settings page throws on load; Save does nothing",
      severity: "major",
      confidence: "high",
      kind: "error",
      steps: ["Open /settings", "Pick a theme", "Click Save"],
      expected: "The theme is saved and a confirmation appears",
      actual: "TypeError on load (element #theme-select missing); Save has no effect",
    })

    ok(text(await call("finish", { summary: "Scripted sample: two defects reproduced.", verdict: "fail" })).startsWith("Session closed"), "finish closes the session")
    ok(text(await call("look")).startsWith("The session is finished"), "actions are refused after finish")

    const outcome = session.outcome()
    ok(outcome.issues.length === 2 && outcome.issues.every((issue) => issue.evidence), "two issues, each with an evidence screenshot")
    ok(outcome.actions === 7, `seven actions counted (got ${outcome.actions})`)

    const report = renderReport(
      { target: DEMO_BASE, targetKind: "url", sessionId: "scripted-local", startedAt, finishedAt: new Date(), model: "scripted (no model)", effort: "n/a" },
      outcome,
      local.collector.history(),
    )
    await fs.writeFile(path.join(outDir, "report.md"), report)
    ok(report.includes("### 1. [critical]") && report.includes("### 2. [major]"), "the report renders both issues")

    console.log(`intern offline: ok (${count()} checks) — ${path.join(outDir, "report.md")}`)
  } finally {
    await local.close()
  }
} finally {
  app.stop()
}

function refOf(state: string, pattern: RegExp): string {
  const match = state.match(pattern)
  assert.ok(match, `state contains ${pattern}`)
  return match[1]
}
