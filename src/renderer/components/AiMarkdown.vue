<template>
  <div class="ai-markdown">
    <template v-for="(block, index) in blocks" :key="index">
      <hr v-if="block.type === 'rule'">
      <div v-else-if="block.type === 'code'" class="code-block"><small v-if="block.language">{{ block.language }}</small><pre><code>{{ block.text }}</code></pre></div>
      <div v-else-if="block.type === 'table'" class="table-wrap"><table><thead><tr><th v-for="(cell, number) in block.headers" :key="number"><InlineText :text="cell" /></th></tr></thead><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex"><InlineText :text="cell" /></td></tr></tbody></table></div>
      <div v-else-if="block.type === 'list'" class="list-row"><span>{{ block.marker }}</span><InlineText :text="block.text" /></div>
      <component :is="block.type === 'heading' ? `h${block.level}` : block.type === 'quote' ? 'blockquote' : 'p'" v-else><InlineText :text="block.text" /></component>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, defineComponent, h } from 'vue'
import { ElMessage } from 'element-plus'
import { electronApi } from '../api/ipc'
import { aiInlineTokens, aiMarkdownBlocks } from './ai-markdown'
const props = defineProps<{ content: string }>()
const blocks = computed(() => aiMarkdownBlocks(props.content))
const InlineText = defineComponent({
  props: { text: { type: String, required: true } },
  setup(inlineProps) {
    return () => h('span', aiInlineTokens(inlineProps.text).map(token => {
      if (token.type === 'link') return h('button', { class: 'inline-link', type: 'button', title: token.href, onClick: async () => { try { await electronApi.openExternal(token.href!); } catch { ElMessage.error('无法打开链接') } } }, token.text)
      return token.type === 'text' ? token.text : h(token.type === 'strong' ? 'strong' : token.type === 'emphasis' ? 'em' : 'code', token.text)
    }))
  },
})
</script>
<style scoped>
.ai-markdown{line-height:1.8;font-size:var(--pl-font-md);overflow-wrap:anywhere;color:var(--pl-text)}
.ai-markdown p{margin:8px 0;white-space:pre-wrap}.ai-markdown p:first-child{margin-top:0}.ai-markdown p:last-child{margin-bottom:0}
.ai-markdown h1,.ai-markdown h2,.ai-markdown h3,.ai-markdown h4,.ai-markdown h5,.ai-markdown h6{margin:20px 0 8px;font-size:var(--pl-font-lg);line-height:1.5}.ai-markdown h1{font-size:var(--pl-font-xl)}
.ai-markdown :deep(code){padding:2px 5px;border-radius:4px;background:var(--pl-hover);font:13px/1.7 Consolas,monospace}.code-block{margin:12px 0;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface-subtle);overflow:hidden}.code-block>small{display:block;padding:5px 12px;color:var(--pl-text-muted);border-bottom:1px solid var(--pl-border)}.code-block pre{margin:0;padding:12px;overflow:auto;white-space:pre}.code-block code{padding:0;background:transparent}
.list-row{display:flex;gap:10px;margin:5px 0 5px 12px}.list-row>span:first-child{min-width:16px;color:var(--pl-text-secondary)}blockquote{margin:10px 0;padding:8px 12px;border-left:3px solid var(--pl-primary);background:var(--pl-primary-soft);color:var(--pl-text-secondary)}hr{border:0;border-top:1px solid var(--pl-border);margin:16px 0}
.table-wrap{max-width:100%;overflow:auto;margin:12px 0}table{border-collapse:collapse;min-width:100%;font-size:var(--pl-font-sm)}th,td{padding:8px 12px;border:1px solid var(--pl-border);text-align:left;min-width:90px;vertical-align:top}th{background:var(--pl-surface-subtle);font-weight:600}.ai-markdown :deep(.inline-link){display:inline;padding:0;border:0;background:none;color:var(--pl-primary);text-decoration:underline;cursor:pointer;font:inherit}
</style>
