/**
 * Public re-export of the tool executor adapter in src/loops/assemble.ts
 * (`ToolExecutorAdapter`) and the tool view port types. Part of the CLI's
 * `host-kit` construction kit (S34 exports-gap decision).
 *
 * @module host-public/tool-executor-adapter
 */
export {
  type PluginToolView,
  ToolExecutorAdapter,
  type ToolExecutorAdapterDeps,
  type ToolViewEvent,
  type ToolViewOutcome,
  type ToolViewPort,
} from "../loops/assemble.ts"
