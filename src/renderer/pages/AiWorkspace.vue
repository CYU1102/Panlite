<template>
  <div class="ai-workspace" :class="{ 'ask-workspace': activeView==='ask' }">
    <header class="page-header">
      <div class="header-copy">
        <span class="header-icon"><Sparkles :size="21" /></span>
        <div><div class="title-line"><h2>AI 控制台</h2><span>文档工作区</span></div><p>管理文档、处理全文，并通过原文引用核对回答</p></div>
      </div>
      <div class="header-actions"><el-button @click="localToolsVisible=true"><Wrench :size="15" />本地能力</el-button><el-button @click="openProviderDialog"><Settings2 :size="15" />模型设置</el-button><el-button type="primary" :loading="importing" @click="selectAndImport"><FilePlus2 :size="15" />导入文件</el-button></div>
    </header>

    <nav class="workspace-tabs">
      <button v-for="tab in tabs" :key="tab.key" :class="{ active: activeView === tab.key }" @click="activeView = tab.key"><component :is="tab.icon" :size="15" />{{ tab.label }}<span v-if="tab.count !== undefined" class="tab-count">{{ tab.count }}</span></button>
    </nav>

    <div class="processing-strip"><ShieldCheck :size="15" /><strong>本地解析优先</strong><span v-if="policyState==='ready'">{{ processingPolicy.allowModelFallback ? '允许模型补充识别' : '模型补充识别关闭' }}</span><span v-if="policyState==='ready'">{{ processingPolicy.useSemanticIndex ? '语义索引开启' : '本地关键词索引' }}</span><span v-if="policyState!=='ready'">{{ policyState==='loading'?'正在读取处理方式…':'处理方式读取失败，请重新检测' }}</span><button @click="localToolsVisible=true">调整处理方式</button></div>
    <main>
      <template v-if="activeView === 'overview'">
        <section class="workspace-start">
          <div class="start-copy"><span class="kicker">文档工作区</span><h3>{{ conversations.length ? '继续你的文档工作' : '从一份文件开始' }}</h3><p>导入文件、本地解析，再按需要问答或处理全文。</p><div class="start-actions"><el-button type="primary" @click="resumeConversation"><MessagesSquare :size="16" />{{ conversations.length ? '继续最近对话' : '开始文档问答' }}</el-button><el-button @click="selectAndImport"><UploadCloud :size="16" />导入文档</el-button><el-button @click="activeView='tasks'"><ListChecks :size="16" />查看任务</el-button></div></div>
          <div class="configuration-summary"><BrainCircuit :size="22" /><div><strong>{{ providerConfigured ? providerConfig.name : '尚未配置问答模型' }}</strong><small>{{ providerConfigured ? providerConfig.model : '本地解析仍可使用' }}</small><span>{{ providerConfigured ? '已配置 · 连接状态请在模型设置中测试' : '配置模型后可发起文档问答' }}</span></div><button class="link-button" @click="openProviderDialog">模型设置 <ArrowRight :size="14" /></button></div>
        </section>
        <section class="stats"><article><Files :size="18" /><strong>{{ documents.length }}</strong><span>已导入文档</span></article><article><CircleCheckBig :size="18" /><strong>{{ readyDocuments.length }}</strong><span>可参与问答</span></article><article><Puzzle :size="18" /><strong>{{ awaitingCount }}</strong><span>等待解析工具</span></article><article><Activity :size="18" /><strong>{{ tasks.length }}</strong><span>AI 任务</span></article></section>
        <section class="panel"><div class="panel-heading"><div><span class="kicker">文件理解</span><h3>当前能力</h3></div><button class="link-button" :disabled="capabilityChecking" @click="refreshCapabilities"><RefreshCw :size="14" :class="{ spinning: capabilityChecking }" />{{ capabilityChecking ? '检测能力中' : '重新检测能力' }}</button></div><div class="capability-grid"><article v-for="item in capabilities" :key="item.name"><span class="capability-icon"><component :is="item.icon" :size="19" /></span><span class="capability-state" :class="{ ready: item.state === 'builtin' || item.state === 'local' }">{{ item.label }}</span><h4>{{ item.name }}</h4><p>{{ item.description }}</p><div><small v-for="format in item.formats" :key="format">{{ format }}</small></div></article></div></section>
        <section class="panel"><div class="panel-heading"><div><span class="kicker">最近内容</span><h3>最近导入</h3></div><button class="link-button" @click="activeView = 'documents'">查看全部 <ArrowRight :size="14" /></button></div><div v-if="documents.length" class="recent-grid"><button v-for="document in documents.slice(0,4)" :key="document.id" @click="showDocument(document)"><span class="file-icon"><FileText :size="17" /></span><span><strong>{{ document.name }}</strong><small>{{ formatFileSize(document.size) }} · {{ statusLabel(document.status) }}</small></span><ChevronRight :size="15" /></button></div><div v-else class="empty"><Library :size="30" /><strong>还没有导入文件</strong><span>先导入一份文档，再开始提问。</span></div></section>
      </template>

      <section v-else-if="activeView === 'ask'" class="chat-layout" :class="{ 'history-collapsed': !historyOpen, 'sources-open': sourcesOpen }">
        <aside v-if="historyOpen" class="scope-panel history-panel" aria-label="对话历史">
          <div class="conversation-heading"><div><span class="kicker">对话记录</span><h3>我的对话</h3></div><div class="sidebar-heading-actions"><button title="新建对话" aria-label="新建对话" @click="newConversation"><Plus :size="14" /></button><button title="收起历史" aria-label="收起对话历史" @click="historyOpen=false"><X :size="14" /></button></div></div>
          <div class="conversation-search"><Search :size="13" /><input v-model="conversationSearch" placeholder="搜索标题和消息" @input="searchConversations" /><X v-if="conversationSearch" :size="12" @click="clearConversationSearch" /></div>
          <div class="conversation-list">
            <div v-for="conversation in displayedConversations" :key="conversation.id" class="conversation-item" :class="{ active: activeConversationId === conversation.id }">
              <button class="conversation-main" @click="selectConversation(conversation.id)"><MessageCircle :size="14" /><span><strong>{{ conversation.title }}</strong><small v-if="conversation.snippet">{{ conversation.snippet }}</small></span></button>
              <button title="重命名" @click="renameConversation(conversation)"><Pencil :size="12" /></button>
              <button title="删除" @click="removeConversation(conversation)"><X :size="13" /></button>
            </div>
          </div>
          <div v-if="!displayedConversations.length" class="history-empty">{{ conversationSearch ? '没有匹配的对话' : '新建对话，开始文档问答' }}</div>
          <button class="new-conversation" @click="newConversation"><Plus :size="15" />新建对话</button>
        </aside>
        <div class="chat-panel">
          <header class="chat-toolbar"><div><button class="history-toggle" :aria-expanded="historyOpen" aria-label="展开或收起对话历史" @click="historyOpen=!historyOpen"><MessagesSquare :size="16" /></button><i :title="providerConfigured ? '模型已配置，连接状态需测试' : '模型未配置'" :class="{ active: providerConfigured }"></i><strong>{{ activeConversation?.title || (providerConfigured ? providerLabel : '模型未配置') }}</strong><small v-if="providerConfigured">{{ providerConfig.name }} · {{ providerConfig.model }}</small></div><span class="chat-tools"><button :aria-expanded="sourcesOpen" @click="toggleSources($event)"><Library :size="14" />文档与来源</button><button v-if="activeConversationId" @click="exportConversation"><Download :size="14" />导出</button><button @click="openProviderDialog"><Settings2 :size="14" />设置</button></span></header>
          <div ref="messageContainer" class="messages">
            <div v-if="!chatMessages.length" class="welcome"><span><MessageCircleQuestion :size="30" /></span><h3>针对文档提问</h3><p>系统先在本地找出相关片段，再交给你配置的模型回答，并标注文件和页码来源。</p><div><button v-for="suggestion in suggestions" :key="suggestion" @click="question=suggestion">{{ suggestion }}</button></div></div>
            <article v-for="message in chatMessages" :key="message.id" class="message" :class="message.role"><span class="avatar"><UserRound v-if="message.role==='user'" :size="16" /><Sparkles v-else :size="16" /></span><div><small>{{ message.role === 'user' ? '你' : 'PanLite AI' }}</small><AiMarkdown v-if="message.role==='assistant'" :content="message.content" /><p v-else>{{ message.content }}</p><div class="message-actions"><button v-if="message.role==='user'" title="编辑这个问题并从这里重新提问" @click="editQuestion(message)"><Edit3 :size="12" />编辑重问</button><button v-else title="复制回答" @click="copyAnswer(message)"><Copy :size="12" />复制</button><button v-if="message.role==='assistant'&&isLastAssistant(message)" title="重新生成最后一个回答" @click="regenerateAnswer"><RotateCcw :size="12" />重新生成</button></div><section v-if="message.citations?.length" class="citations"><details v-for="(citation,index) in message.citations" :key="`${citation.documentId}-${index}`"><summary @click.prevent="openCitation(citation,$event)">[{{ index+1 }}] {{ citation.documentName }} <span>{{ citationLocation(citation) }} · 点击定位</span></summary><p>{{ citation.quote }}</p></details></section></div></article>
            <div v-if="asking" class="thinking"><i></i><i></i><i></i><span role="status">{{ streamPhaseLabel }}</span></div>
          </div>
          <footer class="composer"><div v-if="editingMessageId" class="editing-tip"><Edit3 :size="12" /><span>正在编辑历史问题；发送后将从这里生成新分支</span><button @click="cancelEdit"><X :size="11" /></button></div><textarea ref="questionInput" v-model="question" rows="2" maxlength="2000" placeholder="询问文档内容，Enter 发送，Shift + Enter 换行" @keydown.enter.exact.prevent="askQuestion"></textarea><div><small>{{ selectedDocumentIds.length ? `仅检索已选 ${selectedDocumentIds.length} 份文档` : `检索全部 ${readyDocuments.length} 份文档` }}</small><button v-if="asking" class="stop-button" @click="stopGeneration"><Square :size="13" />停止</button><button v-else :disabled="!question.trim() || !readyDocuments.length" @click="askQuestion"><Send :size="15" />发送</button></div></footer>
        </div>
        <component :is="compactSources ? ElDrawer : 'aside'" v-if="sourcesOpen" :class="compactSources ? 'ai-source-drawer' : 'source-panel'" v-bind="compactSources ? { modelValue:sourcesOpen, size:'min(390px, 94vw)', withHeader:false, appendToBody:true, modal:true, closeOnPressEscape:true } : {}" @update:model-value="onSourceVisibilityChange" @opened="focusSources">
          <div ref="sourcePanel" class="source-body" tabindex="-1" aria-label="文档与引用来源" @keydown.esc.stop.prevent="closeSources">
          <header class="source-heading"><strong>文档与来源</strong><button aria-label="关闭文档与来源" @click="closeSources"><X :size="16" /></button></header>
          <div class="source-tabs"><button :class="{ active: sourceMode==='scope' }" @click="sourceMode='scope'">文档范围</button><button :disabled="!activeCitation" :class="{ active: sourceMode==='citation' }" @click="sourceMode='citation'">引用原文</button></div>
          <template v-if="sourceMode==='scope'">
          <div class="scope-title"><div><span class="kicker">检索范围</span><h3>选择文档</h3></div><small>{{ selectedDocumentIds.length ? `${selectedDocumentIds.length} 项` : '全部' }}</small></div>
          <button class="all-documents" :class="{ active: !selectedDocumentIds.length }" @click="selectAllDocuments"><span class="file-icon"><Library :size="16" /></span><span><strong>全部可用文档</strong><small>自动检索相关片段</small></span><CircleCheckBig v-if="!selectedDocumentIds.length" :size="15" /></button>
          <div class="scope-list"><label v-for="document in readyDocuments" :key="document.id"><input type="checkbox" :checked="selectedDocumentIds.includes(document.id)" @change="toggleDocument(document.id)" /><span class="file-icon"><FileText :size="15" /></span><span><strong>{{ document.name }}</strong><small>{{ document.extension.toUpperCase() }} · {{ formatFileSize(document.size) }}</small></span></label></div>
          <div v-if="!readyDocuments.length" class="scope-empty"><FileWarning :size="24" /><span>暂无可问答文档</span><button @click="selectAndImport">导入文件</button></div>
          <div class="privacy-tip"><ShieldCheck :size="15" /><span>仅发送本地检索命中的文字片段，原文件不会上传。</span></div>
          </template>
          <div v-else-if="activeCitation" class="source-content"><h4>{{ activeCitation.documentName }}</h4><button class="expand-citation" @click="citationExpanded=true"><Eye :size="14" />放大查看原件</button><AiCitationPreview v-if="citationPreviewVisible && !citationExpanded" v-model="citationPreviewVisible" :citation="activeCitation" embedded /></div>
          </div>
        </component>
      </section>

      <AiDocumentWorkflow v-else-if="activeView === 'workflow'" :documents="readyDocuments" @citation="openCitation" />

      <section v-else-if="activeView === 'documents'" class="panel full-panel"><div class="panel-heading"><div><span class="kicker">文档库</span><h3>已导入内容</h3></div><span class="panel-actions"><el-button :disabled="!readyDocuments.length" @click="exportKnowledge"><Download :size="14" />导出知识库</el-button><el-button type="primary" :loading="importing" @click="selectAndImport"><Plus :size="14" />导入</el-button></span></div><div class="document-filters"><label><Search :size="15" /><input v-model="documentSearch" aria-label="搜索文档" placeholder="搜索文件名、格式或解析信息" /><button v-if="documentSearch" aria-label="清除文档搜索" @click="documentSearch='' "><X :size="14" /></button></label><select v-model="documentStatus" aria-label="筛选文档状态"><option value="all">全部状态</option><option v-for="status in documentStatuses" :key="status" :value="status">{{ statusLabel(status) }}</option></select><span>{{ filteredDocuments.length }} / {{ documents.length }} 份文档</span></div><div v-if="filteredDocuments.length" class="document-table"><div class="document-row head"><span>文件</span><span>格式</span><span>大小</span><span>状态</span><span>导入时间</span><span></span></div><div v-for="document in filteredDocuments" :key="document.id" class="document-row" @click="showDocument(document)"><span class="document-name"><span class="file-icon"><FileText :size="15" /></span><span><strong>{{ document.name }}</strong><small>{{ document.sourceType === 'local' ? '本地文件' : '网盘文件' }}</small><small v-if="document.errorMessage || document.parseMessage" class="document-notice" :class="{ failed: document.status==='failed' }" :title="document.errorMessage || document.parseMessage">{{ document.errorMessage || document.parseMessage }}</small></span></span><span class="format-tag">{{ document.extension.toUpperCase() || 'FILE' }}</span><span>{{ formatFileSize(document.size) }}</span><span><i class="status" :class="document.status">{{ statusLabel(document.status) }}</i></span><span>{{ formatDate(document.createdAt) }}</span><span class="row-actions" @click.stop><button title="查看内容" @click="showDocument(document)"><Eye :size="14" /></button><button title="重新解析并重建索引" @click="reindexDocument(document)"><RefreshCw :size="14" /></button><button title="删除记录" @click="removeDocument(document)"><Trash2 :size="14" /></button></span></div></div><div v-else class="empty large"><Library :size="34" /><strong>{{ documents.length ? '没有匹配的文档' : '文档库为空' }}</strong><span>{{ documents.length ? '调整关键词或状态筛选后重试。' : '导入后会在这里显示解析和索引状态。' }}</span></div></section>

      <section v-else class="panel full-panel"><div class="panel-heading"><div><span class="kicker">任务中心</span><h3>AI 任务</h3></div><button class="link-button" @click="loadData"><RefreshCw :size="14" />刷新</button></div><div class="task-filters"><button v-for="status in ['all','running','pending','failed','success','cancelled']" :key="status" :class="{ active:taskStatus===status }" @click="taskStatus=status">{{ status==='all'?'全部':taskStatusLabel(status) }} <span>{{ status==='all'?tasks.length:tasks.filter(task=>task.status===status).length }}</span></button></div><div v-if="filteredTasks.length" class="task-list"><article v-for="task in filteredTasks" :key="task.id"><span class="task-icon" :class="task.status"><component :is="task.status==='success'?CircleCheckBig:task.status==='failed'?CircleX:task.status==='cancelled'?Square:LoaderCircle" :size="17" /></span><div><strong>{{ task.title }}</strong><small>{{ taskStatusLabel(task.status) }} · {{ task.errorMessage || task.message || '等待处理' }}</small></div><el-progress :percentage="task.progress" :show-text="false" :stroke-width="6" /><time>{{ formatDate(task.updatedAt) }}</time></article></div><div v-else class="empty large"><ListChecks :size="34" /><strong>{{ tasks.length ? '该状态下暂无任务' : '暂无 AI 任务' }}</strong></div></section>
    </main>

    <AiProviderDialog v-model="providerVisible" :active-config="providerConfig" @updated="onProviderUpdated" />
    <AiLocalToolsDialog v-model="localToolsVisible" @updated="onLocalToolsUpdated" @policy-updated="onPolicyUpdated" />
    <AiCitationPreview v-if="citationPreviewVisible && !citationInline" v-model="citationPreviewVisible" :citation="activeCitation" />

    <AiCitationPreview v-if="citationExpanded && activeView==='ask'" v-model="citationExpanded" :citation="activeCitation" />
    <el-dialog v-model="previewVisible" class="ai-document-dialog" top="5vh" :title="selectedDocument?.name || '文档详情'" width="min(720px, 94vw)"><div v-if="selectedDocument"><div class="preview-meta"><span><strong>格式</strong>{{ selectedDocument.extension.toUpperCase() }}</span><span><strong>大小</strong>{{ formatFileSize(selectedDocument.size) }}</span><span><strong>状态</strong>{{ statusLabel(selectedDocument.status) }}</span><span><strong>来源</strong>{{ selectedDocument.sourceType==='local'?'本地导入':'网盘导入' }}</span></div><div v-if="selectedDocument.parseMessage || selectedDocument.errorMessage" class="parse-notice">{{ selectedDocument.parseMessage || selectedDocument.errorMessage }}</div><div v-if="selectedCitationQuote" class="citation-focus"><strong>引用位置</strong><span>{{ selectedCitationLocation }}</span><p>{{ selectedCitationQuote }}</p></div><div v-if="selectedDocument.contentPreview" class="preview"><pre>{{ selectedDocument.contentPreview }}</pre></div><div v-else class="empty"><Puzzle :size="28" /><strong>{{ selectedDocument.status==='awaiting_parser'?'等待对应解析能力包':'没有可预览文本' }}</strong></div></div></el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ElDrawer from 'element-plus/es/components/drawer/index.mjs'
import 'element-plus/theme-chalk/el-drawer.css'
import { Activity, ArrowRight, BrainCircuit, ChevronRight, CircleCheckBig, CircleX, Copy, Download, Edit3, Eye, FilePlus2, FileSpreadsheet, Files, FileText, FileWarning, Image, Library, ListChecks, LoaderCircle, MessageCircle, MessageCircleQuestion, MessagesSquare, Mic2, PackageOpen, Pencil, Plus, Puzzle, RefreshCw, RotateCcw, Search, Send, Settings2, ShieldCheck, Sparkles, Square, Trash2, UploadCloud, UserRound, Wrench, X } from 'lucide-vue-next'
import { electronApi } from '../api/ipc'
import AiProviderDialog from '../components/AiProviderDialog.vue'
import AiMarkdown from '../components/AiMarkdown.vue'
import AiLocalToolsDialog from '../components/AiLocalToolsDialog.vue'
import type { AiAskStreamEvent, AiCitation, AiConversation, AiConversationSearchHit, AiDocument, AiDocumentStatus, AiLocalToolStatus, AiProviderConfig, AiTask } from '@shared/ai-types'
import { formatFileSize } from '@shared/utils'
import { getAiCapabilities, type AiCapabilityKey } from '@shared/ai-capabilities'
import { DEFAULT_AI_PROCESSING_POLICY, type AiProcessingPolicy } from '@shared/ai-processing-policy'
import { citationTimeLabel, subtitleTimeRange } from '@shared/ai-citation-preview'

const AiCitationPreview=defineAsyncComponent(()=>import('../components/AiCitationPreview.vue'))
const AiDocumentWorkflow=defineAsyncComponent(()=>import('../components/AiDocumentWorkflow.vue'))
const activeCitation=ref<AiCitation|null>(null), citationPreviewVisible=ref(false), citationInline=ref(false), citationExpanded=ref(false)
const compactSources=ref(window.innerWidth<=1450)
let sourceTrigger:HTMLElement|null=null
const historyOpen=ref(window.innerWidth>1000), sourcesOpen=ref(window.innerWidth>=1450), sourceMode=ref<'scope'|'citation'>('scope')
const taskStatus=ref('all')
const filteredTasks=computed(()=>tasks.value.filter(task=>taskStatus.value==='all'||task.status===taskStatus.value))
function taskStatusLabel(status:string){return ({pending:'等待中',running:'处理中',success:'已完成',failed:'失败',cancelled:'已停止'} as Record<string,string>)[status]||status}
const documentSearch=ref(''), documentStatus=ref<AiDocumentStatus|'all'>('all')
const documentStatuses:AiDocumentStatus[]=['ready','processing','queued','awaiting_parser','failed','unsupported']
const filteredDocuments=computed(()=>documents.value.filter(document=>(documentStatus.value==='all'||document.status===documentStatus.value)&&[document.name,document.extension,document.parseMessage,document.errorMessage].filter(Boolean).join(' ').toLocaleLowerCase().includes(documentSearch.value.trim().toLocaleLowerCase())))
const streamPhaseLabel=computed(()=>pendingAssistantId.value&&chatMessages.value.find(message=>message.id===pendingAssistantId.value)?.content?'正在生成回答，可随时停止':'正在准备回答，可随时停止')

type ViewKey = 'overview'|'ask'|'workflow'|'documents'|'tasks'
interface ChatMessage { id:string; role:'user'|'assistant'; content:string; citations?:AiCitation[] }
let pendingRegeneration:{conversationId:string;originalId:string;replacementId:string}|null=null
let conversationLoadVersion=0
interface ChatAttempt { assistantId:string; requestId:string; stopRequested:boolean; cancelling:boolean; processing:boolean; bufferedEvents:AiAskStreamEvent[] }
let currentAttempt:ChatAttempt|null=null
let workspaceDisposed=false
function ownsAttempt(attempt:ChatAttempt){return !workspaceDisposed&&currentAttempt===attempt}
function beginAttempt(assistantId:string):ChatAttempt{
  const attempt={assistantId,requestId:'',stopRequested:false,cancelling:false,processing:false,bufferedEvents:[]}
  currentAttempt=attempt;pendingAssistantId.value=assistantId;activeRequestId.value='';asking.value=true
  return attempt
}
async function cancelAttempt(attempt:ChatAttempt){
  if(!attempt.requestId||attempt.cancelling)return
  attempt.cancelling=true
  try{
    const result=await electronApi.aiAskStreamCancel(attempt.requestId)
    if(!result.success&&ownsAttempt(attempt)){attempt.stopRequested=false;ElMessage.warning(result.error||'回答已经结束')}
  }catch(error){if(ownsAttempt(attempt)){attempt.stopRequested=false;ElMessage.warning(error instanceof Error?error.message:'停止失败，请重试')}}
  finally{attempt.cancelling=false}
}
async function startAttempt(attempt:ChatAttempt,input:Parameters<typeof electronApi.aiAskStreamStart>[0]){
  const result=await electronApi.aiAskStreamStart(input)
  if(!result.success||!result.requestId)throw new Error(result.error||'启动回答失败')
  attempt.requestId=result.requestId
  if(!ownsAttempt(attempt)){void cancelAttempt(attempt);return}
  activeRequestId.value=result.requestId
  await drainAttemptEvents(attempt)
  if(ownsAttempt(attempt)&&attempt.stopRequested)await cancelAttempt(attempt)
}
const activeView=ref<ViewKey>('overview'), importing=ref(false), asking=ref(false), documents=ref<AiDocument[]>([]), tasks=ref<AiTask[]>([]), conversations=ref<AiConversation[]>([]), conversationHits=ref<AiConversationSearchHit[]>([]), conversationSearch=ref(''), activeConversationId=ref(''), activeRequestId=ref(''), pendingAssistantId=ref(''), editingMessageId=ref(''), selectedDocumentIds=ref<string[]>([]), question=ref(''), chatMessages=ref<ChatMessage[]>([]), previewVisible=ref(false), selectedDocument=ref<AiDocument|null>(null), selectedCitationQuote=ref(''), selectedCitationLocation=ref(''), providerVisible=ref(false), localToolsVisible=ref(false)
const messageContainer=ref<HTMLElement>()
const questionInput=ref<HTMLTextAreaElement>()
const sourcePanel=ref<HTMLElement>()
const providerConfig=reactive<AiProviderConfig>({id:'default',name:'默认模型',type:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'',transcriptionModel:'gpt-4o-mini-transcribe',embeddingModel:'',hasApiKey:false})
let disposeTaskListener:(()=>void)|undefined, disposeStreamListener:(()=>void)|undefined, disposeProviderListener:(()=>void)|undefined
let providerRevision=0
const providerLabels:Record<AiProviderConfig['type'],string>={'openai-compatible':'Chat Completions','openai-responses':'OpenAI Responses',anthropic:'Anthropic Messages',gemini:'Gemini',ollama:'本地 Ollama'}
const readyDocuments=computed(()=>documents.value.filter(item=>item.status==='ready')), awaitingCount=computed(()=>documents.value.filter(item=>item.status==='awaiting_parser').length), providerConfigured=computed(()=>Boolean(providerConfig.model&&providerConfig.baseUrl)), providerLabel=computed(()=>providerLabels[providerConfig.type])
const activeConversation=computed(()=>conversations.value.find(item=>item.id===activeConversationId.value))
const displayedConversations=computed(()=>(conversationSearch.value.trim()?conversationHits.value.map(hit=>{const conversation=conversations.value.find(item=>item.id===hit.conversationId);return conversation?{...conversation,snippet:hit.snippet}:null}).filter((item):item is AiConversation&{snippet:string}=>Boolean(item)):conversations.value.map(item=>({...item,snippet:''}))))
const tabs=computed(()=>[{key:'overview' as const,label:'概览',icon:markRaw(Sparkles)},{key:'ask' as const,label:'文档问答',icon:markRaw(MessagesSquare)},{key:'workflow' as const,label:'全文处理',icon:markRaw(FileSpreadsheet)},{key:'documents' as const,label:'文档库',icon:markRaw(Library),count:documents.value.length},{key:'tasks' as const,label:'AI 任务',icon:markRaw(ListChecks),count:tasks.value.length}])
const suggestions=['总结这些文档的核心内容','列出文档中的关键结论','有哪些重要日期和数字？','比较不同文档的主要观点']
const capabilityTools=ref<AiLocalToolStatus[]|null>(null), capabilityChecking=ref(false)
const capabilityIcons:Record<AiCapabilityKey, typeof FileText>={text:markRaw(FileText),pdf:markRaw(Files),office:markRaw(FileSpreadsheet),ocr:markRaw(Image),archive:markRaw(PackageOpen),media:markRaw(Mic2)}
const policyState=ref<'loading'|'ready'|'failed'>('loading')
const processingPolicy=reactive<AiProcessingPolicy>({...DEFAULT_AI_PROCESSING_POLICY})
const capabilities=computed(()=>getAiCapabilities(providerConfig,capabilityTools.value,processingPolicy).map(item=>({...item,icon:capabilityIcons[item.key]})))
let capabilityRevision=0
let policyRevision=0
function onLocalToolsUpdated(tools:AiLocalToolStatus[]){capabilityRevision++;capabilityTools.value=tools}
function onPolicyUpdated(policy:AiProcessingPolicy){policyRevision++;Object.assign(processingPolicy,policy);policyState.value='ready'}
async function refreshPolicy(){const revision=++policyRevision;policyState.value='loading';try{const result=await electronApi.aiProcessingPolicyGet();if(!result.success||!result.policy)throw new Error(result.error||'读取模型使用方式失败');if(revision===policyRevision){Object.assign(processingPolicy,result.policy);policyState.value='ready'}}catch(error){if(revision===policyRevision){policyState.value='failed';Object.assign(processingPolicy,DEFAULT_AI_PROCESSING_POLICY);ElMessage.error(error instanceof Error?error.message:String(error))}}}
async function refreshCapabilities(){if(capabilityChecking.value)return;capabilityChecking.value=true;void refreshPolicy();const revision=++capabilityRevision;try{const result=await electronApi.aiLocalToolsGet();if(!result.success)throw new Error(result.error||'能力检测失败');if(revision===capabilityRevision)capabilityTools.value=result.tools||[]}catch(error){if(revision===capabilityRevision)capabilityTools.value=[];ElMessage.error(error instanceof Error?error.message:String(error))}finally{capabilityChecking.value=false}}
function statusLabel(status:AiDocumentStatus){return({queued:'等待中',processing:'处理中',ready:'已就绪',awaiting_parser:'等待解析器',unsupported:'暂不支持',failed:'失败'} as const)[status]}
function formatDate(value:number){return new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
function citationLocation(value:AiCitation){const start=value.startSeconds??subtitleTimeRange(value.section).startSeconds;return value.pageNumber?`第 ${value.pageNumber} 页`:start!==undefined?citationTimeLabel(start):value.section||''}
let conversationSearchTimer:ReturnType<typeof setTimeout>|undefined
function searchConversations(){if(conversationSearchTimer)clearTimeout(conversationSearchTimer);const query=conversationSearch.value.trim();if(!query){conversationHits.value=[];return}conversationSearchTimer=setTimeout(async()=>{const result=await electronApi.aiConversationSearch(query);if(result.success&&query===conversationSearch.value.trim())conversationHits.value=result.hits||[]},220)}
function clearConversationSearch(){conversationSearch.value='';conversationHits.value=[]}
function toggleDocument(id:string){selectedDocumentIds.value=selectedDocumentIds.value.includes(id)?selectedDocumentIds.value.filter(item=>item!==id):[...selectedDocumentIds.value,id];void persistDocumentScope()}
function selectAllDocuments(){selectedDocumentIds.value=[];void persistDocumentScope()}
async function scrollMessages(){await nextTick();if(messageContainer.value)messageContainer.value.scrollTop=messageContainer.value.scrollHeight}
async function loadData(){const revision=providerRevision;const[d,t,p]=await Promise.all([electronApi.aiDocumentList(),electronApi.aiTaskList(),electronApi.aiProviderGet()]);if(d.success)documents.value=d.documents||[];if(t.success)tasks.value=t.tasks||[];if(p.success&&p.config&&revision===providerRevision)Object.assign(providerConfig,p.config);selectedDocumentIds.value=selectedDocumentIds.value.filter(id=>readyDocuments.value.some(doc=>doc.id===id))}
async function loadConversations(selectFirst=false){const result=await electronApi.aiConversationList();if(!result.success)return;conversations.value=result.conversations||[];if(activeConversationId.value&&!conversations.value.some(item=>item.id===activeConversationId.value))activeConversationId.value='';if(selectFirst&&!activeConversationId.value&&conversations.value.length)await selectConversation(conversations.value[0].id)}
function focusSources(){sourcePanel.value?.focus()}
function openSources(event?:Event){const target=event?.currentTarget;sourceTrigger=target instanceof HTMLElement?target:document.activeElement instanceof HTMLElement?document.activeElement:null;sourcesOpen.value=true;void nextTick(focusSources)}
function closeSources(){sourcesOpen.value=false;void nextTick(()=>{if(sourceTrigger?.isConnected)sourceTrigger.focus()})}
function toggleSources(event:Event){if(sourcesOpen.value)closeSources();else openSources(event)}
function onSourceVisibilityChange(value:boolean){if(!value)closeSources()}
function onWorkspaceResize(){const compact=window.innerWidth<=1450;if(compactSources.value!==compact){compactSources.value=compact;if(sourcesOpen.value)void nextTick(focusSources)}}
watch(activeView,(view,previous)=>{if(previous==='ask'&&view!=='ask'){citationPreviewVisible.value=false;citationExpanded.value=false;sourceMode.value='scope'}})
async function resumeConversation(){activeView.value='ask';if(conversations.value.length)await selectConversation(conversations.value[0].id)}
async function selectConversation(id:string){
  if(asking.value){ElMessage.warning('请先停止当前回答');return}
  const conversation=conversations.value.find(item=>item.id===id)
  if(!conversation)return
  const version=++conversationLoadVersion
  try{
    const result=await electronApi.aiConversationMessages(id)
    if(version!==conversationLoadVersion||asking.value)return
    if(!result.success)throw new Error(result.error||'读取对话失败')
    activeConversationId.value=id
    selectedDocumentIds.value=conversation.documentIds.filter(documentId=>readyDocuments.value.some(doc=>doc.id===documentId))
    chatMessages.value=(result.messages||[]).map(message=>({id:message.id,role:message.role,content:message.content,citations:message.citations}))
    if(window.innerWidth<=1050)historyOpen.value=false
    await scrollMessages()
  }catch(error){if(version===conversationLoadVersion)ElMessage.error(error instanceof Error?error.message:String(error))}
}
async function newConversation(){
  if(asking.value){ElMessage.warning('请先停止当前回答');return}
  const version=++conversationLoadVersion
  const result=await electronApi.aiConversationCreate({title:'新对话',documentIds:selectedDocumentIds.value})
  if(version!==conversationLoadVersion||asking.value)return
  if(!result.success||!result.conversation){ElMessage.error(result.error||'创建对话失败');return}
  conversations.value.unshift(result.conversation);activeConversationId.value=result.conversation.id;chatMessages.value=[]
}
async function renameConversation(conversation:AiConversation){try{const {value}=await ElMessageBox.prompt('输入新的对话名称','重命名对话',{inputValue:conversation.title,inputPattern:/\S+/,inputErrorMessage:'名称不能为空'});const result=await electronApi.aiConversationRename(conversation.id,value);if(!result.success||!result.conversation)throw new Error(result.error||'重命名失败');await loadConversations()}catch(error){if(error!=='cancel'&&error!=='close')ElMessage.error(error instanceof Error?error.message:String(error))}}
async function removeConversation(conversation:AiConversation){try{await ElMessageBox.confirm(`删除对话“${conversation.title}”及其消息记录？不会删除文档。`,'删除对话',{type:'warning'});const result=await electronApi.aiConversationDelete(conversation.id);if(!result.success)throw new Error(result.error||'删除失败');conversationLoadVersion++;if(activeConversationId.value===conversation.id){activeConversationId.value='';chatMessages.value=[]}await loadConversations(true)}catch(error){if(error!=='cancel'&&error!=='close')ElMessage.error(error instanceof Error?error.message:String(error))}}
async function persistDocumentScope(){if(!activeConversationId.value)return;const result=await electronApi.aiConversationSetDocuments(activeConversationId.value,selectedDocumentIds.value);if(result.success&&result.conversation){const index=conversations.value.findIndex(item=>item.id===result.conversation?.id);if(index>=0)conversations.value[index]=result.conversation}}
async function ensureConversation(title:string):Promise<string>{if(activeConversationId.value){if(activeConversation.value?.title==='新对话'&&!chatMessages.value.length){const renamed=await electronApi.aiConversationRename(activeConversationId.value,title.slice(0,30));if(renamed.success&&renamed.conversation){const index=conversations.value.findIndex(item=>item.id===renamed.conversation?.id);if(index>=0)conversations.value[index]=renamed.conversation}}return activeConversationId.value}const result=await electronApi.aiConversationCreate({title:title.slice(0,30),documentIds:selectedDocumentIds.value});if(!result.success||!result.conversation)throw new Error(result.error||'创建对话失败');activeConversationId.value=result.conversation.id;conversations.value.unshift(result.conversation);return result.conversation.id}
async function selectAndImport(){importing.value=true;try{const selected=await electronApi.aiSelectFiles();if(!selected.success)throw new Error(selected.error||'选择文件失败');if(!selected.files?.length)return;const result=await electronApi.aiImportFiles(selected.files.map(file=>({localPath:file.localPath,fileName:file.fileName})));if(!result.success)throw new Error(result.error||'导入失败');await loadData();activeView.value='documents';ElMessage.success(`已导入 ${result.documents?.length||0} 个文件`)}catch(error){ElMessage.error(error instanceof Error?error.message:String(error))}finally{importing.value=false}}
async function askQuestion(){
  const value=question.value.trim()
  if(!value||asking.value)return
  if(!providerConfigured.value){openProviderDialog();ElMessage.warning('请先配置 AI 模型');return}
  conversationLoadVersion++
  const assistantId=crypto.randomUUID(),attempt=beginAttempt(assistantId)
  try{
    const conversationId=await ensureConversation(value)
    if(!ownsAttempt(attempt))return
    if(editingMessageId.value&&conversationId){
      const messageIndex=chatMessages.value.findIndex(item=>item.id===editingMessageId.value)
      const truncated=await electronApi.aiConversationTruncate(conversationId,editingMessageId.value)
      if(!ownsAttempt(attempt))return
      if(!truncated.success)throw new Error(truncated.error||'无法从选中问题创建新分支')
      if(messageIndex>=0)chatMessages.value.splice(messageIndex)
      editingMessageId.value=''
    }
    if(attempt.stopRequested){currentAttempt=null;asking.value=false;pendingAssistantId.value='';return}
    chatMessages.value.push({id:crypto.randomUUID(),role:'user',content:value},{id:assistantId,role:'assistant',content:''})
    question.value=''
    await scrollMessages()
    if(!ownsAttempt(attempt))return
    await startAttempt(attempt,{question:value,documentIds:selectedDocumentIds.value,conversationId})
  }catch(error){
    if(!ownsAttempt(attempt))return
    currentAttempt=null;asking.value=false;activeRequestId.value='';pendingAssistantId.value=''
    const index=chatMessages.value.findIndex(item=>item.id===assistantId)
    if(index>=0&&!chatMessages.value[index].content)chatMessages.value.splice(index,1)
    ElMessage.error(error instanceof Error?error.message:String(error))
  }
}
function lastMessageIndex(role:'user'|'assistant'){for(let index=chatMessages.value.length-1;index>=0;index--){if(chatMessages.value[index].role===role)return index}return-1}
function isLastAssistant(message:ChatMessage){const index=lastMessageIndex('assistant');return message.role==='assistant'&&index>=0&&chatMessages.value[index].id===message.id}
async function copyAnswer(message:ChatMessage){try{await navigator.clipboard.writeText(message.content);ElMessage.success('回答已复制')}catch{ElMessage.error('复制失败，请手动选择文本')}}
async function editQuestion(message:ChatMessage){if(asking.value)return;editingMessageId.value=message.id;question.value=message.content;await nextTick();questionInput.value?.focus()}
function cancelEdit(){editingMessageId.value='';question.value=''}
function restoreRegeneratedAnswer(){
  if(!pendingRegeneration)return
  const index=chatMessages.value.findIndex(message=>message.id===pendingRegeneration?.replacementId)
  if(index>=0)chatMessages.value.splice(index,1)
  pendingRegeneration=null
}
async function regenerateAnswer(){
  if(asking.value||!activeConversationId.value)return
  const userIndex=lastMessageIndex('user'),assistantIndex=lastMessageIndex('assistant')
  const lastUser=userIndex>=0?chatMessages.value[userIndex]:undefined
  if(!lastUser||assistantIndex<userIndex)return
  const assistantId=crypto.randomUUID(),conversationId=activeConversationId.value
  conversationLoadVersion++
  pendingRegeneration={conversationId,originalId:chatMessages.value[assistantIndex].id,replacementId:assistantId}
  // Keep the saved answer and its citations visible until a replacement succeeds.
  chatMessages.value.push({id:assistantId,role:'assistant',content:''})
  const attempt=beginAttempt(assistantId)
  await scrollMessages()
  try{
    if(!ownsAttempt(attempt))return
    await startAttempt(attempt,{question:lastUser.content,documentIds:selectedDocumentIds.value,conversationId,regenerate:true})
  }catch(error){
    if(!ownsAttempt(attempt))return
    restoreRegeneratedAnswer()
    currentAttempt=null;asking.value=false;activeRequestId.value='';pendingAssistantId.value=''
    ElMessage.error(error instanceof Error?error.message:String(error))
  }
}
async function stopGeneration(){
  const attempt=currentAttempt
  if(!attempt)return
  attempt.stopRequested=true
  await cancelAttempt(attempt)
}
async function handleStreamEvent(event:AiAskStreamEvent){
  const attempt=currentAttempt
  if(!attempt||!ownsAttempt(attempt)||!asking.value)return
  // IPC events can arrive before invoke() resolves. Do not adopt an unverified
  // request ID: a delayed event may belong to the preceding conversation.
  attempt.bufferedEvents.push(event)
  await drainAttemptEvents(attempt)
}
async function drainAttemptEvents(attempt:ChatAttempt){
  if(attempt.processing||!attempt.requestId)return
  attempt.processing=true
  try{
    while(ownsAttempt(attempt)&&attempt.bufferedEvents.length){
      await applyStreamEvent(attempt,attempt.bufferedEvents.shift()!)
    }
  }finally{attempt.processing=false}
}
async function applyStreamEvent(attempt:ChatAttempt,event:AiAskStreamEvent){
  if(!ownsAttempt(attempt))return
  if(event.requestId!==attempt.requestId)return
  const message=chatMessages.value.find(item=>item.id===pendingAssistantId.value)
  if(event.type==='delta'&&message&&event.delta){message.content+=event.delta;await scrollMessages();return}
  if(event.type==='completed'&&message){
    message.content=event.answer||message.content;message.citations=event.citations||[]
    if(pendingRegeneration){
      const index=chatMessages.value.findIndex(item=>item.id===pendingRegeneration?.originalId)
      if(index>=0)chatMessages.value.splice(index,1)
      pendingRegeneration=null
    }
  }
  if(event.type==='error'){
    if(pendingRegeneration)restoreRegeneratedAnswer()
    else if(message&&!message.content)message.content=`生成失败：${event.error||'未知错误'}`
    ElMessage.error(event.error||'生成失败')
  }
  if(event.type==='cancelled'){
    if(pendingRegeneration)restoreRegeneratedAnswer()
    else if(message)message.content=`${message.content}${message.content?'\n\n':''}[已停止生成]`
    ElMessage.info('已停止生成')
  }
  if(['completed','error','cancelled'].includes(event.type)){
    const conversationId=activeConversationId.value
    currentAttempt=null;asking.value=false;activeRequestId.value='';pendingAssistantId.value=''
    try{
      await Promise.all([loadData(),loadConversations()])
      if(conversationId&&conversationId===activeConversationId.value&&event.type==='completed'&&!asking.value)await selectConversation(conversationId)
    }catch{ElMessage.warning('回答状态已保留，刷新对话列表失败，请稍后重试')}
    await scrollMessages()
  }
}
function openProviderDialog(){providerVisible.value=true}
function onProviderUpdated(config:AiProviderConfig){providerRevision++;Object.assign(providerConfig,config)}
function showDocument(document:AiDocument){selectedCitationQuote.value='';selectedCitationLocation.value='';selectedDocument.value=document;previewVisible.value=true}
function openCitation(citation:AiCitation,event?:Event){if(!documents.value.some(item=>item.id===citation.documentId)){ElMessage.warning('引用文档已经被删除');return}activeCitation.value=citation;citationPreviewVisible.value=true;citationInline.value=activeView.value==='ask';citationExpanded.value=false;if(activeView.value==='ask'){sourceMode.value='citation';openSources(event)}}
async function exportConversation(){if(!activeConversationId.value)return;const result=await electronApi.aiConversationExport(activeConversationId.value);if(!result.success)ElMessage.error(result.error||'导出失败');else if(!result.canceled)ElMessage.success('对话已导出为 Markdown')}
async function exportKnowledge(){const result=await electronApi.aiKnowledgeExport();if(!result.success)ElMessage.error(result.error||'知识库导出失败');else if(!result.canceled)ElMessage.success('完整知识库已导出为 Markdown')}
async function reindexDocument(document:AiDocument){try{const result=await electronApi.aiDocumentReindex(document.id);if(!result.success)throw new Error(result.error||'重建索引失败');await loadData();ElMessage.success('文档已重新解析并重建索引')}catch(error){ElMessage.error(error instanceof Error?error.message:String(error))}}
async function removeDocument(document:AiDocument){try{await ElMessageBox.confirm(`只删除 AI 工作台中的“${document.name}”记录和本地索引，不会删除原文件。`,'删除导入记录',{type:'warning'});const result=await electronApi.aiDocumentDelete(document.id);if(!result.success)throw new Error(result.error||'删除失败');await loadData();ElMessage.success('已删除 AI 导入记录')}catch(error){if(error!=='cancel'&&error!=='close')ElMessage.error(error instanceof Error?error.message:String(error))}}
onMounted(async()=>{
  window.addEventListener('resize',onWorkspaceResize)
  disposeProviderListener=electronApi.onAiProviderChanged(onProviderUpdated)
  disposeTaskListener=electronApi.onAiTaskUpdated(task=>{const index=tasks.value.findIndex(item=>item.id===task.id);if(index>=0)tasks.value[index]=task;else tasks.value.unshift(task)})
  disposeStreamListener=electronApi.onAiAskStreamEvent(event=>{void handleStreamEvent(event)})
  void refreshCapabilities()
  await loadData()
  await loadConversations(true)
})
onUnmounted(()=>{workspaceDisposed=true;conversationLoadVersion++;const attempt=currentAttempt;currentAttempt=null;if(attempt){attempt.stopRequested=true;void cancelAttempt(attempt)}window.removeEventListener('resize',onWorkspaceResize);disposeTaskListener?.();disposeStreamListener?.();disposeProviderListener?.();if(conversationSearchTimer)clearTimeout(conversationSearchTimer)})
</script>

<style scoped>
.ai-workspace{height:100%;overflow:auto;padding:24px;background:var(--pl-page-bg);color:var(--pl-text)}h2,h3,h4,p{margin:0}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}
.page-header,.header-copy,.title-line,.header-actions,.panel-heading,.document-name,.row-actions{display:flex;align-items:center}.page-header{justify-content:space-between;gap:16px;margin-bottom:18px}.header-copy{gap:12px;min-width:0}.header-icon,.file-icon,.capability-icon{display:grid;place-items:center;flex-shrink:0;color:var(--pl-primary);background:var(--pl-primary-soft);border-radius:8px}.header-icon{width:42px;height:42px}.title-line{gap:10px}.title-line h2{font-size:var(--pl-font-xl)}.title-line>span{color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.header-copy p{margin-top:4px;color:var(--pl-text-secondary);font-size:var(--pl-font-sm)}.header-actions{gap:8px;flex-wrap:wrap}.header-actions :deep(.el-button){gap:6px;margin-left:0}
.workspace-tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--pl-border);overflow:auto}.workspace-tabs>button{display:flex;align-items:center;gap:7px;flex-shrink:0;height:42px;padding:0 14px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--pl-text-secondary);font-size:var(--pl-font-md)}.workspace-tabs>button:hover{color:var(--pl-primary)}.workspace-tabs>button.active{border-bottom-color:var(--pl-primary);color:var(--pl-primary);font-weight:600}.tab-count{font-size:var(--pl-font-xs);padding:1px 5px;border-radius:6px;background:var(--pl-hover)}
.processing-strip{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:10px 12px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface);font-size:var(--pl-font-xs);color:var(--pl-text-secondary)}.processing-strip>svg{color:var(--pl-primary)}.processing-strip strong{color:var(--pl-text)}.processing-strip>span{padding-left:12px;border-left:1px solid var(--pl-border)}.processing-strip button{margin-left:auto;border:0;background:none;color:var(--pl-primary);font:inherit}
.workspace-start{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.6fr);gap:24px;padding:24px;border:1px solid var(--pl-border);border-radius:12px;background:var(--pl-surface)}.kicker{color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.start-copy h3{margin:6px 0;font-size:var(--pl-font-xl)}.start-copy p{color:var(--pl-text-secondary);font-size:var(--pl-font-sm)}.start-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.start-actions :deep(.el-button){gap:6px;margin-left:0}.configuration-summary{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;border-left:1px solid var(--pl-border);padding:8px 0 8px 24px}.configuration-summary>svg{color:var(--pl-primary);flex-shrink:0}.configuration-summary>div{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px}.configuration-summary strong{font-size:var(--pl-font-md)}.configuration-summary small{overflow-wrap:anywhere;color:var(--pl-text-secondary)}.configuration-summary span{font-size:var(--pl-font-xs);line-height:1.6;color:var(--pl-text-muted)}.configuration-summary>.link-button{margin-left:34px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0}.stats article{display:grid;grid-template-columns:36px 1fr;gap:3px 10px;padding:14px;border:1px solid var(--pl-border);border-radius:10px;background:var(--pl-surface)}.stats svg{grid-row:1/3;align-self:center;color:var(--pl-primary)}.stats strong{font-size:var(--pl-font-xl)}.stats span{font-size:var(--pl-font-xs);color:var(--pl-text-secondary)}
.panel{margin-top:14px;padding:20px;border:1px solid var(--pl-border);border-radius:12px;background:var(--pl-surface)}.panel-heading{justify-content:space-between;gap:12px;margin-bottom:16px}.panel-heading h3{margin-top:4px;font-size:var(--pl-font-lg)}.panel-actions{display:flex;gap:8px;flex-wrap:wrap}.panel-actions :deep(.el-button){margin-left:0;gap:5px}.link-button{display:inline-flex;align-items:center;gap:5px;border:0;background:none;color:var(--pl-primary);font-size:var(--pl-font-sm)}.spinning{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.capability-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.capability-grid article{position:relative;padding:16px;border:1px solid var(--pl-border);border-radius:10px}.capability-icon{width:36px;height:36px}.capability-state{position:absolute;right:12px;top:16px;font-size:var(--pl-font-xs);padding:3px 6px;border-radius:5px;color:var(--pl-warning);background:var(--pl-warning-soft)}.capability-state.ready{color:var(--pl-success);background:var(--pl-success-soft)}.capability-grid h4{margin:12px 0 6px;font-size:var(--pl-font-md)}.capability-grid p{min-height:42px;font-size:var(--pl-font-sm);line-height:1.65;color:var(--pl-text-secondary)}.capability-grid article>div{display:flex;gap:5px;flex-wrap:wrap;margin-top:12px}.capability-grid article>div small,.format-tag{padding:3px 6px;border-radius:5px;background:var(--pl-hover);color:var(--pl-text-secondary);font-size:var(--pl-font-xs)}
.recent-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.recent-grid button{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface);color:var(--pl-text);text-align:left}.recent-grid button:hover{background:var(--pl-hover)}.file-icon{width:32px;height:32px}.recent-grid button>span:nth-child(2){display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}.recent-grid strong{font-size:var(--pl-font-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recent-grid small{color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.recent-grid button>svg{color:var(--pl-text-muted)}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;color:var(--pl-text-muted);font-size:var(--pl-font-sm);text-align:center}.empty strong{font-size:var(--pl-font-md);color:var(--pl-text-secondary)}.empty.large{min-height:260px}
.chat-layout{position:relative;display:grid;grid-template-columns:220px minmax(0,1fr);height:calc(100vh - 248px);min-height:420px;border:1px solid var(--pl-border);border-radius:12px;background:var(--pl-surface);overflow:hidden}.chat-layout.history-collapsed{grid-template-columns:minmax(0,1fr)}.chat-layout.sources-open{grid-template-columns:220px minmax(0,1fr) 310px}.chat-layout.history-collapsed.sources-open{grid-template-columns:minmax(0,1fr) 310px}.scope-panel,.source-panel{display:flex;flex-direction:column;min-height:0;padding:16px;background:var(--pl-surface-subtle)}.scope-panel{border-right:1px solid var(--pl-border)}.source-panel{border-left:1px solid var(--pl-border);padding:0;overflow:hidden}.source-body{display:flex;flex-direction:column;min-height:0;height:100%;padding:16px;overflow:auto;outline:none;box-sizing:border-box;background:var(--pl-surface-subtle)}:global(.ai-source-drawer .el-drawer__body){padding:0;overflow:hidden}.conversation-heading,.scope-title,.source-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.conversation-heading h3,.scope-title h3{font-size:var(--pl-font-md);margin-top:4px}.sidebar-heading-actions{display:flex;gap:4px}.sidebar-heading-actions button,.source-heading button,.history-toggle{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;color:var(--pl-text-secondary);background:transparent}.sidebar-heading-actions button:hover,.source-heading button:hover,.history-toggle:hover{background:var(--pl-hover);color:var(--pl-primary)}.conversation-search{display:flex;align-items:center;gap:6px;margin:14px 0 10px;padding:8px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface);color:var(--pl-text-muted)}.conversation-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--pl-text);font-size:var(--pl-font-xs)}.conversation-search>svg:last-child{cursor:pointer}.conversation-list{flex:1;overflow:auto}.conversation-item{display:grid;grid-template-columns:minmax(0,1fr) 22px 22px;gap:2px;align-items:center;padding:6px 3px;border-radius:7px;margin-bottom:4px}.conversation-item:hover{background:var(--pl-hover)}.conversation-item.active{background:var(--pl-primary-soft)}.conversation-item>button{display:grid;place-items:center;padding:3px;border:0;background:transparent;color:var(--pl-text-muted)}.conversation-item>button:hover{color:var(--pl-primary)}.conversation-main{display:flex!important;align-items:center;gap:7px;min-width:0;text-align:left;color:var(--pl-text-secondary)!important}.conversation-main svg{flex-shrink:0}.conversation-main>span{display:flex;min-width:0;flex-direction:column;gap:4px}.conversation-main strong,.conversation-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--pl-font-xs)}.conversation-main small{font-weight:400;color:var(--pl-text-muted)}.conversation-item.active .conversation-main{color:var(--pl-primary)!important}.history-empty{color:var(--pl-text-muted);font-size:var(--pl-font-xs);line-height:1.6;padding:12px 0}.new-conversation{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;padding:9px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface);color:var(--pl-primary)}
.chat-panel{display:flex;min-height:0;min-width:0;flex-direction:column}.chat-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--pl-border)}.chat-toolbar>div{display:flex;align-items:center;gap:8px;min-width:0}.chat-toolbar strong{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--pl-font-sm)}.chat-toolbar small{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.chat-toolbar i{width:7px;height:7px;flex-shrink:0;border-radius:50%;background:var(--pl-text-muted)}.chat-toolbar i.active{background:var(--pl-primary)}.chat-tools{display:flex;align-items:center;gap:8px;flex-shrink:0}.chat-tools button{display:flex;align-items:center;gap:4px;padding:4px;border:0;background:none;color:var(--pl-text-secondary);font-size:var(--pl-font-xs)}.chat-tools button:hover{color:var(--pl-primary)}
.messages{flex:1;min-height:0;overflow:auto;padding:24px}.welcome{max-width:620px;margin:35px auto;text-align:center}.welcome>span{display:inline-grid;place-items:center;width:56px;height:56px;border-radius:14px;color:var(--pl-primary);background:var(--pl-primary-soft)}.welcome h3{margin:16px 0 8px;font-size:var(--pl-font-xl)}.welcome p{font-size:var(--pl-font-sm);line-height:1.8;color:var(--pl-text-secondary)}.welcome>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:22px}.welcome button{padding:12px;border:1px solid var(--pl-border);border-radius:8px;color:var(--pl-text-secondary);background:var(--pl-surface);font-size:var(--pl-font-sm)}.welcome button:hover{border-color:var(--pl-primary);color:var(--pl-primary)}
.message{display:flex;align-items:flex-start;gap:10px;max-width:880px;margin:0 auto 24px}.avatar{display:grid;place-items:center;flex-shrink:0;width:30px;height:30px;border-radius:8px;color:var(--pl-primary);background:var(--pl-primary-soft)}.message>div{min-width:0;flex:1}.message>div>small{display:block;margin:5px 0 8px;color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.message.user>div>p{padding:12px 14px;border-radius:8px;background:var(--pl-primary-soft);color:var(--pl-text);white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--pl-font-md);line-height:1.7}.message-actions{display:flex;gap:6px;margin-top:8px}.message-actions button{display:flex;align-items:center;gap:4px;padding:4px 6px;border:0;border-radius:5px;background:none;color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.message-actions button:hover{color:var(--pl-primary);background:var(--pl-primary-soft)}.citations{display:flex;flex-direction:column;gap:6px;margin-top:12px}.citations details{border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface-subtle)}.citations summary{padding:8px 10px;color:var(--pl-primary);font-size:var(--pl-font-xs);cursor:pointer;overflow-wrap:anywhere}.citations summary span{margin-left:6px;color:var(--pl-text-muted)}.citations p{padding:0 10px 10px;font-size:var(--pl-font-xs);color:var(--pl-text-secondary);line-height:1.7}.thinking{display:flex;align-items:center;gap:5px;max-width:880px;margin:8px auto;color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.thinking i{width:4px;height:4px;border-radius:50%;background:var(--pl-primary)}.thinking span{margin-left:5px}
.composer{margin:0 20px 16px;padding:12px 14px;border:1px solid var(--pl-border-strong);border-radius:10px;background:var(--pl-surface)}.composer:focus-within{border-color:var(--pl-primary);box-shadow:0 0 0 3px var(--pl-primary-soft)}.composer textarea{display:block;width:100%;resize:none;border:0;outline:0;background:transparent;color:var(--pl-text);font-family:inherit;font-size:var(--pl-font-md);line-height:1.65}.composer>div:last-child{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.composer small{color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.composer button{display:flex;align-items:center;gap:5px;padding:8px 12px;border:0;border-radius:7px;background:var(--pl-primary);color:#fff;font-size:var(--pl-font-sm)}.composer .stop-button{color:var(--pl-danger);background:var(--pl-danger-soft)}.editing-tip{display:flex;align-items:center;gap:6px;margin-bottom:10px;padding:6px 8px;border-radius:6px;background:var(--pl-warning-soft);color:var(--pl-warning);font-size:var(--pl-font-xs)}.editing-tip span{flex:1}.editing-tip button{padding:2px!important;background:none!important;color:inherit!important}
.source-heading strong{font-size:var(--pl-font-md)}.source-tabs{display:flex;gap:4px;margin:12px 0 20px;padding:3px;border-radius:8px;background:var(--pl-hover)}.source-tabs button{flex:1;padding:7px 4px;border:0;border-radius:6px;background:none;color:var(--pl-text-secondary);font-size:var(--pl-font-xs)}.source-tabs button.active{background:var(--pl-surface);color:var(--pl-primary)}.scope-title{margin-bottom:12px}.scope-title>small{color:var(--pl-text-muted)}.all-documents{display:flex;align-items:center;gap:8px;width:100%;padding:10px 8px;border:1px solid var(--pl-border);border-radius:8px;text-align:left;background:var(--pl-surface);color:var(--pl-text-secondary)}.all-documents.active{background:var(--pl-primary-soft);border-color:var(--pl-primary);color:var(--pl-primary)}.all-documents>span:nth-child(2){display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}.all-documents strong,.scope-list strong{font-size:var(--pl-font-xs)}.all-documents small,.scope-list small{color:var(--pl-text-muted);font-size:var(--pl-font-xs)}.scope-list{flex:1;min-height:0;overflow:auto;margin:8px 0}.scope-list label{display:flex;align-items:center;gap:7px;padding:9px 4px;border-radius:7px;cursor:pointer}.scope-list label:hover{background:var(--pl-hover)}.scope-list input{accent-color:var(--pl-primary);flex-shrink:0}.scope-list label>span:last-child{display:flex;flex-direction:column;gap:4px;min-width:0}.scope-list strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scope-list .file-icon{width:26px;height:26px}.scope-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 0;color:var(--pl-text-muted);font-size:var(--pl-font-sm)}.scope-empty button{border:0;background:none;color:var(--pl-primary)}.privacy-tip{display:flex;align-items:flex-start;gap:7px;margin-top:auto;padding-top:12px;border-top:1px solid var(--pl-border);font-size:var(--pl-font-xs);line-height:1.7;color:var(--pl-text-muted)}.privacy-tip svg{flex-shrink:0;margin-top:3px}.source-content{min-width:0}.source-content h4{margin-bottom:10px;font-size:var(--pl-font-sm);overflow-wrap:anywhere}.expand-citation{display:flex;align-items:center;gap:5px;margin:0 0 12px;padding:6px 8px;border:1px solid var(--pl-border);border-radius:6px;color:var(--pl-primary);background:var(--pl-surface);font-size:var(--pl-font-xs)}
.document-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}.document-filters label{display:flex;align-items:center;gap:8px;flex:1;min-width:220px;max-width:500px;padding:9px 12px;border:1px solid var(--pl-border);border-radius:8px;color:var(--pl-text-muted)}.document-filters input{flex:1;min-width:0;border:0;background:transparent;outline:0;color:var(--pl-text);font-size:var(--pl-font-sm)}.document-filters label>button{display:grid;place-items:center;border:0;background:none;color:var(--pl-text-muted)}.document-filters select{padding:8px 10px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface);color:var(--pl-text-secondary)}.document-filters>span{font-size:var(--pl-font-xs);color:var(--pl-text-muted)}.document-table{border:1px solid var(--pl-border);border-radius:8px;overflow:hidden}.document-row{display:grid;grid-template-columns:minmax(240px,1.8fr) .55fr .65fr .8fr .85fr 100px;align-items:center;gap:14px;min-height:62px;padding:10px 14px;border-top:1px solid var(--pl-border);color:var(--pl-text-secondary);font-size:var(--pl-font-sm);cursor:pointer}.document-row:hover:not(.head){background:var(--pl-hover)}.document-row.head{min-height:38px;padding:8px 14px;border-top:0;background:var(--pl-surface-subtle);font-size:var(--pl-font-xs);cursor:default}.document-name{gap:9px;min-width:0}.document-name>span:last-child{display:flex;flex-direction:column;gap:4px;min-width:0}.document-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pl-text);font-weight:500}.document-name small{font-size:var(--pl-font-xs);color:var(--pl-text-muted)}.document-name .document-notice{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pl-warning)}.document-name .document-notice.failed{color:var(--pl-danger)}.status{display:inline-block;padding:4px 7px;border-radius:5px;font-style:normal;font-size:var(--pl-font-xs);background:var(--pl-hover);color:var(--pl-text-secondary)}.status.ready{color:var(--pl-success);background:var(--pl-success-soft)}.status.awaiting_parser{color:var(--pl-warning);background:var(--pl-warning-soft)}.status.failed,.status.unsupported{color:var(--pl-danger);background:var(--pl-danger-soft)}.row-actions{justify-content:flex-end;gap:4px}.row-actions button{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:6px;color:var(--pl-text-secondary);background:transparent}.row-actions button:hover{color:var(--pl-primary);background:var(--pl-primary-soft)}
.task-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}.task-filters button{padding:7px 10px;border:1px solid var(--pl-border);border-radius:7px;color:var(--pl-text-secondary);background:var(--pl-surface);font-size:var(--pl-font-xs)}.task-filters button.active{border-color:var(--pl-primary);background:var(--pl-primary-soft);color:var(--pl-primary)}.task-filters span{margin-left:4px;color:var(--pl-text-muted)}.task-list{display:flex;flex-direction:column;gap:8px}.task-list article{display:grid;grid-template-columns:34px minmax(0,1fr) 150px 110px;align-items:center;gap:12px;padding:14px;border:1px solid var(--pl-border);border-radius:8px}.task-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:8px;background:var(--pl-primary-soft);color:var(--pl-primary)}.task-icon.success{background:var(--pl-success-soft);color:var(--pl-success)}.task-icon.failed{background:var(--pl-danger-soft);color:var(--pl-danger)}.task-icon.cancelled{background:var(--pl-hover);color:var(--pl-text-muted)}.task-list article>div{display:flex;flex-direction:column;min-width:0;gap:5px}.task-list strong{font-size:var(--pl-font-sm);overflow-wrap:anywhere}.task-list small,.task-list time{font-size:var(--pl-font-xs);color:var(--pl-text-secondary);overflow-wrap:anywhere}.task-list time{text-align:right}.document-row,.task-list article{content-visibility:auto;contain-intrinsic-size:auto 62px}
.preview-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.preview-meta span{display:flex;flex-direction:column;gap:5px;padding:10px;border-radius:8px;background:var(--pl-surface-subtle);color:var(--pl-text-secondary);font-size:var(--pl-font-sm)}.preview-meta strong{font-size:var(--pl-font-xs);color:var(--pl-text-muted)}.parse-notice{margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--pl-warning-soft);color:var(--pl-text-secondary);font-size:var(--pl-font-sm);line-height:1.7}.preview{max-height:390px;overflow:auto;margin-top:12px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface-subtle)}.preview pre{margin:0;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 Consolas,monospace}.citation-focus{margin-top:12px;padding:12px;background:var(--pl-primary-soft);border-radius:8px}.citation-focus strong{color:var(--pl-primary)}.citation-focus span{margin-left:8px;color:var(--pl-text-secondary);font-size:var(--pl-font-xs)}.citation-focus p{margin-top:8px;line-height:1.7}
@media(max-width:1450px){.chat-toolbar small{display:none}.chat-layout.sources-open,.chat-layout.history-collapsed.sources-open{grid-template-columns:220px minmax(0,1fr)}.chat-layout.history-collapsed.sources-open{grid-template-columns:minmax(0,1fr)}.document-row{grid-template-columns:minmax(210px,1.6fr) .5fr .6fr .8fr 90px}.document-row>span:nth-child(5){display:none}}
@media(max-width:1050px){.page-header{align-items:flex-start}.header-actions{justify-content:flex-end}.workspace-start{grid-template-columns:minmax(0,1fr)}.configuration-summary{border-left:0;border-top:1px solid var(--pl-border);padding:16px 0 0}.configuration-summary>.link-button{margin-left:0}.chat-layout,.chat-layout.sources-open{grid-template-columns:minmax(0,1fr)}.history-panel{position:absolute;left:0;top:0;bottom:0;width:240px;z-index:2;box-shadow:var(--pl-shadow-float)}.capability-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.task-list article{grid-template-columns:34px minmax(0,1fr) 100px}.task-list time{grid-column:2/4;text-align:left}}
@media(max-width:760px){.ai-workspace{padding:16px}.page-header{flex-direction:column}.header-actions{justify-content:flex-start}.workspace-start{padding:18px;gap:18px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.chat-layout{min-height:500px;height:calc(100vh - 290px)}.chat-toolbar{padding:10px}.chat-toolbar strong{max-width:110px}.chat-tools{gap:3px}.chat-tools button{font-size:11px}.messages{padding:16px 12px}.composer{margin:0 10px 10px;padding:10px}.welcome>div{grid-template-columns:minmax(0,1fr)}.panel{padding:16px}.panel-heading{align-items:flex-start;flex-wrap:wrap}.recent-grid{grid-template-columns:minmax(0,1fr)}.document-table{overflow-x:auto}.document-row{min-width:660px}.preview-meta{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:500px){.capability-grid{grid-template-columns:minmax(0,1fr)}.processing-strip{gap:8px}.processing-strip>span{padding-left:0;border-left:0}.processing-strip button{margin-left:0}.start-actions{gap:6px}.start-actions :deep(.el-button){font-size:12px}.chat-toolbar strong{max-width:80px}}
/* Question input follows the available application area, including display scaling. */
.ai-workspace{box-sizing:border-box}.ask-workspace{display:flex;flex-direction:column;min-height:0;overflow:hidden}.ask-workspace>.page-header,.ask-workspace>.workspace-tabs,.ask-workspace>.processing-strip{flex-shrink:0}.ask-workspace>main{display:flex;flex:1;min-height:0;min-width:0}.ask-workspace .chat-layout{flex:1;height:auto;min-height:0;min-width:0}.ask-workspace .chat-toolbar,.ask-workspace .composer{flex-shrink:0}.ask-workspace .new-conversation,.ask-workspace .conversation-search,.ask-workspace .conversation-heading{flex-shrink:0}
@media(max-height:650px){.ask-workspace{padding:12px 16px}.ask-workspace .page-header{margin-bottom:10px;gap:10px}.ask-workspace .header-copy p,.ask-workspace .title-line>span{display:none}.ask-workspace .header-icon{width:32px;height:32px}.ask-workspace .workspace-tabs{margin-bottom:8px}.ask-workspace .workspace-tabs>button{height:34px;padding:0 10px;font-size:var(--pl-font-sm)}.ask-workspace .processing-strip{padding:6px 10px;gap:8px;margin-bottom:8px}.ask-workspace .processing-strip>span:nth-of-type(2){display:none}.ask-workspace .chat-toolbar{padding:8px 12px}.ask-workspace .messages{padding:12px}.ask-workspace .composer{padding:8px 10px;margin:0 10px 10px}.ask-workspace .composer textarea{height:42px;min-height:0}.ask-workspace .composer>div:last-child{margin-top:4px}.ask-workspace .composer button{padding:6px 10px}.ask-workspace .welcome{margin:16px auto}}
@media(max-height:550px){.ask-workspace .header-icon{display:none}.ask-workspace .title-line h2{font-size:18px}.ask-workspace .header-actions :deep(.el-button){height:28px;padding:0 8px;font-size:var(--pl-font-xs)}.ask-workspace .page-header{margin-bottom:8px;flex-direction:row;align-items:center}.ask-workspace .header-actions{gap:5px}.ask-workspace .composer small{font-size:11px}.ask-workspace .chat-toolbar small{display:none}}
:global(.ai-document-dialog.el-dialog){display:flex;flex-direction:column;max-height:calc(100vh - 48px)}:global(.ai-document-dialog .el-dialog__body){flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}:global(.ai-document-dialog .el-dialog__header){flex-shrink:0}
</style>
