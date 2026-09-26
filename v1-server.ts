import type { PluginModule } from "@opencode-ai/plugin"
import { MemoryPlugin } from "./src/index"

const plugin: PluginModule = {
  id: "opencode-simple-memory",
  server: MemoryPlugin,
}

export default plugin
