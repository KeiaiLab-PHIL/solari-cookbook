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
npm test                 # typecheck + test:offline + test:intern
npm run test:offline     # page driver + collectors: demo app in a local headless Chromium
npm run test:intern      # the intern's tools driven by a script; writes runs/sample/report.md
npm run test:live        # the Solari half of a real run: sandbox build, recorded browser, replay
```

`test:live` needs `SOLARI_API_KEY` and costs a few cents: it clones this repo
into a sandbox, serves the demo app, drives it through the preview URL, reads
the server log from inside the sandbox, releases everything and downloads the
replay. Last run: 8/8 checks in 15.7 s wall clock.

The offline test needs a Chromium for Patchright 1.62: `npx patchright install
chromium-headless-shell`, or point `QA_INTERN_CHROME` at one you already have.

## What a report looks like

[`runs/sample/report.md`](runs/sample/report.md) is written by `test:intern`:
the intern's tools driven by a fixed script (no model), reproducing two of the
planted bugs. It shows the format — verdict, issues with steps and evidence,
every machine-collected signal, pages visited. A real run adds the model's
judgment, the replay, and the token/cost line.

## Solari, as measured

- Sandbox boot → clone → app serving on a public URL: **3 s**. Browser session
  with recording: **1 s** more. The Solari half of a run is ~15 s end to end.
- `previewUrl(port)` returns a URL carrying a `pt_token` query parameter. The
  first visit sets a cookie; after that the app's own relative `fetch` calls
  and plain same-origin navigations work without the token.
- `commands.run` waits for the process to exit, so a server has to be
  backgrounded: `sh -c "nohup <start> > app.log 2>&1 &"`, then
  `files.readText("app.log")` is the server log. `kill()` ends the VM;
  `close()` only drops the control channel.
- The replay is rrweb NDJSON behind a presigned link that expires in
  15 minutes, and `getReplayUrl` 404s for a few seconds after release while
  the upload lands. The run downloads the events and writes `replay.ndjson`
  plus a self-contained `replay.html` next to the report.
- Stealth browsers (Patchright, Solari with `stealth: true`) keep CDP
  `Runtime.enable` off, so Playwright's `console` and `pageerror` events never
  fire — and `page.evaluate` runs in an isolated world where the page's
  `window` globals are invisible. The DOM is shared, though: an init script
  parks errors on `<html data-qa-signals>` and `page.evaluate` reads them back.
- `await solari.close()` at the end, or the process never exits.

## Status

Verified live: the build, the browser, the signals, the server log and the
replay (`test:live`). The Claude loop is wired, typechecked and exercised by
`test:intern`, but has not been run against a model from this repo yet —
`npm run demo` is that run once Claude auth is set.

## Layout

```
src/main.ts      orchestration: build → watch → explore → report, always releases both VMs
src/sandbox.ts   git URL → public preview URL
src/browser.ts   recorded Solari session + signal collector
src/signals.ts   console / pageerror / request signals
src/page.ts      refs, snapshots, click/type/scroll, link sweep
src/intern.ts    the Claude tool loop and its tools
src/report.ts    markdown report, cost estimate, replay page
src/cli.ts       arguments
src/constants.ts every number that is not self-explanatory
demo-app/        Nebula Notes + BUGS.md
test/offline.ts  driver-level smoke, no network services
test/intern-offline.ts  the intern's tools, scripted
test/live.ts     the Solari half of a run
test/harness.ts  demo app + local Chromium plumbing
```
