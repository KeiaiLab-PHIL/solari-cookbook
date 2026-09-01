# qa-intern — design

## Goal

One command that takes a repository (or a live URL) and returns a QA report a
human would trust: reproduced defects with steps, evidence screenshots, the
server-side traceback when there is one, and a replay of the whole session.

Not goals: visual regression diffs, filing tickets, testing desktop apps,
authenticated flows (a Solari profile could add that later).

## Shape

```
           --repo                                   --url
             │                                        │
             ▼                                        │
   ┌─────────────────────┐   previewUrl(port)          │
   │ Solari sandbox      │ ───────────────────────┐    │
   │ clone → setup →     │                        ▼    ▼
   │ start (nohup → log) │                 ┌──────────────────────┐
   └─────────────────────┘                 │ Solari browser       │
             ▲ server_logs                 │ recording: on        │
             │                             │ collectors: console, │
   ┌─────────┴───────────┐  look/click/…   │ pageerror, 4xx/5xx   │
   │ Claude Opus 5       │ ◀─────────────▶ │                      │
   │ tool runner         │  state+signals  └──────────────────────┘
   │ report_issue/finish │
   └─────────┬───────────┘
             ▼
   runs/<ts>/report.md · screenshots/ · summary.json · replay URL
```

Layers talk only to the layer directly below them:

| layer | module | knows about |
|---|---|---|
| orchestration | `main.ts` | the other modules, nothing else |
| agent | `intern.ts` | the page driver, the collector, the tool shape |
| brains | `brain-claude.ts`, `brain-nvidia.ts` | one provider SDK each |
| page driver | `page.ts` | Playwright selectors, DOM |
| session drivers | `browser.ts`, `sandbox.ts` | the Solari SDKs |
| evidence | `signals.ts`, `report.ts` | plain data |

## Decisions

**Deterministic signals before model judgment.** Console errors and uncaught
exceptions are captured by an init script inside every document (stealth
browsers keep CDP `Runtime.enable` off, so Playwright's `console`/`pageerror`
events cannot be relied on); failed requests and 4xx/5xx responses come from
network listeners. All of them are appended to every tool result. `check_links` sweeps
same-origin links with plain GETs. These cost no tokens and never hallucinate;
the model's job is to reproduce them and to find the defects that leave no
trace (wrong counts, wrong item deleted, silent failures).

**Refs instead of selectors.** The page driver stamps `data-qa-ref="eN"` on
visible interactive elements and renders a numbered list. The model acts by
ref. Refs are reassigned on every snapshot, so a stale ref fails loudly rather
than clicking the wrong element.

**One return shape for every action.** `observe()` returns what happened, the
budget, the new page state and the signals since the previous action. The
model never has to ask where it is, and the budget guard lives in one place.

**The budget is a machine gate.** After `maxSteps` actions the action tools
refuse and ask for `finish`; `max_iterations` on the runner caps API calls
regardless of what the model does. `report_issue` and `finish` are free so a
full budget never blocks reporting.

**Sandbox and browser together.** The app's stdout/stderr go to a file inside
the sandbox; `server_logs` tails it. A 500 in the browser plus a traceback in
the log is a complete bug report.

**Claude API tool runner, not an agent framework.** `betaZodTool` gives typed
tool inputs and the SDK runs the loop; the whole agent fits in one file that a
reviewer can read top to bottom. Adaptive thinking, `effort`, prompt caching on
the system prompt, server-side refusal fallbacks.

**One tool set, two brains.** Tools are declared once as neutral specs
(`tool-spec.ts`) and adapted per provider. NIM is OpenAI-compatible, not
Anthropic-compatible, so there is no tool runner to borrow and the loop is
written out: request, read `tool_calls`, execute, append `role: "tool"`,
repeat. A tool message cannot carry an image, so a screenshot is appended as a
separate user message — and only for models that can see one. Anything a brain
cannot support is removed from the tool list rather than offered and ignored.

**Coverage is a machine gate, not a plea.** Small models declare the app
"covered" after a third of their budget: an early run stopped at 10 of 30
actions and missed a page. `finish` now refuses while pages the app itself
links to are unopened and budget remains, and names them. The same run then
used 29 of 30 actions. This is deliberately a gate, not prompt wording —
prompt wording is what failed.

## What the live runs changed

Running it for real is what found the defects worth fixing, in this order:

1. A clean clone's first `npm test` failed — Patchright wants a Chromium build
   no machine has. The tests install it themselves now.
2. The report pasted a 2 KB presigned replay URL into a table meant to be
   committed. A saved player page replaces it.
3. `summary.json` serialised the replay's bytes as JSON: 60 KB became 1.3 MB.
   The bytes already live in `replay.ndjson`.
4. The intern quit at a third of its budget (see the coverage gate above).
5. When a tool pushed back, the model answered in prose instead of calling a
   tool, and the NVIDIA loop treated that as the end of the session. A
   text-only turn now gets a bounded nudge instead of ending an unfinished run.
6. A run that found six defects filed itself as *inconclusive*: `report_issue`
   is free in actions but not in API calls, so the loop hit its iteration cap
   before `finish`. The cap now scales with the action budget, and a run that
   ends without `finish` says so and takes its verdict from the issues.
7. Readiness was polled through the public preview URL from this machine. That
   conflates the app with the gateway — when a leaked sandbox pushed the
   account over its concurrency limit, the browser got a 401 and the intern
   dutifully filed "app inaccessible". Readiness is now checked inside the
   guest, the gateway gets its own short check with a message that names the
   likely cause, and the process releases its VMs on SIGTERM and SIGHUP too
   (a dropped pipe was what leaked the sandbox).
8. The preview token kept ending up in committed reports — in a table cell,
   then in the model's own prose. Redaction now runs once over the finished
   document instead of field by field.

## Failure handling

- Build failures (clone, setup, start, no HTTP within 90 s) kill the sandbox and
  abort with the app log tail in the error.
- Action failures (bad ref, timeout) are returned to the model as text with the
  current state; the session continues.
- The browser and the sandbox are released in `finally`, and on SIGINT.
- A refusal from the model ends the loop; the report still renders with
  whatever was collected.
- The replay link expires in 15 minutes, so the events are downloaded and
  written next to the report with a player page.

## Testing

- `npm run typecheck` — strict TypeScript.
- `npm run test:offline` — the demo app plus a local headless Chromium drives
  the page driver and collectors end to end; asserts the machine-detectable
  planted bugs leave their evidence. No Solari, no Claude.
- `npm run test:intern` — the intern's tools called in a scripted order:
  dispatch, budget guard, evidence capture, report rendering. No model.
- `npm run test:live` — the Solari half with the real products: build, browse,
  signals, server log, release, replay download. No model.
- `npm run demo` — the real thing: sandbox, browser, model, report.
