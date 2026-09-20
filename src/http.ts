import {
  deleteSelectedEntries,
  isMemoryId,
  isMemoryType,
  isStorageScope,
  readEntries,
  toRecord,
  updateSelectedEntry,
  type MemoryStores,
  type StorageScope,
} from "./memory"

const MAX_BODY_BYTES = 64 * 1024
const MEMORY_PATH = /^\/memories\/([^/]+)$/

const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
})

const error = (message: string, status: number) => json({ error: message }, status)

const methodNotAllowed = (allow: string[]) => json({ error: "Method not allowed" }, 405, { allow: allow.join(", ") })

const validateQuery = (url: URL, allowed: string[]): Response | undefined => {
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) return error("Invalid query parameter", 400)
  if (url.searchParams.getAll("directory").length > 1) return error("directory may be provided once", 400)
}

const queryScope = (url: URL, allowed: string[]): StorageScope | Response => {
  const invalid = validateQuery(url, allowed)
  if (invalid) return invalid
  if (url.searchParams.getAll("scope").length !== 1 || !isStorageScope(url.searchParams.get("scope"))) {
    return error("scope must be global or project", 400)
  }
  return url.searchParams.get("scope") as StorageScope
}

const decodeId = (value: string): string | Response => {
  let id: string
  try {
    id = decodeURIComponent(value)
  } catch {
    return error("Invalid memory id", 400)
  }
  if (!isMemoryId(id)) return error("Invalid memory id", 400)
  return id
}

const parsePatch = async (request: Request): Promise<{
  scope: StorageScope
  title?: string
  type?: string
  content?: string
} | Response> => {
  const length = Number(request.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return error("Request body too large", 413)
  const contentType = request.headers.get("content-type")?.toLowerCase()
  if (contentType && !contentType.startsWith("application/json") && !contentType.startsWith("text/plain")) {
    return error("Content-Type must contain JSON text", 415)
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return error("Request body too large", 413)

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return error("Invalid JSON body", 400)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return error("Body must be a JSON object", 400)

  const value = body as Record<string, unknown>
  const keys = Object.keys(value)
  if (keys.some((key) => !["scope", "title", "type", "content"].includes(key))) return error("Unknown body field", 400)
  if (!isStorageScope(value.scope)) return error("scope must be global or project", 400)
  if (!keys.some((key) => key !== "scope")) return error("At least one update field is required", 400)
  if (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200)) {
    return error("title must be a non-empty string of at most 200 characters", 400)
  }
  if (value.type !== undefined && !isMemoryType(value.type)) return error("Invalid memory type", 400)
  if (value.content !== undefined && (typeof value.content !== "string" || !value.content.trim())) {
    return error("content must be a non-empty string", 400)
  }

  return {
    scope: value.scope,
    title: value.title as string | undefined,
    type: value.type as string | undefined,
    content: value.content as string | undefined,
  }
}

export const createFetchHandler = (stores: MemoryStores) => async (request: Request): Promise<Response> => {
  const url = new URL(request.url)

  if (url.pathname === "/memories") {
    if (request.method !== "GET") return methodNotAllowed(["GET"])
    const scope = queryScope(url, ["scope", "q", "directory"])
    if (scope instanceof Response) return scope
    if (url.searchParams.getAll("q").length > 1) return error("q may be provided once", 400)
    const query = url.searchParams.get("q")?.trim().toLowerCase()
    if (query !== undefined && !query) return error("q must not be empty", 400)
    if (query && query.length > 500) return error("q is too long", 400)

    const records = (await readEntries(stores, scope))
      .filter((entry) => !query || [
        entry.memory.id,
        entry.memory.title,
        entry.memory.type,
        entry.memory.topic,
        entry.memory.content,
        entry.memory.tags?.join(" ") || "",
      ].join(" ").toLowerCase().includes(query))
      .map(toRecord)
    return json({ memories: records })
  }

  const match = MEMORY_PATH.exec(url.pathname)
  if (!match) return error("Not found", 404)
  if (request.method !== "PATCH" && request.method !== "DELETE") return methodNotAllowed(["PATCH", "DELETE"])

  const id = decodeId(match[1]!)
  if (id instanceof Response) return id

  if (request.method === "DELETE") {
    const scope = queryScope(url, ["scope", "directory"])
    if (scope instanceof Response) return scope
    const entries = await deleteSelectedEntries(
      stores[scope],
      (items) => items.filter((item) => item.memory.id === id).slice(0, 1),
      "Deleted through HTTP API",
    )
    if (!entries.length) return error("Memory not found", 404)
    return json({ success: true, id, scope })
  }

  const invalid = validateQuery(url, ["directory"])
  if (invalid) return invalid
  const patch = await parsePatch(request)
  if (patch instanceof Response) return patch
  const entry = await updateSelectedEntry(
    stores[patch.scope],
    (items) => items.find((item) => item.memory.id === id),
    (memory) => ({
      ...memory,
      title: patch.title?.trim() ?? memory.title,
      type: isMemoryType(patch.type) ? patch.type : memory.type,
      content: patch.content ?? memory.content,
      updatedAt: new Date().toISOString(),
    }),
    "Updated through HTTP API",
  )
  if (!entry) return error("Memory not found", 404)
  return json({ memory: toRecord(entry) })
}
