import { parseArgs } from "node:util"
import { DEFAULT_EFFORT, DEFAULT_MAX_STEPS, DEFAULT_MODEL, DEFAULT_PORT, DEMO_TARGET, NVIDIA_DEFAULT_MODEL, OUTPUT_ROOT } from "./constants.js"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]

/** Which API drives the intern. Claude speaks the Messages API; NVIDIA NIM is OpenAI-compatible. */
export type Provider = "claude" | "nvidia"
const PROVIDERS: readonly Provider[] = ["claude", "nvidia"]

export interface UrlTarget {
  kind: "url"
  url: string
}

export interface RepoTarget {
  kind: "repo"
  repo: string
  /** Sub-directory of the clone that holds the app. */
  path: string
  /** Optional one-off install step, run with `sh -c`. */
  setup?: string
  /** Command that serves the app on `port`, run with `sh -c` in the background. */
  start: string
  port: number
}

export type Target = UrlTarget | RepoTarget

export interface RunOptions {
  target: Target
  provider: Provider
  model: string
  effort: Effort
  maxSteps: number
  /** Capture a frame after every action and encode an MP4 of the session. */
  film: boolean
  /** Extra instructions for the intern, e.g. "focus on checkout". */
  focus?: string
  outRoot: string
}

const USAGE = `qa-intern — an AI QA intern with Solari hands

Usage:
  npm start -- --url https://staging.example.com
  npm start -- --repo <git-url> [--path sub/dir] [--setup "npm ci"] --start "npm run dev" --port 3000
  npm run demo                       # this repo's planted-bug app, built in a Solari sandbox

Options:
  --url <url>          Test a live URL (no sandbox)
  --repo <git-url>     Clone and serve the app inside a Solari sandbox
  --path <dir>         Sub-directory of the repo to run in (default: repo root)
  --setup <cmd>        Install step run before --start (sh -c)
  --start <cmd>        Serve command (sh -c, backgrounded) — required with --repo
  --port <n>           Port the app listens on (default ${DEFAULT_PORT})
  --demo               Shorthand for the bundled demo-app target
  --provider <name>    ${PROVIDERS.join("|")} (default: whichever API key is set)
  --model <id>         Default ${DEFAULT_MODEL} for claude, ${NVIDIA_DEFAULT_MODEL} for nvidia
  --effort <level>     ${EFFORTS.join("|")} (default ${DEFAULT_EFFORT}) — claude only
  --max-steps <n>      Action budget for the intern (default ${DEFAULT_MAX_STEPS})
  --film               Record the session as an MP4 next to the report
  --focus <text>       Extra instructions for the intern
  --out <dir>          Where reports go (default ./${OUTPUT_ROOT})
  --help`

export function parseCli(argv: string[]): RunOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      repo: { type: "string" },
      path: { type: "string", default: "" },
      setup: { type: "string" },
      start: { type: "string" },
      port: { type: "string" },
      demo: { type: "boolean", default: false },
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string", default: DEFAULT_EFFORT },
      "max-steps": { type: "string" },
      film: { type: "boolean", default: false },
      focus: { type: "string" },
      out: { type: "string", default: OUTPUT_ROOT },
      help: { type: "boolean", default: false },
    },
  })

  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }

  const effort = values.effort as Effort
  if (!EFFORTS.includes(effort)) {
    fail(`--effort must be one of ${EFFORTS.join(", ")}`)
  }

  const provider = pickProvider(values.provider)
  const maxSteps = values["max-steps"] === undefined ? DEFAULT_MAX_STEPS : Number(values["max-steps"])
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    fail("--max-steps must be a positive integer")
  }

  return {
    target: pickTarget(values),
    provider,
    model: values.model ?? (provider === "nvidia" ? NVIDIA_DEFAULT_MODEL : DEFAULT_MODEL),
    effort,
    maxSteps,
    film: values.film,
    focus: values.focus,
    outRoot: values.out,
  }
}

/** Explicit flag wins; otherwise use whichever key the environment actually has. */
function pickProvider(requested: string | undefined): Provider {
  if (requested !== undefined) {
    if (!PROVIDERS.includes(requested as Provider)) {
      fail(`--provider must be one of ${PROVIDERS.join(", ")}`)
    }
    return requested as Provider
  }
  if (!process.env.ANTHROPIC_API_KEY && process.env.NVIDIA_API_KEY) {
    return "nvidia"
  }
  return "claude"
}

interface RawTarget {
  url?: string
  repo?: string
  path: string
  setup?: string
  start?: string
  port?: string
  demo: boolean
}

function pickTarget(v: RawTarget): Target {
  const chosen = [v.url, v.repo, v.demo || undefined].filter(Boolean).length
  if (chosen !== 1) {
    fail("pick exactly one target: --url, --repo or --demo")
  }
  if (v.demo) {
    return { kind: "repo", ...DEMO_TARGET }
  }
  if (v.url) {
    return { kind: "url", url: v.url }
  }
  if (!v.start) {
    fail("--repo needs --start (the command that serves the app)")
  }

  const port = v.port === undefined ? DEFAULT_PORT : Number(v.port)
  if (!Number.isInteger(port) || port < 1) {
    fail("--port must be a positive integer")
  }
  return { kind: "repo", repo: v.repo!, path: v.path, setup: v.setup, start: v.start, port }
}

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`)
  process.exit(2)
}
