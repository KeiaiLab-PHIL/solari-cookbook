import OpenAI from "openai"
import { z } from "zod"
import { NVIDIA_BASE_URL, NVIDIA_MAX_TOKENS, NVIDIA_VISION_MODELS } from "./constants.js"
import { log } from "./log.js"
import { isImageOutput, type BrainRun, type ToolSpec } from "./tool-spec.js"

/**
 * NVIDIA NIM brain — an OpenAI-compatible loop, written out by hand.
 *
 * NIM speaks chat/completions, not the Anthropic Messages API, so there is no
 * tool runner to lean on: request → read `tool_calls` → execute → append
 * `role: "tool"` results → repeat. Two wrinkles the shape has to absorb:
 *
 *   - A tool message cannot carry an image. A screenshot is appended as a
 *     separate user message, and only when the model can see one.
 *   - Models differ on whether they emit `content` alongside `tool_calls`,
 *     so narration is optional on every turn.
 */
const FINISH_TOOL = "finish"
/** A model that answers with prose instead of a tool call gets this many reminders. */
const MAX_NUDGES = 3

export function nvidiaCanSeeImages(model: string): boolean {
  return NVIDIA_VISION_MODELS.includes(model)
}

export async function runNvidia(run: BrainRun, apiKey: string): Promise<void> {
  const client = new OpenAI({ apiKey, baseURL: NVIDIA_BASE_URL })
  const byName = new Map(run.tools.map((tool) => [tool.name, tool]))
  const withImages = nvidiaCanSeeImages(run.model)

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: run.systemPrompt },
    { role: "user", content: run.firstMessage },
  ]
  let nudges = 0

  for (let iteration = 0; iteration < run.maxIterations; iteration++) {
    const completion = await client.chat.completions.create({
      model: run.model,
      max_tokens: NVIDIA_MAX_TOKENS,
      messages,
      tools: run.tools.map(toOpenAiTool),
      tool_choice: "auto",
    })

    const usage = completion.usage
    run.observer.usage({ input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0 })
    const choice = completion.choices[0]
    run.observer.stop(choice?.finish_reason)

    const message = choice?.message
    if (!message) {
      log.warn("empty response from the model")
      return
    }
    if (message.content?.trim()) {
      run.observer.text(message.content.trim())
    }

    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      // Prose instead of a tool call. Small models do this when a tool pushes
      // back; ending here would abandon a session that never called finish.
      if (run.isDone() || nudges >= MAX_NUDGES) {
        return
      }
      nudges += 1
      messages.push(message, { role: "user", content: "That was not a tool call. Keep working: call the next tool, and call finish when you are done." })
      continue
    }
    messages.push(message)

    let finished = false
    for (const call of calls) {
      if (call.type !== "function") {
        continue
      }
      const { content, image, isFinish } = await execute(byName, call.function.name, call.function.arguments, run)
      messages.push({ role: "tool", tool_call_id: call.id, content })

      if (image && withImages) {
        messages.push({
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }],
        })
      }
      finished ||= isFinish
    }

    if (finished && run.isDone()) {
      return
    }
  }

  log.warn(`stopped at the iteration cap (${run.maxIterations})`)
}

interface Executed {
  content: string
  image?: string
  isFinish: boolean
}

/** Parse, validate and run one call; a bad call becomes a message the model can recover from. */
async function execute(byName: Map<string, ToolSpec>, name: string, rawArgs: string, run: BrainRun): Promise<Executed> {
  const spec = byName.get(name)
  if (!spec) {
    return { content: `No tool named ${name}. Available: ${[...byName.keys()].join(", ")}.`, isFinish: false }
  }

  let parsed: unknown
  try {
    parsed = spec.schema.parse(rawArgs.trim() ? JSON.parse(rawArgs) : {})
  } catch (err) {
    return { content: `Invalid arguments for ${name}: ${(err as Error).message}`, isFinish: false }
  }

  run.observer.toolCall(name, parsed)
  const output = await spec.run(parsed)
  const isFinish = name === FINISH_TOOL
  if (!isImageOutput(output)) {
    return { content: output, isFinish }
  }
  return { content: output.text, image: output.jpegBase64, isFinish }
}

function toOpenAiTool(spec: ToolSpec): OpenAI.Chat.ChatCompletionTool {
  const schema = z.toJSONSchema(spec.schema, { target: "draft-7" }) as Record<string, unknown>
  delete schema.$schema
  return { type: "function", function: { name: spec.name, description: spec.description, parameters: schema } }
}
