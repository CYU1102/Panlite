<template>
  <div class="module-page">
    <header class="page-header">
      <span class="heading-icon"><ArchiveRestore :size="23" /></span>
      <div>
        <h2>配置备份与迁移</h2>
        <p>安全迁移账号元数据、设置和搜索源</p>
      </div>
    </header>

    <div class="card-grid">
      <section class="action-card">
        <div class="card-title"><Download :size="19" /><div><h3>导出备份</h3><p>凭据、敏感设置和认证头不会写入文件</p></div></div>
        <el-alert type="success" :closable="false" show-icon title="导出的账号仅包含元数据，迁移后需要重新登录。" />
        <el-button type="primary" :loading="exporting" @click="confirmExport">确认并导出 JSON</el-button>
      </section>

      <section class="action-card">
        <div class="card-title"><Upload :size="19" /><div><h3>导入备份</h3><p>先校验和预览，确认后才会事务恢复</p></div></div>
        <el-upload :auto-upload="false" :show-file-list="false" accept="application/json,.json" :on-change="selectFile">
          <el-button>选择备份文件</el-button>
        </el-upload>
        <span class="file-name">{{ fileName || '尚未选择文件' }}</span>
        <el-radio-group v-model="mode" :disabled="!backupText">
          <el-radio-button value="merge">合并</el-radio-button>
          <el-radio-button value="replace">替换配置</el-radio-button>
        </el-radio-group>
        <el-button :disabled="!backupText" :loading="previewing" @click="loadPreview">校验并预览</el-button>
      </section>
    </div>

    <section v-if="preview" class="preview-card">
      <div class="preview-heading">
        <div><h3>导入预览</h3><p>备份时间：{{ new Date(preview.createdAt).toLocaleString() }}</p></div>
        <el-tag type="success"><ShieldCheck :size="14" /> 校验和通过</el-tag>
      </div>
      <el-table :data="preview.tables" size="small">
        <el-table-column prop="table" label="数据表" min-width="170" />
        <el-table-column prop="incoming" label="备份记录" width="100" />
        <el-table-column prop="inserts" label="新增" width="90" />
        <el-table-column prop="updates" label="更新" width="90" />
        <el-table-column prop="deletes" label="删除" width="90" />
      </el-table>
      <div class="warnings">
        <p v-for="warning in preview.warnings" :key="warning">• {{ warning }}</p>
      </div>
      <el-checkbox v-model="confirmed">我已理解账号需要重新登录，并确认以上变更</el-checkbox>
      <div class="restore-bar">
        <span>共 {{ preview.totals.incoming }} 条记录</span>
        <el-button type="danger" :disabled="!confirmed" :loading="restoring" @click="confirmRestore">确认恢复</el-button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { UploadFile } from 'element-plus'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs'
import { ArchiveRestore, Download, ShieldCheck, Upload } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'

type ImportMode = 'merge' | 'replace'

interface TablePreview {
  table: string
  incoming: number
  inserts: number
  updates: number
  deletes: number
}

interface ImportPreview {
  createdAt: string
  tables: TablePreview[]
  totals: { incoming: number; inserts: number; updates: number; deletes: number }
  warnings: string[]
}

interface IpcResult {
  success: boolean
  error?: string
  backup?: unknown
  preview?: ImportPreview
}

const exporting = ref(false)
const previewing = ref(false)
const restoring = ref(false)
const backupText = ref('')
const fileName = ref('')
const mode = ref<ImportMode>('merge')
const preview = ref<ImportPreview | null>(null)
const confirmed = ref(false)

function asResult(value: unknown): IpcResult {
  return value as IpcResult
}

async function confirmExport(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '备份不会包含账号凭据、加密设置或明文密码。恢复账号后需要重新登录，是否继续？',
      '安全导出确认',
      { type: 'warning', confirmButtonText: '继续导出' },
    )
    exporting.value = true
    const result = asResult(await electronApi.exportConfigBackup())
    if (!result.success || !result.backup) throw new Error(result.error || '导出失败')
    const content = typeof result.backup === 'string' ? result.backup : JSON.stringify(result.backup, null, 2)
    const blobUrl = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = blobUrl
    anchor.download = `panlite-backup-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(blobUrl)
    ElMessage.success('安全备份已导出')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  } finally {
    exporting.value = false
  }
}

async function selectFile(uploadFile: UploadFile): Promise<void> {
  if (!uploadFile.raw) return
  if (uploadFile.raw.size > 20 * 1024 * 1024) {
    ElMessage.error('备份文件不能超过 20 MB')
    return
  }
  backupText.value = await uploadFile.raw.text()
  fileName.value = uploadFile.name
  preview.value = null
  confirmed.value = false
}

async function loadPreview(): Promise<void> {
  previewing.value = true
  try {
    const result = asResult(await electronApi.previewConfigBackup(backupText.value, { mode: mode.value }))
    if (!result.success || !result.preview) throw new Error(result.error || '备份校验失败')
    preview.value = result.preview
    confirmed.value = false
  } catch (error) {
    preview.value = null
    ElMessage.error(String(error))
  } finally {
    previewing.value = false
  }
}

async function confirmRestore(): Promise<void> {
  if (!preview.value || !confirmed.value) return
  try {
    await ElMessageBox.confirm(
      `将新增 ${preview.value.totals.inserts} 条、更新 ${preview.value.totals.updates} 条、删除 ${preview.value.totals.deletes} 条配置。是否继续？`,
      '最终恢复确认',
      { type: 'error', confirmButtonText: '执行恢复' },
    )
    restoring.value = true
    const result = asResult(await electronApi.importConfigBackup(backupText.value, { mode: mode.value }))
    if (!result.success) throw new Error(result.error || '恢复失败')
    ElMessage.success('配置恢复完成')
    preview.value = null
    backupText.value = ''
    fileName.value = ''
    confirmed.value = false
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  } finally {
    restoring.value = false
  }
}
</script>

<style scoped>
.module-page { height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 14px; padding-bottom: 18px; }
.page-header, .action-card, .preview-card { background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); }
.page-header { display: flex; align-items: center; gap: 12px; padding: 18px 22px; }
.heading-icon { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; color: var(--pl-primary); background: var(--pl-primary-soft); }
h2, h3 { margin: 0 0 3px; color: var(--pl-text); }
h2 { font-size: 17px; } h3 { font-size: 14px; }
p { margin: 0; color: var(--pl-text-secondary); font-size: 12px; line-height: 1.5; }
.card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.action-card { min-height: 220px; display: flex; flex-direction: column; align-items: flex-start; gap: 16px; padding: 20px; }
.card-title { display: flex; align-items: flex-start; gap: 10px; color: var(--pl-primary); }
.file-name { color: var(--pl-text-muted); font-size: 12px; word-break: break-all; }
.preview-card { padding: 18px 20px; }
.preview-heading, .restore-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.preview-heading { margin-bottom: 14px; }
.warnings { margin: 14px 0; padding: 12px 14px; border-radius: 8px; background: var(--pl-warning-soft); }
.warnings p { color: var(--pl-warning); }
.restore-bar { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--pl-border); color: var(--pl-text-secondary); font-size: 13px; }
:deep(.el-tag) { display: inline-flex; align-items: center; gap: 5px; }
@media (max-width: 760px) { .card-grid { grid-template-columns: 1fr; } }
</style>
