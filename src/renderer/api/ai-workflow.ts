import type { AiWorkflowApi } from '@shared/ai-workflow'
import { plainIpcData } from './plain-ipc-data'
declare global { interface Window { aiWorkflowAPI: AiWorkflowApi } }
export const aiWorkflowApi: AiWorkflowApi = {
  list: () => window.aiWorkflowAPI.list(),
  get: id => window.aiWorkflowAPI.get(id),
  start: input => window.aiWorkflowAPI.start(plainIpcData(input)),
  resume: id => window.aiWorkflowAPI.resume(id),
  cancel: id => window.aiWorkflowAPI.cancel(id),
  export: (id, format) => window.aiWorkflowAPI.export(id, format),
  templates: () => window.aiWorkflowAPI.templates(),
  saveTemplate: input => window.aiWorkflowAPI.saveTemplate(plainIpcData(input)),
  deleteTemplate: id => window.aiWorkflowAPI.deleteTemplate(id),
}
