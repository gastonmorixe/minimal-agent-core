import type { StreamProvider } from "./interfaces"
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
