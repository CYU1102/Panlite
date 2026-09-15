import { callAiModelStream } from './ai-provider'
import { DocumentWorkflowStore } from './document-workflow-store'
import { validateWorkflowOutput, workflowPrompt } from './document-workflow'
import type { AiWorkflowRun, AiWorkflowStartInput } from '../../shared/ai-workflow'

export type WorkflowModel = (system: string, user: string, signal: AbortSignal) => Promise<string>
const model: WorkflowModel = (system, user, signal) => callAiModelStream(system, user, [], { signal, onDelta: () => undefined })

export class DocumentWorkflowRuntime {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  constructor(readonly store: DocumentWorkflowStore, private readonly callModel: WorkflowModel = model) { store.recoverInterrupted() }

  start(input: AiWorkflowStartInput): AiWorkflowRun {
    const run = this.store.create(input)
    this.launch(run.id)
    return this.store.get(run.id)
  }
  resume(id: string): AiWorkflowRun {
    const current = this.store.get(id)
    const active = this.active.get(id)
    if (active?.controller.signal.aborted) throw new Error('取消操作正在完成，请稍后继续')
    if (active) return current
    if (current.status === 'completed') throw new Error('这项处理已经完成')
    this.launch(id)
    return this.store.get(id)
  }
  cancel(id: string): AiWorkflowRun {
    const current = this.store.get(id)
    const active = this.active.get(id)
    if (active) active.controller.abort(new DOMException('用户取消处理', 'AbortError'))
    if (current.status !== 'completed') this.store.setStatus(id, 'cancelled', '用户取消处理，可继续未完成分段')
    return this.store.get(id)
  }
  async settled(id: string): Promise<void> { await this.active.get(id)?.promise }
  dispose(): void { for (const task of this.active.values()) task.controller.abort(new DOMException('应用关闭', 'AbortError')) }

  private launch(id: string): void {
    if (this.active.has(id)) return
    const controller = new AbortController()
    this.store.setStatus(id, 'running')
    // Queue execution so the API returns a durable run ID before the first model response.
    const promise = Promise.resolve().then(() => this.execute(id, controller.signal)).finally(() => this.active.delete(id))
    this.active.set(id, { controller, promise })
  }
  private async execute(id: string, signal: AbortSignal): Promise<void> {
    let activeBatchId: string | undefined
    try {
      const metadata = this.store.metadata(id)
      while (true) {
        signal.throwIfAborted()
        const batch = this.store.nextBatch(id)
        if (!batch) break
        activeBatchId = batch.id
        const prompt = workflowPrompt(metadata.input.mode, batch.input, metadata.input.instruction || '', metadata.template)
        let succeeded = false
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted()
          this.store.startBatch(batch.id)
          try {
            const response = await this.callModel(prompt.system, prompt.user, signal)
            signal.throwIfAborted()
            const output = validateWorkflowOutput(response, metadata.input.mode, batch.input, metadata.template)
            this.store.finishBatch(batch.id, 'completed', output)
            this.store.setStatus(id, 'running')
            succeeded = true; break
          } catch (error) {
            if (signal.aborted || attempt === 1) throw error
          }
        }
        if (!succeeded) throw new Error('分段处理未完成')
        activeBatchId = undefined
      }
      signal.throwIfAborted()
      this.store.setStatus(id, 'completed')
    } catch (error) {
      const message = signal.aborted ? '处理已取消，可继续未完成分段' : error instanceof Error ? error.message : String(error)
      if (activeBatchId) this.store.finishBatch(activeBatchId, signal.aborted ? 'cancelled' : 'failed', undefined, message)
      this.store.setStatus(id, signal.aborted ? 'cancelled' : 'failed', message)
    }
  }
}
