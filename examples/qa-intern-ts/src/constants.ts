/** Tunables in one place. Anything that is a number in the code should live here. */

// Claude
export const DEFAULT_MODEL = "claude-opus-5"
export const DEFAULT_EFFORT = "high"
export const DEFAULT_MAX_STEPS = 30
export const MAX_TOKENS_PER_TURN = 16_000
/** API calls the intern may spend beyond its action budget: reports, finish, sign-off. */
export const EXTRA_ITERATIONS = 8
export const FALLBACK_BETA = "server-side-fallback-2026-07-01"

// Solari sandbox (where the app under test is built and served)
export const SANDBOX_TEMPLATE = "base"
export const SANDBOX_IDLE_MS = 10 * 60_000
export const SETUP_TIMEOUT_MS = 5 * 60_000
export const SERVER_READY_TIMEOUT_MS = 90_000
export const SERVER_POLL_MS = 1_500
export const WORK_ROOT = "/tmp/qa-intern"
export const WORK_DIR = `${WORK_ROOT}/app`
export const APP_LOG = `${WORK_ROOT}/app.log`
export const LOG_TAIL_CHARS = 4_000
export const DEFAULT_PORT = 3000

// Solari browser (where the intern clicks)
export const VIEWPORT = { width: 1280, height: 800 }
export const SCREENSHOT_JPEG_QUALITY = 70
export const ACTION_TIMEOUT_MS = 10_000
export const NAV_TIMEOUT_MS = 20_000
/** Pause after an action so the DOM catches up before the next state is read. */
export const SETTLE_MS = 400
export const PAGE_TEXT_CAP = 4_000
export const LABEL_CAP = 60
export const MAX_ELEMENTS = 120
export const MAX_LINKS_CHECKED = 60
export const SCROLL_PX = 600
export const REPLAY_POLL_ATTEMPTS = 10
export const REPLAY_POLL_MS = 3_000
export const RECENT_SIGNALS = 5

// HTTP (from the spec — constants regardless of how obvious they look)
export const HTTP_OK = 200
export const HTTP_REDIRECT_MAX = 399
export const HTTP_BAD_REQUEST = 400
export const HTTP_NOT_FOUND = 404
export const HTTP_SERVER_ERROR = 500

// Output
export const OUTPUT_ROOT = "runs"
export const SCREENSHOT_DIR = "screenshots"
export const REPLAY_NDJSON = "replay.ndjson"
export const REPLAY_PAGE = "replay.html"
export const RRWEB_PLAYER_CDN = "https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4"

/** `--demo` target: this repo's planted-bug app, served with nothing but python3. */
export const DEMO_TARGET = {
  repo: "https://github.com/KeiaiLab-PHIL/solari-cookbook",
  path: "examples/qa-intern-ts/demo-app",
  start: "python3 server.py --port 3000",
  port: DEFAULT_PORT,
}

/** USD per million tokens, for the cost line in the report. Unknown models get no estimate. */
export const PRICES_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
}
