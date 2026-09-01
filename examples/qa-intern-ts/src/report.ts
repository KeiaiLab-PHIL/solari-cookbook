import type { Replay } from "./browser.js"
import { PRICES_PER_MTOK, RRWEB_PLAYER_CDN, VIEWPORT } from "./constants.js"
import type { InternOutcome, Issue, Usage } from "./intern.js"
import type { Signal } from "./signals.js"

export interface RunMeta {
  target: string
  targetKind: "url" | "repo"
  sessionId: string
  sandboxId?: string
  replay?: Replay
  /** Present when the events were saved next to the report. */
  replayPage?: string
  startedAt: Date
  finishedAt: Date
  provider: string
  model: string
  /** Empty when the provider has no effort control. */
  effort: string
}

const MTOK = 1_000_000
const SECONDS_PER_MINUTE = 60

export function renderReport(meta: RunMeta, outcome: InternOutcome, signals: readonly Signal[]): string {
  const cost = estimateCost(meta.model, outcome.usage)
  const u = outcome.usage
  const tokens = `in ${fmt(u.input)} · cache read ${fmt(u.cacheRead)} · cache write ${fmt(u.cacheWrite)} · out ${fmt(u.output)}`
  const costNote = cost === undefined ? "" : ` (≈ $${cost.toFixed(2)})`
  const replayRow = meta.replay ? `| Replay | ${replayLinks(meta)} |` : "| Replay | not available |"

  const lines = [
    `# QA intern report — ${meta.target}`,
    "",
    `**Verdict: ${outcome.verdict.toUpperCase()}** — ${outcome.issues.length} issue(s)${countBySeverity(outcome.issues)}`,
    "",
    "| | |",
    "|---|---|",
    `| Target | ${meta.target} (${meta.targetKind === "repo" ? "built and served in a Solari sandbox" : "live URL"}) |`,
    `| Browser session | \`${meta.sessionId}\` |`,
    replayRow,
    ...(meta.sandboxId ? [`| Sandbox | \`${meta.sandboxId}\` |`] : []),
    `| Duration | ${formatDuration(meta.finishedAt.getTime() - meta.startedAt.getTime())} |`,
    `| Actions | ${outcome.actions}/${outcome.maxSteps} across ${u.turns} model turns |`,
    `| Model | ${meta.provider} · ${meta.model}${meta.effort ? `, effort ${meta.effort}` : ""} |`,
    `| Tokens | ${tokens}${costNote} |`,
    "",
    "## Summary",
    "",
    outcome.summary || "(the intern did not leave a summary)",
    "",
    "## Issues",
    "",
    ...(outcome.issues.length ? outcome.issues.flatMap(renderIssue) : ["No issues reported.", ""]),
    "## Machine-collected signals",
    "",
    ...(signals.length
      ? ["| # | Kind | Page | Detail |", "|---|---|---|---|", ...signals.map((s, i) => `| ${i + 1} | ${s.kind} | ${s.pageUrl} | ${cell(s.detail)} |`)]
      : ["None."]),
    "",
    "## Pages visited",
    "",
    ...(outcome.visited.length ? outcome.visited.map((url) => `- ${url}`) : ["(none)"]),
    "",
  ]
  return lines.join("\n")
}

function replayLinks(meta: RunMeta): string {
  if (meta.replayPage) {
    return `[${meta.replayPage}](${meta.replayPage}) — the events are saved next to this report`
  }
  // Only when the download failed: a presigned URL, so it dies quickly and should not be shared.
  return `[raw rrweb NDJSON](${meta.replay!.url}) — presigned, expires in ${Math.round(meta.replay!.expiresInSeconds / SECONDS_PER_MINUTE)} min`
}

/** rrweb events as one line each; anything that is not JSON is skipped. */
export function parseEvents(ndjson: Uint8Array): unknown[] {
  const events: unknown[] = []
  for (const line of new TextDecoder().decode(ndjson).split("\n")) {
    if (!line.trim()) {
      continue
    }
    try {
      events.push(JSON.parse(line))
    } catch {
      // partial line at the end of the upload
    }
  }
  return events
}

/** A self-contained page that plays the recording with rrweb-player from a CDN. */
export function renderReplayPage(title: string, events: unknown[]): string {
  const json = JSON.stringify(events).replace(/<\/script/gi, "<\\/script")
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Replay — ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${RRWEB_PLAYER_CDN}/dist/style.css">
  <script src="${RRWEB_PLAYER_CDN}/dist/index.js"></script>
  <style>body { margin: 0; background: #111; display: grid; place-items: center; min-height: 100vh; }</style>
</head>
<body>
  <div id="player"></div>
  <script>
    const events = ${json}
    new rrwebPlayer({ target: document.getElementById("player"), props: { events, autoPlay: false, width: ${VIEWPORT.width}, height: ${VIEWPORT.height} } })
  </script>
</body>
</html>
`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function renderIssue(issue: Issue): string[] {
  return [
    `### ${issue.id}. [${issue.severity}] ${issue.title}`,
    "",
    `*${issue.kind} · confidence ${issue.confidence} · at ${issue.where}*`,
    "",
    "Steps to reproduce:",
    "",
    ...issue.steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    `**Expected:** ${issue.expected}`,
    "",
    `**Actual:** ${issue.actual}`,
    "",
    ...(issue.evidence ? [`![evidence](${issue.evidence})`, ""] : []),
    ...(issue.signals.length ? ["Signals around this issue:", "", ...issue.signals.map((s) => `- ${s.kind}: ${s.detail}`), ""] : []),
  ]
}

/** USD for the run, or undefined when the model has no price on file. */
export function estimateCost(model: string, usage: Usage): number | undefined {
  const priced = Object.keys(PRICES_PER_MTOK).find((id) => model.startsWith(id))
  if (!priced) {
    return undefined
  }
  const p = PRICES_PER_MTOK[priced]
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / MTOK
}

function countBySeverity(issues: Issue[]): string {
  if (issues.length === 0) {
    return ""
  }
  const counts = new Map<string, number>()
  for (const issue of issues) {
    counts.set(issue.severity, (counts.get(issue.severity) ?? 0) + 1)
  }
  return ` (${[...counts].map(([severity, n]) => `${n} ${severity}`).join(", ")})`
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}
