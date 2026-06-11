<template>
  <el-dialog
    :model-value="modelValue"
    width="600px"
    title="复制文件"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <!-- 源文件信息 -->
    <div class="source-info">
      <div class="source-label">复制：</div>
      <div class="source-files">
        <span v-for="file in files" :key="file.id" class="source-file">
          📄 {{ file.name }}
        </span>
      </div>
    </div>

    <!-- 目标目录选择 -->
    <div class="target-section">
      <div class="target-label">复制到：</div>
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
import { ElMessage } from 'element-plus'
import { electronApi } from '../api/ipc'
import type { DriveAccount, FileItem } from '@shared/types'

interface TreeNode {
  id: string
  name: string
  children?: TreeNode[]
  isLeaf?: boolean
}

const props = defineProps<{
  modelValue: boolean
  account: DriveAccount | null
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
</style>
