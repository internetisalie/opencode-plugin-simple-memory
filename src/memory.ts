import { createHash } from "node:crypto"
import { appendFile, mkdir, open, realpath, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export const MEMORY_TYPES = ["decision", "learning", "preference", "blocker", "context", "pattern"] as const
export const STORAGE_SCOPES = ["global", "project"] as const

export type MemoryType = typeof MEMORY_TYPES[number]
export type StorageScope = typeof STORAGE_SCOPES[number]

export interface Memory {
  id: string
  title: string
  type: MemoryType
  topic: string
  content: string
  createdAt: string
  updatedAt: string
  issue?: string
  tags?: string[]
}

export interface MemoryRecord extends Memory {
  scope: StorageScope
}

export interface MemoryEntry {
  memory: Memory
  scope: StorageScope
  filepath: string
  lineIndex: number
}

export interface MemoryStoreTransaction {
  appendMemory(memory: Memory): Promise<void>
  appendDeletion(memory: Memory, reason: string): Promise<void>
  readEntries(): Promise<MemoryEntry[]>
  readDeletionLines(): Promise<string[]>
  rewriteFile(filepath: string, lines: string[]): Promise<void>
  replaceFiles(files: Map<string, string[]>, obsolete: Set<string>): Promise<void>
}

export interface MemoryStore extends MemoryStoreTransaction {
  scope: StorageScope
  dir: string
  ensureDir(): Promise<void>
  transaction<T>(operation: (store: MemoryStoreTransaction) => Promise<T>): Promise<T>
}

export type MemoryStores = Record<StorageScope, MemoryStore>

const storeQueues = new Map<string, Promise<void>>()
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

export const isMemoryType = (value: unknown): value is MemoryType =>
  typeof value === "string" && MEMORY_TYPES.includes(value as MemoryType)

export const isStorageScope = (value: unknown): value is StorageScope =>
  typeof value === "string" && STORAGE_SCOPES.includes(value as StorageScope)

export const isMemoryId = (value: string) => /^mem_[0-9a-f]{20}$|^mem_[0-9a-f-]{36}$/i.test(value)

export const createMemoryId = () => `mem_${crypto.randomUUID()}`

export const defaultTitle = (content: string) => {
  const normalized = content.replace(/\s+/g, " ").trim()
  if (!normalized) return "Untitled memory"
  if (normalized.length <= 80) return normalized
  return `${normalized.slice(0, 77).trimEnd()}...`
}

const validDateParts = (year: string, month: string, day: string) => {
  const value = new Date(`${year}-${month}-${day}T00:00:00.000Z`)
  return !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === `${year}-${month}-${day}`
}

export const normalizeTimestamp = (value: string): string | null => {
  const date = DATE.exec(value)
  if (date) return validDateParts(date[1]!, date[2]!, date[3]!) ? `${value}T00:00:00.000Z` : null
  const timestamp = ISO_TIMESTAMP.exec(value)
  if (!timestamp || !validDateParts(timestamp[1]!, timestamp[2]!, timestamp[3]!)) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

export const dateFromTimestamp = (timestamp: string) => {
  const normalized = normalizeTimestamp(timestamp)
  if (!normalized) throw new TypeError(`Invalid memory timestamp: ${timestamp}`)
  return normalized.slice(0, 10)
}

const escapeValue = (value: string) => value
  .replace(/\\/g, "\\\\")
  .replace(/\n/g, "\\n")
  .replace(/\r/g, "\\r")
  .replace(/"/g, '\\"')

const unescapeValue = (value: string) => {
  let result = ""
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char !== "\\") {
      result += char
      continue
    }

    const next = value[++i]
    if (next === "n") result += "\n"
    else if (next === "r") result += "\r"
    else if (next === '"') result += '"'
    else if (next === "\\") result += "\\"
    else if (next !== undefined) result += `\\${next}`
  }
  return result
}

const field = (key: string, value: string, alwaysQuote = false) => {
  if (!alwaysQuote && value !== "" && !/\s|"|\\/.test(value)) return `${key}=${value}`
  return `${key}="${escapeValue(value)}"`
}

export const parseFields = (line: string): Record<string, string> => {
  const fields: Record<string, string> = {}
  let index = 0

  while (index < line.length) {
    while (line[index] === " ") index++
    const keyStart = index
    while (index < line.length && line[index] !== "=" && line[index] !== " ") index++
    const key = line.slice(keyStart, index)
    if (!key || line[index] !== "=") break
    index++

    if (line[index] === '"') {
      index++
      let value = ""
      while (index < line.length) {
        const char = line[index]
        if (char === '"') {
          index++
          break
        }
        if (char === "\\" && index + 1 < line.length) {
          value += char + line[index + 1]
          index += 2
          continue
        }
        value += char
        index++
      }
      fields[key] = unescapeValue(value)
      continue
    }

    const valueStart = index
    while (index < line.length && line[index] !== " ") index++
    fields[key] = line.slice(valueStart, index)
  }

  return fields
}

const legacyId = (memory: Omit<Memory, "id" | "title">, location?: string) => {
  const canonical = [
    memory.createdAt,
    memory.updatedAt,
    memory.type,
    memory.topic,
    memory.content,
    memory.issue || "",
    memory.tags?.join(",") || "",
    location || "",
  ].join("\0")
  return `mem_${createHash("sha256").update(canonical).digest("hex").slice(0, 20)}`
}

export const parseMemoryLine = (line: string, location?: string): Memory | null => {
  const fields = parseFields(line)
  if (fields.action === "deleted") return null
  const content = fields.content ?? fields.text
  const timestamp = fields.created_at ?? fields.createdAt ?? fields.ts ?? fields.date
  if (content === undefined || !timestamp) return null

  const createdAt = normalizeTimestamp(timestamp)
  const updatedAt = normalizeTimestamp(fields.updated_at ?? fields.updatedAt ?? fields.ts ?? timestamp)
  if (!createdAt || !updatedAt) return null
  const base = {
    type: fields.type && isMemoryType(fields.type) ? fields.type : "context" as MemoryType,
    topic: fields.topic ?? fields.scope ?? "legacy",
    content,
    createdAt,
    updatedAt,
    issue: fields.issue,
    tags: fields.tags ? fields.tags.split(",").filter(Boolean) : undefined,
  }

  return {
    ...base,
    id: fields.id && isMemoryId(fields.id) ? fields.id : legacyId(base, location),
    title: fields.title?.trim() || defaultTitle(content),
  }
}

export const encodeMemory = (memory: Memory): string => {
  const parts = [
    field("id", memory.id),
    field("title", memory.title, true),
    field("created_at", memory.createdAt),
    field("updated_at", memory.updatedAt),
    field("ts", memory.updatedAt),
    field("type", memory.type),
    field("scope", memory.topic),
    field("content", memory.content, true),
  ]
  if (memory.issue) parts.push(field("issue", memory.issue))
  if (memory.tags?.length) parts.push(field("tags", memory.tags.join(",")))
  return parts.join(" ")
}

const encodeDeletion = (memory: Memory, scope: StorageScope, reason: string): string => {
  const parts = [
    field("ts", new Date().toISOString()),
    field("action", "deleted"),
    field("id", memory.id),
    field("title", memory.title, true),
    field("original_ts", memory.updatedAt),
    field("type", memory.type),
    field("scope", memory.topic),
    field("storage_scope", scope),
    field("content", memory.content, true),
    field("reason", reason, true),
  ]
  if (memory.issue) parts.push(field("issue", memory.issue))
  if (memory.tags?.length) parts.push(field("tags", memory.tags.join(",")))
  return parts.join(" ")
}

const serializeLines = (lines: string[]) => {
  const text = lines.join("\n")
  if (!text) return ""
  return text.endsWith("\n") ? text : `${text}\n`
}

const prepareFile = async (filepath: string, lines: string[]) => {
  await mkdir(dirname(filepath), { recursive: true })
  const temporary = `${filepath}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, serializeLines(lines))
  const handle = await open(temporary, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  return temporary
}

const atomicRewrite = async (filepath: string, lines: string[]) => {
  const temporary = await prepareFile(filepath, lines)
  try {
    await rename(temporary, filepath)
  } finally {
    await rm(temporary, { force: true })
  }
}

const enqueue = async <T>(directory: string, operation: () => Promise<T>): Promise<T> => {
  await mkdir(directory, { recursive: true })
  const key = await realpath(directory)
  const previous = storeQueues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const settled = result.then(() => undefined, () => undefined)
  storeQueues.set(key, settled)
  try {
    return await result
  } finally {
    if (storeQueues.get(key) === settled) storeQueues.delete(key)
  }
}

const createTransaction = (scope: StorageScope, dir: string): MemoryStoreTransaction => ({
  async appendMemory(memory) {
    await appendFile(join(dir, `${dateFromTimestamp(memory.createdAt)}.logfmt`), `${encodeMemory(memory)}\n`, "utf8")
  },
  async appendDeletion(memory, reason) {
    await appendFile(join(dir, "deletions.logfmt"), `${encodeDeletion(memory, scope, reason)}\n`, "utf8")
  },
  async readEntries() {
    const files = (await Array.fromAsync(new Bun.Glob("*.logfmt").scan(dir)))
      .filter((filename) => filename !== "deletions.logfmt")
      .sort()
    const entries: MemoryEntry[] = []
    for (const filename of files) {
      const filepath = join(dir, filename)
      const lines = (await Bun.file(filepath).text()).split("\n")
      lines.forEach((line, lineIndex) => {
        const memory = parseMemoryLine(line, `${filename}:${lineIndex}`)
        if (memory) entries.push({ memory, scope, filepath, lineIndex })
      })
    }
    return entries.sort((a, b) => a.memory.createdAt.localeCompare(b.memory.createdAt))
  },
  async readDeletionLines() {
    const file = Bun.file(join(dir, "deletions.logfmt"))
    if (!(await file.exists())) return []
    return (await file.text()).trim().split("\n").filter(Boolean)
  },
  async rewriteFile(filepath, lines) {
    await atomicRewrite(filepath, lines)
  },
  async replaceFiles(files, obsolete) {
    const prepared = new Map<string, string>()
    try {
      for (const [filepath, lines] of files) prepared.set(filepath, await prepareFile(filepath, lines))
      for (const [filepath, temporary] of prepared) {
        await rename(temporary, filepath)
        prepared.delete(filepath)
      }
      for (const filepath of obsolete) {
        if (!files.has(filepath)) await rm(filepath, { force: true })
      }
    } finally {
      await Promise.all([...prepared.values()].map((filepath) => rm(filepath, { force: true })))
    }
  },
})

export const createStore = (scope: StorageScope, directory: string): MemoryStore => {
  const dir = resolve(directory)
  const raw = createTransaction(scope, dir)
  const transaction = <T>(operation: (store: MemoryStoreTransaction) => Promise<T>) => enqueue(dir, () => operation(raw))
  return {
    scope,
    dir,
    ensureDir: () => mkdir(dir, { recursive: true }).then(() => undefined),
    transaction,
    appendMemory: (memory) => transaction((store) => store.appendMemory(memory)),
    appendDeletion: (memory, reason) => transaction((store) => store.appendDeletion(memory, reason)),
    readEntries: () => transaction((store) => store.readEntries()),
    readDeletionLines: () => transaction((store) => store.readDeletionLines()),
    rewriteFile: (filepath, lines) => transaction((store) => store.rewriteFile(filepath, lines)),
    replaceFiles: (files, obsolete) => transaction((store) => store.replaceFiles(files, obsolete)),
  }
}

export const createStores = (projectDir: string, globalDir: string): MemoryStores => ({
  project: createStore("project", projectDir),
  global: createStore("global", globalDir),
})

export const readEntries = async (stores: MemoryStores, scope?: StorageScope) => {
  if (scope) return stores[scope].readEntries()
  const entries = await Promise.all(STORAGE_SCOPES.map((item) => stores[item].readEntries()))
  return entries.flat().sort((a, b) => a.memory.createdAt.localeCompare(b.memory.createdAt))
}

export const toRecord = (entry: MemoryEntry): MemoryRecord => ({ ...entry.memory, scope: entry.scope })

const rewriteEntry = async (store: MemoryStoreTransaction, entry: MemoryEntry, memory: Memory, reason: string) => {
  await store.appendDeletion(entry.memory, reason)
  const lines = (await Bun.file(entry.filepath).text()).split("\n")
  lines[entry.lineIndex] = encodeMemory(memory)
  await store.rewriteFile(entry.filepath, lines)
}

const deleteEntries = async (store: MemoryStoreTransaction, entries: MemoryEntry[], reason: string) => {
  const byFile = new Map<string, Set<number>>()
  for (const entry of entries) {
    const indexes = byFile.get(entry.filepath) ?? new Set<number>()
    indexes.add(entry.lineIndex)
    byFile.set(entry.filepath, indexes)
  }
  for (const entry of entries) await store.appendDeletion(entry.memory, reason)
  for (const [filepath, indexes] of byFile) {
    const lines = (await Bun.file(filepath).text()).split("\n")
    for (const index of indexes) lines[index] = ""
    await store.rewriteFile(filepath, lines)
  }
}

export const updateSelectedEntry = (
  store: MemoryStore,
  select: (entries: MemoryEntry[]) => MemoryEntry | undefined,
  update: (memory: Memory) => Memory,
  reason: string,
) => store.transaction(async (transaction) => {
  const entry = select(await transaction.readEntries())
  if (!entry) return undefined
  const memory = update(entry.memory)
  await rewriteEntry(transaction, entry, memory, reason)
  return { ...entry, memory }
})

export const deleteSelectedEntries = (
  store: MemoryStore,
  select: (entries: MemoryEntry[]) => MemoryEntry[],
  reason: string,
) => store.transaction(async (transaction) => {
  const entries = select(await transaction.readEntries())
  if (entries.length) await deleteEntries(transaction, entries, reason)
  return entries
})

export const compactStore = (store: MemoryStore, dryRun = false) => store.transaction(async (transaction) => {
  const entries = await transaction.readEntries()
  const unique = new Map<string, Memory>()
  for (const entry of entries) {
    const key = encodeMemory(entry.memory)
    if (!unique.has(key)) unique.set(key, entry.memory)
  }
  const duplicateCount = entries.length - unique.size
  if (dryRun) return { before: entries.length, after: unique.size, duplicateCount }

  const files = new Map<string, string[]>()
  for (const memory of [...unique.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const filepath = join(store.dir, `${dateFromTimestamp(memory.createdAt)}.logfmt`)
    const lines = files.get(filepath) ?? []
    lines.push(encodeMemory(memory))
    files.set(filepath, lines)
  }
  await transaction.replaceFiles(files, new Set(entries.map((entry) => entry.filepath)))
  return { before: entries.length, after: unique.size, duplicateCount }
})

export const newMemory = (input: {
  title?: string
  type: MemoryType
  topic?: string
  content: string
  issue?: string
  tags?: string[]
}): Memory => {
  const timestamp = new Date().toISOString()
  return {
    id: createMemoryId(),
    title: input.title?.trim() || defaultTitle(input.content),
    type: input.type,
    topic: input.topic?.trim() || "general",
    content: input.content,
    createdAt: timestamp,
    updatedAt: timestamp,
    issue: input.issue?.trim() || undefined,
    tags: input.tags?.map((tag) => tag.trim()).filter(Boolean),
  }
}
