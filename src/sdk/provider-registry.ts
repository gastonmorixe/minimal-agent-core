import type { StreamProvider } from "./interfaces"
/**
 * Mutable registry of SDK stream providers with one "active" selection. The
 * first registration becomes active automatically; `switch` changes the
 * selection only when the target id is registered, returning whether it took
 * effect.
 */
export class ProviderRegistry {
  private providers = new Map<string, StreamProvider>()
  private active: string | null = null
  register(p: StreamProvider) {
    this.providers.set(p.id, p)
    if (!this.active) this.active = p.id
  }
  switch(id: string) {
    if (this.providers.has(id)) {
      this.active = id
      return true
    }
    return false
  }
  get current() {
    return this.active ? this.providers.get(this.active) : undefined
  }
}
