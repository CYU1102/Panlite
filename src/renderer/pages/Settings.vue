<template>
  <div class="settings-page">
    <!-- Page header -->
    <div class="page-header">
      <div class="header-info">
        <div class="header-icon">
          <SettingsIcon :size="20" :stroke-width="1.5" />
        </div>
        <div>
          <h2>设置</h2>
          <p>配置应用参数和偏好</p>
        </div>
      </div>
    </div>

    <!-- Settings sections -->
    <div class="settings-sections">
      <!-- Baidu OAuth settings -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-icon">
            <Key :size="16" />
          </div>
          <div>
            <h3>百度网盘 OAuth</h3>
            <p>配置百度开放平台应用凭证</p>
          </div>
        </div>
        <div class="setting-body">
          <el-alert
            title="OAuth 需要百度网盘开放平台应用凭证；请先创建并启用包含 netdisk 权限的应用。"
            type="info"
            :closable="false"
            show-icon
            class="oauth-config-alert"
          >
            <template #default>
              <el-button link type="primary" @click="electronApi.openExternal('https://yun.baidu.com/open/platform')">
                打开百度网盘开放平台
              </el-button>
            </template>
          </el-alert>
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">Client ID</span>
              <span class="label-hint">百度开放平台应用的 AppKey</span>
            </div>
            <el-input v-model="form.baiduClientId" placeholder="百度 Client ID" style="width: 320px" />
          </div>
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">Client Secret</span>
              <span class="label-hint">百度开放平台应用的 SecretKey（加密存储）</span>
            </div>
            <el-input v-model="form.baiduClientSecret" placeholder="百度 Client Secret" type="password" show-password style="width: 320px" />
          </div>
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">Redirect URI</span>
              <span class="label-hint">桌面授权建议使用 oob，授权完成后页面会显示授权码</span>
            </div>
            <el-input v-model="form.baiduRedirectUri" placeholder="oob" style="width: 320px" />
          </div>
        </div>
      </div>

      <!-- Page size settings -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-icon">
            <Gauge :size="16" />
          </div>
          <div>
            <h3>请求设置</h3>
            <p>控制分页大小和请求间隔</p>
          </div>
        </div>
        <div class="setting-body">
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">夸克 / UC 每页数量</span>
              <span class="label-hint">文件列表和搜索 API 每次返回的文件数</span>
            </div>
            <el-input-number v-model="form.quarkPageSize" :min="20" :max="500" :step="20" size="small" />
          </div>
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">百度每页数量</span>
              <span class="label-hint">每次 API 请求返回的文件数</span>
            </div>
            <el-input-number v-model="form.baiduPageSize" :min="20" :max="1000" :step="50" size="small" />
          </div>
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">请求间隔 (ms)</span>
              <span class="label-hint">分页请求之间的延迟，防止触发限流</span>
            </div>
            <el-input-number v-model="form.requestDelayMs" :min="0" :max="5000" :step="100" size="small" />
          </div>
        </div>
      </div>

      <!-- Ad filter settings -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-icon">
            <Shield :size="16" />
          </div>
          <div>
            <h3>广告过滤</h3>
            <p>转存后自动扫描并删除广告文件（参考 xinyue-search）</p>
          </div>
        </div>
        <div class="setting-body">
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">启用广告过滤</span>
              <span class="label-hint">转存后自动检查文件名是否包含广告关键词</span>
            </div>
            <el-switch v-model="form.adFilterEnabled" />
          </div>
          <div class="setting-row">
            <div class="setting-label">
              <span class="label-text">广告关键词</span>
              <span class="label-hint">逗号分隔，文件名包含任一关键词则视为广告</span>
            </div>
            <el-input
              v-model="form.bannedKeywords"
              type="textarea"
              :rows="3"
              placeholder="公众号,微信,关注,广告,推广..."
              style="width: 320px"
              :disabled="!form.adFilterEnabled"
            />
          </div>
        </div>
      </div>

      <!-- Search Sources -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-icon">
            <Search :size="16" />
          </div>
          <div>
            <h3>搜索源管理</h3>
            <p>配置全网资源搜索的数据源</p>
          </div>
        </div>
        <div class="setting-body">
          <div class="search-sources-toolbar">
            <el-button size="small" type="primary" @click="onAddSource">
              <Plus :size="14" style="margin-right: 4px" />
              添加搜索源
            </el-button>
            <el-button size="small" type="success" @click="batchImportVisible = true">
              <Upload :size="14" style="margin-right: 4px" />
              批量导入
            </el-button>
            <el-button size="small" type="danger" @click="onBatchDeleteSources" :disabled="sourceSelectedRows.length === 0">
              <Delete :size="14" style="margin-right: 4px" />
              批量删除 ({{ sourceSelectedRows.length }})
            </el-button>
            <el-button size="small" @click="loadSearchSources">刷新</el-button>
          </div>
          <el-table :data="searchSources" size="small" max-height="300" stripe @selection-change="onSourceSelectionChange">
            <el-table-column type="selection" width="40" />
            <el-table-column prop="name" label="名称" width="120" />
            <el-table-column prop="type" label="类型" width="60">
              <template #default="{ row }">
                <el-tag :type="row.type === 'api' ? 'primary' : 'success'" size="small">{{ row.type }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="platform" label="平台" width="80">
              <template #default="{ row }">{{ getPlatformLabel(row.platform) }}</template>
            </el-table-column>
            <el-table-column prop="category" label="分类" width="120" />
            <el-table-column prop="url" label="URL" show-overflow-tooltip />
            <el-table-column prop="status" label="状态" width="60">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">{{ row.status === 1 ? '启用' : '禁用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="onEditSource(row)">编辑</el-button>
                <el-button link type="success" size="small" @click="onTestSource(row)">测试</el-button>
                <el-button link type="danger" size="small" @click="onDeleteSource(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <!-- Search Source Dialog -->
      <el-dialog v-model="sourceDialogVisible" :title="editingSource.id ? '编辑搜索源' : '添加搜索源'" width="560px">
        <el-form label-width="80px" size="small">
          <el-form-item label="名称">
            <el-input v-model="editingSource.name" placeholder="搜索源名称" />
          </el-form-item>
          <el-form-item label="类型">
            <el-select v-model="editingSource.type" style="width: 100%">
              <el-option label="API (JSON)" value="api" />
              <el-option label="HTML (网页)" value="html" />
            </el-select>
          </el-form-item>
          <el-form-item label="平台">
            <el-select v-model="editingSource.platform" style="width: 100%">
              <el-option label="夸克网盘" value="quark" />
              <el-option label="百度网盘" value="baidu" />
              <el-option label="UC网盘" value="uc" />
              <el-option label="迅雷网盘" value="xunlei" />
              <el-option label="全部" value="all" />
            </el-select>
          </el-form-item>
          <el-form-item label="URL">
            <el-input v-model="editingSource.url" placeholder="搜索 URL，用 {keyword} 作为关键词占位符" />
          </el-form-item>
          <el-form-item label="请求方式" v-if="editingSource.type === 'api'">
            <el-select v-model="editingSource.method" style="width: 100%">
              <el-option label="GET" value="GET" />
              <el-option label="POST" value="POST" />
            </el-select>
          </el-form-item>
          <el-form-item label="请求参数" v-if="editingSource.type === 'api'">
            <el-input v-model="editingSource.paramsStr" type="textarea" :rows="2" placeholder='{"key": "{keyword}"}' />
          </el-form-item>
          <el-form-item label="请求头" v-if="editingSource.type === 'api'">
            <el-input v-model="editingSource.headersStr" type="textarea" :rows="2" placeholder='{"Authorization": "Bearer xxx"}' />
          </el-form-item>
          <el-form-item label="字段映射" v-if="editingSource.type === 'api'">
            <el-input v-model="editingSource.fieldMapStr" type="textarea" :rows="3" placeholder='{"list_path": "data.list", "fields": {"title": "name", "url": "link"}}' />
          </el-form-item>
          <el-form-item label="最大结果" >
            <el-input-number v-model="editingSource.max_count" :min="1" :max="100" />
          </el-form-item>
          <el-form-item label="权重">
            <el-input-number v-model="editingSource.weight" :min="0" :max="999" />
          </el-form-item>
          <el-form-item label="状态">
            <el-switch v-model="editingSource.status" :active-value="1" :inactive-value="0" active-text="启用" inactive-text="禁用" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="sourceDialogVisible = false">取消</el-button>
          <el-button type="primary" @click="onSaveSource">保存</el-button>
        </template>
      </el-dialog>

      <!-- Batch Import Dialog -->
      <el-dialog v-model="batchImportVisible" title="批量导入资源站" width="600px">
        <div class="batch-import-hint">
          <p>粘贴网址（每行一个），系统自动保存为资源站：</p>
          <p class="form-hint">只保留网址，其他格式自动过滤</p>
        </div>
        <el-input
          v-model="batchImportText"
          type="textarea"
          :rows="12"
          placeholder="每行一个网址，例如：
https://www.xunjiso.com
https://www.soali.net
https://pan.funletu.com"
        />
        <template #footer>
          <el-button @click="batchImportVisible = false">取消</el-button>
          <el-button type="primary" @click="onBatchImport" :loading="batchImporting">
            导入 ({{ batchImportCount }} 个)
          </el-button>
        </template>
      </el-dialog>

      <!-- TG Channels -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-icon">
            <Hash :size="16" />
          </div>
          <div>
            <h3>TG频道订阅</h3>
            <p>从Telegram频道搜索网盘资源（无需第三方API）</p>
          </div>
        </div>
        <div class="setting-body">
          <div class="search-sources-toolbar">
            <el-button size="small" type="primary" @click="onAddTgChannel">
              <Plus :size="14" style="margin-right: 4px" />
              添加频道
            </el-button>
            <el-button size="small" type="danger" @click="onBatchDeleteTg" :disabled="tgSelectedRows.length === 0">
              <Delete :size="14" style="margin-right: 4px" />
              批量删除 ({{ tgSelectedRows.length }})
            </el-button>
            <el-button size="small" @click="loadTgChannels">刷新</el-button>
          </div>
          <el-table :data="tgChannels" size="small" max-height="300" stripe @selection-change="onTgSelectionChange">
            <el-table-column type="selection" width="40" />
            <el-table-column prop="name" label="名称" width="120" />
            <el-table-column prop="channel" label="频道" width="150" />
            <el-table-column prop="platform" label="平台" width="80">
              <template #default="{ row }">{{ getPlatformLabel(row.platform) }}</template>
            </el-table-column>
            <el-table-column prop="weight" label="权重" width="60" />
            <el-table-column prop="status" label="状态" width="60">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">{{ row.status === 1 ? '启用' : '禁用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="onEditTgChannel(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="onDeleteTgChannel(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <!-- TG Channel Dialog -->
      <el-dialog v-model="tgDialogVisible" :title="editingTgChannel.id ? '编辑TG频道' : '添加TG频道'" width="480px">
        <el-form label-width="80px" size="small">
          <el-form-item label="名称">
            <el-input v-model="editingTgChannel.name" placeholder="频道名称" />
          </el-form-item>
          <el-form-item label="频道">
            <el-input v-model="editingTgChannel.channel" placeholder="频道名（不含 https://t.me/）" />
          </el-form-item>
          <el-form-item label="平台">
            <el-select v-model="editingTgChannel.platform" style="width: 100%">
              <el-option label="夸克网盘" value="quark" />
              <el-option label="百度网盘" value="baidu" />
              <el-option label="UC网盘" value="uc" />
              <el-option label="迅雷网盘" value="xunlei" />
            </el-select>
          </el-form-item>
          <el-form-item label="最大结果">
            <el-input-number v-model="editingTgChannel.max_count" :min="1" :max="100" />
          </el-form-item>
          <el-form-item label="权重">
            <el-input-number v-model="editingTgChannel.weight" :min="0" :max="999" />
          </el-form-item>
          <el-form-item label="状态">
            <el-switch v-model="editingTgChannel.status" :active-value="1" :inactive-value="0" active-text="启用" inactive-text="禁用" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="tgDialogVisible = false">取消</el-button>
          <el-button type="primary" @click="onSaveTgChannel">保存</el-button>
        </template>
      </el-dialog>

      <!-- Crawler Sources -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-icon">
            <Globe :size="16" />
          </div>
          <div>
            <h3>网页爬虫源</h3>
            <p>配置网页爬虫提取网盘资源（支持自定义CSS选择器）</p>
          </div>
        </div>
        <div class="setting-body">
          <div class="search-sources-toolbar">
            <el-button size="small" type="primary" @click="onAddCrawlerSource">
              <Plus :size="14" style="margin-right: 4px" />
              添加爬虫源
            </el-button>
            <el-button size="small" type="danger" @click="onBatchDeleteCrawler" :disabled="crawlerSelectedRows.length === 0">
              <Delete :size="14" style="margin-right: 4px" />
              批量删除 ({{ crawlerSelectedRows.length }})
            </el-button>
            <el-button size="small" @click="loadCrawlerSources">刷新</el-button>
          </div>
          <el-table :data="crawlerSources" size="small" max-height="300" stripe @selection-change="onCrawlerSelectionChange">
            <el-table-column type="selection" width="40" />
            <el-table-column prop="name" label="名称" width="120" />
            <el-table-column prop="platform" label="平台" width="80">
              <template #default="{ row }">{{ getPlatformLabel(row.platform) }}</template>
            </el-table-column>
            <el-table-column prop="html_type" label="提取方式" width="80">
              <template #default="{ row }">
                <el-tag :type="row.html_type === 0 ? 'primary' : 'warning'" size="small">{{ row.html_type === 0 ? '直接' : '详情页' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="url" label="URL" show-overflow-tooltip />
            <el-table-column prop="status" label="状态" width="60">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">{{ row.status === 1 ? '启用' : '禁用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="onEditCrawlerSource(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="onDeleteCrawlerSource(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <!-- Crawler Source Dialog -->
      <el-dialog v-model="crawlerDialogVisible" :title="editingCrawlerSource.id ? '编辑爬虫源' : '添加爬虫源'" width="600px">
        <el-form label-width="100px" size="small">
          <el-form-item label="名称">
            <el-input v-model="editingCrawlerSource.name" placeholder="爬虫源名称" />
          </el-form-item>
          <el-form-item label="搜索URL">
            <el-input v-model="editingCrawlerSource.url" placeholder="搜索URL，用 {keyword} 作为关键词占位符" />
          </el-form-item>
          <el-form-item label="平台">
            <el-select v-model="editingCrawlerSource.platform" style="width: 100%">
              <el-option label="夸克网盘" value="quark" />
              <el-option label="百度网盘" value="baidu" />
              <el-option label="UC网盘" value="uc" />
              <el-option label="迅雷网盘" value="xunlei" />
            </el-select>
          </el-form-item>
          <el-form-item label="提取方式">
            <el-select v-model="editingCrawlerSource.html_type" style="width: 100%">
              <el-option label="直接提取（列表页包含链接）" :value="0" />
              <el-option label="详情页提取（需要进入详情页）" :value="1" />
            </el-select>
          </el-form-item>
          <el-divider content-position="left">选择器配置（格式：tag+class）</el-divider>
          <el-form-item label="列表项">
            <el-input v-model="editingCrawlerSource.html_item" placeholder="div+resource-item" />
            <div class="form-hint">列表项的标签和类名，如 div+resource-item</div>
          </el-form-item>
          <el-form-item label="标题">
            <el-input v-model="editingCrawlerSource.html_title" placeholder="h3+title" />
            <div class="form-hint">标题的标签和类名，如 h3+title</div>
          </el-form-item>
          <el-form-item label="详情链接" v-if="editingCrawlerSource.html_type === 1">
            <el-input v-model="editingCrawlerSource.html_url" placeholder="a+detail-link" />
            <div class="form-hint">详情页链接的标签和类名，如 a+detail-link</div>
          </el-form-item>
          <el-form-item label="内容区域">
            <el-input v-model="editingCrawlerSource.html_url2" placeholder="div+content" />
            <div class="form-hint">内容区域的标签和类名，如 div+content</div>
          </el-form-item>
          <el-divider content-position="left">其他设置</el-divider>
          <el-form-item label="最大结果">
            <el-input-number v-model="editingCrawlerSource.max_count" :min="1" :max="100" />
          </el-form-item>
          <el-form-item label="权重">
            <el-input-number v-model="editingCrawlerSource.weight" :min="0" :max="999" />
          </el-form-item>
          <el-form-item label="状态">
            <el-switch v-model="editingCrawlerSource.status" :active-value="1" :inactive-value="0" active-text="启用" inactive-text="禁用" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="crawlerDialogVisible = false">取消</el-button>
          <el-button type="primary" @click="onSaveCrawlerSource">保存</el-button>
        </template>
      </el-dialog>

      <!-- KK Sources -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-icon">
            <Zap :size="16" />
          </div>
          <div>
            <h3>KK搜索源</h3>
            <p>使用 kkkba.com 接口搜索资源（支持夸克、百度）</p>
          </div>
        </div>
        <div class="setting-body">
          <div class="search-sources-toolbar">
            <el-button size="small" type="primary" @click="onAddKkSource">
              <Plus :size="14" style="margin-right: 4px" />
              添加KK源
            </el-button>
            <el-button size="small" type="danger" @click="onBatchDeleteKk" :disabled="kkSelectedRows.length === 0">
              <Delete :size="14" style="margin-right: 4px" />
              批量删除 ({{ kkSelectedRows.length }})
            </el-button>
            <el-button size="small" @click="loadKkSources">刷新</el-button>
          </div>
          <el-table :data="kkSources" size="small" max-height="300" stripe @selection-change="onKkSelectionChange">
            <el-table-column type="selection" width="40" />
            <el-table-column prop="name" label="名称" width="120" />
            <el-table-column prop="platform" label="平台" width="80">
              <template #default="{ row }">{{ getPlatformLabel(row.platform) }}</template>
            </el-table-column>
            <el-table-column prop="api_type" label="接口类型" width="100">
              <template #default="{ row }">
                <el-tag :type="row.api_type === 0 ? 'primary' : row.api_type === 1 ? 'success' : 'warning'" size="small">
                  {{ row.api_type === 0 ? '全部' : row.api_type === 1 ? '句子' : '搜索' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="weight" label="权重" width="60" />
            <el-table-column prop="status" label="状态" width="60">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">{{ row.status === 1 ? '启用' : '禁用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="onEditKkSource(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="onDeleteKkSource(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <!-- KK Source Dialog -->
      <el-dialog v-model="kkDialogVisible" :title="editingKkSource.id ? '编辑KK源' : '添加KK源'" width="480px">
        <el-form label-width="80px" size="small">
          <el-form-item label="名称">
            <el-input v-model="editingKkSource.name" placeholder="KK源名称" />
          </el-form-item>
          <el-form-item label="平台">
            <el-select v-model="editingKkSource.platform" style="width: 100%">
              <el-option label="夸克网盘" value="quark" />
              <el-option label="百度网盘" value="baidu" />
            </el-select>
          </el-form-item>
          <el-form-item label="接口类型">
            <el-select v-model="editingKkSource.api_type" style="width: 100%">
              <el-option label="全部接口" :value="0" />
              <el-option label="句子接口" :value="1" />
              <el-option label="搜索接口" :value="2" />
            </el-select>
          </el-form-item>
          <el-form-item label="最大结果">
            <el-input-number v-model="editingKkSource.max_count" :min="1" :max="100" />
          </el-form-item>
          <el-form-item label="权重">
            <el-input-number v-model="editingKkSource.weight" :min="0" :max="999" />
          </el-form-item>
          <el-form-item label="状态">
            <el-switch v-model="editingKkSource.status" :active-value="1" :inactive-value="0" active-text="启用" inactive-text="禁用" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="kkDialogVisible = false">取消</el-button>
          <el-button type="primary" @click="onSaveKkSource">保存</el-button>
        </template>
      </el-dialog>

      <!-- About -->
      <div class="setting-card">
        <div class="setting-header">
          <div class="setting-icon">
            <Info :size="16" />
          </div>
          <div>
            <h3>关于</h3>
            <p>PanLite 网盘管理与跨云端传输工具</p>
          </div>
        </div>
        <div class="setting-body">
          <div class="about-info">
            <div class="about-intro">
              <strong>PanLite</strong>
              <span>统一管理多个网盘账号，在本地完成文件浏览、上传下载、任务调度和跨网盘迁移。</span>
            </div>
            <div class="about-row">
              <span class="about-label">版本</span>
              <span class="about-value">0.1.0</span>
            </div>
            <div class="about-row">
              <span class="about-label">技术栈</span>
              <span class="about-value">Electron + Vue 3 + TypeScript</span>
            </div>
            <div class="about-row">
              <span class="about-label">运行平台</span>
              <span class="about-value">Windows x64 桌面端</span>
            </div>
            <div class="about-row">
              <span class="about-label">支持平台</span>
              <div class="about-platforms">
                <span class="platform-chip quark">夸克网盘</span>
                <span class="platform-chip baidu">百度网盘</span>
                <span class="platform-chip uc">UC 网盘</span>
                <span class="platform-chip xunlei">迅雷网盘</span>
              </div>
            </div>
            <div class="about-row">
              <span class="about-label">核心能力</span>
              <span class="about-value about-value-wrap">文件管理 · 官方上传下载 · 跨网盘迁移 · 任务队列 · 资源搜索</span>
            </div>
            <div class="about-row">
              <span class="about-label">数据与安全</span>
              <span class="about-value about-value-wrap">账号凭据加密保存在本机 SQLite，业务请求仅发送至对应网盘官方接口</span>
            </div>
            <div class="about-row">
              <span class="about-label">许可证</span>
              <span class="about-value">MIT License</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Save button -->
    <div class="save-bar">
      <el-button type="primary" @click="onSave" :loading="saving">
        <Save :size="14" style="margin-right: 4px" />
        保存设置
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import {
  Settings as SettingsIcon, Gauge, Info, Save, Key, Shield, Search, Plus, Edit as EditIcon, Delete, Hash, Globe, Zap, ArrowDown, Upload,
} from 'lucide-vue-next'
import { PLATFORM_LABELS } from '@shared/constants'
import { DEFAULT_BANNED_KEYWORDS } from '@shared/constants'
import { electronApi } from '../api/ipc'

const saving = ref(false)

const form = reactive({
  baiduClientId: '',
  baiduClientSecret: '',
  baiduRedirectUri: 'oob',
  quarkPageSize: 200,
  baiduPageSize: 100,
  requestDelayMs: 300,
  adFilterEnabled: true,
  bannedKeywords: DEFAULT_BANNED_KEYWORDS,
})

const SETTINGS_KEYS = [
  'baiduClientId',
  'baiduClientSecret',
  'baiduRedirectUri',
  'quarkPageSize',
  'baiduPageSize',
  'requestDelayMs',
  'adFilterEnabled',
  'bannedKeywords',
] as const

const REQUEST_SETTING_LIMITS = {
  quarkPageSize: [20, 500],
  baiduPageSize: [20, 1000],
  requestDelayMs: [0, 5000],
} as const

function clampRequestSetting<K extends keyof typeof REQUEST_SETTING_LIMITS>(key: K, value: unknown): number {
  const [min, max] = REQUEST_SETTING_LIMITS[key]
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return key === 'quarkPageSize' ? 200 : key === 'baiduPageSize' ? 100 : 300
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

async function loadSettings() {
  try {
    const result = await electronApi.getAllSettings()
    if (result.success && result.settings) {
      const s = result.settings
      if (s.baiduClientId !== undefined) form.baiduClientId = s.baiduClientId
      if (s.baiduClientSecret !== undefined) form.baiduClientSecret = s.baiduClientSecret
      if (s.baiduRedirectUri !== undefined) form.baiduRedirectUri = s.baiduRedirectUri
      if (s.quarkPageSize !== undefined) form.quarkPageSize = clampRequestSetting('quarkPageSize', s.quarkPageSize)
      if (s.baiduPageSize !== undefined) form.baiduPageSize = clampRequestSetting('baiduPageSize', s.baiduPageSize)
      if (s.requestDelayMs !== undefined) form.requestDelayMs = clampRequestSetting('requestDelayMs', s.requestDelayMs)
      if (s.adFilterEnabled !== undefined) form.adFilterEnabled = s.adFilterEnabled !== 'false'
      if (s.bannedKeywords !== undefined) form.bannedKeywords = s.bannedKeywords
    }
  } catch (err) {
    console.error('Failed to load settings:', err)
  }
}

async function onSave() {
  saving.value = true
  try {
    form.quarkPageSize = clampRequestSetting('quarkPageSize', form.quarkPageSize)
    form.baiduPageSize = clampRequestSetting('baiduPageSize', form.baiduPageSize)
    form.requestDelayMs = clampRequestSetting('requestDelayMs', form.requestDelayMs)
    for (const key of SETTINGS_KEYS) {
      const value = String(form[key])
      await electronApi.setSetting(key, value)
    }
    ElMessage.success('设置已保存')
  } catch (err) {
    ElMessage.error('保存失败: ' + String(err))
  } finally {
    saving.value = false
  }
}

onMounted(loadSettings)

// ---- Search Sources Management ----

function getPlatformLabel(platform: string): string {
  return (PLATFORM_LABELS as Record<string, string>)[platform] || platform
}

interface SearchSourceItem {
  id: string
  name: string
  type: string
  platform: string
  url: string
  method: string
  params: string | null
  headers: string | null
  field_map: string | null
  html_selectors: string | null
  max_count: number
  weight: number
  status: number
  category?: string
  risk_level?: string
  capabilities?: string
  // UI fields
  paramsStr?: string
  headersStr?: string
  fieldMapStr?: string
}

const searchSources = ref<SearchSourceItem[]>([])
const sourceDialogVisible = ref(false)
const editingSource = reactive<SearchSourceItem>({
  id: '', name: '', type: 'api', platform: 'quark', url: '',
  method: 'GET', params: null, headers: null, field_map: null,
  html_selectors: null, max_count: 20, weight: 0, status: 1,
  paramsStr: '', headersStr: '', fieldMapStr: '',
})

async function loadSearchSources() {
  try {
    const result = await electronApi.searchSourcesList()
    if (result.success && result.sources) {
      searchSources.value = result.sources as SearchSourceItem[]
    }
  } catch (err) {
    console.error('Failed to load search sources:', err)
  }
}

function onAddSource() {
  Object.assign(editingSource, {
    id: '', name: '', type: 'api', platform: 'quark', url: '',
    method: 'GET', params: null, headers: null, field_map: null,
    html_selectors: null, max_count: 20, weight: 0, status: 1,
    paramsStr: '', headersStr: '', fieldMapStr: '',
  })
  sourceDialogVisible.value = true
}

function onEditSource(row: SearchSourceItem) {
  Object.assign(editingSource, {
    ...row,
    paramsStr: row.params || '',
    headersStr: row.headers || '',
    fieldMapStr: row.field_map || '',
  })
  sourceDialogVisible.value = true
}

async function onSaveSource() {
  try {
    const source = {
      ...editingSource,
      params: editingSource.paramsStr || null,
      headers: editingSource.headersStr || null,
      field_map: editingSource.fieldMapStr || null,
    }
    const result = await electronApi.searchSourcesSave(source)
    if (result.success) {
      ElMessage.success('搜索源已保存')
      sourceDialogVisible.value = false
      await loadSearchSources()
    } else {
      ElMessage.error(result.error || '保存失败')
    }
  } catch (err) {
    ElMessage.error('保存失败: ' + String(err))
  }
}

async function onDeleteSource(row: SearchSourceItem) {
  try {
    const result = await electronApi.searchSourcesDelete(row.id)
    if (result.success) {
      ElMessage.success('已删除')
      await loadSearchSources()
    } else {
      ElMessage.error(result.error || '删除失败')
    }
  } catch (err) {
    ElMessage.error('删除失败: ' + String(err))
  }
}

// 搜索源批量删除
const sourceSelectedRows = ref<SearchSourceItem[]>([])
function onSourceSelectionChange(rows: SearchSourceItem[]) {
  sourceSelectedRows.value = rows
}
async function onBatchDeleteSources() {
  if (sourceSelectedRows.value.length === 0) return
  try {
    let count = 0
    for (const row of sourceSelectedRows.value) {
      const result = await electronApi.searchSourcesDelete(row.id)
      if (result.success) count++
    }
    ElMessage.success(`已删除 ${count} 个搜索源`)
    sourceSelectedRows.value = []
    await loadSearchSources()
  } catch (err) {
    ElMessage.error('批量删除失败: ' + String(err))
  }
}

// 预设搜索源模板
const presetSources: Record<string, Partial<SearchSourceItem>> = {
  quark: {
    name: '夸克网盘搜索',
    type: 'api',
    platform: 'quark',
    url: 'https://www.pansearch.me/api/search?keyword={keyword}&pan=quark',
    method: 'GET',
    field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
  },
  baidu: {
    name: '百度网盘搜索',
    type: 'api',
    platform: 'baidu',
    url: 'https://www.pansearch.me/api/search?keyword={keyword}&pan=baidu',
    method: 'GET',
    field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
  },
}

function onPresetSource(command: string) {
  const preset = presetSources[command]
  if (preset) {
    Object.assign(editingSource, {
      id: '',
      ...preset,
      max_count: 20,
      weight: 0,
      status: 1,
      params: null,
      headers: null,
      html_selectors: null,
      paramsStr: '',
      headersStr: '',
      fieldMapStr: preset.field_map || '',
    })
    sourceDialogVisible.value = true
  }
}

// 测试搜索源
async function onTestSource(row: SearchSourceItem) {
  ElMessage.info('正在测试搜索源...')
  try {
    const plainData = JSON.parse(JSON.stringify(row))
    const result = await electronApi.testSearchSource(plainData)
    if (result.success) {
      ElMessage.success(`测试成功！找到 ${result.resultCount} 条结果`)
    } else {
      ElMessage.error(`测试失败: ${result.error}`)
    }
  } catch (err) {
    ElMessage.error(`测试失败: ${String(err)}`)
  }
}

// ---- Batch Import ----

const batchImportVisible = ref(false)
const batchImportText = ref('')
const batchImporting = ref(false)

// 从任意文本中提取所有网址
function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  // 1. 先提取 http/https 开头的完整网址
  const httpRegex = /https?:\/\/[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g
  const httpMatches = text.match(httpRegex) || []
  for (const url of httpMatches) {
    const cleaned = url.replace(/[.,;:!?。，；：！？）)】}>]+$/, '')
    const key = cleaned.replace(/\/+$/, '')
    if (!seen.has(key)) {
      seen.add(key)
      result.push(cleaned)
    }
  }

  // 2. 再提取纯域名格式（如 xunjiso.com、www.yunso.net）
  const domainRegex = /\b([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/[^\s,，]*)?/g
  const domainMatches = text.match(domainRegex) || []
  for (const domain of domainMatches) {
    // 跳过已经是 http 开头的
    if (seen.has(domain) || seen.has('https://' + domain) || seen.has('https://www.' + domain)) continue
    // 跳过常见非域名后缀
    if (/\.(js|ts|vue|css|html|json|png|jpg|gif|svg)$/.test(domain)) continue
    // 补全为 https://www.xxx.com 格式
    const fullUrl = domain.startsWith('www.') ? 'https://' + domain : 'https://www.' + domain
    const key = fullUrl.replace(/\/+$/, '')
    if (!seen.has(key)) {
      seen.add(key)
      result.push(fullUrl)
    }
  }

  return result
}

// 计算导入数量（从文本中提取网址数量）
const batchImportCount = computed(() => {
  return extractUrls(batchImportText.value).length
})

// 从URL提取网站名
function generateName(url: string): string {
  try {
    const hostname = new URL(url).hostname
    return hostname.replace(/^www\./, '').replace(/\.(com|cn|net|org|top|cc|vip|xyz|me)$/, '')
  } catch {
    return url.substring(0, 20)
  }
}

async function onBatchImport() {
  const urls = extractUrls(batchImportText.value)

  if (urls.length === 0) {
    ElMessage.warning('未识别到网址，请粘贴包含网址的文本')
    return
  }

  batchImporting.value = true
  let successCount = 0
  let failCount = 0

  for (const url of urls) {
    const name = generateName(url)
    const source = {
      id: '',
      name,
      type: 'api',
      platform: 'quark',
      url,
      method: 'GET',
      params: null,
      headers: null,
      field_map: null,
      html_selectors: null,
      max_count: 20,
      weight: 0,
      status: 1,
    }

    try {
      const result = await electronApi.searchSourcesSave(source)
      if (result.success) {
        successCount++
      } else {
        failCount++
      }
    } catch {
      failCount++
    }
  }

  batchImporting.value = false
  batchImportVisible.value = false
  batchImportText.value = ''

  if (successCount > 0) {
    ElMessage.success(`成功导入 ${successCount} 个资源站${failCount > 0 ? `，${failCount} 个失败` : ''}`)
    await loadSearchSources()
  } else {
    ElMessage.error('导入失败')
  }
}

// Load search sources on mount
onMounted(loadSearchSources)

// ---- TG Channels Management ----

interface TgChannelItem {
  id: string
  name: string
  channel: string
  platform: string
  max_count: number
  weight: number
  status: number
}

const tgChannels = ref<TgChannelItem[]>([])
const tgDialogVisible = ref(false)
const editingTgChannel = reactive<TgChannelItem>({
  id: '', name: '', channel: '', platform: 'quark',
  max_count: 20, weight: 0, status: 1,
})

async function loadTgChannels() {
  try {
    const result = await electronApi.tgChannelsList()
    if (result.success && result.channels) {
      tgChannels.value = result.channels as TgChannelItem[]
    }
  } catch (err) {
    console.error('Failed to load TG channels:', err)
  }
}

function onAddTgChannel() {
  Object.assign(editingTgChannel, {
    id: '', name: '', channel: '', platform: 'quark',
    max_count: 20, weight: 0, status: 1,
  })
  tgDialogVisible.value = true
}

function onEditTgChannel(row: TgChannelItem) {
  Object.assign(editingTgChannel, { ...row })
  tgDialogVisible.value = true
}

async function onSaveTgChannel() {
  try {
    const result = await electronApi.tgChannelsSave({ ...editingTgChannel })
    if (result.success) {
      ElMessage.success('TG频道已保存')
      tgDialogVisible.value = false
      await loadTgChannels()
    } else {
      ElMessage.error(result.error || '保存失败')
    }
  } catch (err) {
    ElMessage.error('保存失败: ' + String(err))
  }
}

async function onDeleteTgChannel(row: TgChannelItem) {
  try {
    const result = await electronApi.tgChannelsDelete(row.id)
    if (result.success) {
      ElMessage.success('已删除')
      await loadTgChannels()
    } else {
      ElMessage.error(result.error || '删除失败')
    }
  } catch (err) {
    ElMessage.error('删除失败: ' + String(err))
  }
}

// TG频道批量删除
const tgSelectedRows = ref<TgChannelItem[]>([])
function onTgSelectionChange(rows: TgChannelItem[]) {
  tgSelectedRows.value = rows
}
async function onBatchDeleteTg() {
  if (tgSelectedRows.value.length === 0) return
  try {
    let count = 0
    for (const row of tgSelectedRows.value) {
      const result = await electronApi.tgChannelsDelete(row.id)
      if (result.success) count++
    }
    ElMessage.success(`已删除 ${count} 个TG频道`)
    tgSelectedRows.value = []
    await loadTgChannels()
  } catch (err) {
    ElMessage.error('批量删除失败: ' + String(err))
  }
}

// Load TG channels on mount
onMounted(loadTgChannels)

// ---- Crawler Sources Management ----

interface CrawlerSourceItem {
  id: string
  name: string
  url: string
  platform: string
  max_count: number
  weight: number
  status: number
  // 与xinyue-search的html_item, html_title, html_url, html_url2对应
  // 格式: "tag+class" (如 "div+resource-item" 或 "h3+title")
  html_item: string
  html_title: string
  html_url: string
  html_url2: string
  // 与xinyue-search的html_type对应
  // 0: 从列表页直接提取链接
  // 1: 需要进入详情页提取链接
  html_type: number
}

const crawlerSources = ref<CrawlerSourceItem[]>([])
const crawlerDialogVisible = ref(false)
const editingCrawlerSource = reactive<CrawlerSourceItem>({
  id: '', name: '', url: '', platform: 'quark',
  max_count: 20, weight: 0, status: 1,
  html_item: 'div+', html_title: 'h3+', html_url: 'a+', html_url2: 'div+',
  html_type: 0,
})

async function loadCrawlerSources() {
  try {
    const result = await electronApi.crawlerSourcesList()
    if (result.success && result.sources) {
      crawlerSources.value = result.sources as CrawlerSourceItem[]
    }
  } catch (err) {
    console.error('Failed to load crawler sources:', err)
  }
}

function onAddCrawlerSource() {
  Object.assign(editingCrawlerSource, {
    id: '', name: '', url: '', platform: 'quark',
    max_count: 20, weight: 0, status: 1,
    html_item: 'div+', html_title: 'h3+', html_url: 'a+', html_url2: 'div+',
    html_type: 0,
  })
  crawlerDialogVisible.value = true
}

function onEditCrawlerSource(row: CrawlerSourceItem) {
  Object.assign(editingCrawlerSource, { ...row })
  crawlerDialogVisible.value = true
}

async function onSaveCrawlerSource() {
  try {
    const result = await electronApi.crawlerSourcesSave({ ...editingCrawlerSource })
    if (result.success) {
      ElMessage.success('爬虫源已保存')
      crawlerDialogVisible.value = false
      await loadCrawlerSources()
    } else {
      ElMessage.error(result.error || '保存失败')
    }
  } catch (err) {
    ElMessage.error('保存失败: ' + String(err))
  }
}

async function onDeleteCrawlerSource(row: CrawlerSourceItem) {
  try {
    const result = await electronApi.crawlerSourcesDelete(row.id)
    if (result.success) {
      ElMessage.success('已删除')
      await loadCrawlerSources()
    } else {
      ElMessage.error(result.error || '删除失败')
    }
  } catch (err) {
    ElMessage.error('删除失败: ' + String(err))
  }
}

// 爬虫源批量删除
const crawlerSelectedRows = ref<CrawlerSourceItem[]>([])
function onCrawlerSelectionChange(rows: CrawlerSourceItem[]) {
  crawlerSelectedRows.value = rows
}
async function onBatchDeleteCrawler() {
  if (crawlerSelectedRows.value.length === 0) return
  try {
    let count = 0
    for (const row of crawlerSelectedRows.value) {
      const result = await electronApi.crawlerSourcesDelete(row.id)
      if (result.success) count++
    }
    ElMessage.success(`已删除 ${count} 个爬虫源`)
    crawlerSelectedRows.value = []
    await loadCrawlerSources()
  } catch (err) {
    ElMessage.error('批量删除失败: ' + String(err))
  }
}

// Load crawler sources on mount
onMounted(loadCrawlerSources)

// ---- KK Sources Management ----

interface KkSourceItem {
  id: string
  name: string
  platform: string
  api_type: number
  max_count: number
  weight: number
  status: number
}

const kkSources = ref<KkSourceItem[]>([])
const kkDialogVisible = ref(false)
const editingKkSource = reactive<KkSourceItem>({
  id: '', name: '', platform: 'quark',
  api_type: 0, max_count: 20, weight: 0, status: 1,
})

async function loadKkSources() {
  try {
    const result = await electronApi.kkSourcesList()
    if (result.success && result.sources) {
      kkSources.value = result.sources as KkSourceItem[]
    }
  } catch (err) {
    console.error('Failed to load KK sources:', err)
  }
}

function onAddKkSource() {
  Object.assign(editingKkSource, {
    id: '', name: '', platform: 'quark',
    api_type: 0, max_count: 20, weight: 0, status: 1,
  })
  kkDialogVisible.value = true
}

function onEditKkSource(row: KkSourceItem) {
  Object.assign(editingKkSource, { ...row })
  kkDialogVisible.value = true
}

async function onSaveKkSource() {
  try {
    const result = await electronApi.kkSourcesSave({ ...editingKkSource })
    if (result.success) {
      ElMessage.success('KK源已保存')
      kkDialogVisible.value = false
      await loadKkSources()
    } else {
      ElMessage.error(result.error || '保存失败')
    }
  } catch (err) {
    ElMessage.error('保存失败: ' + String(err))
  }
}

async function onDeleteKkSource(row: KkSourceItem) {
  try {
    const result = await electronApi.kkSourcesDelete(row.id)
    if (result.success) {
      ElMessage.success('已删除')
      await loadKkSources()
    } else {
      ElMessage.error(result.error || '删除失败')
    }
  } catch (err) {
    ElMessage.error('删除失败: ' + String(err))
  }
}

// KK源批量删除
const kkSelectedRows = ref<KkSourceItem[]>([])
function onKkSelectionChange(rows: KkSourceItem[]) {
  kkSelectedRows.value = rows
}
async function onBatchDeleteKk() {
  if (kkSelectedRows.value.length === 0) return
  try {
    let count = 0
    for (const row of kkSelectedRows.value) {
      const result = await electronApi.kkSourcesDelete(row.id)
      if (result.success) count++
    }
    ElMessage.success(`已删除 ${count} 个KK源`)
    kkSelectedRows.value = []
    await loadKkSources()
  } catch (err) {
    ElMessage.error('批量删除失败: ' + String(err))
  }
}

// Load KK sources on mount
onMounted(loadKkSources)
</script>

<style scoped>
.settings-page { height: 100%; display: flex; flex-direction: column; overflow: hidden; }

.page-header {
  display: flex;
  align-items: center;
  padding: 18px 22px;
  background: var(--pl-surface);
  border: 1px solid var(--pl-border);
  border-radius: var(--pl-radius-card);
  box-shadow: var(--pl-shadow-card);
  flex-shrink: 0;
  margin-bottom: 14px;
}

.header-info { display: flex; align-items: center; gap: 12px; }
.header-icon { width: 42px; height: 42px; border-radius: 12px; background: var(--pl-primary-soft); color: var(--pl-primary); display: flex; align-items: center; justify-content: center; }
.header-info h2 { font-size: 17px; line-height: 1.3; font-weight: 700; color: var(--pl-text); margin: 0 0 3px; }
.header-info p { font-size: 12px; color: var(--pl-text-secondary); margin: 0; }

.settings-sections {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0 4px 18px 0;
}

.settings-sections::-webkit-scrollbar { width: 7px; }
.settings-sections::-webkit-scrollbar-track { background: transparent; }
.settings-sections::-webkit-scrollbar-thumb { background: var(--pl-border-strong); border-radius: 8px; }
.settings-sections::-webkit-scrollbar-thumb:hover { background: #b8c5d8; }

.setting-card {
  background: var(--pl-surface);
  border: 1px solid var(--pl-border);
  border-radius: var(--pl-radius-card);
  box-shadow: var(--pl-shadow-card);
  overflow: hidden;
  flex-shrink: 0;
}

.setting-header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--pl-border); background: var(--pl-surface-subtle); }
.setting-icon { width: 34px; height: 34px; border-radius: 10px; background: var(--pl-primary-soft); color: var(--pl-primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.setting-header h3 { font-size: 14px; line-height: 1.35; font-weight: 650; color: var(--pl-text); margin: 0 0 3px; }
.setting-header p { font-size: 12px; line-height: 1.45; color: var(--pl-text-secondary); margin: 0; }
.setting-body { padding: 14px 20px 16px; }

.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 13px 0; }
.setting-row + .setting-row { border-top: 1px solid var(--pl-border); }
.setting-label { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.label-text { font-size: 13px; font-weight: 550; color: var(--pl-text); }
.label-hint { font-size: 12px; line-height: 1.45; color: var(--pl-text-muted); }

.about-info { display: flex; flex-direction: column; gap: 12px; }
.about-intro { display: flex; flex-direction: column; gap: 4px; margin-bottom: 2px; padding: 12px 14px; border: 1px solid #dbe7fb; border-radius: 10px; color: var(--pl-text-secondary); background: #f6f9ff; font-size: 12px; line-height: 1.55; }
.about-intro strong { color: var(--pl-primary); font-size: 14px; }
.about-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.about-label { font-size: 13px; color: var(--pl-text-secondary); }
.about-value { font-size: 13px; color: var(--pl-text); font-weight: 550; text-align: right; }
.about-value-wrap { max-width: 68%; line-height: 1.5; }
.about-platforms { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.platform-chip { display: inline-block; padding: 4px 9px; border-radius: 999px; font-size: 12px; font-weight: 550; }
.platform-chip.quark { background: var(--pl-primary-soft); color: var(--pl-primary); }
.platform-chip.baidu { background: var(--pl-success-soft); color: var(--pl-success); }
.platform-chip.uc { background: #fff4df; color: #a56a16; }
.platform-chip.xunlei { background: #f1eaff; color: #7652b8; }

.save-bar { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); flex-shrink: 0; margin-top: 12px; }

.search-sources-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.form-hint { font-size: 12px; line-height: 1.45; color: var(--pl-text-muted); margin-top: 4px; }
.batch-import-hint { margin-bottom: 12px; }
.batch-import-hint p { font-size: 13px; color: var(--pl-text-secondary); margin: 0 0 4px; }
.batch-import-options { margin-top: 12px; }

:deep(.el-table) { --el-table-border-color: var(--pl-border); --el-table-header-bg-color: var(--pl-surface-subtle); --el-table-row-hover-bg-color: var(--pl-primary-soft); color: var(--pl-text-secondary); border-radius: var(--pl-radius-sm); overflow: hidden; }
:deep(.el-table th.el-table__cell) { color: var(--pl-text-secondary); font-weight: 600; }
:deep(.el-table .el-table__cell) { padding: 9px 0; }
:deep(.el-table__inner-wrapper::before) { display: none; }
:deep(.el-dialog__header) { margin-right: 0; padding: 20px 22px 14px; border-bottom: 1px solid var(--pl-border); }
:deep(.el-dialog__body) { padding: 18px 22px; }
:deep(.el-dialog__footer) { padding: 14px 22px 18px; border-top: 1px solid var(--pl-border); }
:deep(.el-form-item__label) { color: var(--pl-text-secondary); font-size: 12px; }
:deep(.el-input-number) { max-width: 180px; }
.setting-row > :deep(.el-input) { width: min(320px, 48%) !important; }

@media (max-width: 800px) {
  .page-header { padding: 15px 16px; }
  .setting-header { padding: 14px 16px; }
  .setting-body { padding: 12px 16px 14px; }
  .setting-row { align-items: flex-start; flex-direction: column; gap: 9px; }
  .setting-row > :deep(.el-input), .setting-row > :deep(.el-input-number), .setting-row > :deep(.el-switch) { width: 100% !important; max-width: none; }
  .setting-row > :deep(.el-switch) { width: auto !important; }
  .about-row { align-items: flex-start; flex-direction: column; gap: 5px; }
  .about-value { text-align: left; }
  .about-value-wrap { max-width: none; }
  .about-platforms { justify-content: flex-start; }
}

@media (max-width: 520px) {
  .header-icon { width: 36px; height: 36px; }
  .header-info h2 { font-size: 16px; }
  .search-sources-toolbar :deep(.el-button) { flex: 1 1 auto; }
}
</style>
