# Example AGENTS.md Using Simple Memory Plugin

This is an example `AGENTS.md` file showing how to configure agent guidelines for a project using the simple-memory plugin.

---

# Agent Guidelines for my-project

## Memory Usage (CRITICAL)

**One line, detailed** - Keep each memory on a single line to avoid git conflicts. Be detailed but concise. Include file references where applicable (e.g., "See: path/to/file.py").

- A compact memory index (ID, title, type, and storage scope) is injected automatically; use `memory_read()` for a full body
- Explicit "remember ..." requests are saved automatically by the plugin
- Use `memory_recall()` manually when you need a broader memory search
- **NEVER** use `memory_remember()` automatically for arbitrary conversation content
- If user asks to remember: store as patterns, decisions, learnings, preferences, blockers, or context
- If new info contradicts existing memory: ask user before using `memory_forget()` + `memory_remember()`
- During a session, if the user repeatedly corrects behavior, repeats preferences, or you notice recurring project patterns, prompt them to remember the specific reusable fact
- **End of session**: If significant patterns, decisions, or learnings were discovered, ask user: "Would you like me to remember [specific thing]?"

**Use memory_recall freely. NEVER memory_remember automatically.**

### Memory Types

| Type | Use For | Example |
|------|---------|---------|
| decision | Architecture/design choices | "Using Drizzle ORM over Prisma for type safety. See: src/db/schema.ts" |
| learning | Codebase discoveries | "Auth tokens stored in httpOnly cookies, not localStorage. See: src/auth/session.ts" |
| preference | User/project preferences | "User prefers functional components over class components" |
| blocker | Known issues | "Websocket reconnection fails on Safari - tracking in issue #42" |
| context | Feature/system info | "Payment integration uses Stripe in test mode. API keys in .env.local" |
| pattern | Code patterns | "All API routes follow /api/v1/[resource]/[action] pattern. See: src/routes/" |

### Memory Scopes

Use scopes to organize memories logically:

| Scope | Use For |
|-------|---------|
| `project` | Project-wide decisions and patterns |
| `user` | User-specific preferences |
| `auth` | Authentication/authorization context |
| `api` | API design decisions |
| `database` | Database schema and query patterns |
| `testing` | Testing strategies and known issues |
| `deployment` | Deployment and infrastructure notes |

### Example Memory Workflow

```
# At session start - always recall first
memory_recall()                           # Get all memories
memory_recall(scope="project")            # Get project-specific memories
memory_recall(type="blocker")             # Check for known blockers

# When user explicitly asks to remember
User: "Remember that we decided to use Redis for session storage"
memory_remember(
  type="decision",
  scope="project",
  content="Using Redis for session storage instead of database sessions. Config in src/lib/redis.ts"
)

# When updating existing memory
User: "Actually we switched from Redis to database sessions"
memory_update(
  type="decision",
  scope="project",
  content="Using database sessions (switched from Redis). See: src/lib/session.ts"
)

# When removing outdated memory
memory_forget(
  type="blocker",
  scope="testing",
  reason="Issue #42 was fixed in PR #58"
)

# Discovering all stored context
memory_list()  # Returns all scopes and types in use
```

## Commands

- **Install**: `bun install`
- **Test**: `bun test`
- **Type check**: `bun run typecheck`

## Code Style

- DO NOT use unnecessary destructuring
- DO NOT use else statements unless necessary
- AVOID try/catch where possible
- AVOID using `any` type
- AVOID `let` statements - prefer `const`
- PREFER single word variable names where possible
- Keep functions focused - one function = one job

## Tool Calling

**ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE**.

When multiple independent operations are needed, batch them together:

```
# Good - parallel reads
Read file1.ts, file2.ts, file3.ts in parallel

# Good - parallel memory operations
memory_recall(scope="auth") + memory_recall(scope="api") in parallel

# Bad - sequential when parallel is possible
Read file1.ts
Read file2.ts
Read file3.ts
```
