/**
 * SpinnerManager — owns a single mounted {@link Spinner} at a time, drives
 * the render loop, and negotiates handoffs between spinners with a per-swap
 * grace window.
 *
 * Lifecycle hooks (`willShow`/`didShow`/`willDisappear`/`didDisappear`) and
 * change notifications (`onThemeChange`/`onNotificationChange`) are
 * dispatched here, never inside the individual spinner classes.
 *
 * @module spinner/manager
 */

import type { Spinner, SpinnerNotification, SpinnerRenderFrame } from "./types.ts"

export interface SpinnerManagerOptions<TTheme> {
  spinner: Spinner<TTheme>
  theme: TTheme
  notification?: SpinnerNotification
  now?: () => number
  maxSwitchGraceMs?: number
}

function normalizeNotification(notification?: SpinnerNotification): SpinnerNotification {
  return {
    notificationId: notification?.notificationId,
    category: notification?.category,
  }
}

function sameNotification(a: SpinnerNotification, b: SpinnerNotification): boolean {
  return a.notificationId === b.notificationId && a.category === b.category
}

type MountedSpinner<TTheme> = {
  spinner: Spinner<TTheme>
  startedAt: number
}

export class SpinnerManager<TTheme> {
  private readonly now: () => number
  private readonly defaultSpinner: Spinner<TTheme>
  private readonly maxSwitchGraceMs: number
  private theme: TTheme
  private notification: SpinnerNotification
  private mounted: MountedSpinner<TTheme> | null = null
  private pendingSpinner: Spinner<TTheme> | null = null
  private switchDeadlineMs: number | null = null
  private requestedFps: number | null = null

  constructor(opts: SpinnerManagerOptions<TTheme>) {
    this.defaultSpinner = opts.spinner
    this.theme = opts.theme
    this.notification = normalizeNotification(opts.notification)
    this.maxSwitchGraceMs = opts.maxSwitchGraceMs ?? 120
    this.now = opts.now ?? Date.now
  }

  ensureMounted(): void {
    if (this.mounted) return
    this.mount(this.defaultSpinner, this.now())
  }

  setSpinner(nextSpinner: Spinner<TTheme>, maxGraceMs = this.maxSwitchGraceMs): void {
    const now = this.now()
    if (!this.mounted) {
      this.mount(nextSpinner, now)
      return
    }
    if (this.mounted.spinner === nextSpinner && !this.pendingSpinner) return
    if (this.pendingSpinner) {
      this.pendingSpinner = nextSpinner
      return
    }

    const boundedMaxGrace = Math.max(0, maxGraceMs)
    const decision = this.mounted.spinner.willDisappear?.({
      now,
      startedAt: this.mounted.startedAt,
      theme: this.theme,
      notification: this.notification,
      maxGraceMs: boundedMaxGrace,
    })
    const requestedGrace =
      decision === false
        ? 0
        : typeof decision === "number" && Number.isFinite(decision)
          ? Math.max(0, Math.min(decision, boundedMaxGrace))
          : 0

    if (requestedGrace <= 0) {
      this.unmountMounted(now)
      this.mount(nextSpinner, now)
      return
    }

    this.pendingSpinner = nextSpinner
    this.switchDeadlineMs = now + requestedGrace
  }

  unmount(maxGraceMs = 0): void {
    const now = this.now()
    if (!this.mounted) return

    const boundedMaxGrace = Math.max(0, maxGraceMs)
    const decision = this.mounted.spinner.willDisappear?.({
      now,
      startedAt: this.mounted.startedAt,
      theme: this.theme,
      notification: this.notification,
      maxGraceMs: boundedMaxGrace,
    })
    const requestedGrace =
      decision === false
        ? 0
        : typeof decision === "number" && Number.isFinite(decision)
          ? Math.max(0, Math.min(decision, boundedMaxGrace))
          : 0

    if (requestedGrace <= 0) {
      this.unmountMounted(now)
      this.pendingSpinner = null
      this.switchDeadlineMs = null
      return
    }

    this.pendingSpinner = null
    this.switchDeadlineMs = now + requestedGrace
  }

  setTheme(nextTheme: TTheme): void {
    const previousTheme = this.theme
    this.theme = nextTheme
    if (!this.mounted) return
    this.mounted.spinner.onThemeChange?.({
      now: this.now(),
      startedAt: this.mounted.startedAt,
      theme: this.theme,
      notification: this.notification,
      previousTheme,
      nextTheme: this.theme,
    })
  }

  setNotification(nextNotification: SpinnerNotification): void {
    const normalized = normalizeNotification(nextNotification)
    if (sameNotification(this.notification, normalized)) return

    const previousNotification = this.notification
    this.notification = normalized
    if (!this.mounted) return

    this.mounted.spinner.onNotificationChange?.({
      now: this.now(),
      startedAt: this.mounted.startedAt,
      theme: this.theme,
      notification: this.notification,
      previousNotification,
      nextNotification: this.notification,
    })
  }

  render(maxFps: number): SpinnerRenderFrame | null {
    const now = this.now()
    this.flushPending(now)
    if (!this.mounted) return null
    const currentFps = this.effectiveFps(maxFps) ?? maxFps

    const frame = this.mounted.spinner.render({
      now,
      startedAt: this.mounted.startedAt,
      elapsedMs: now - this.mounted.startedAt,
      maxFps,
      currentFps,
      theme: this.theme,
      notification: this.notification,
    })
    this.requestedFps = this.resolveRequestedFps(frame.requestedFps)
    return frame
  }

  effectiveFps(maxFps: number): number | null {
    if (!this.mounted || maxFps <= 0) return null
    const source = this.requestedFps ?? this.resolveRequestedFps(this.mounted.spinner.preferredFps)
    const desired = source ?? maxFps
    return Math.max(1, Math.min(desired, maxFps))
  }

  private flushPending(now: number): void {
    if (!this.mounted || this.switchDeadlineMs === null || now < this.switchDeadlineMs) {
      return
    }
    const pending = this.pendingSpinner
    this.unmountMounted(now)
    this.switchDeadlineMs = null
    this.pendingSpinner = null
    if (pending) this.mount(pending, now)
  }

  private mount(spinner: Spinner<TTheme>, now: number): void {
    const mounted: MountedSpinner<TTheme> = { spinner, startedAt: now }
    this.mounted = mounted
    this.requestedFps = this.resolveRequestedFps(spinner.preferredFps)
    spinner.willShow?.({
      now,
      startedAt: now,
      theme: this.theme,
      notification: this.notification,
    })
    spinner.didShow?.({
      now,
      startedAt: now,
      theme: this.theme,
      notification: this.notification,
    })
  }

  private unmountMounted(now: number): void {
    if (!this.mounted) return
    const current = this.mounted
    current.spinner.didDisappear?.({
      now,
      startedAt: current.startedAt,
      theme: this.theme,
      notification: this.notification,
    })
    this.mounted = null
    this.requestedFps = null
  }

  private resolveRequestedFps(value: number | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
    return value
  }
}
