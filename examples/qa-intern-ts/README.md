# qa-intern — an AI QA intern with Solari hands

Give it a repo. It builds the app inside a Solari **sandbox**, clicks through it
in a recorded Solari **browser** with a model at the wheel, and hands you a
report: reproduced defects with steps, evidence screenshots, the server-side
traceback when there is one, and a replay of the whole session.

Runs on **Claude** or on **NVIDIA NIM** — whichever key you have.

```
 --repo <git url>          Solari sandbox (microVM)
 ┌──────────┐  clone   ┌──────────────────────────┐
 │ your app │────────▶ │ setup → start :PORT       │
 └──────────┘          │ previewUrl → public https │
                       └────────────┬─────────────┘
                                    │  (or --url, no sandbox)
 ┌──────────────┐  tools  ┌─────────▼────────────────┐
 │ Claude  ·  or │◀──────▶ │ Solari browser (Chrome)   │
 │ NVIDIA NIM    │ look /  │ recording: on             │
 │ (same tools)  │ click / │ collectors: console.error │
 └──────┬────────┘ type …  │ pageerror · 4xx / 5xx     │
        ▼                 └──────────────────────────┘
 runs/<ts>/report.md · screenshots/ · summary.json · replay link
```

## Run it

```bash
cd examples/qa-intern-ts
npm install

export SOLARI_API_KEY=slr_live_...     # console.getsolari.com — the free plan covers a run

# then either brain:
export ANTHROPIC_API_KEY=sk-ant-...    # or `ant auth login`
export NVIDIA_API_KEY=nvapi-...        # build.nvidia.com

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
| `--provider claude\|nvidia` | which brain drives; defaults to whichever key is set |
| `--model`, `--effort`, `--max-steps`, `--focus`, `--out` | see `--help` |

## Two brains, one set of tools

The tools are provider-neutral (`src/tool-spec.ts`): a name, a description, a
Zod schema, a `run`. Each brain adapts them.

| | Claude (`src/brain-claude.ts`) | NVIDIA NIM (`src/brain-nvidia.ts`) |
|---|---|---|
| API | Messages API, SDK tool runner drives the loop | OpenAI-compatible chat/completions, loop written by hand |
| Tools | `betaZodTool` | Zod → JSON Schema → `tools: [{type:"function"}]` |
| Screenshots | any model | only the vision models (`NVIDIA_VISION_MODELS`); otherwise the tool is not offered at all |
| Prompt caching | yes, on the system prompt | none — NIM has no cache control, so every turn resends the state |
| Effort | `output_config.effort` | not available |

Default NIM model is `nvidia/nemotron-3.5-lightning-30b-a3b`. It was picked by
measurement, not preference: the 100B+ models on NIM answer a single
tool-calling turn in 100–126 s, which a 30-step loop cannot afford, while the
lightning model answers in single-digit seconds and calls tools reliably.

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

The two offline tests need a Chromium; they install one themselves on first
run (~95 MB, once). Set `QA_INTERN_CHROME` to use a browser you already have.

`test:live` needs `SOLARI_API_KEY` and costs a few cents: it clones this repo
into a sandbox, serves the demo app, drives it through the preview URL, reads
the server log from inside the sandbox, releases everything and downloads the
replay. Last run: 8/8 checks in 15.7 s wall clock.

## What a report looks like

[`runs/live-nvidia/report.md`](runs/live-nvidia/report.md) is a real run:
`npm run demo` on NVIDIA NIM, 29 actions in 5 minutes, three defects
reproduced, with [`replay.html`](runs/live-nvidia/replay.html) next to it.

[`runs/sample/report.md`](runs/sample/report.md) is the same format produced
by `test:intern` — the tools driven by a fixed script, no model at all.

### What the intern actually caught

Six bugs are planted. Across four live runs on
`nemotron-3.5-lightning-30b-a3b` the intern reported three or four of them,
and the split is the interesting part:

| | planted | found |
|---|---|---|
| Leaves a machine signal (404, 500, uncaught TypeError) | B1, B3, B4, B6 | every run caught 3–4 of these |
| Leaves no trace — needs judgment (wrong item deleted, count off by one) | B2, B5 | never caught |

That is the honest shape of the result: the deterministic collectors do the
work they were built for, and a small fast model is good at reproducing what
they surface but not at noticing that a list of two items is labelled "3
notes". A larger model is the lever on the second row, and the same tools
already run on one — `--provider claude`.

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

Verified live end to end on NVIDIA NIM: sandbox build, recorded browser,
signals, server log, the model loop, the report and the replay
(`runs/live-nvidia/`). The Claude brain shares every one of those parts and is
exercised by `test:intern`, but has not been run against Claude from this repo.

## Layout

```
src/main.ts      orchestration: build → watch → explore → report, always releases both VMs
src/sandbox.ts   git URL → public preview URL
src/browser.ts   recorded Solari session + signal collector
src/signals.ts   console / pageerror / request signals
src/page.ts      refs, snapshots, click/type/scroll, link sweep
src/intern.ts    the Claude tool loop and its tools
src/tool-spec.ts provider-neutral tool shape
src/brain-claude.ts  Anthropic tool runner
src/brain-nvidia.ts  OpenAI-compatible loop for NVIDIA NIM
src/report.ts    markdown report, cost estimate, replay page
src/cli.ts       arguments
src/constants.ts every number that is not self-explanatory
demo-app/        Nebula Notes + BUGS.md
test/offline.ts  driver-level smoke, no network services
test/intern-offline.ts  the intern's tools, scripted
test/live.ts     the Solari half of a run
test/harness.ts  demo app + local Chromium plumbing
```
