export interface Task {
  id: string
  description: string
  priority: "critical" | "high" | "medium" | "low"
  status: "pending" | "assigned" | "running" | "done"
  assignee?: string
}
/**
 * In-memory bookkeeping for a multi-agent run: registers agents by role,
 * assigns prioritized tasks to them, and tracks task completion. Pure state
 * container; it does not spawn processes or schedule anything itself.
 */
export class Swarm {
  private agents = new Map<string, { id: string; role: string }>()
  private tasks = new Map<string, Task>()
  spawn(role: string) {
    const id = "agent-" + (this.agents.size + 1)
    this.agents.set(id, { id, role })
    return id
  }
  assign(agentId: string, desc: string, priority: Task["priority"]) {
    const id = "task-" + (this.tasks.size + 1)
    this.tasks.set(id, { id, description: desc, priority, status: "assigned", assignee: agentId })
    return id
  }
  complete(taskId: string) {
    const t = this.tasks.get(taskId)
    if (t) t.status = "done"
  }
  get status() {
    const t = [...this.tasks.values()]
    return {
      agents: this.agents.size,
      total: t.length,
      done: t.filter((x) => x.status === "done").length,
    }
  }
}
