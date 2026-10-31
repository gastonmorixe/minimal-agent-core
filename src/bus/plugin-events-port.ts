/**
 * The `pluginEvents` port (spec S28): where per-run, bus-shaped telemetry
 * (today: streamed-output token progress) goes. The host passes one per
 * run; engine code never reads a global plugin-bus pointer. With no port,
 * a send is simply silent on this channel.
 *
 * @module bus/plugin-events-port
 */

/** A named-channel event sink, the shape the legacy plugin bus used. */
export interface PluginEventsPort {
  emit(event: string, payload?: unknown): void
}

/** A `pluginEvents` port that goes nowhere. */
export const NOOP_PLUGIN_EVENTS: PluginEventsPort = { emit: () => {} }
