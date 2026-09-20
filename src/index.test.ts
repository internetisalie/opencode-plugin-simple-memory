import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createMemoryPlugin } from "../index"
import serverPlugin from "../server"

const tempRoot = join(import.meta.dir, "..", ".tmp-tests")
let testDir = ""

const context = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  abort: new AbortController().signal,
} as never

interface TestTool {
  execute(args: Record<string, unknown>, context: unknown): Promise<string>
}

const loadPlugin = () => createMemoryPlugin(() => join(testDir, "global-memory"))({ directory: testDir } as never)

const loadTools = async () => {
  const plugin = await loadPlugin()
  if (!plugin.tool) throw new Error("Plugin did not return tools")
  const tools = plugin.tool as unknown as Record<string, TestTool | undefined>
  const recall = tools.memory_recall
  const remember = tools.memory_remember
  const exportMemories = tools.memory_export
  const importMemories = tools.memory_import
  const forget = tools.memory_forget
  const update = tools.memory_update
  const compact = tools.memory_compact
  const memoryContext = tools.memory_context
  const write = tools.memory_write
  const read = tools.memory_read
  const list = tools.memory_list
  if (!recall) throw new Error("Plugin did not return memory_recall")
  if (!remember) throw new Error("Plugin did not return memory_remember")
  if (!exportMemories) throw new Error("Plugin did not return memory_export")
  if (!importMemories) throw new Error("Plugin did not return memory_import")
  if (!forget) throw new Error("Plugin did not return memory_forget")
  if (!update) throw new Error("Plugin did not return memory_update")
  if (!compact) throw new Error("Plugin did not return memory_compact")
  if (!memoryContext) throw new Error("Plugin did not return memory_context")
  if (!write) throw new Error("Plugin did not return memory_write")
  if (!read) throw new Error("Plugin did not return memory_read")
  if (!list) throw new Error("Plugin did not return memory_list")
  return { recall, remember, exportMemories, importMemories, forget, update, compact, memoryContext, write, read, list }
}

beforeEach(async () => {
  testDir = join(tempRoot, crypto.randomUUID())
  await mkdir(join(testDir, ".opencode", "memory"), { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe("memory_recall", () => {
  test("returns the highest scoring query matches within the limit", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      [
        'ts=2026-05-28T10:00:00.000Z type=context scope=api content="api only"',
        'ts=2026-05-28T10:01:00.000Z type=context scope=database content="api only"',
        'ts=2026-05-28T10:02:00.000Z type=decision scope=api content="api decision"',
      ].join("\n") + "\n",
    )

    const tools = await loadTools()
    const output = await tools.recall.execute({ query: "api", limit: 2 }, context)

    expect(output).toContain("[2026-05-28] decision/api: api decision")
    expect(output).toContain("[2026-05-28] context/api: api only")
    expect(output).not.toContain("context/database")
  })

  test("returns the latest chronological memories when no query is provided", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-27.logfmt"),
      'ts=2026-05-27T10:00:00.000Z type=context scope=old content="old memory"\n',
    )
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      [
        'ts=2026-05-28T10:00:00.000Z type=context scope=first content="first new memory"',
        'ts=2026-05-28T11:00:00.000Z type=context scope=second content="second new memory"',
      ].join("\n") + "\n",
    )

    const tools = await loadTools()
    const output = await tools.recall.execute({ limit: 2 }, context)

    expect(output).toContain("[2026-05-28] context/first: first new memory")
    expect(output).toContain("[2026-05-28] context/second: second new memory")
    expect(output).not.toContain("old memory")
  })

  test("round-trips multiline content written by memory_remember", async () => {
    const tools = await loadTools()
    await tools.remember.execute(
      {
        type: "context",
        scope: "notes",
        content: "line one\nline two with \"quotes\" and \\ slash",
      },
      context,
    )

    const output = await tools.recall.execute({ scope: "notes", match: "exact" }, context)
    const raw = await Bun.file(join(testDir, ".opencode", "memory", new Date().toISOString().split("T")[0] + ".logfmt")).text()

    expect(output).toContain("line one\nline two with \"quotes\" and \\ slash")
    expect(raw).toContain('content="line one\\nline two with \\"quotes\\" and \\\\ slash"')
  })

  test("imports compatible logfmt records with escaped multiline content", async () => {
    const tools = await loadTools()
    await tools.importMemories.execute(
      {
        format: "logfmt",
        data: 'ts=2026-05-28T12:00:00.000Z type=context scope=imported content="first\\nsecond"',
      },
      context,
    )

    const output = await tools.recall.execute({ scope: "imported", match: "exact" }, context)
    const exported = await tools.exportMemories.execute({ format: "jsonl" }, context)

    expect(output).toContain("first\nsecond")
    expect(JSON.parse(exported).content).toBe("first\nsecond")
  })

  test("preserves raw backslashes from older compatible records", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      'ts=2026-05-28T10:00:00.000Z type=context scope=paths content="C:\\tmp\\memory"\n',
    )

    const tools = await loadTools()
    const output = await tools.recall.execute({ scope: "paths", match: "exact" }, context)

    expect(output).toContain("C:\\tmp\\memory")
  })

  test("filters by tags, date range, and exact scope matching", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      [
        'ts=2026-05-28T10:00:00.000Z type=context scope=api content="old api" tags=backend,stale',
        'ts=2026-05-28T11:00:00.000Z type=context scope=api-v2 content="new api v2" tags=backend,current',
        'ts=2026-05-28T12:00:00.000Z type=context scope=api content="new api" tags=backend,current',
      ].join("\n") + "\n",
    )

    const tools = await loadTools()
    const output = await tools.recall.execute(
      { scope: "api", match: "exact", tags: ["current"], since: "2026-05-28T11:30:00.000Z", until: "2026-05-28" },
      context,
    )

    expect(output).toContain("new api")
    expect(output).not.toContain("old api")
    expect(output).not.toContain("api-v2")
  })

  test("memory_forget with query deletes only the best matching memory", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      [
        'ts=2026-05-28T10:00:00.000Z type=context scope=api content="keep postgres detail"',
        'ts=2026-05-28T11:00:00.000Z type=context scope=api content="delete redis detail"',
      ].join("\n") + "\n",
    )

    const tools = await loadTools()
    const deleted = await tools.forget.execute({ type: "context", scope: "api", reason: "test", query: "redis" }, context)
    const output = await tools.recall.execute({ scope: "api", match: "exact" }, context)

    expect(deleted).toContain("Deleted 1 context memory(s)")
    expect(output).toContain("keep postgres detail")
    expect(output).not.toContain("delete redis detail")
  })

  test("memory_export and memory_import round-trip json", async () => {
    const tools = await loadTools()
    await tools.remember.execute({ type: "pattern", scope: "tests", content: "use plugin interface", tags: ["testing"] }, context)

    const exported = await tools.exportMemories.execute({ format: "json" }, context)
    await rm(join(testDir, ".opencode", "memory"), { recursive: true, force: true })

    const imported = await tools.importMemories.execute({ format: "json", data: exported }, context)
    const output = await tools.recall.execute({ scope: "tests", match: "exact" }, context)

    expect(imported).toBe("Imported 1 memory(s)")
    expect(output).toContain("pattern/tests: use plugin interface [testing]")
  })

  test("memory_compact removes records with the same persisted identity", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      [
        'id=mem_aaaaaaaaaaaaaaaaaaaa title="duplicate" created_at=2026-05-28T10:00:00.000Z updated_at=2026-05-28T10:00:00.000Z ts=2026-05-28T10:00:00.000Z type=context scope=api content="duplicate"',
        'id=mem_aaaaaaaaaaaaaaaaaaaa title="duplicate" created_at=2026-05-28T10:00:00.000Z updated_at=2026-05-28T10:00:00.000Z ts=2026-05-28T10:00:00.000Z type=context scope=api content="duplicate"',
      ].join("\n") + "\n",
    )

    const tools = await loadTools()
    const dryRun = await tools.compact.execute({ dryRun: true }, context)
    const compacted = await tools.compact.execute({}, context)
    const output = await tools.recall.execute({}, context)

    expect(dryRun).toContain("1 duplicate(s) removed")
    expect(compacted).toContain("1 duplicate(s) removed")
    expect(output).toContain("Found 1 memories")
  })

  test("memory_context returns a compact relevant memory pack", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      [
        'ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy',
        'ts=2026-05-28T11:00:00.000Z type=context scope=tests content="Run make staging-live-onboarding-e2e for staging onboarding" tags=staging,e2e',
        'ts=2026-05-28T12:00:00.000Z type=context scope=runtime/local content="Local Bifrost is available through host.docker.internal" tags=local',
      ].join("\n") + "\n",
    )

    const tools = await loadTools()
    const output = await tools.memoryContext.execute({ query: "staging deploy", limit: 2, maxChars: 220 }, context)

    expect(output).toContain("Relevant Memory:")
    expect(output).toContain("deploy/staging")
    expect(output).toContain("tests")
    expect(output).not.toContain("runtime/local")
  })

  test("automatic hooks are disabled by default", async () => {
    const plugin = await loadPlugin()
    if (!plugin["chat.message"] || !plugin["experimental.chat.system.transform"] || !plugin.tool?.memory_recall) throw new Error("Plugin did not return hooks/tools")

    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      'ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy\n',
    )

    await plugin["chat.message"](
      { sessionID: "session-1", agent: "build", model: { providerID: "test", modelID: "test" } },
      {
        message: {} as never,
        parts: [{ type: "text", text: "remember that I prefer minimal diffs and how do I restart staging deployments?" }] as never,
      },
    )

    const system = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]({} as never, system)

    const output = await plugin.tool.memory_recall.execute({ scope: "user", match: "exact" }, context) as string

    expect(output).toContain("No matching memories")
    expect(system.system).toEqual([])
  })

  test("auto-save stores explicit remember requests when enabled", async () => {
    const plugin = await createMemoryPlugin(() => join(testDir, "global-memory"))({ directory: testDir } as never, { autoSave: true })
    if (!plugin["chat.message"] || !plugin.tool?.memory_recall) throw new Error("Plugin did not return hooks/tools")

    await plugin["chat.message"](
      { sessionID: "session-1", agent: "build", model: { providerID: "test", modelID: "test" } },
      {
        message: {} as never,
        parts: [{ type: "text", text: "remember that I prefer minimal diffs" }] as never,
      },
    )

    const output = await plugin.tool.memory_recall.execute({ scope: "user", match: "exact" }, context) as string

    expect(output).toContain("preference/user: I prefer minimal diffs [auto]")
  })

  test("auto-load injects relevant memories into system context when enabled", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2026-05-28.logfmt"),
      'ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy\n',
    )
    const plugin = await createMemoryPlugin(() => join(testDir, "global-memory"))({ directory: testDir } as never, { autoLoad: true })
    if (!plugin["chat.message"] || !plugin["experimental.chat.system.transform"]) throw new Error("Plugin did not return auto hooks")

    await plugin["chat.message"](
      { sessionID: "session-1", agent: "build", model: { providerID: "test", modelID: "test" } },
      {
        message: {} as never,
        parts: [{ type: "text", text: "how do I restart staging deployments?" }] as never,
      },
    )

    const output = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]({} as never, output)

    expect(output.system.join("\n")).toContain("Relevant Memory Index:")
    expect(output.system.join("\n")).toContain("type=context")
  })
})

describe("durable memory model", () => {
  test("exports the custom V1 server module with the stable plugin id", () => {
    expect(serverPlugin.id).toBe("opencode-simple-memory")
    expect(typeof serverPlugin.server).toBe("function")
  })

  test("reads legacy date/text records with deterministic ids, titles, and defaults", async () => {
    await Bun.write(
      join(testDir, ".opencode", "memory", "2024-01-02.logfmt"),
      'date=2024-01-02 text="Legacy deployment note"\n',
    )
    const plugin = await loadPlugin()
    if (!plugin.http) throw new Error("Plugin did not return HTTP support")

    const first = await plugin.http.fetch(new Request("http://memory.local/memories?scope=project"))
    const second = await plugin.http.fetch(new Request("http://memory.local/memories?scope=project"))
    const firstBody = await first.json() as { memories: Array<Record<string, string>> }
    const secondBody = await second.json() as { memories: Array<Record<string, string>> }

    expect(firstBody.memories).toHaveLength(1)
    expect(firstBody.memories[0]).toMatchObject({
      title: "Legacy deployment note",
      type: "context",
      scope: "project",
      content: "Legacy deployment note",
      createdAt: "2024-01-02T00:00:00.000Z",
    })
    expect(firstBody.memories[0]?.id).toMatch(/^mem_[0-9a-f]{20}$/)
    expect(secondBody.memories[0]?.id).toBe(firstBody.memories[0]?.id)
  })

  test("keeps exact duplicate legacy records independently addressable across reloads", async () => {
    const filepath = join(testDir, ".opencode", "memory", "2026-05-28.logfmt")
    const line = 'ts=2026-05-28T10:00:00.000Z type=context scope=api content="same legacy body"'
    await Bun.write(filepath, `${line}\n${line}\n`)

    const tools = await loadTools()
    const listed = await tools.list.execute({ scope: "project" }, context)
    const ids = [...listed.matchAll(/mem_[0-9a-f]{20}/g)].map((match) => match[0])
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])

    await tools.compact.execute({}, context)
    const afterCompact = await (await loadTools()).list.execute({ scope: "project" }, context)
    expect(afterCompact).toContain(ids[0]!)
    expect(afterCompact).toContain(ids[1]!)
    expect(await Bun.file(filepath).text()).toContain(`id=${ids[0]}`)
    expect(await Bun.file(filepath).text()).toContain(`id=${ids[1]}`)

    await tools.update.execute({ id: ids[0], storageScope: "project", content: "updated first duplicate" }, context)
    const afterUpdate = await (await loadTools()).list.execute({ scope: "project" }, context)
    expect(afterUpdate).toContain(ids[0]!)
    expect(afterUpdate).toContain(ids[1]!)

    await tools.forget.execute({ id: ids[0], storageScope: "project", reason: "remove one duplicate" }, context)
    const reloaded = await loadTools()
    const afterDelete = await reloaded.list.execute({ scope: "project" }, context)
    expect(afterDelete).not.toContain(ids[0]!)
    expect(afterDelete).toContain(ids[1]!)
    expect(await reloaded.read.execute({ id: ids[1], scope: "project" }, context)).toContain("same legacy body")
    expect((await Bun.file(filepath).text()).startsWith("\n")).toBe(true)
  })

  test("does not re-import update or deletion audit bodies from logfmt exports", async () => {
    const tools = await loadTools()
    const kept = JSON.parse(await tools.write.execute({
      scope: "project",
      title: "Kept",
      type: "context",
      content: "old kept body",
    }, context)) as { id: string }
    const removed = JSON.parse(await tools.write.execute({
      scope: "project",
      title: "Removed",
      type: "context",
      content: "deleted body",
    }, context)) as { id: string }
    await tools.update.execute({ id: kept.id, storageScope: "project", content: "current kept body" }, context)
    await tools.forget.execute({ id: removed.id, storageScope: "project", reason: "round-trip test" }, context)

    const exported = await tools.exportMemories.execute({ format: "logfmt", includeDeletions: true }, context)
    expect(exported).toContain("action=deleted")
    await rm(join(testDir, ".opencode", "memory"), { recursive: true, force: true })

    const imported = await tools.importMemories.execute({ format: "logfmt", data: exported }, context)
    const recalled = await tools.recall.execute({}, context)
    expect(imported).toBe("Imported 1 memory(s)")
    expect(recalled).toContain("current kept body")
    expect(recalled).not.toContain("old kept body")
    expect(recalled).not.toContain("deleted body")
  })

  test("rejects unsafe and invalid imported timestamps without writing outside the store", async () => {
    const tools = await loadTools()
    const importedJson = await tools.importMemories.execute({
      format: "json",
      data: JSON.stringify([
        { type: "context", content: "traversal", createdAt: "../../escaped" },
        { type: "context", content: "invalid date", createdAt: "2026-02-30" },
        { type: "context", content: "bad update", createdAt: "2026-05-28", updatedAt: "not-a-date" },
        { type: "context", content: "valid date-only", createdAt: "2026-05-28" },
      ]),
    }, context)
    const importedLogfmt = await tools.importMemories.execute({
      format: "logfmt",
      data: 'ts=../../../outside type=context scope=bad content="logfmt traversal"',
    }, context)

    expect(importedJson).toBe("Imported 1 memory(s)")
    expect(importedLogfmt).toBe("Imported 0 memory(s)")
    expect(await Bun.file(join(testDir, "escaped.logfmt")).exists()).toBe(false)
    expect(await Bun.file(join(tempRoot, "outside.logfmt")).exists()).toBe(false)
    expect(await Bun.file(join(testDir, ".opencode", "memory", "2026-05-28.logfmt")).exists()).toBe(true)
    expect(await tools.recall.execute({}, context)).toContain("valid date-only")
  })

  test("serializes cross-instance global updates as complete transactions", async () => {
    const pluginA = await createMemoryPlugin(() => join(testDir, "shared-global"))({ directory: join(testDir, "project-a") } as never)
    const pluginB = await createMemoryPlugin(() => join(testDir, "shared-global"))({ directory: join(testDir, "project-b") } as never)
    if (!pluginA.tool?.memory_write || !pluginA.http || !pluginB.http) throw new Error("Plugin did not return tools/HTTP")
    const record = JSON.parse(await pluginA.tool.memory_write.execute({
      scope: "global",
      title: "Concurrent",
      type: "context",
      content: "original concurrent body",
    }, context) as string) as { id: string }

    const patch = (fetch: (request: Request) => Response | Promise<Response>, content: string) => fetch(new Request(
      `http://memory.local/memories/${record.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ scope: "global", content }),
      },
    ))
    const responses = await Promise.all([
      patch(pluginA.http.fetch, "concurrent body A"),
      patch(pluginB.http.fetch, "concurrent body B"),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])

    const current = await pluginA.http.fetch(new Request("http://memory.local/memories?scope=global"))
    const body = await current.text()
    const audit = await Bun.file(join(testDir, "shared-global", "deletions.logfmt")).text()
    expect(audit).toContain("original concurrent body")
    if (body.includes("concurrent body A")) expect(audit).toContain("concurrent body B")
    else {
      expect(body).toContain("concurrent body B")
      expect(audit).toContain("concurrent body A")
    }
  })

  test("compaction preserves deletion audit data", async () => {
    const tools = await loadTools()
    const record = JSON.parse(await tools.write.execute({
      scope: "project",
      title: "Audit",
      type: "context",
      content: "audit body",
    }, context)) as { id: string }
    await tools.forget.execute({ id: record.id, storageScope: "project", reason: "preserve audit" }, context)
    const auditPath = join(testDir, ".opencode", "memory", "deletions.logfmt")
    const before = await Bun.file(auditPath).text()

    await tools.compact.execute({}, context)

    expect(await Bun.file(auditPath).text()).toBe(before)
  })

  test("keeps global and project storage separate while tools can address both", async () => {
    const tools = await loadTools()
    const project = JSON.parse(await tools.write.execute({
      scope: "project",
      title: "Project rule",
      type: "decision",
      content: "project-only body",
    }, context)) as { id: string }
    const global = JSON.parse(await tools.write.execute({
      scope: "global",
      title: "Global preference",
      type: "preference",
      content: "global-only body",
    }, context)) as { id: string }

    const plugin = await loadPlugin()
    if (!plugin.http) throw new Error("Plugin did not return HTTP support")
    const projectResponse = await plugin.http.fetch(new Request(`http://memory.local/memories?scope=project&directory=${encodeURIComponent(testDir)}`))
    const globalResponse = await plugin.http.fetch(new Request("http://memory.local/memories?scope=global"))
    const projectBody = await projectResponse.text()
    const globalBody = await globalResponse.text()

    expect(projectBody).toContain(project.id)
    expect(projectBody).toContain("project-only body")
    expect(projectBody).not.toContain(global.id)
    expect(globalBody).toContain(global.id)
    expect(globalBody).toContain("global-only body")
    expect(globalBody).not.toContain(project.id)
    expect(await tools.read.execute({ id: global.id, scope: "global" }, context)).toContain("global-only body")
    expect(await tools.list.execute({}, context)).toContain("Global preference | preference | global")
  })

  test("validates HTTP GET, PATCH, and DELETE and returns JSON", async () => {
    const tools = await loadTools()
    const record = JSON.parse(await tools.write.execute({
      scope: "project",
      title: "Original title",
      type: "context",
      content: "Original body",
    }, context)) as { id: string; createdAt: string }
    const plugin = await loadPlugin()
    if (!plugin.http) throw new Error("Plugin did not return HTTP support")
    const fetch = plugin.http.fetch

    expect((await fetch(new Request("http://memory.local/memories"))).status).toBe(400)
    expect((await fetch(new Request("http://memory.local/memories?scope=elsewhere"))).status).toBe(400)
    expect((await fetch(new Request("http://memory.local/nope"))).status).toBe(404)
    expect((await fetch(new Request("http://memory.local/memories", { method: "POST" }))).status).toBe(405)
    expect((await fetch(new Request("http://memory.local/memories/not-an-id?scope=project", { method: "DELETE" }))).status).toBe(400)
    expect((await fetch(new Request(`http://memory.local/memories/${record.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    }))).status).toBe(400)
    expect((await fetch(new Request(`http://memory.local/memories/${record.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", path: "/tmp", content: "bad" }),
    }))).status).toBe(400)
    expect((await fetch(new Request(`http://memory.local/memories/${record.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "content-length": String(70 * 1024) },
      body: JSON.stringify({ scope: "project", content: "too large" }),
    }))).status).toBe(413)

    const patched = await fetch(new Request(`http://memory.local/memories/${record.id}`, {
      method: "PATCH",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ scope: "project", title: "Updated title", type: "decision", content: "Updated body" }),
    }))
    expect(patched.status).toBe(200)
    expect(patched.headers.get("content-type")).toBe("application/json")
    expect(await patched.json()).toMatchObject({
      memory: {
        id: record.id,
        title: "Updated title",
        type: "decision",
        scope: "project",
        content: "Updated body",
        createdAt: record.createdAt,
      },
    })

    const missing = "mem_00000000-0000-0000-0000-000000000000"
    expect((await fetch(new Request(`http://memory.local/memories/${missing}?scope=project`, { method: "DELETE" }))).status).toBe(404)
    const deleted = await fetch(new Request(`http://memory.local/memories/${record.id}?scope=project&directory=${encodeURIComponent(testDir)}`, { method: "DELETE" }))
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ success: true, id: record.id, scope: "project" })
    expect((await fetch(new Request(`http://memory.local/memories/${record.id}?scope=project`, { method: "DELETE" }))).status).toBe(404)
  })

  test("automatic injection contains only index metadata and never the body", async () => {
    const tools = await loadTools()
    const record = JSON.parse(await tools.write.execute({
      scope: "project",
      title: "Deployment restart",
      type: "pattern",
      content: "SECRET-BODY restart staging with private-token-123",
    }, context)) as { id: string }
    const plugin = await createMemoryPlugin(() => join(testDir, "global-memory"))({ directory: testDir } as never, { autoLoad: true })
    if (!plugin["chat.message"] || !plugin["experimental.chat.system.transform"]) throw new Error("Plugin did not return hooks")

    await plugin["chat.message"](
      { sessionID: "session-1", agent: "build", model: { providerID: "test", modelID: "test" } },
      { message: {} as never, parts: [{ type: "text", text: "restart staging deployment" }] as never },
    )
    const output = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]({} as never, output)
    const injected = output.system.join("\n")

    expect(injected).toContain(record.id)
    expect(injected).toContain('title="Deployment restart"')
    expect(injected).toContain("type=pattern")
    expect(injected).toContain("scope=project")
    expect(injected).not.toContain("SECRET-BODY")
    expect(injected).not.toContain("private-token-123")
  })
})
