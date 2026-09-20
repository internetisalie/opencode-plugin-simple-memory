/// <reference path="./plugin-http.d.ts" />

import { type Plugin, tool } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { createFetchHandler } from "./http"
import {
  MEMORY_TYPES,
  STORAGE_SCOPES,
  compactStore,
  createStores,
  dateFromTimestamp,
  deleteSelectedEntries,
  encodeMemory,
  isMemoryType,
  isStorageScope,
  newMemory,
  parseMemoryLine,
  readEntries,
  toRecord,
  updateSelectedEntry,
  type Memory,
  type MemoryEntry,
  type MemoryStores,
  type MemoryType,
  type StorageScope,
} from "./memory"

export type { MemoryRecord, MemoryType, StorageScope } from "./memory"
export { MEMORY_TYPES, STORAGE_SCOPES, parseMemoryLine } from "./memory"

interface PluginOptions {
  autoLoad?: boolean
  autoSave?: boolean
  autoHookTimeoutMs?: number
  contextLimit?: number
  contextMaxChars?: number
  contextMinScore?: number
  autoSaveScope?: string
}

interface ContextOptions {
  query?: string
  scope?: string
  tags?: string[]
  types?: MemoryType[]
  limit?: number
  maxChars?: number
  minScore?: number
}

const typePriority: Record<MemoryType, number> = {
  preference: 6,
  decision: 5,
  blocker: 4,
  pattern: 3,
  context: 2,
  learning: 1,
}

export const defaultGlobalMemoryDirectory = (home = homedir()) => join(home, ".config", "opencode", "simple-memory")

const formatMemory = (entry: MemoryEntry): string => {
  const memory = entry.memory
  const tags = memory.tags?.length ? ` [${memory.tags.join(", ")}]` : ""
  const issue = memory.issue ? ` (${memory.issue})` : ""
  return `[${dateFromTimestamp(memory.createdAt)}] ${memory.type}/${memory.topic}: ${memory.content}${issue}${tags} {id=${memory.id} title=${JSON.stringify(memory.title)} scope=${entry.scope}}`
}

const scoreMatch = (memory: Memory, words: string[]): number => {
  const searchable = `${memory.id} ${memory.title} ${memory.type} ${memory.topic} ${memory.content} ${memory.tags?.join(" ") || ""}`.toLowerCase()
  let score = 0
  for (const word of words) {
    if (searchable.includes(word)) score++
    if (memory.topic.toLowerCase() === word) score += 2
    if (memory.type === word) score += 2
    if (memory.tags?.some((tag) => tag.toLowerCase() === word)) score += 2
  }
  return score
}

const matchesTopic = (memory: Memory, scope: string, mode: "contains" | "exact" | "prefix") => {
  if (mode === "exact") return memory.topic === scope
  if (mode === "prefix") return memory.topic.startsWith(scope)
  return memory.topic === scope || memory.topic.includes(scope)
}

const startOfDateFilter = (value: string) => value.includes("T") ? value : `${value}T00:00:00.000Z`
const endOfDateFilter = (value: string) => value.includes("T") ? value : `${value}T23:59:59.999Z`

const filterEntries = (
  entries: MemoryEntry[],
  args: {
    scope?: string
    type?: MemoryType
    query?: string
    tags?: string[]
    since?: string
    until?: string
    match?: "contains" | "exact" | "prefix"
  },
) => {
  let results = entries
  const match = args.match || "contains"
  if (args.scope) results = results.filter((entry) => matchesTopic(entry.memory, args.scope!, match))
  if (args.type) results = results.filter((entry) => entry.memory.type === args.type)
  if (args.tags?.length) {
    const tags = args.tags.map((tag) => tag.toLowerCase())
    results = results.filter((entry) => {
      const memoryTags = entry.memory.tags?.map((tag) => tag.toLowerCase()) || []
      return tags.every((tag) => memoryTags.includes(tag))
    })
  }
  if (args.since) results = results.filter((entry) => entry.memory.createdAt >= startOfDateFilter(args.since!))
  if (args.until) results = results.filter((entry) => entry.memory.createdAt <= endOfDateFilter(args.until!))
  if (!args.query) return results

  const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
  return results
    .map((entry) => ({ entry, score: scoreMatch(entry.memory, words) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.memory.createdAt.localeCompare(a.entry.memory.createdAt))
    .map((item) => item.entry)
}

const rankEntries = (entries: MemoryEntry[], options: ContextOptions) => {
  const query = options.query?.trim()
  const words = query?.toLowerCase().split(/\s+/).filter(Boolean) || []
  const minScore = options.minScore ?? (query ? 1 : 0)
  let results = entries
  if (options.scope) results = results.filter((entry) => matchesTopic(entry.memory, options.scope!, "contains"))
  if (options.types?.length) results = results.filter((entry) => options.types!.includes(entry.memory.type))
  if (options.tags?.length) {
    const tags = options.tags.map((tag) => tag.toLowerCase())
    results = results.filter((entry) => {
      const memoryTags = entry.memory.tags?.map((tag) => tag.toLowerCase()) || []
      return tags.every((tag) => memoryTags.includes(tag))
    })
  }
  return results
    .map((entry) => ({ entry, score: words.length ? scoreMatch(entry.memory, words) : 0 }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => {
      const priority = typePriority[b.entry.memory.type] - typePriority[a.entry.memory.type]
      return b.score - a.score || priority || b.entry.memory.createdAt.localeCompare(a.entry.memory.createdAt)
    })
    .slice(0, options.limit && options.limit > 0 ? Math.floor(options.limit) : 5)
    .map((item) => item.entry)
}

const buildContextPack = (entries: MemoryEntry[], options: ContextOptions) => {
  const maxChars = options.maxChars && options.maxChars > 0 ? Math.floor(options.maxChars) : 1200
  const lines = ["Relevant Memory:"]
  let used = lines[0]!.length + 1
  for (const entry of rankEntries(entries, options)) {
    const prefix = `- ${entry.memory.type}/${entry.memory.topic}: `
    const remaining = maxChars - used - prefix.length
    if (remaining <= 20) break
    const normalized = entry.memory.content.replace(/\s+/g, " ").trim()
    const content = normalized.length <= Math.min(remaining, 260)
      ? normalized
      : `${normalized.slice(0, Math.max(0, Math.min(remaining, 260) - 3)).trimEnd()}...`
    const line = `${prefix}${content}`
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 1 ? lines.join("\n") : ""
}

const buildMemoryIndex = (entries: MemoryEntry[], options: ContextOptions) => {
  const maxChars = options.maxChars && options.maxChars > 0 ? Math.floor(options.maxChars) : 1200
  const lines = ["Relevant Memory Index:"]
  let used = lines[0]!.length + 1
  for (const entry of rankEntries(entries, options)) {
    const title = entry.memory.title.replace(/\s+/g, " ").trim()
    const line = `- id=${entry.memory.id} title=${JSON.stringify(title)} type=${entry.memory.type} scope=${entry.scope}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 1 ? lines.join("\n") : ""
}

const textFromParts = (parts: unknown[]) => parts
  .map((part) => {
    if (typeof part !== "object" || !part) return ""
    if (!("type" in part) || part.type !== "text") return ""
    if (!("text" in part) || typeof part.text !== "string") return ""
    return part.text
  })
  .filter(Boolean)
  .join("\n")
  .trim()

const inferExplicitMemory = (text: string, topic: string) => {
  if (/\b(don't|do not|dont)\s+remember\b/i.test(text)) return null
  const content = text.match(/(?:^|\b)(?:please\s+)?remember(?:\s+that|:)?\s+([\s\S]+)$/i)?.[1]?.trim()
  if (!content) return null
  const lower = content.toLowerCase()
  const type: MemoryType = lower.includes("prefer")
    ? "preference"
    : lower.includes("decided") || lower.includes("decision")
      ? "decision"
      : lower.includes("blocked") || lower.includes("blocker")
        ? "blocker"
        : lower.includes("pattern") || lower.includes("always")
          ? "pattern"
          : "context"
  return newMemory({ type, topic, content, tags: ["auto"] })
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  let timeout: Timer | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const chooseUpdateTarget = (matches: MemoryEntry[], query?: string) => {
  if (matches.length <= 1) return { target: matches[0], message: undefined }
  if (!query) return { target: undefined, message: `Found ${matches.length} memories. Provide an id or query to select one.` }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored = matches
    .map((entry) => ({ entry, score: scoreMatch(entry.memory, words) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.memory.updatedAt.localeCompare(a.entry.memory.updatedAt))
  return scored[0]
    ? { target: scored[0].entry, message: undefined }
    : { target: undefined, message: `Found ${matches.length} memories, but none matched query "${query}".` }
}

const parseImportedMemory = (value: unknown): { memory: Memory; scope?: StorageScope } | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (!isMemoryType(input.type) || typeof input.content !== "string") return null
  const timestamp = typeof input.createdAt === "string"
    ? input.createdAt
    : typeof input.ts === "string"
      ? input.ts
      : new Date().toISOString()
  const source = [
    `created_at=${timestamp}`,
    `updated_at=${typeof input.updatedAt === "string" ? input.updatedAt : timestamp}`,
    `ts=${typeof input.updatedAt === "string" ? input.updatedAt : timestamp}`,
    `type=${input.type}`,
    `scope=${typeof input.topic === "string" ? input.topic : typeof input.scope === "string" && !isStorageScope(input.scope) ? input.scope : "general"}`,
    `content=${JSON.stringify(input.content)}`,
    typeof input.id === "string" ? `id=${input.id}` : "",
    typeof input.title === "string" ? `title=${JSON.stringify(input.title)}` : "",
  ].filter(Boolean).join(" ")
  const memory = parseMemoryLine(source)
  if (!memory) return null
  memory.issue = typeof input.issue === "string" ? input.issue : undefined
  memory.tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : undefined
  const scope = isStorageScope(input.storageScope) ? input.storageScope : isStorageScope(input.scope) ? input.scope : undefined
  return { memory, scope }
}

const createTools = (stores: MemoryStores) => {
  const remember = tool({
    description: "Store a memory while preserving the legacy topic-based call shape",
    args: {
      type: tool.schema.enum(MEMORY_TYPES).describe("Type of memory"),
      scope: tool.schema.string().describe("Legacy topic/area (e.g., auth, api, mobile)"),
      content: tool.schema.string().describe("The memory content"),
      title: tool.schema.string().optional().describe("Short memory title"),
      storageScope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Storage scope (default project)"),
      issue: tool.schema.string().optional().describe("Related GitHub issue (e.g., #51)"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Additional tags"),
    },
    async execute(args) {
      const scope = args.storageScope || "project"
      const memory = newMemory({ ...args, topic: args.scope })
      await stores[scope].appendMemory(memory)
      return `Remembered ${memory.id}: ${args.type} in ${args.scope} (${scope})`
    },
  })

  const write = tool({
    description: "Create a titled global or project memory",
    args: {
      scope: tool.schema.enum(STORAGE_SCOPES).describe("Storage scope"),
      title: tool.schema.string().describe("Short memory title"),
      type: tool.schema.enum(MEMORY_TYPES).describe("Type of memory"),
      content: tool.schema.string().describe("The full memory content"),
    },
    async execute(args) {
      const memory = newMemory(args)
      await stores[args.scope].appendMemory(memory)
      return JSON.stringify(toRecord({ memory, scope: args.scope, filepath: "", lineIndex: 0 }))
    },
  })

  const read = tool({
    description: "Read one full memory body by stable id",
    args: {
      id: tool.schema.string().describe("Stable memory id"),
      scope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Storage scope; omit to search both"),
    },
    async execute(args) {
      const matches = (await readEntries(stores, args.scope)).filter((entry) => entry.memory.id === args.id)
      if (!matches.length) return "No matching memory"
      if (matches.length > 1) return "Memory id exists in both scopes; provide scope"
      return JSON.stringify(toRecord(matches[0]!), null, 2)
    },
  })

  const recall = tool({
    description: "Retrieve full memories by topic, type, tag, date, or search query",
    args: {
      scope: tool.schema.string().optional().describe("Legacy topic filter"),
      storageScope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Storage scope (default project)"),
      type: tool.schema.enum(MEMORY_TYPES).optional().describe("Filter by type"),
      query: tool.schema.string().optional().describe("Search term (space-separated words, matches any)"),
      limit: tool.schema.number().optional().describe("Max results (default 20)"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Only include memories with all tags"),
      since: tool.schema.string().optional().describe("Only include memories at or after this timestamp/date"),
      until: tool.schema.string().optional().describe("Only include memories at or before this timestamp/date"),
      match: tool.schema.enum(["contains", "exact", "prefix"]).optional().describe("Topic match mode"),
    },
    async execute(args) {
      const entries = await readEntries(stores, args.storageScope || "project")
      if (!entries.length) return "No memories found"
      const results = filterEntries(entries, args)
      const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 20
      const limited = args.query ? results.slice(0, limit) : results.slice(-limit)
      if (!limited.length) return "No matching memories"
      const header = results.length > limit
        ? `Found ${results.length} memories (showing ${args.query ? "best" : "last"} ${limit} of ${entries.length} total)\n\n`
        : results.length !== entries.length
          ? `Found ${results.length} memories (${entries.length} total)\n\n`
          : `Found ${results.length} memories\n\n`
      return header + limited.map(formatMemory).join("\n")
    },
  })

  const update = tool({
    description: "Update an existing project memory by legacy topic/type or stable id",
    args: {
      scope: tool.schema.string().optional().describe("Legacy topic of memory to update"),
      type: tool.schema.enum(MEMORY_TYPES).optional().describe("Type of memory"),
      id: tool.schema.string().optional().describe("Stable memory id"),
      storageScope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Storage scope (default project)"),
      title: tool.schema.string().optional().describe("New title"),
      content: tool.schema.string().describe("The new content"),
      query: tool.schema.string().optional().describe("Search term when multiple legacy matches exist"),
      issue: tool.schema.string().optional().describe("Update related GitHub issue"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Update tags"),
    },
    async execute(args) {
      const storageScope = args.storageScope || "project"
      let selectionMessage: string | undefined
      const updated = await updateSelectedEntry(
        stores[storageScope],
        (entries) => {
          const matches = args.id
            ? entries.filter((entry) => entry.memory.id === args.id)
            : args.scope && args.type
              ? entries.filter((entry) => entry.memory.topic === args.scope && entry.memory.type === args.type)
              : []
          const selected = chooseUpdateTarget(matches, args.query)
          selectionMessage = selected.message
          return selected.target
        },
        (memory) => ({
          ...memory,
          title: args.title?.trim() || memory.title,
          content: args.content,
          updatedAt: new Date().toISOString(),
          issue: args.issue !== undefined ? args.issue.trim() || undefined : memory.issue,
          tags: args.tags !== undefined ? args.tags.map((tag) => tag.trim()).filter(Boolean) : memory.tags,
        }),
        `Updated to: ${args.content}`,
      )
      if (!updated) return selectionMessage || "No matching memories; provide id or both scope and type"
      return `Updated ${updated.memory.id}: ${updated.memory.title}`
    },
  })

  const listMemories = tool({
    description: "List compact memory indexes with stable ids across global and project scopes",
    args: {
      scope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Only list one storage scope"),
    },
    async execute(args) {
      const entries = await readEntries(stores, args.scope)
      if (!entries.length) return "No memories found"
      return [`Total memories: ${entries.length}`, ...entries.map((entry) =>
        `${entry.memory.id} | ${entry.memory.title} | ${entry.memory.type} | ${entry.scope}`,
      )].join("\n")
    },
  })

  const forget = tool({
    description: "Delete by stable id or legacy topic/type and log the deletion for audit",
    args: {
      id: tool.schema.string().optional().describe("Stable memory id"),
      scope: tool.schema.string().optional().describe("Legacy topic of memory to delete"),
      storageScope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Storage scope; id lookups search both when omitted"),
      type: tool.schema.enum(MEMORY_TYPES).optional().describe("Type of memory"),
      reason: tool.schema.string().describe("Why this is being deleted"),
      query: tool.schema.string().optional().describe("Narrow legacy matches to the best result"),
    },
    async execute(args) {
      const scopes = args.storageScope ? [args.storageScope] : args.id ? STORAGE_SCOPES : ["project" as const]
      const matches = (await Promise.all(scopes.map((storageScope) => deleteSelectedEntries(
        stores[storageScope],
        (entries) => {
          let selected = args.id
            ? entries.filter((entry) => entry.memory.id === args.id)
            : args.scope && args.type
              ? entries.filter((entry) => entry.memory.topic === args.scope && entry.memory.type === args.type)
              : []
          if (args.query && selected.length) {
            const target = chooseUpdateTarget(selected, args.query).target
            selected = target ? [target] : []
          }
          return selected
        },
        args.reason,
      )))).flat()
      if (!matches.length) return "No matching memories; provide id or both scope and type"
      if (!args.id && args.scope && args.type) {
        return `Deleted ${matches.length} ${args.type} memory(s) from ${args.scope}. Reason: ${args.reason}`
      }
      return `Deleted ${matches.length} memory(s): ${matches.map((entry) => entry.memory.id).join(", ")}`
    },
  })

  const exportMemories = tool({
    description: "Export project or global memories as jsonl, json, or logfmt",
    args: {
      format: tool.schema.enum(["jsonl", "json", "logfmt"]).optional().describe("Export format (default jsonl)"),
      storageScope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Storage scope (default project)"),
      includeDeletions: tool.schema.boolean().optional().describe("Include deletion audit lines for logfmt exports"),
    },
    async execute(args) {
      const scope = args.storageScope || "project"
      const entries = await readEntries(stores, scope)
      const records = entries.map((entry) => ({
        ts: entry.memory.updatedAt,
        type: entry.memory.type,
        scope: entry.memory.topic,
        content: entry.memory.content,
        id: entry.memory.id,
        title: entry.memory.title,
        createdAt: entry.memory.createdAt,
        updatedAt: entry.memory.updatedAt,
        storageScope: entry.scope,
        issue: entry.memory.issue,
        tags: entry.memory.tags,
      }))
      const format = args.format || "jsonl"
      if (format === "json") return JSON.stringify(records, null, 2)
      if (format === "logfmt") {
        const lines = entries.map((entry) => encodeMemory(entry.memory))
        if (args.includeDeletions) lines.push(...await stores[scope].readDeletionLines())
        return lines.join("\n")
      }
      return records.map((record) => JSON.stringify(record)).join("\n")
    },
  })

  const importMemories = tool({
    description: "Import memories into project or global storage from jsonl, json, or compatible logfmt",
    args: {
      data: tool.schema.string().describe("Memory data to import"),
      format: tool.schema.enum(["jsonl", "json", "logfmt"]).optional().describe("Import format (default jsonl)"),
      storageScope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Destination scope (default project)"),
    },
    async execute(args) {
      const format = args.format || "jsonl"
      const imported: Array<{ memory: Memory; scope?: StorageScope } | null> = format === "logfmt"
        ? args.data.split("\n").map((line, index) => {
            const memory = parseMemoryLine(line, `import:${index}:${crypto.randomUUID()}`)
            return memory ? { memory, scope: undefined } : null
          })
        : (format === "json" ? JSON.parse(args.data) as unknown[] : args.data.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown))
            .map(parseImportedMemory)
      let count = 0
      for (const item of imported) {
        if (!item) continue
        const scope = args.storageScope || item.scope || "project"
        await stores[scope].appendMemory(item.memory)
        count++
      }
      return `Imported ${count} memory(s)`
    },
  })

  const compact = tool({
    description: "Rewrite one scope chronologically and remove exact duplicate records",
    args: {
      storageScope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Storage scope (default project)"),
      dryRun: tool.schema.boolean().optional().describe("Report what would change without rewriting files"),
    },
    async execute(args) {
      const scope = args.storageScope || "project"
      const result = await compactStore(stores[scope], args.dryRun)
      if (args.dryRun) return `Would compact ${result.before} memories to ${result.after} unique memories (${result.duplicateCount} duplicate(s) removed)`
      return `Compacted ${result.before} memories to ${result.after} unique memories (${result.duplicateCount} duplicate(s) removed)`
    },
  })

  const context = tool({
    description: "Build a compact full-body context pack for an explicit agent request",
    args: {
      query: tool.schema.string().optional().describe("Task text to match against memories"),
      scope: tool.schema.string().optional().describe("Optional legacy topic filter"),
      storageScope: tool.schema.enum(STORAGE_SCOPES).optional().describe("Storage scope (default project)"),
      tags: tool.schema.array(tool.schema.string()).optional().describe("Only include memories with all tags"),
      types: tool.schema.array(tool.schema.enum(MEMORY_TYPES)).optional().describe("Only include these memory types"),
      limit: tool.schema.number().optional().describe("Maximum memories to include (default 5)"),
      maxChars: tool.schema.number().optional().describe("Maximum characters in the context pack"),
      minScore: tool.schema.number().optional().describe("Minimum query relevance score"),
    },
    async execute(args) {
      const pack = buildContextPack(await readEntries(stores, args.storageScope || "project"), args)
      return pack || "No relevant memories"
    },
  })

  return {
    memory_remember: remember,
    memory_write: write,
    memory_read: read,
    memory_recall: recall,
    memory_update: update,
    memory_forget: forget,
    memory_list: listMemories,
    memory_export: exportMemories,
    memory_import: importMemories,
    memory_compact: compact,
    memory_context: context,
  }
}

export const createMemoryPlugin = (
  resolveGlobalDirectory: () => string = defaultGlobalMemoryDirectory,
): Plugin => async (input, rawOptions) => {
  const options = rawOptions as PluginOptions | undefined
  const stores = createStores(join(input.directory, ".opencode", "memory"), resolveGlobalDirectory())
  const autoLoad = options?.autoLoad ?? false
  const autoSave = options?.autoSave ?? false
  const autoHookTimeoutMs = options?.autoHookTimeoutMs && options.autoHookTimeoutMs > 0 ? options.autoHookTimeoutMs : 100
  let latestPrompt: string | undefined

  return {
    tool: createTools(stores),
    http: { fetch: createFetchHandler(stores) },
    "chat.message": async (_input, output) => {
      const text = textFromParts(output.parts)
      if (!text) return
      latestPrompt = text
      if (!autoSave) return
      await withTimeout((async () => {
        const memory = inferExplicitMemory(text, options?.autoSaveScope || "user")
        if (memory) await stores.project.appendMemory(memory)
      })(), autoHookTimeoutMs)
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (!autoLoad || !latestPrompt) return
      const pack = await withTimeout((async () => buildMemoryIndex(await readEntries(stores), {
        query: latestPrompt,
        limit: options?.contextLimit,
        maxChars: options?.contextMaxChars,
        minScore: options?.contextMinScore,
      }))(), autoHookTimeoutMs)
      if (pack) output.system.push(`${pack}\n\nUse memory_read to retrieve a full body. Do not mention this block unless asked.`)
    },
  }
}

export const MemoryPlugin = createMemoryPlugin()

export default MemoryPlugin
