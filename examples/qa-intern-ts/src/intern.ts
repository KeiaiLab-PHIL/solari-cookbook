import fs from "node:fs/promises"
import path from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import type { Page } from "patchright-core"
import { z } from "zod"
import type { Effort } from "./cli.js"
import { EXTRA_ITERATIONS, FALLBACK_BETA, MAX_TOKENS_PER_TURN, RECENT_SIGNALS, SCREENSHOT_DIR, VIEWPORT } from "./constants.js"
import { log } from "./log.js"
import * as ui from "./page.js"
import { Direction, Submit } from "./page.js"
import { Collector, renderSignals, type Signal } from "./signals.js"

/**
 * The intern: a Claude tool-runner loop whose tools are the page driver.
 *
 *   ┌────────── Claude ──────────┐        ┌──── page driver ────┐
 *   │ look / click / type / …    │──────▶ │ Playwright on Solari │
 *   │ ◀── page state + signals   │        └─────────────────────┘
 *   │ report_issue → Issue[]     │
 *   │ finish → summary, verdict  │
 *   └────────────────────────────┘
 *
 * Every action tool returns the same shape (state + signals), so the model
 * always knows where it is, and the budget guard lives in one place.
 */
export type Severity = "critical" | "major" | "minor" | "cosmetic"
export type Confidence = "high" | "medium" | "low"
export type IssueKind = "functional" | "error" | "data" | "visual" | "usability" | "content" | "performance" | "accessibility"
export type Verdict = "pass" | "fail" | "inconclusive"

export interface Issue {
  id: number
  title: string
  severity: Severity
  confidence: Confidence
  kind: IssueKind
  where: string
  steps: string[]
  expected: string
  actual: string
  /** Path of the evidence screenshot, relative to the run directory. */
  evidence?: string
  signals: Signal[]
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
}

export interface InternOutcome {
  issues: Issue[]
  summary: string
  verdict: Verdict
  actions: number
  maxSteps: number
  visited: string[]
  usage: Usage
  narration: string[]
  stopReason?: string
}

export interface InternDeps {
  page: Page
  collector: Collector
  targetUrl: string
  /** Present in repo mode: the app's log inside the sandbox. */
  serverLogs?: () => Promise<string>
  outDir: string
  model: string
  effort: Effort
  maxSteps: number
  focus?: string
}

type ToolResult = string | Extract<Anthropic.Beta.BetaToolResultBlockParam["content"], unknown[]>

const SEVERITIES = ["critical", "major", "minor", "cosmetic"] as const
const CONFIDENCES = ["high", "medium", "low"] as const
const KINDS = ["functional", "error", "data", "visual", "usability", "content", "performance", "accessibility"] as const
const VERDICTS = ["pass", "fail", "inconclusive"] as const
const INPUT_LOG_CAP = 100

export async function runIntern(deps: InternDeps): Promise<InternOutcome> {
  await fs.mkdir(path.join(deps.outDir, SCREENSHOT_DIR), { recursive: true })
  const session = new InternSession(deps)
  const client = new Anthropic()

  const runner = client.beta.messages.toolRunner({
    model: deps.model,
    max_tokens: MAX_TOKENS_PER_TURN,
    output_config: { effort: deps.effort },
    // The system prompt and tool list never change, so they cache across every turn.
    system: [{ type: "text", text: session.systemPrompt(), cache_control: { type: "ephemeral" } }],
    cache_control: { type: "ephemeral" },
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    tools: session.tools(),
    messages: [{ role: "user", content: `Target: ${deps.targetUrl}\n\nStart the session.` }],
    max_iterations: deps.maxSteps + EXTRA_ITERATIONS,
  })

  for await (const message of runner) {
    session.track(message)
    if (message.stop_reason === "refusal") {
      log.warn("the model declined to continue")
      break
    }
  }
  return session.outcome()
}

class InternSession {
  private actions = 0
  private finished = false
  private summary = ""
  private verdict: Verdict = "inconclusive"
  private stopReason?: string
  private readonly issues: Issue[] = []
  private readonly visited = new Set<string>()
  private readonly narration: string[] = []
  private readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }

  constructor(private readonly deps: InternDeps) {}

  systemPrompt(): string {
    const { maxSteps, focus, serverLogs } = this.deps
    const logsHint = serverLogs ? " When a request fails, server_logs shows the application's own log." : ""
    const lines = [
      "You are a QA engineer running an exploratory test session on a web app you have never seen before.",
      "",
      "Your hands are tools that drive a real Chrome browser. Every action returns the new page state — URL, visible text and the interactive elements with refs like [e12] — plus signals: console errors, uncaught exceptions and failed HTTP requests collected automatically since your previous action. Refs are reassigned on every state; only use refs from the latest state.",
      "",
      "A defect is anything a real user would experience as broken or wrong: actions that do nothing or fail silently, errors, wrong or inconsistent data (counts, lists, labels), broken links, layout problems visible in a screenshot, missing or misleading feedback. Report each defect with report_issue as soon as you have reproduced it — one call per distinct defect. Report everything you are confident about and let severity and confidence carry the nuance; do not hold back findings because they seem small. Do not report anything you could not reproduce.",
      "",
      `Method: start with look and check_links to map the app. Exercise each main flow end to end with realistic input, then with edge cases (empty, very long, non-ASCII, special characters). After every action, compare what the UI shows with what should have happened. Signals are leads, not conclusions: reproduce them and turn them into reports.${logsHint} Use screenshot when something looks visually wrong or when text alone cannot settle it.`,
      "",
      `Budget: ${maxSteps} actions (report_issue and finish are free). When the budget is spent or the app is covered, call finish with an honest summary and a verdict: fail if any major or critical defect was found, pass if none, inconclusive if you could not test meaningfully.`,
      "",
      "Narrate briefly: one short sentence between tool calls, no more.",
    ]
    if (focus) {
      lines.push("", `Focus from the requester: ${focus}`)
    }
    return lines.join("\n")
  }

  tools() {
    const { page, collector, serverLogs } = this.deps

    const open = betaZodTool({
      name: "open",
      description: "Navigate to a URL — absolute, or a path relative to the current page. Returns the new page state.",
      inputSchema: z.object({ url: z.string().describe("e.g. https://example.com/pricing or /pricing") }),
      run: (input) =>
        this.act(async () => {
          await ui.navigate(page, input.url)
          return this.observe(`Opened ${input.url}.`)
        }),
    })

    const look = betaZodTool({
      name: "look",
      description: "Re-read the current page state without acting. Use it for fresh refs or to check the result of a previous action.",
      inputSchema: z.object({}),
      run: () => this.act(() => this.observe("Current page state.")),
    })

    const click = betaZodTool({
      name: "click",
      description: "Click an element by its ref from the latest page state, e.g. e7.",
      inputSchema: z.object({ ref: z.string().describe("Element ref such as e7") }),
      run: (input) =>
        this.act(async () => {
          await ui.click(page, input.ref)
          return this.observe(`Clicked ${input.ref}.`)
        }),
    })

    const type = betaZodTool({
      name: "type",
      description: "Clear a field and type text into it. Set submit to true to press Enter afterwards.",
      inputSchema: z.object({
        ref: z.string().describe("Ref of an input, textarea or editable element"),
        text: z.string(),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      }),
      run: (input) =>
        this.act(async () => {
          await ui.typeText(page, input.ref, input.text, input.submit ? Submit.Enter : Submit.None)
          return this.observe(`Typed into ${input.ref}.`)
        }),
    })

    const press = betaZodTool({
      name: "press",
      description: "Press a keyboard key on the focused element: Enter, Escape, Tab, ArrowDown, …",
      inputSchema: z.object({ key: z.string() }),
      run: (input) =>
        this.act(async () => {
          await ui.press(page, input.key)
          return this.observe(`Pressed ${input.key}.`)
        }),
    })

    const scroll = betaZodTool({
      name: "scroll",
      description: "Scroll the page up or down by about one screen.",
      inputSchema: z.object({ direction: z.enum(["up", "down"]) }),
      run: (input) =>
        this.act(async () => {
          await ui.scroll(page, input.direction === "up" ? Direction.Up : Direction.Down)
          return this.observe(`Scrolled ${input.direction}.`)
        }),
    })

    const screenshot = betaZodTool({
      name: "screenshot",
      description: "Take a screenshot of the viewport to judge layout and visual state. Costs one action.",
      inputSchema: z.object({}),
      run: () =>
        this.act(async () => {
          const jpeg = await ui.screenshot(page)
          await this.saveShot(`step-${this.actions}.jpg`, jpeg)
          return [
            { type: "text", text: `Screenshot of ${page.url()} (${VIEWPORT.width}x${VIEWPORT.height}).` },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
          ]
        }),
    })

    const checkLinks = betaZodTool({
      name: "check_links",
      description: "Request every same-origin link on the current page and list the ones that fail (4xx, 5xx or unreachable).",
      inputSchema: z.object({}),
      run: () =>
        this.act(async () => {
          const results = await ui.checkLinks(page)
          const broken = results.filter((r) => !r.ok)
          const detail = broken.length ? broken.map((r) => `- ${r.status || "unreachable"} ${r.url}`).join("\n") : "(none)"
          return `Checked ${results.length} same-origin link(s). Broken:\n${detail}`
        }),
    })

    const logsTool = betaZodTool({
      name: "server_logs",
      description: "Tail of the application's own log inside the sandbox. Stack traces land here when a request fails.",
      inputSchema: z.object({}),
      run: () => this.act(async () => `Application log tail:\n${(await serverLogs!()) || "(empty)"}`),
    })

    const reportIssue = betaZodTool({
      name: "report_issue",
      description: "Record a reproduced defect. One call per distinct defect, as soon as it is reproduced. A screenshot and the recent signals are attached automatically.",
      inputSchema: z.object({
        title: z.string().describe("One line, what is wrong"),
        severity: z.enum(SEVERITIES),
        confidence: z.enum(CONFIDENCES),
        kind: z.enum(KINDS),
        steps: z.array(z.string()).min(1).describe("Exact steps that reproduce it"),
        expected: z.string(),
        actual: z.string(),
      }),
      run: async (input) => {
        if (this.finished) {
          return "The session is finished."
        }
        const id = this.issues.length + 1
        const evidence = await this.saveShot(`issue-${id}.jpg`, await ui.screenshot(page).catch(() => undefined))
        this.issues.push({ id, ...input, where: page.url(), evidence, signals: collector.recent(RECENT_SIGNALS) })
        log.step(`issue #${id} [${input.severity}] ${input.title}`)
        return `Recorded issue #${id} (${input.severity}): ${input.title}`
      },
    })

    const finish = betaZodTool({
      name: "finish",
      description: "End the session with a summary and a verdict. Call it when the budget is spent or the app is covered.",
      inputSchema: z.object({ summary: z.string(), verdict: z.enum(VERDICTS) }),
      run: (input) => {
        if (this.finished) {
          return "The session was already finished."
        }
        this.finished = true
        this.summary = input.summary
        this.verdict = input.verdict
        log.step(`finish: ${input.verdict}`)
        return "Session closed. Reply with a one-sentence sign-off and do not call any more tools."
      },
    })

    const actionTools = [open, look, click, type, press, scroll, screenshot, checkLinks]
    if (serverLogs) {
      actionTools.push(logsTool)
    }
    return [...actionTools, reportIssue, finish]
  }

  /** Accumulate usage and echo the intern's narration and tool calls to the log. */
  track(message: Anthropic.Beta.BetaMessage): void {
    const u = message.usage
    this.usage.turns += 1
    this.usage.input += u.input_tokens
    this.usage.output += u.output_tokens
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0
    this.stopReason = message.stop_reason ?? undefined

    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        this.narration.push(block.text.trim())
        log.step(`intern: ${block.text.trim()}`)
      }
      if (block.type === "tool_use") {
        log.step(`→ ${block.name} ${compact(block.input)}`)
      }
    }
  }

  outcome(): InternOutcome {
    return {
      issues: this.issues,
      summary: this.summary || this.narration.at(-1) || "",
      verdict: this.verdict,
      actions: this.actions,
      maxSteps: this.deps.maxSteps,
      visited: [...this.visited],
      usage: this.usage,
      narration: this.narration,
      stopReason: this.stopReason,
    }
  }

  /** Budget and lifecycle guard shared by every action tool. */
  private async act(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    if (this.finished) {
      return "The session is finished. Do not call any more tools."
    }
    if (this.actions >= this.deps.maxSteps) {
      return `Action budget exhausted (${this.actions}/${this.deps.maxSteps}). Call finish now with your summary and verdict.`
    }

    this.actions += 1
    // Keep the current document's signals before an action can navigate away from it.
    await this.deps.collector.pull()
    try {
      return await fn()
    } catch (err) {
      return this.observe(`Action failed: ${(err as Error).message}`)
    }
  }

  /** The one shape every action returns: what happened, where we are, what fired. */
  private async observe(note: string): Promise<string> {
    const state = await ui.snapshot(this.deps.page)
    this.visited.add(state.url)

    const signals = await this.deps.collector.drain()
    if (signals.length > 0) {
      log.step(`signals: ${signals.map((s) => s.kind).join(", ")}`)
    }

    return [
      note,
      `Actions used: ${this.actions}/${this.deps.maxSteps}.`,
      ui.renderSnapshot(state),
      `Signals since your previous action:\n${renderSignals(signals)}`,
    ].join("\n\n")
  }

  private async saveShot(name: string, jpeg: Buffer | undefined): Promise<string | undefined> {
    if (!jpeg) {
      return undefined
    }
    const relative = path.join(SCREENSHOT_DIR, name)
    await fs.writeFile(path.join(this.deps.outDir, relative), jpeg)
    return relative
  }
}

function compact(input: unknown): string {
  const text = JSON.stringify(input) ?? ""
  return text.length > INPUT_LOG_CAP ? `${text.slice(0, INPUT_LOG_CAP)}…` : text
}
