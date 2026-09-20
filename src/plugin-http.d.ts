// @opencode-ai/plugin@1.18.31 does not yet publish the custom HTTP hook.
import type {} from "@opencode-ai/plugin"

declare module "@opencode-ai/plugin" {
  interface PluginHttpHandler {
    readonly fetch: (request: Request) => Response | Promise<Response>
  }

  interface Hooks {
    http?: PluginHttpHandler
  }
}
