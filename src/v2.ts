import { Plugin } from "@opencode/plugin"
import { type ToolDefinition, tool } from "@opencode-ai/plugin"
import { join } from "node:path"
import { createFetchHandler } from "./http"
import {
  buildMemoryIndex,
  createTools,
  defaultGlobalMemoryDirectory,
  inferExplicitMemory,
  type PluginOptions,
  withTimeout,
} from "./index"
import { createStores, readEntries } from "./memory"

type HttpRegistration = {
  register: (handler: { fetch(request: Request): Response | Promise<Response> }) => Promise<{ dispose(): Promise<void> }>
}

// The HTTP domain is being added to the v2 host separately. Keep the handler
// functional for hosts with that capability while tools work on stock v2.
export const createV2MemoryPlugin = (
  resolveGlobalDirectory: () => string = defaultGlobalMemoryDirectory,
) => Plugin.define({
  id: "opencode-simple-memory",
  setup: async (ctx) => {
    const options = ctx.options as PluginOptions
    const stores = createStores(
      join(ctx.location.directory, ".opencode", "memory"),
      resolveGlobalDirectory(),
    )
    const definitions = createTools(stores) as Record<string, ToolDefinition>
    const prompts = new Map<string, string>()
    const timeout = options.autoHookTimeoutMs && options.autoHookTimeoutMs > 0 ? options.autoHookTimeoutMs : 100

    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(definitions)) {
        editor.add({
          name,
          description: definition.description,
          input: tool.schema.object(definition.args),
          options: { codemode: false },
          execute: async (input, context) => {
            const output = await definition.execute(input, {
              sessionID: context.sessionID,
              messageID: context.messageID,
              agent: context.agent,
              directory: ctx.location.directory,
              worktree: ctx.location.project.directory,
              abort: context.signal,
              metadata: () => undefined,
              ask: async () => undefined,
            })
            return { content: typeof output === "string" ? output : output.output }
          },
        })
      }
    })

    if (options.autoLoad || options.autoSave) {
      await ctx.session.hook("prompt", async (event) => {
        const text = event.prompt.text.trim()
        if (!text) return
        prompts.set(event.sessionID, text)
        if (!options.autoSave) return
        await withTimeout((async () => {
          const memory = inferExplicitMemory(text, options.autoSaveScope || "user")
          if (memory) await stores.project.appendMemory(memory)
        })(), timeout)
      })
    }

    if (options.autoLoad) {
      await ctx.session.hook("context", async (event) => {
        const prompt = prompts.get(event.sessionID)
        if (!prompt) return
        const index = await withTimeout((async () => buildMemoryIndex(await readEntries(stores), {
          query: prompt,
          limit: options.contextLimit,
          maxChars: options.contextMaxChars,
          minScore: options.contextMinScore,
        }))(), timeout)
        if (index) event.system.push({
          type: "text",
          text: `${index}\n\nUse memory_read to retrieve a full body. Do not mention this block unless asked.`,
        })
      })
    }

    const http = (ctx as typeof ctx & { http?: HttpRegistration }).http
    if (http) await http.register({ fetch: createFetchHandler(stores) })
    return () => prompts.clear()
  },
})

export const SimpleMemoryPlugin = createV2MemoryPlugin()

export default SimpleMemoryPlugin
