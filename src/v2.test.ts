import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createV2MemoryPlugin } from "./v2"

const root = join(import.meta.dir, "..", ".cache", "v2-tests")
const directories: string[] = []

type Tool = {
  name: string
  input: { safeParse(value: unknown): { success: boolean } }
  execute(input: Record<string, unknown>, context: unknown): Promise<{ content?: string }>
}
type Hook = (event: any) => Promise<void> | void

const host = async (options: Record<string, unknown> = {}, withHttp = true) => {
  const directory = join(root, crypto.randomUUID())
  directories.push(directory)
  await mkdir(directory, { recursive: true })
  const tools = new Map<string, Tool>()
  const hooks = new Map<string, Hook>()
  let fetch: ((request: Request) => Promise<Response> | Response) | undefined
  const plugin = createV2MemoryPlugin(() => join(directory, "global"))
  const cleanup = await plugin.setup({
    options,
    location: { directory, project: { directory } },
    tool: { transform: async (callback: (editor: { add(tool: Tool): void }) => void) => {
      callback({ add: (tool) => tools.set(tool.name, tool) })
      return { dispose: async () => undefined }
    } },
    session: { hook: async (name: string, callback: Hook) => {
      hooks.set(name, callback)
      return { dispose: async () => undefined }
    } },
    ...(withHttp ? { http: { register: async (handler: { fetch(request: Request): Response | Promise<Response> }) => {
      fetch = handler.fetch
      return { dispose: async () => undefined }
    } } } : {}),
  } as never)
  return { directory, tools, hooks, fetch: () => fetch, cleanup }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("OpenCode v2 adapter", () => {
  test("registers all memory tools and preserves the logfmt store", async () => {
    const runtime = await host()
    expect(runtime.tools.size).toBe(11)
    const write = runtime.tools.get("memory_write")!
    const read = runtime.tools.get("memory_read")!
    expect(write.input.safeParse({ scope: "project", title: "A", type: "decision", content: "Keep it" }).success).toBe(true)
    expect(write.input.safeParse({ scope: "invalid", title: "A", type: "decision", content: "Keep it" }).success).toBe(false)

    const created = await write.execute({ scope: "project", title: "A", type: "decision", content: "Keep it" }, {})
    const id = (JSON.parse(created.content!) as { id: string }).id
    const result = await read.execute({ id, scope: "project" }, {})
    expect(result.content).toContain("Keep it")
    const raw = await readFile(join(runtime.directory, ".opencode", "memory", new Date().toISOString().slice(0, 10) + ".logfmt"), "utf8")
    expect(raw).toContain(`id=${id}`)
  })

  test("auto hooks keep prompts separate by session and inject only an index", async () => {
    const runtime = await host({ autoLoad: true, autoSave: true })
    const prompt = runtime.hooks.get("prompt")!
    const context = runtime.hooks.get("context")!
    await prompt({ sessionID: "one", prompt: { text: "remember that I prefer short summaries when working on staging deployments and include a private body suffix that must not be injected" } })
    const one = { sessionID: "one", system: [] as Array<{ type: string; text: string }> }
    await context(one)
    expect(one.system.map((part) => part.text).join("\n")).toContain("Relevant Memory Index:")
    expect(one.system.map((part) => part.text).join("\n")).not.toContain("that must not be injected")

    const other = { sessionID: "two", system: [] as Array<{ type: string; text: string }> }
    await context(other)
    expect(other.system).toEqual([])
  })

  test("registers the existing authenticated-host HTTP handler when available", async () => {
    const runtime = await host()
    const fetch = runtime.fetch()
    expect(fetch).toBeDefined()
    const response = await fetch!(new Request("http://memory.local/memories?scope=project"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ memories: [] })
    const withoutHttp = await host({}, false)
    expect(withoutHttp.fetch()).toBeUndefined()
  })
})
