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
| agent | `intern.ts` | the page driver, the collector, the Claude SDK |
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

## Failure handling

- Build failures (clone, setup, start, no HTTP within 90 s) kill the sandbox and
  abort with the app log tail in the error.
- Action failures (bad ref, timeout) are returned to the model as text with the
  current state; the session continues.
- The browser and the sandbox are released in `finally`, and on SIGINT.
- A refusal from the model ends the loop; the report still renders with
  whatever was collected.

## Testing

- `npm run typecheck` — strict TypeScript.
- `npm run test:offline` — the demo app plus a local headless Chromium drives
  the page driver and collectors end to end; asserts the machine-detectable
  planted bugs leave their evidence. No Solari, no Claude.
- `npm run demo` — the real thing: sandbox, browser, model, report.
