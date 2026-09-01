import { HTTP_FORBIDDEN, HTTP_SERVER_ERROR, HTTP_UNAUTHORIZED, SERVER_POLL_MS } from "./constants.js"

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until the URL answers as a working site. A 404 still means the app is
 * up; a 502 means the gateway is not ready yet; and a 401/403 means the
 * gateway rejected us, which is NOT ready however cheerful the status line
 * looks - an early version accepted it and handed the intern a login wall to
 * test.
 */
export async function waitForHttp(url: string, timeoutMs: number, diagnostics?: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await probe(url)
    if (status > 0 && status < HTTP_SERVER_ERROR && status !== HTTP_UNAUTHORIZED && status !== HTTP_FORBIDDEN) {
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

/**
 * Solari hands out preview URLs with a ~400-character access token in the
 * query string. Visiting one sets a cookie, after which the token is
 * unnecessary — so strip it before anything else sees the URL. It was in the
 * intern's prompt once, and the model retyped it a character short.
 */
export function withoutPreviewToken(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.delete("pt_token")
  return parsed.toString().replace(/\?$/, "")
}
