# qa-intern — an AI QA intern with Solari hands

Give it a repo. It builds the app inside a Solari **sandbox**, clicks through it
in a recorded Solari **browser** with Claude at the wheel, and hands you a
report: reproduced defects with steps, evidence screenshots, the server-side
traceback when there is one, and a replay of the whole session.

```
 --repo <git url>          Solari sandbox (microVM)
 ┌──────────┐  clone   ┌──────────────────────────┐
 │ your app │────────▶ │ setup → start :PORT       │
 └──────────┘          │ previewUrl → public https │
                       └────────────┬─────────────┘
                                    │  (or --url, no sandbox)
 ┌──────────────┐  tools  ┌─────────▼────────────────┐
 │ Claude Opus 5│◀──────▶ │ Solari browser (Chrome)   │
 │ tool runner  │ look /  │ recording: on             │
 │              │ click / │ collectors: console.error │
 └──────┬───────┘ type …  │ pageerror · 4xx / 5xx     │
        ▼                 └──────────────────────────┘
 runs/<ts>/report.md · screenshots/ · summary.json · replay link
```

## Run it

```bash
cd examples/qa-intern-ts
npm install

export SOLARI_API_KEY=slr_live_...     # console.getsolari.com — the free plan covers a run
export ANTHROPIC_API_KEY=sk-ant-...    # or `ant auth login`

npm run demo                           # build demo-app/ in a sandbox and test it
npm start -- --url https://staging.example.com
npm start -- --repo https://github.com/you/app --setup "npm ci" --start "npm run dev" --port 3000
```

| option | meaning |
|---|---|
| `--url <url>` | test a live URL, no sandbox |
| `--repo <git-url>` | clone and serve the app inside a Solari sandbox |
| `--path <dir>` | sub-directory of the repo to run in |
| `--setup <cmd>` | install step, `sh -c`, before `--start` |
| `--start <cmd>` | serve command, `sh -c`, backgrounded — required with `--repo` |
| `--port <n>` | port the app listens on (default 3000) |
| `--demo` | shorthand for the bundled demo app |
| `--model`, `--effort`, `--max-steps`, `--focus`, `--out` | see `--help` |

## How it works

1. **Build** (`src/sandbox.ts`) — `sandboxes.create({ template: "base" })`,
   `git.clone`, optional setup, then the start command under `nohup` with
   stdout/stderr redirected to a file. `previewUrl(port)` gives a public URL;
   we poll it until the app answers.
2. **Watch** (`src/browser.ts`, `src/signals.ts`) — `solari.launch({ recording: true })`,
   an init script that captures `console.error` and uncaught exceptions inside
   every document, and Playwright listeners for `requestfailed` and any
   response ≥ 400. These are *signals*: cheap, deterministic, never
   hallucinated.
3. **Explore** (`src/intern.ts`, `src/page.ts`) — a Claude tool-runner loop. The
   page is presented as a numbered list of visible interactive elements
   (`[e7] button "Add note"`); the model acts by ref. Every action returns the
   same shape: what happened, the budget, the new page state, and the signals
   since the previous action.
4. **Report** (`src/report.ts`) — Markdown with the issues, all signals, pages
   visited, tokens and cost, and the replay link.

| tool | what it does |
|---|---|
| `open`, `look`, `click`, `type`, `press`, `scroll` | drive the page; each returns state + signals |
| `screenshot` | JPEG of the viewport, returned as an image the model can see |
| `check_links` | GET every same-origin link; list the ones that fail |
| `server_logs` | tail of the app's log inside the sandbox (repo mode) |
| `report_issue` | record a reproduced defect; screenshot and recent signals attached |
| `finish` | summary + verdict; ends the session |

The action budget is a machine gate: after `--max-steps` actions the tools
refuse and ask for `finish`, and `max_iterations` caps API calls regardless.
Details and the reasoning behind each choice: [DESIGN.md](DESIGN.md).

## The demo app

`demo-app/` is Nebula Notes: a notes app in Python's standard library (so it
runs in a bare `base` sandbox) with six planted bugs. The answer key is in
[`demo-app/BUGS.md`](demo-app/BUGS.md) — score a run by counting how many the
intern reported.

## Tests

```bash
npm run typecheck
npm run test:offline     # demo app + local headless Chromium; no Solari, no Claude
npm run test:live        # demo app in a Solari sandbox + recorded Solari browser; no Claude
```

`test:live` is the Solari half of a real run: build, browse, collect signals,
read the server log, release, fetch the replay link. It costs a few cents.

The offline test needs a Chromium for Patchright 1.62: `npx patchright install
chromium-headless-shell`, or point `QA_INTERN_CHROME` at one you already have.

## Layout

```
src/main.ts      orchestration: build → watch → explore → report, always releases both VMs
src/sandbox.ts   git URL → public preview URL
src/browser.ts   recorded Solari session + signal collector
src/signals.ts   console / pageerror / request signals
src/page.ts      refs, snapshots, click/type/scroll, link sweep
src/intern.ts    the Claude tool loop and its tools
src/report.ts    markdown report + cost estimate
src/cli.ts       arguments
src/constants.ts every number that is not self-explanatory
demo-app/        Nebula Notes + BUGS.md
test/offline.ts  driver-level smoke, no network services
```
