import type { z } from "zod"

/**
 * A tool, described once and run by either brain.
 *
 * The page driver's tools are provider-neutral: a name, a description, a Zod
 * schema and a `run`. `brain-claude.ts` wraps these in the Anthropic tool
 * runner; `brain-nvidia.ts` converts them to OpenAI-style function schemas.
 * Nothing provider-specific belongs in a tool body.
 */
export interface ToolImage {
  text: string
  jpegBase64: string
}

/** A tool returns text, or text plus one screenshot. */
export type ToolOutput = string | ToolImage

export interface ToolSpec<Input = unknown> {
  name: string
  description: string
  schema: z.ZodType<Input>
  run: (input: Input) => Promise<ToolOutput>
}

export function isImageOutput(output: ToolOutput): output is ToolImage {
  return typeof output !== "string"
}

/** What a brain reports back per turn, so the session can log and total it. */
export interface TurnObserver {
  text(text: string): void
  toolCall(name: string, input: unknown): void
  usage(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): void
  stop(reason: string | undefined): void
}

export interface BrainRun {
  systemPrompt: string
  firstMessage: string
  tools: ToolSpec[]
  model: string
  maxIterations: number
  observer: TurnObserver
  /** True once `finish` has been accepted. A brain must not stop before this. */
  isDone: () => boolean
}
