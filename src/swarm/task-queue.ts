import type { Task } from "./swarm"

const P: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
export class TaskQueue {
  private q: Task[] = []
  enqueue(t: Task) {
    this.q.push(t)
    this.q.sort((a, b) => P[a.priority] - P[b.priority])
  }
  dequeue() {
    return this.q.find((t) => t.status === "pending")
  }
  complete(id: string) {
    const t = this.q.find((x) => x.id === id)
    if (t) t.status = "done"
  }
  get pending() {
    return this.q.filter((t) => t.status === "pending")
  }
}
