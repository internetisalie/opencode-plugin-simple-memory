# Simple Memory Plugin for OpenCode

A durable memory plugin for [OpenCode](https://opencode.ai) with separate global and project stores, stable record IDs, agent tools, and an authenticated-host HTTP interface.

This repository is the `internetisalie/opencode-plugin-simple-memory` fork. Its package is published as `@internetisalie/opencode-plugin-simple-memory`.

## Setup

This package is published through GitHub Packages. Configure the `@internetisalie` scope and authenticate with a token that can read packages:

```ini
@internetisalie:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The root package targets OpenCode v2.0.18. Configure it with the v2 `plugins` field:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@internetisalie/opencode-plugin-simple-memory"]
}
```

The module retains the stable ID `opencode-simple-memory`. OpenCode v1 hosts can load the `/v1/server` subpath. The older callable plugin remains available for direct imports:

```ts
import MemoryPlugin from "@internetisalie/opencode-plugin-simple-memory/legacy"
```

The root package entry point now uses the v2 `{ id, setup }` contract. Use `/v1/server` only with the custom v1 host.

## Storage

- Project memories: `<ctx.location.directory>/.opencode/memory/*.logfmt`
- Global memories: `~/.config/opencode/simple-memory/*.logfmt`

Project storage is always derived from the directory captured when the plugin instance starts. Neither the HTTP API nor a tool accepts a project filesystem path.

Each full record contains:

```json
{
  "id": "mem_2d82f71e-9bd8-45ed-a494-889b97e3063d",
  "title": "Use Redis for sessions",
  "type": "decision",
  "scope": "project",
  "topic": "general",
  "content": "Use Redis for session storage.",
  "createdAt": "2026-09-20T12:00:00.000Z",
  "updatedAt": "2026-09-20T12:00:00.000Z"
}
```

`scope` is the storage scope (`global` or `project`). `topic` preserves the older free-form `scope` concept used by legacy tools and logfmt records.

## Tools

Tools remain agent-only. In particular, the HTTP API has no create endpoint.

| Tool | Description |
|------|-------------|
| `memory_write` | Create a titled memory in `global` or `project` storage |
| `memory_read` | Read one full record by stable ID, optionally restricted to a storage scope |
| `memory_remember` | Legacy-compatible create call using free-form topic `scope`; defaults to project storage |
| `memory_recall` | Retrieve full project records with legacy topic, type, date, tag, and query filters |
| `memory_update` | Update by stable ID or legacy topic/type selection |
| `memory_forget` | Delete by stable ID across stores or by legacy topic/type selection |
| `memory_list` | List compact `id`, title, type, and storage-scope indexes across both stores |
| `memory_export` | Export one store as `jsonl`, `json`, or logfmt |
| `memory_import` | Import compatible data into one store |
| `memory_compact` | Remove exact duplicates and rewrite one store chronologically |
| `memory_context` | Explicitly build a compact full-body context pack |

Legacy calls continue to work:

```text
memory_remember(type="decision", scope="auth", content="Use passkeys")
memory_recall(scope="auth", match="exact")
memory_forget(type="decision", scope="auth", reason="Superseded")
```

The durable interface uses stable IDs and storage scopes:

```text
memory_write(scope="global", title="Preferred diffs", type="preference", content="Keep diffs minimal")
memory_read(id="mem_...", scope="global")
memory_forget(id="mem_...", storageScope="global", reason="No longer applies")
```

Memory types are `decision`, `learning`, `preference`, `blocker`, `context`, and `pattern`.

## HTTP API

On a v2 host with plugin HTTP routing, the host authenticates and strips `/api/plugins/opencode-simple-memory` before calling the plugin handler. The handler still validates every method, path, query, ID, and body itself. Stock v2 hosts without plugin HTTP routing can run the tools, but do not expose this API. All responses are JSON with `content-type: application/json`.

### List And Search

```http
GET /memories?scope=global|project&q=optional
```

Returns `{ "memories": [...] }` containing full records. `scope` is required. `q` searches ID, title, type, topic, content, and tags.

### Update

```http
PATCH /memories/:id
Content-Type: application/json

{"scope":"project","title":"New title","type":"decision","content":"New body"}
```

`scope` is required and identifies the store. At least one of `title`, `type`, or `content` is required. Unknown fields, invalid types, empty values, and bodies over 64 KiB are rejected. The stable ID and creation timestamp do not change.

The custom SDK may forward the same JSON body as `text/plain`; the handler accepts both content types. A forwarded `directory` query parameter is ignored, and cannot override the project directory captured by the plugin instance. Successful updates return `{ "memory": { ... } }`.

### Delete

```http
DELETE /memories/:id?scope=global|project
```

Returns `{ "success": true, "id": "...", "scope": "..." }`. Updates and deletions append audit records to that store's `deletions.logfmt`.

Unknown routes return `404`; unsupported methods on known routes return `405` with an `Allow` header.

## Automatic Context

Automatic loading and saving are disabled by default. Enable them with a v2 plugin options entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@internetisalie/opencode-plugin-simple-memory",
      "options": {
        "autoLoad": true,
        "autoSave": true,
        "autoHookTimeoutMs": 100,
        "contextLimit": 5,
        "contextMaxChars": 1200,
        "contextMinScore": 1,
        "autoSaveScope": "user"
      }
    }
  ]
}
```

When `autoLoad` is enabled, the system hook searches both stores but injects only an index:

```text
Relevant Memory Index:
- id=mem_... title="Staging restart" type=pattern scope=project
```

Memory bodies are never inserted automatically. The agent must explicitly use `memory_read`, `memory_recall`, `memory_context`, or the HTTP GET endpoint to retrieve them.

When `autoSave` is enabled, only explicit requests such as `remember that I prefer minimal diffs` are stored. Auto-saved records use the complete durable model, default to project storage, and keep the configured legacy topic (default `user`).

## Logfmt Compatibility

New records extend the existing one-record-per-line format:

```logfmt
id=mem_... title="Use Redis" created_at=2026-09-20T12:00:00.000Z updated_at=2026-09-20T12:00:00.000Z ts=2026-09-20T12:00:00.000Z type=decision scope=auth content="Use Redis for sessions"
```

Compatibility behavior:

- Existing `ts`, `type`, `scope`, and `content` records remain readable.
- Older `date` and `text` records remain readable.
- Legacy records receive deterministic location-derived IDs, content-derived titles, default type `context` when absent, and timestamps without requiring a rewrite. Exact duplicate lines remain independently addressable.
- Existing multiline escaping and raw-backslash behavior remain supported.
- New writes retain `ts`, `type`, `scope`, and `content` fields for older logfmt readers.
- Imports accept real `YYYY-MM-DD` dates and ISO-like timestamps only; invalid timestamps are skipped before a filename is derived.
- `action=deleted` audit lines are never imported as active memories.
- In-process reads and mutations are serialized per canonical store directory, including across plugin instances sharing global storage.
- No startup migration or destructive rewrite is performed.

## Local Development

```bash
bun install
bun test
bun run typecheck
```

There is no separate build step; the package publishes its TypeScript entrypoints directly.
