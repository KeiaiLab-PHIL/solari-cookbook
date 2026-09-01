import type { Page } from "patchright-core"
import {
  ACTION_TIMEOUT_MS,
  HTTP_OK,
  HTTP_REDIRECT_MAX,
  LABEL_CAP,
  MAX_ELEMENTS,
  MAX_LINKS_CHECKED,
  NAV_TIMEOUT_MS,
  PAGE_TEXT_CAP,
  SCREENSHOT_JPEG_QUALITY,
  SCROLL_PX,
  SETTLE_MS,
} from "./constants.js"

/**
 * Page driver — the only module that knows Playwright selectors.
 *
 * The intern never sees a DOM. It sees a numbered list of interactive
 * elements ([e1], [e2], …) that this module stamps onto the page, and it acts
 * by ref. Refs are reassigned on every snapshot, which keeps them short and
 * makes stale refs fail loudly instead of clicking the wrong thing.
 */
export interface UiElement {
  ref: string
  tag: string
  label: string
  href?: string
  type?: string
  value?: string
  placeholder?: string
  disabled?: boolean
  /** The browser's own validation message when the field blocks submission. */
  invalid?: string
}

export interface Snapshot {
  url: string
  title: string
  text: string
  elements: UiElement[]
}

export interface LinkCheck {
  url: string
  status: number
  ok: boolean
}

export enum Submit {
  None = "none",
  Enter = "enter",
}

export enum Direction {
  Up = "up",
  Down = "down",
}

const REF_ATTR = "data-qa-ref"
const INTERACTIVE =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [contenteditable="true"]'

export async function navigate(page: Page, url: string): Promise<void> {
  const absolute = new URL(url, page.url() === "about:blank" ? undefined : page.url()).toString()
  await page.goto(absolute, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
  await settle(page)
}

export async function snapshot(page: Page): Promise<Snapshot> {
  const state = await page.evaluate(collectState, {
    selector: INTERACTIVE,
    refAttr: REF_ATTR,
    maxElements: MAX_ELEMENTS,
    labelCap: LABEL_CAP,
    textCap: PAGE_TEXT_CAP,
  })
  return { url: page.url(), ...state }
}

/**
 * Runs inside the browser. Must stay self-contained: no imports, no closures,
 * and no nested named functions — tsx wraps those in a `__name()` helper that
 * does not exist in the page.
 */
function collectState(args: { selector: string; refAttr: string; maxElements: number; labelCap: number; textCap: number }) {
  type Widget = HTMLElement & {
    value?: string
    placeholder?: string
    type?: string
    disabled?: boolean
    alt?: string
    validity?: ValidityState
    validationMessage?: string
  }

  for (const stale of document.querySelectorAll(`[${args.refAttr}]`)) {
    stale.removeAttribute(args.refAttr)
  }

  const elements: UiElement[] = []
  for (const el of document.querySelectorAll<HTMLElement>(args.selector)) {
    if (elements.length >= args.maxElements) {
      break
    }
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") {
      continue
    }

    const w = el as Widget
    const ref = `e${elements.length + 1}`
    el.setAttribute(args.refAttr, ref)
    const tag = el.tagName.toLowerCase()
    const rawLabel = el.getAttribute("aria-label") || el.innerText || w.placeholder || w.value || el.title || w.alt || ""
    const label = rawLabel.trim().replace(/\s+/g, " ").slice(0, args.labelCap)
    const isField = tag === "input" || tag === "textarea" || tag === "select"

    elements.push({
      ref,
      tag,
      label,
      href: tag === "a" ? el.getAttribute("href") ?? undefined : undefined,
      type: tag === "input" ? w.type : undefined,
      value: isField ? w.value : undefined,
      placeholder: isField ? w.placeholder || undefined : undefined,
      disabled: w.disabled || undefined,
      // `validity` is read-only - unlike checkValidity(), reading it fires no event.
      invalid: w.validity && !w.validity.valid ? w.validationMessage || "invalid" : undefined,
    })
  }

  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim()
  const truncated = text.length > args.textCap ? `${text.slice(0, args.textCap)}\n…(truncated)` : text
  return { title: document.title, text: truncated, elements }
}

export function renderSnapshot(s: Snapshot): string {
  const lines = s.elements.map((e) => {
    const bits = [`[${e.ref}] ${e.tag}${e.type ? `[${e.type}]` : ""}`]
    if (e.label) {
      bits.push(`"${e.label}"`)
    }
    if (e.href) {
      bits.push(`href=${e.href}`)
    }
    if (e.placeholder) {
      bits.push(`placeholder="${e.placeholder}"`)
    }
    if (e.value !== undefined && e.value !== "") {
      bits.push(`value="${e.value}"`)
    }
    if (e.disabled) {
      bits.push("(disabled)")
    }
    if (e.invalid) {
      bits.push(`(blocks submit: ${e.invalid})`)
    }
    return bits.join(" ")
  })

  return [
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    `Interactive elements (${s.elements.length}):`,
    lines.join("\n") || "(none)",
    "Visible text:",
    s.text || "(empty)",
  ].join("\n")
}

export async function click(page: Page, ref: string): Promise<void> {
  await byRef(page, ref).click({ timeout: ACTION_TIMEOUT_MS })
  await settle(page)
}

export async function typeText(page: Page, ref: string, text: string, submit: Submit): Promise<void> {
  const target = byRef(page, ref)
  await target.fill(text, { timeout: ACTION_TIMEOUT_MS })
  if (submit === Submit.Enter) {
    await target.press("Enter", { timeout: ACTION_TIMEOUT_MS })
  }
  await settle(page)
}

export async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
  await settle(page)
}

export async function scroll(page: Page, direction: Direction): Promise<void> {
  const delta = direction === Direction.Down ? SCROLL_PX : -SCROLL_PX
  await page.mouse.wheel(0, delta)
  await settle(page)
}

export async function screenshot(page: Page): Promise<Buffer> {
  return page.screenshot({ type: "jpeg", quality: SCREENSHOT_JPEG_QUALITY })
}

/**
 * Deterministic broken-link sweep: every same-origin link on the page gets a
 * GET through the browser's own network stack, so cookies and preview-URL
 * access behave exactly as they do for a click.
 */
export async function checkLinks(page: Page): Promise<LinkCheck[]> {
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => a.href))
  const origin = new URL(page.url()).origin
  const targets = [...new Set(hrefs.map((h) => h.split("#")[0]))].filter((h) => h.startsWith(origin)).slice(0, MAX_LINKS_CHECKED)

  const results: LinkCheck[] = []
  for (const url of targets) {
    const status = await fetchStatus(page, url)
    results.push({ url, status, ok: status >= HTTP_OK && status <= HTTP_REDIRECT_MAX })
  }
  return results
}

async function fetchStatus(page: Page, url: string): Promise<number> {
  try {
    const res = await page.request.get(url, { timeout: ACTION_TIMEOUT_MS, maxRedirects: 5 })
    return res.status()
  } catch {
    return 0
  }
}

function byRef(page: Page, ref: string) {
  if (!/^e\d+$/.test(ref)) {
    throw new Error(`"${ref}" is not a ref — refs look like e12 and come from the latest page state`)
  }
  return page.locator(`[${REF_ATTR}="${ref}"]`).first()
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(() => undefined)
  await page.waitForTimeout(SETTLE_MS)
}
