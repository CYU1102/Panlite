<template>
  <el-dialog
    :model-value="modelValue"
    width="600px"
    title="复制文件"
    class="copy-dialog"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 源文件信息 -->
    <div class="source-info">
      <div class="source-label"><strong>复制内容</strong><span>{{ files.length }} 个项目</span></div>
      <div class="source-files">
        <span v-for="file in files" :key="file.id" class="source-file">
          <FileText :size="14" /> {{ file.name }}
        </span>
      </div>
    </div>

    <!-- 目标目录选择 -->
    <div class="target-section">
      <div class="target-label"><strong>目标位置</strong><span>请选择一个文件夹</span></div>
      <div class="target-tree">
        <el-tree
          :data="treeData"
          :props="{ label: 'name', children: 'children' }"
          node-key="id"
          highlight-current
          check-strictly
          :expand-on-click-node="false"
          @current-change="onNodeClick"
          lazy
          :load="loadNode"
        />
      </div>
    </div>

    <template #footer>
      <el-button @click="onClose">取消</el-button>
      <el-button
        type="primary"
        @click="startCopy"
        :disabled="!selectedDirId"
        :loading="copying"
      >
        复制到此处
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { electronApi } from '../api/ipc'
import { FileText } from 'lucide-vue-next'
import type { DriveAccount, FileItem } from '@shared/types'
import { getPlatformCapabilities } from '@shared/capabilities'

interface TreeNode {
  id: string
  name: string
  children?: TreeNode[]
  isLeaf?: boolean
}

const props = defineProps<{
  modelValue: boolean
  account: Omit<DriveAccount, 'credential'> | null
  files: FileItem[]
  currentDirId: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  success: []
}>()

const selectedDirId = ref('')
const copying = ref(false)
const treeData = ref<TreeNode[]>([])

onMounted(() => {
  // 初始化根目录
  treeData.value = [{
    id: '0',
    name: '根目录',
    children: [],
  }]
})

async function loadNode(node: any, resolve: (data: TreeNode[]) => void) {
  if (!props.account) {
    resolve([])
    return
  }

  try {
    const result = await electronApi.listFiles(props.account.id, node.data.id)
    if (result.success) {
      const dirs = result.files
        .filter((f: FileItem) => f.isDir && f.id !== props.currentDirId) // 过滤当前目录
        .map((f: FileItem) => ({
          id: f.id,
          name: f.name,
          children: [],
          isLeaf: false,
        }))
      resolve(dirs)
    } else {
      resolve([])
    }
  } catch {
    resolve([])
  }
}

function onNodeClick(data: TreeNode) {
  selectedDirId.value = data.id
}

async function startCopy() {
  if (!props.account) return
  if (!getPlatformCapabilities(props.account.platform).copy) {
    ElMessage.warning('当前网盘暂不支持服务端复制')
    return
  }
  if (!selectedDirId.value) {
    ElMessage.warning('请选择目标目录')
    return
  }

  copying.value = true
  try {
    const fileIds = props.files.map(f => f.id)
    const result = await electronApi.copyFiles(
      props.account.id,
      fileIds,
      selectedDirId.value
    )

    if (result.success) {
      ElMessage.success('复制成功')
      emit('success')
      onClose()
    } else {
      ElMessage.error(result.error || '复制失败')
    }
  } catch (err) {
    ElMessage.error('复制失败: ' + String(err))
  } finally {
    copying.value = false
  }
}

function onClose() {
  emit('update:modelValue', false)
  selectedDirId.value = ''
}
</script>

<style scoped>
.source-info {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 16px;
}

.source-label {
  font-size: 13px;
  color: #909399;
  white-space: nowrap;
}

.source-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.source-file {
  font-size: 13px;
  color: #303133;
}

.target-section {
  margin-bottom: 16px;
}

.target-label {
  font-size: 13px;
  color: #606266;
  margin-bottom: 12px;
}

.target-tree {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 8px;
}
.source-info {
  align-items: flex-start;
  padding: 13px;
  background: var(--pl-primary-soft);
  border: 1px solid #d5e3ff;
  border-radius: 12px;
}
.source-label, .target-label { display: flex; min-width: 74px; flex-direction: column; gap: 2px; }
.source-label strong, .target-label strong { color: var(--pl-text); font-size: 12px; font-weight: 650; }
.source-label span, .target-label span { color: var(--pl-text-muted); font-size: 11px; }
.source-files { gap: 6px; }
.source-file { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; color: var(--pl-primary-hover); background: var(--pl-surface); border: 1px solid #d5e3ff; border-radius: 7px; font-size: 12px; }
.target-section { margin-bottom: 8px; }
.target-tree {
  min-height: 180px;
  max-height: 300px;
  margin-top: 9px;
  padding: 8px;
  background: var(--pl-surface-subtle);
  border: 1px solid var(--pl-border);
  border-radius: 12px;
}
.target-tree :deep(.el-tree-node__content) { height: 34px; border-radius: 8px; }
.target-tree :deep(.el-tree-node__content:hover) { background: var(--pl-primary-soft); }
.target-tree :deep(.is-current > .el-tree-node__content) { color: var(--pl-primary-hover); background: var(--pl-primary-soft); font-weight: 600; }
</style>
