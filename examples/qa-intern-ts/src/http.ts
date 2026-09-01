import { HTTP_SERVER_ERROR, SERVER_POLL_MS } from "./constants.js"

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until the URL answers with anything below 500. A 404 still means the
 * app is up; a 502 from the preview gateway means it is not yet.
 */
export async function waitForHttp(url: string, timeoutMs: number, diagnostics?: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await probe(url)
    if (status > 0 && status < HTTP_SERVER_ERROR) {
      return
    }
    await sleep(SERVER_POLL_MS)
  }

  const extra = diagnostics ? `\n--- app log tail ---\n${await diagnostics()}` : ""
  throw new Error(
    `${url.split("?")[0]} did not serve within ${timeoutMs / 1000}s. ` +
      `A 401 or timeout here is the preview gateway, not your app — usually a leftover session against the plan's concurrency limit.${extra}`,
  )
}

async function probe(url: string): Promise<number> {
  try {
    const res = await fetch(url, { redirect: "manual" })
    return res.status
  } catch {
    return 0
  }
}
