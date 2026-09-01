import { SolariClient, type Sandbox } from "@solarisdk/sdk"
import type { RepoTarget } from "./cli.js"
import { APP_LOG, GATEWAY_READY_TIMEOUT_MS, GUEST_POLL_MS, LOG_TAIL_CHARS, SANDBOX_IDLE_MS, SANDBOX_TEMPLATE, SERVER_READY_TIMEOUT_MS, SETUP_TIMEOUT_MS, WORK_DIR, WORK_ROOT } from "./constants.js"
import { sleep, waitForHttp } from "./http.js"
import { log } from "./log.js"

/**
 * Build driver — turns a git URL into a public URL.
 *
 *   create sandbox → git clone → [setup] → start (backgrounded, logs to a file)
 *   → previewUrl(port) → poll until it answers
 */
export interface BuiltApp {
  url: string
  sandboxId: string
  /** Tail of the app's stdout/stderr — what the intern reads when a request fails. */
  logs(): Promise<string>
  close(): Promise<void>
}

export async function buildApp(apiKey: string, target: RepoTarget): Promise<BuiltApp> {
  const client = new SolariClient({ apiKey })
  const sandbox = await client.sandboxes.create({
    template: SANDBOX_TEMPLATE,
    timeoutMs: SANDBOX_IDLE_MS,
    lifecycle: { onTimeout: "kill" },
  })
  log.step(`sandbox ${sandbox.sandboxId} booted`)

  try {
    await sandbox.connect()
    await clone(sandbox, target)

    const cwd = target.path ? `${WORK_DIR}/${target.path}` : WORK_DIR
    if (target.setup) {
      await runSetup(sandbox, cwd, target.setup)
    }
    await startServer(sandbox, cwd, target.start)

    // Readiness is checked inside the guest: the public preview URL is the
    // gateway's business, and polling it here only muddies which of the two
    // is broken.
    await waitForGuest(sandbox, target.port)
    log.step("app is up in the guest")

    const { url } = await sandbox.previewUrl(target.port)
    await waitForHttp(url, GATEWAY_READY_TIMEOUT_MS, () => readLog(sandbox))
    log.step(`preview url ready: ${url.split("?")[0]}`)

    return {
      url,
      sandboxId: sandbox.sandboxId,
      logs: () => readLog(sandbox),
      close: () => sandbox.kill(),
    }
  } catch (err) {
    // kill(), not close(): close() only drops the control channel and leaves the VM billing.
    await sandbox.kill().catch(() => undefined)
    throw err
  }
}

async function clone(sandbox: Sandbox, target: RepoTarget): Promise<void> {
  await sandbox.files.mkdir(WORK_ROOT).catch(() => undefined)
  await sandbox.git.clone(target.repo, { path: WORK_DIR, depth: 1 })
  log.step(`cloned ${target.repo}`)
}

async function runSetup(sandbox: Sandbox, cwd: string, setup: string): Promise<void> {
  log.step(`setup: ${setup}`)
  const res = await sandbox.commands.run("sh", { args: ["-c", setup], cwd, timeoutMs: SETUP_TIMEOUT_MS })
  if (res.exitCode !== 0) {
    throw new Error(`setup failed (exit ${res.exitCode}):\n${tail(res.stderr || res.stdout)}`)
  }
}

/**
 * `commands.run` waits for the process to exit, so a server must be
 * backgrounded by a shell. Output goes to a file the intern can read later.
 */
async function startServer(sandbox: Sandbox, cwd: string, start: string): Promise<void> {
  log.step(`start: ${start}`)
  const res = await sandbox.commands.run("sh", { args: ["-c", `nohup ${start} > ${APP_LOG} 2>&1 &`], cwd })
  if (res.exitCode !== 0) {
    throw new Error(`could not start the app (exit ${res.exitCode}): ${res.stderr}`)
  }
}

/** Poll the port from inside the VM until the app answers, or give up with its log. */
async function waitForGuest(sandbox: Sandbox, port: number): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const probe = await sandbox.commands.run("sh", {
      args: ["-c", `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/ || true`],
    })
    if (probe.stdout.trim().startsWith("2") || probe.stdout.trim().startsWith("3") || probe.stdout.trim() === "404") {
      return
    }
    await sleep(GUEST_POLL_MS)
  }
  throw new Error(`the app never answered on port ${port} inside the sandbox:\n${await readLog(sandbox)}`)
}

async function readLog(sandbox: Sandbox): Promise<string> {
  const text = await sandbox.files.readText(APP_LOG).catch(() => "")
  return tail(text)
}

function tail(text: string): string {
  return text.length > LOG_TAIL_CHARS ? `…${text.slice(-LOG_TAIL_CHARS)}` : text
}
