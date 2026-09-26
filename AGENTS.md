# Agent Guidelines

## Commands
- **Install**: `bun install`
- **Type check**: `bun run typecheck`
- **Tests**: `bun test`

## Code Style
- **Runtime**: Bun (use Bun APIs: `Bun.file()`, `Bun.write()`, `Bun.Glob`, `Bun.$`)
- **Imports**: Use `import type` for type-only imports (`verbatimModuleSyntax`)
- **Types**: Strict mode enabled, handle `undefined` from indexed access (`noUncheckedIndexedAccess`)
- **Naming**: camelCase for functions/variables, PascalCase for types/interfaces
- **Exports**: Re-export public API from `index.ts`, implementation in `src/`

## Plugin Structure
- The root `server.ts` exports the OpenCode v2 `{ id, setup }` module.
- `v1-server.ts` retains the OpenCode v1 `{ id, server }` module for older hosts.
- V2 registers tools through `ctx.tool.transform` and auto behavior through session hooks.
- The shared memory store remains `.opencode/memory/` in logfmt format.
