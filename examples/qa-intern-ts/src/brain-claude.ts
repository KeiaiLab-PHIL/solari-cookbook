import Anthropic from "@anthropic-ai/sdk"
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import type { Effort } from "./cli.js"
import { FALLBACK_BETA, MAX_TOKENS_PER_TURN } from "./constants.js"
import { log } from "./log.js"
import { isImageOutput, type BrainRun, type ToolSpec } from "./tool-spec.js"

/**
 * Claude brain — the SDK's tool runner drives the loop, so this file only
 * translates tool specs and forwards each turn to the observer.
 */
export async function runClaude(run: BrainRun, effort: Effort): Promise<void> {
  const client = new Anthropic()

  const runner = client.beta.messages.toolRunner({
    model: run.model,
    max_tokens: MAX_TOKENS_PER_TURN,
    output_config: { effort },
    // The system prompt and tool list never change, so they cache across turns.
    system: [{ type: "text", text: run.systemPrompt, cache_control: { type: "ephemeral" } }],
    cache_control: { type: "ephemeral" },
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    tools: run.tools.map(toClaudeTool),
    messages: [{ role: "user", content: run.firstMessage }],
    max_iterations: run.maxIterations,
  })

  for await (const message of runner) {
    const u = message.usage
    run.observer.usage({
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    })
    run.observer.stop(message.stop_reason ?? undefined)

    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        run.observer.text(block.text.trim())
      }
      if (block.type === "tool_use") {
        run.observer.toolCall(block.name, block.input)
      }
    }

    if (message.stop_reason === "refusal") {
      log.warn("the model declined to continue")
      break
    }
  }
}

function toClaudeTool(spec: ToolSpec) {
  return betaZodTool({
    name: spec.name,
    description: spec.description,
    // The runner validates against this schema before calling `run`.
    inputSchema: spec.schema as never,
    run: async (input: unknown) => {
      const output = await spec.run(input)
      if (!isImageOutput(output)) {
        return output
      }
      return [
        { type: "text" as const, text: output.text },
        { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: output.jpegBase64 } },
      ]
    },
  })
}
