/**
 * AbortBus — single-source-of-truth for cancelling the currently in-flight
 * agent turn.
 *
 * Lifecycle:
 *   1. The host calls {@link AbortBus.beginTurn} immediately before starting
 *      a turn. It receives a fresh {@link AbortController} and stores its
 *      signal on whatever async work the turn drives.
 *   2. Anyone (key handler, signal handler, timeout, programmatic caller)
 *      may invoke {@link AbortBus.requestAbort} with a structured reason.
 *      The first call aborts the controller and emits a single "abort"
 *      event with the reason. Subsequent calls are no-ops until the next
 *      turn begins.
 *   3. The host calls {@link AbortBus.endTurn} after the turn settles
 *      (success, error, or aborted). It is idempotent.
 */

import { EventEmitter } from "node:events";

export type AbortReason =
	| { kind: "user-key"; key: "Esc" | "Ctrl+C" }
	| { kind: "signal"; signal: NodeJS.Signals }
	| { kind: "programmatic"; tag: string }
	| { kind: "timeout"; ms: number };

export class AbortBus extends EventEmitter {
	private controller: AbortController | null = null;
	private aborted = false;

	beginTurn(): AbortController {
		this.controller = new AbortController();
		this.aborted = false;
		return this.controller;
	}

	endTurn(): void {
		this.controller = null;
		this.aborted = false;
	}

	requestAbort(reason: AbortReason): boolean {
		if (!this.controller || this.aborted) return false;
		this.aborted = true;
		this.controller.abort();
		this.emit("abort", reason);
		return true;
	}

	isTurnInFlight(): boolean {
		return this.controller !== null && !this.aborted;
	}
}

export const abortBus: AbortBus = new AbortBus();
