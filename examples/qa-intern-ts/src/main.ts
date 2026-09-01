import fs from "node:fs/promises"
import path from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { openBrowser, type OpenedBrowser, type Replay } from "./browser.js"
import { parseCli, type RunOptions } from "./cli.js"
import { loadDotEnv } from "./env.js"
import { runIntern, type InternOutcome } from "./intern.js"
import { log } from "./log.js"
import { REPLAY_NDJSON, REPLAY_PAGE } from "./constants.js"
import { parseEvents, renderReplayPage, renderReport, type RunMeta } from "./report.js"
import { buildApp, type BuiltApp } from "./sandbox.js"

/**
 * Orchestration only — every layer below owns its own mechanics:
 *
 *   main ─▶ sandbox.ts   (git URL → public preview URL)
 *        ─▶ browser.ts   (recorded Solari session + signal collector)
 *        ─▶ intern.ts    (Claude tool loop over page.ts)
 *        ─▶ report.ts    (markdown)
 */
const EXIT_USAGE = 2
const EXIT_FAILURE = 1
const EXIT_INTERRUPTED = 130

loadDotEnv()
const options = parseCli(process.argv.slice(2))

const solariKey = process.env.SOLARI_API_KEY
if (!solariKey) {
  console.error("SOLARI_API_KEY is not set — grab one at https://console.getsolari.com")
  process.exit(EXIT_USAGE)
}

const startedAt = new Date()
const outDir = path.join(options.outRoot, runId(startedAt))
await fs.mkdir(outDir, { recursive: true })

let app: BuiltApp | undefined
let browser: OpenedBrowser | undefined
process.once("SIGINT", async () => {
  log.warn("interrupted — releasing the browser and the sandbox")
  await Promise.allSettled([browser?.close(), app?.close()])
  process.exit(EXIT_INTERRUPTED)
})

try {
  if (options.target.kind === "repo") {
    app = await buildApp(solariKey, options.target)
  }
  const targetUrl = options.target.kind === "repo" ? app!.url : options.target.url

  browser = await openBrowser(solariKey)
  const { outcome, replay } = await explore(browser, app, targetUrl, options, outDir)

  const target = options.target.kind === "repo" ? `${options.target.repo}${options.target.path ? ` (${options.target.path})` : ""}` : targetUrl
  const meta: RunMeta = {
    target,
    targetKind: options.target.kind,
    sessionId: browser.sessionId,
    sandboxId: app?.sandboxId,
    replay,
    replayPage: await saveReplay(outDir, target, replay),
    startedAt,
    finishedAt: new Date(),
    provider: options.provider,
    model: options.model,
    effort: options.provider === "claude" ? options.effort : "",
  }
  const reportPath = path.join(outDir, "report.md")
  await fs.writeFile(reportPath, renderReport(meta, outcome, browser.collector.history()))
  // The replay bytes live in replay.ndjson; a Uint8Array in JSON is 20x its own size.
  const { replay: _replay, ...leanMeta } = meta
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ meta: leanMeta, outcome, signals: browser.collector.history() }, null, 2))

  printOutcome(outcome, reportPath, replay)
} catch (err) {
  explain(err)
  process.exit(EXIT_FAILURE)
}

/** Run the intern and always release both Solari resources, whatever happens. */
async function explore(
  session: OpenedBrowser,
  built: BuiltApp | undefined,
  targetUrl: string,
  opts: RunOptions,
  dir: string,
): Promise<{ outcome: InternOutcome; replay: Replay | undefined }> {
  try {
    const outcome = await runIntern({
      page: session.page,
      collector: session.collector,
      targetUrl,
      serverLogs: built?.logs,
      outDir: dir,
      provider: opts.provider,
      model: opts.model,
      effort: opts.effort,
      maxSteps: opts.maxSteps,
      focus: opts.focus,
    })
    const replay = await session.close()
    return { outcome, replay }
  } catch (err) {
    await session.close().catch(() => undefined)
    throw err
  } finally {
    await built?.close().catch((e: Error) => log.warn(`sandbox kill failed: ${e.message}`))
  }
}

function printOutcome(outcome: InternOutcome, reportPath: string, replay: Replay | undefined): void {
  console.log("")
  console.log(`Verdict: ${outcome.verdict.toUpperCase()} — ${outcome.issues.length} issue(s), ${outcome.actions}/${outcome.maxSteps} actions`)
  for (const issue of outcome.issues) {
    console.log(`  #${issue.id} [${issue.severity}] ${issue.title}`)
  }
  console.log(`Report:  ${reportPath}`)
  console.log(`Replay:  ${replay?.ndjson ? path.join(path.dirname(reportPath), REPLAY_PAGE) : replay?.url ?? "not available"}`)
}

/** Write the events and a player page next to the report; returns the page's file name. */
async function saveReplay(dir: string, title: string, replay: Replay | undefined): Promise<string | undefined> {
  if (!replay?.ndjson) {
    return undefined
  }
  await fs.writeFile(path.join(dir, REPLAY_NDJSON), replay.ndjson)
  await fs.writeFile(path.join(dir, REPLAY_PAGE), renderReplayPage(title, parseEvents(replay.ndjson)))
  return REPLAY_PAGE
}

function explain(err: unknown): void {
  if (err instanceof Anthropic.AuthenticationError) {
    console.error("Claude authentication failed — set ANTHROPIC_API_KEY, run `ant auth login`, or use --provider nvidia.")
    return
  }
  if (err instanceof OpenAI.APIError) {
    console.error(`NVIDIA NIM error ${err.status}: ${err.message}`)
    return
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`Claude API error ${err.status}: ${err.message}`)
    return
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
}

function runId(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, "YYYY-MM-DDTHH-MM-SS".length)
}
