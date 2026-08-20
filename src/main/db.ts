import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import log from 'electron-log'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db
}

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'panlite.db')
  log.info('Database path:', dbPath)

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  createTables()
  runMigrations()

  // 清理过期的搜索缓存
  try {
    const cleared = clearExpiredSearchCache()
    if (cleared > 0) {
      log.info(`Cleared ${cleared} expired search cache entries`)
    }
  } catch (err) {
    log.warn('Failed to clear expired search cache:', err)
  }

  // 每小时清理一次过期缓存
  setInterval(() => {
    try {
      clearExpiredSearchCache()
    } catch {}
  }, 60 * 60 * 1000)
}

/** 数据库迁移系统 */
interface Migration {
  id: string
  description: string
  up: () => void
}

const migrations: Migration[] = [
  {
    id: '001_add_logs_columns',
    description: 'Add account_id and task_id to logs table',
    up: () => {
      const columns = db.prepare('PRAGMA table_info(logs)').all() as { name: string }[]
      const colNames = new Set(columns.map((c) => c.name))
      if (!colNames.has('account_id')) {
        db.exec('ALTER TABLE logs ADD COLUMN account_id TEXT')
      }
      if (!colNames.has('task_id')) {
        db.exec('ALTER TABLE logs ADD COLUMN task_id TEXT')
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_logs_account ON logs(account_id)')
    },
  },
  {
    id: '002_add_tg_channels_and_crawler_sources',
    description: 'Add tg_channels and crawler_sources tables for local search',
    up: () => {
      // 创建TG频道表
      db.exec(`
        CREATE TABLE IF NOT EXISTS tg_channels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          channel TEXT NOT NULL,
          platform TEXT NOT NULL,
          max_count INTEGER DEFAULT 20,
          weight INTEGER DEFAULT 0,
          status INTEGER DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      // 创建爬虫源表（与xinyue-search的qf_api_list表结构对应）
      db.exec(`
        CREATE TABLE IF NOT EXISTS crawler_sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          platform TEXT NOT NULL,
          max_count INTEGER DEFAULT 20,
          weight INTEGER DEFAULT 0,
          status INTEGER DEFAULT 1,

          -- 与xinyue-search的html_item, html_title, html_url, html_url2对应
          -- 格式: "tag+class" (如 "div+resource-item" 或 "h3+title")
          html_item TEXT NOT NULL DEFAULT 'div+',
          html_title TEXT NOT NULL DEFAULT 'h3+',
          html_url TEXT NOT NULL DEFAULT 'a+',
          html_url2 TEXT NOT NULL DEFAULT 'div+',

          -- 与xinyue-search的html_type对应
          -- 0: 从列表页直接提取链接
          -- 1: 需要进入详情页提取链接
          html_type INTEGER DEFAULT 0,

          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      // 创建KK搜索源表
      db.exec(`
        CREATE TABLE IF NOT EXISTS kk_sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          api_type INTEGER DEFAULT 0,
          max_count INTEGER DEFAULT 20,
          weight INTEGER DEFAULT 0,
          status INTEGER DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      // 创建索引
      db.exec('CREATE INDEX IF NOT EXISTS idx_tg_channels_status ON tg_channels(status)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_tg_channels_platform ON tg_channels(platform)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_crawler_sources_status ON crawler_sources(status)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_crawler_sources_platform ON crawler_sources(platform)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_kk_sources_status ON kk_sources(status)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_kk_sources_platform ON kk_sources(platform)')

      // 预置默认TG频道
      seedDefaultTgChannels()

      // 预置默认KK搜索源
      seedDefaultKkSources()

      // 预置默认网页爬虫源
      seedDefaultCrawlerSources()

      log.info('Migration 002: Added tg_channels, crawler_sources, and kk_sources tables')
    },
  },
  {
    id: '003_replace_search_sources_with_curated_sites',
    description: 'Replace legacy search sources with the curated built-in resource catalog',
    up: () => {
      const columns = db.prepare('PRAGMA table_info(search_sources)').all() as { name: string }[]
      const names = new Set(columns.map((column) => column.name))
      if (!names.has('category')) db.exec("ALTER TABLE search_sources ADD COLUMN category TEXT NOT NULL DEFAULT '网盘搜索'")
      if (!names.has('risk_level')) db.exec("ALTER TABLE search_sources ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'medium'")
      if (!names.has('capabilities')) db.exec("ALTER TABLE search_sources ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'")
      db.exec('DELETE FROM search_sources')
      seedCuratedSearchSources()
      log.info('Migration 003: Replaced legacy search sources with curated sites')
    },
  },
  {
    id: '004_add_ai_workspace_tables',
    description: 'Add independent AI workspace documents and tasks',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_documents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'local',
          source_account_id TEXT,
          source_file_id TEXT,
          source_path TEXT,
          extension TEXT NOT NULL DEFAULT '',
          mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          size INTEGER NOT NULL DEFAULT 0,
          sha256 TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'queued',
          content_preview TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_documents_status ON ai_documents(status);
        CREATE INDEX IF NOT EXISTS idx_ai_documents_hash ON ai_documents(sha256);

        CREATE TABLE IF NOT EXISTS ai_tasks (
          id TEXT PRIMARY KEY,
          task_type TEXT NOT NULL,
          title TEXT NOT NULL,
          document_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          progress INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_ai_tasks_created ON ai_tasks(created_at);
      `)
    },
  },
  {
    id: '005_add_ai_document_chunks',
    description: 'Add local chunks for independent AI document retrieval',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_document_chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          page_number INTEGER,
          section TEXT,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (document_id) REFERENCES ai_documents(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_chunks_document_index
          ON ai_document_chunks(document_id, chunk_index);
        CREATE INDEX IF NOT EXISTS idx_ai_chunks_document
          ON ai_document_chunks(document_id);

        INSERT OR IGNORE INTO ai_document_chunks
          (id, document_id, chunk_index, page_number, section, content, created_at)
        SELECT 'legacy-' || id, id, 0, NULL, '已导入内容', content_preview, created_at
        FROM ai_documents
        WHERE status = 'ready' AND content_preview IS NOT NULL AND length(trim(content_preview)) > 0;
      `)
    },
  },
  {
    id: '006_add_ai_conversations',
    description: 'Add persistent AI conversations and messages',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          document_ids TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated
          ON ai_conversations(updated_at DESC);

        CREATE TABLE IF NOT EXISTS ai_conversation_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          message_index INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          citations TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ai_conversation_messages_order
          ON ai_conversation_messages(conversation_id, message_index);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversation_messages_unique_index
          ON ai_conversation_messages(conversation_id, message_index);
      `)
    },
  },
  {
    id: '007_add_ai_chunk_embeddings',
    description: 'Add optional semantic vectors for hybrid AI document retrieval',
    up: () => {
      db.exec('ALTER TABLE ai_document_chunks ADD COLUMN embedding TEXT')
    },
  },
  // 添加更多迁移...
]

function runMigrations(): void {
  // 创建迁移记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      description TEXT,
      applied_at INTEGER NOT NULL
    )
  `)

  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map((r) => r.id),
  )

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    try {
      log.info(`DB migration: applying ${migration.id} - ${migration.description}`)
      db.transaction(() => {
        migration.up()
        db.prepare('INSERT INTO _migrations (id, description, applied_at) VALUES (?, ?, ?)').run(
          migration.id, migration.description, Date.now(),
        )
      })()
      log.info(`DB migration: applied ${migration.id}`)
    } catch (err) {
      log.error(`DB migration failed: ${migration.id}`, err)
      throw new Error(`Database migration ${migration.id} failed: ${String(err)}`)
    }
  }
}

function createTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      nickname TEXT,
      login_type TEXT NOT NULL,
      encrypted_credential TEXT NOT NULL,
      user_agent TEXT,
      status TEXT DEFAULT 'active',
      bind_machine INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_check_at INTEGER
    );

    -- Last successful directory snapshots used for offline fallback.
    CREATE TABLE IF NOT EXISTS files_cache (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      file_id TEXT NOT NULL,
      parent_id TEXT,
      filename TEXT NOT NULL,
      is_dir INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      task_type TEXT NOT NULL,
      title TEXT,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      module TEXT,
      message TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL,
      account_id TEXT,
      task_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_cache_account ON files_cache(account_id);
    CREATE INDEX IF NOT EXISTS idx_files_cache_parent ON files_cache(parent_id);

    -- A separate marker is required because an empty directory is still a valid
    -- successful snapshot and therefore has no row in files_cache.
    CREATE TABLE IF NOT EXISTS files_cache_snapshots (
      account_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, parent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_files_cache_snapshots_account ON files_cache_snapshots(account_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);

    -- 搜索缓存表
    CREATE TABLE IF NOT EXISTS search_cache (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      results TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_search_cache_account ON search_cache(account_id);
    CREATE INDEX IF NOT EXISTS idx_search_cache_keyword ON search_cache(keyword);
    CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);

    -- 搜索历史表
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_search_history_account ON search_history(account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_search_history_keyword ON search_history(account_id, keyword);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      encrypted INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      share_url TEXT NOT NULL,
      password TEXT,
      title TEXT,
      file_ids TEXT NOT NULL,
      expired_at INTEGER,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfer_records (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      source_url TEXT NOT NULL,
      password TEXT,
      target_dir_id TEXT,
      target_path TEXT,
      saved_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_share_links_account ON share_links(account_id);
    CREATE INDEX IF NOT EXISTS idx_transfer_records_account ON transfer_records(account_id);

    CREATE TABLE IF NOT EXISTS search_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      platform TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT DEFAULT 'GET',
      params TEXT,
      headers TEXT,
      field_map TEXT,
      html_selectors TEXT,
      max_count INTEGER DEFAULT 20,
      weight INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      category TEXT NOT NULL DEFAULT '网盘搜索',
      risk_level TEXT NOT NULL DEFAULT 'medium',
      capabilities TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_search_sources_status ON search_sources(status);
  `)

  // 预置搜索源（首次运行时插入）
  seedDefaultSearchSources()
}

/** 预置常用搜索源 */
function seedDefaultSearchSources(): void {
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM search_sources').get() as { cnt: number }).cnt
  if (count > 0) return // 已有数据，不重复插入

  const ts = Date.now()
  const defaults = [
    // ── 迅雷网盘资源站（影视娱乐类） ──
    {
      id: 'preset_xunjiso',
      name: '迅极搜',
      type: 'api',
      platform: 'xunlei',
      url: 'https://www.xunjiso.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 100,
    },
    {
      id: 'preset_yunso',
      name: '云搜',
      type: 'api',
      platform: 'xunlei',
      url: 'https://www.yunso.net',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 95,
    },
    {
      id: 'preset_iizhi',
      name: '毕方铺',
      type: 'api',
      platform: 'quark',
      url: 'https://www.iizhi.cn',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 85,
    },

    // ── 百度网盘资源站（学习教育类） ──
    {
      id: 'preset_xinjuc',
      name: '新剧资源',
      type: 'api',
      platform: 'baidu',
      url: 'https://www.xinjuc.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 80,
    },
    {
      id: 'preset_qupanshe',
      name: '趣盘社',
      type: 'api',
      platform: 'baidu',
      url: 'https://www.qupanshe.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 75,
    },
    {
      id: 'preset_xuebapan',
      name: '学霸盘',
      type: 'api',
      platform: 'baidu',
      url: 'https://www.xuebapan.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 70,
    },

    // ── 夸克网盘资源站 ──
    {
      id: 'preset_kuafuzys',
      name: '夸父资源',
      type: 'api',
      platform: 'quark',
      url: 'https://www.kuafuzys.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 78,
    },
    {
      id: 'preset_funletu',
      name: '趣盘搜',
      type: 'api',
      platform: 'quark',
      url: 'https://pan.funletu.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 76,
    },

    // ── 通用资源站（全平台） ──
    {
      id: 'preset_qkpanso',
      name: '夸克盘搜',
      type: 'api',
      platform: 'quark',
      url: 'https://www.qkpanso.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 65,
    },
    {
      id: 'preset_fastsoso',
      name: '快搜搜',
      type: 'api',
      platform: 'quark',
      url: 'https://www.fastsoso.cc',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 63,
    },
    {
      id: 'preset_xibuluo',
      name: '西部落',
      type: 'api',
      platform: 'quark',
      url: 'https://www.xibuluo.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 55,
    },
    {
      id: 'preset_buyutu',
      name: '捕娱兔',
      type: 'api',
      platform: 'quark',
      url: 'https://www.buyutu.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 53,
    },
    {
      id: 'preset_kkxz',
      name: '快快下载',
      type: 'api',
      platform: 'quark',
      url: 'https://www.kkxz.vip',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 50,
    },
    {
      id: 'preset_xiongdipan',
      name: '兄弟盘',
      type: 'api',
      platform: 'baidu',
      url: 'https://www.xiongdipan.com',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 48,
    },
    {
      id: 'preset_yunpanziyuan',
      name: '云盘资源网',
      type: 'api',
      platform: 'quark',
      url: 'https://www.yunpanziyuan.xyz',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 45,
    },

    // ── PanSearch 备用 ──
    {
      id: 'preset_pansearch_quark',
      name: 'PanSearch 夸克',
      type: 'api',
      platform: 'quark',
      url: 'https://www.pansearch.me',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 40,
    },
    {
      id: 'preset_pansearch_baidu',
      name: 'PanSearch 百度',
      type: 'api',
      platform: 'baidu',
      url: 'https://www.pansearch.me',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 38,
    },
    {
      id: 'preset_pansearch_uc',
      name: 'PanSearch UC',
      type: 'api',
      platform: 'uc',
      url: 'https://www.pansearch.me',
      method: 'GET',
      field_map: JSON.stringify({ list_path: 'data', fields: { title: 'title', url: 'url' } }),
      weight: 36,
    },
    // ── 更多资源站 ──
    {
      id: 'preset_upyunso',
      name: 'UP云搜',
      type: 'browser',
      platform: 'quark',
      url: 'https://www.upyunso.com',
      method: 'GET',
      weight: 72,
    },
    {
      id: 'preset_yiso',
      name: '易搜',
      type: 'browser',
      platform: 'quark',
      url: 'https://yiso.fun',
      method: 'GET',
      weight: 70,
    },
    {
      id: 'preset_niceban',
      name: '好搜',
      type: 'browser',
      platform: 'quark',
      url: 'https://www.niceban.com',
      method: 'GET',
      weight: 68,
    },
    {
      id: 'preset_pansearch_me',
      name: '盘搜索',
      type: 'browser',
      platform: 'quark',
      url: 'https://pansearch.me',
      method: 'GET',
      weight: 66,
    },
    {
      id: 'preset_hunhepan',
      name: '混合盘',
      type: 'browser',
      platform: 'quark',
      url: 'https://www.hunhepan.com',
      method: 'GET',
      weight: 64,
    },
    {
      id: 'preset_soupan',
      name: '搜盘',
      type: 'browser',
      platform: 'baidu',
      url: 'https://www.soupan.info',
      method: 'GET',
      weight: 62,
    },
    {
      id: 'preset_duoduo',
      name: '多多搜索',
      type: 'browser',
      platform: 'baidu',
      url: 'https://www.duoduozy.com',
      method: 'GET',
      weight: 60,
    },
  ]

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO search_sources (id, name, type, platform, url, method, params, headers, field_map, html_selectors, max_count, weight, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)

  const insertMany = db.transaction(() => {
    for (const s of defaults) {
      stmt.run(s.id, s.name, s.type, s.platform, s.url, s.method, null, null, s.field_map, null, 20, s.weight, ts, ts)
    }
  })
  insertMany()
  log.info('Seeded default search sources')
}

/**
 * 用户确认过的内置资源目录。
 * 这些站点以浏览器入口为主，不伪装成稳定 JSON API；资源搜索页负责分组、风险提示和安全打开。
 */
function seedCuratedSearchSources(): void {
  const ts = Date.now()
  const defaults = [
    {
      id: 'builtin_xuebapan', name: '学霸盘', type: 'browser', platform: 'baidu',
      url: 'https://www.xuebapan.com/', category: '网盘搜索', riskLevel: 'medium', weight: 100,
      capabilities: ['学习资料', '课程', '考试', '电子书', '百度网盘'],
    },
    {
      id: 'builtin_qkpanso', name: '夸克盘搜', type: 'browser', platform: 'quark',
      url: 'https://qkpanso.com/', category: '网盘搜索', riskLevel: 'medium', weight: 95,
      capabilities: ['夸克网盘', '影视', '动漫', '课程', '电子书'],
    },
    {
      id: 'builtin_ruancang', name: '软仓', type: 'browser', platform: 'all',
      url: 'https://www.ruancang.net/', category: '软件与技术资源', riskLevel: 'high', weight: 80,
      capabilities: ['办公软件', 'Adobe', 'CAD', '三维建模', '设计工程'],
    },
    {
      id: 'builtin_yxzhi', name: '鸭先知', type: 'browser', platform: 'all',
      url: 'https://www.yxzhi.com/', category: '软件与技术资源', riskLevel: 'medium', weight: 78,
      capabilities: ['软件教程', '脚本插件', '效率工具', '技术分享'],
    },
    {
      id: 'builtin_fireoa', name: 'Fireoa Tools', type: 'browser', platform: 'all',
      url: 'https://fireoa.com/zh-cn', category: '在线工具', riskLevel: 'low', weight: 75,
      capabilities: ['开发工具', '隐私安全', '文档PDF', '图像音视频', '本地处理'],
    },
    {
      id: 'builtin_weidus', name: '维度导航', type: 'browser', platform: 'all',
      url: 'https://www.weidus.com/?ref=kuaf', category: '综合导航', riskLevel: 'medium', weight: 70,
      capabilities: ['网盘入口', 'AI工具', '影音', '资源分享', '在线工具'],
    },
  ]

  const stmt = db.prepare(`
    INSERT INTO search_sources (
      id, name, type, platform, url, method, params, headers, field_map, html_selectors,
      max_count, weight, status, category, risk_level, capabilities, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'GET', NULL, NULL, NULL, NULL, 20, ?, 1, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction(() => {
    for (const source of defaults) {
      stmt.run(
        source.id, source.name, source.type, source.platform, source.url, source.weight,
        source.category, source.riskLevel, JSON.stringify(source.capabilities), ts, ts,
      )
    }
  })
  insertMany()
  log.info(`Seeded ${defaults.length} curated built-in resource sources`)
}

// ---- Account CRUD ----

export interface DbAccount {
  id: string
  platform: string
  nickname: string | null
  login_type: string
  encrypted_credential: string
  user_agent: string | null
  status: string
  bind_machine: number
  created_at: number
  updated_at: number
  last_check_at: number | null
}

export function insertAccount(account: DbAccount): void {
  const stmt = getDb().prepare(`
    INSERT INTO accounts (id, platform, nickname, login_type, encrypted_credential, user_agent, status, bind_machine, created_at, updated_at, last_check_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    account.id,
    account.platform,
    account.nickname,
    account.login_type,
    account.encrypted_credential,
    account.user_agent,
    account.status,
    account.bind_machine,
    account.created_at,
    account.updated_at,
    account.last_check_at,
  )
}

export function getAllAccounts(): DbAccount[] {
  return getDb().prepare('SELECT * FROM accounts ORDER BY created_at DESC').all() as DbAccount[]
}

export function getAccountById(id: string): DbAccount | undefined {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as DbAccount | undefined
}

export function deleteAccountById(id: string): void {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id)
}

export function updateAccountStatus(id: string, status: string, lastCheckAt: number): void {
  getDb().prepare('UPDATE accounts SET status = ?, last_check_at = ?, updated_at = ? WHERE id = ?').run(
    status,
    lastCheckAt,
    Date.now(),
    id,
  )
}

export function updateAccountCredential(id: string, encryptedCredential: string): void {
  getDb().prepare('UPDATE accounts SET encrypted_credential = ?, updated_at = ? WHERE id = ?').run(
    encryptedCredential,
    Date.now(),
    id,
  )
}

// ---- Task CRUD ----

export interface DbTask {
  id: string
  account_id: string
  platform: string
  task_type: string
  title: string | null
  payload: string
  status: string
  progress: number
  retry_count: number
  error_message: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

export function insertTask(task: DbTask): void {
  const stmt = getDb().prepare(`
    INSERT INTO tasks (id, account_id, platform, task_type, title, payload, status, progress, retry_count, error_message, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    task.id,
    task.account_id,
    task.platform,
    task.task_type,
    task.title,
    task.payload,
    task.status,
    task.progress,
    task.retry_count,
    task.error_message,
    task.created_at,
    task.updated_at,
    task.finished_at,
  )
}

export function getAllTasks(): DbTask[] {
  return getDb().prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as DbTask[]
}

export function getTaskById(id: string): DbTask | undefined {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as DbTask | undefined
}

export function updateTaskStatus(id: string, status: string, progress?: number, errorMessage?: string): void {
  const now = Date.now()
  const isTerminal = status === 'success' || status === 'partial_success' || status === 'failed' || status === 'cancelled'
  if (progress !== undefined && errorMessage !== undefined) {
    getDb().prepare('UPDATE tasks SET status = ?, progress = ?, error_message = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(status, progress, errorMessage, now, isTerminal ? now : null, id)
  } else if (progress !== undefined) {
    getDb().prepare('UPDATE tasks SET status = ?, progress = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(status, progress, now, isTerminal ? now : null, id)
  } else {
    getDb().prepare('UPDATE tasks SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(status, now, isTerminal ? now : null, id)
  }
}

export function updateTaskPayload(id: string, payload: unknown): void {
  getDb().prepare('UPDATE tasks SET payload = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(payload), Date.now(), id)
}

export function incrementTaskRetry(id: string): void {
  getDb().prepare('UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?').run(Date.now(), id)
}

export function updateTaskProgress(id: string, progress: number): void {
  getDb().prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(progress, Date.now(), id)
}

export function markTaskSuccess(id: string): void {
  const now = Date.now()
  getDb().prepare('UPDATE tasks SET status = ?, progress = 100, updated_at = ?, finished_at = ? WHERE id = ?')
    .run('success', now, now, id)
}

export function markTaskFailed(id: string, errorMessage: string): void {
  const now = Date.now()
  getDb().prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = ?, finished_at = ? WHERE id = ?')
    .run('failed', errorMessage, now, now, id)
}

export function markTaskCancelled(id: string): void {
  const now = Date.now()
  getDb().prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = ?, finished_at = ? WHERE id = ?')
    .run('cancelled', 'Cancelled by user', now, now, id)
}

export function recoverInterruptedTasks(): number {
  const now = Date.now()
  const result = getDb().prepare(`
    UPDATE tasks
    SET status = 'pending', error_message = 'Recovered after application restart', updated_at = ?, finished_at = NULL
    WHERE status = 'running'
  `).run(now)
  return result.changes
}

export function getPendingTasks(): DbTask[] {
  return getDb().prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC").all() as DbTask[]
}

export function getTasksByAccount(accountId: string): DbTask[] {
  return getDb().prepare('SELECT * FROM tasks WHERE account_id = ? ORDER BY created_at DESC').all(accountId) as DbTask[]
}

export function deleteTaskById(id: string): boolean {
  const database = getDb()
  return database.transaction(() => {
    database.prepare('DELETE FROM logs WHERE task_id = ?').run(id)
    return database.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
  })()
}

// ---- Log CRUD ----

export interface DbLog {
  id: string
  level: string
  module: string | null
  message: string
  detail: string | null
  created_at: number
  account_id?: string | null
  task_id?: string | null
}

export function insertLog(logEntry: DbLog): void {
  const stmt = getDb().prepare(`
    INSERT INTO logs (id, level, module, message, detail, created_at, account_id, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    logEntry.id,
    logEntry.level,
    logEntry.module,
    logEntry.message,
    logEntry.detail,
    logEntry.created_at,
    logEntry.account_id ?? null,
    logEntry.task_id ?? null,
  )
}

export function getLogsByTaskId(taskId: string): DbLog[] {
  return getDb().prepare('SELECT * FROM logs WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as DbLog[]
}

export function getRecentLogs(limit: number = 100): DbLog[] {
  return getDb().prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?').all(limit) as DbLog[]
}

// ---- Cascade delete ----

// ---- Files Cache CRUD ----

export interface DbCacheFile {
  id: string
  account_id: string
  platform: string
  file_id: string
  parent_id: string | null
  filename: string
  is_dir: number
  size: number
  created_at: number | null
  updated_at: number | null
  raw_json: string | null
}

export function insertFilesCache(files: DbCacheFile[]): void {
  if (files.length === 0) return
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO files_cache (id, account_id, platform, file_id, parent_id, filename, is_dir, size, created_at, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const txn = getDb().transaction((items: DbCacheFile[]) => {
    for (const f of items) {
      stmt.run(f.id, f.account_id, f.platform, f.file_id, f.parent_id, f.filename, f.is_dir, f.size, f.created_at, f.updated_at, f.raw_json)
    }
  })
  txn(files)
}

/** Replace one complete directory snapshot atomically, including empty folders. */
export function replaceFilesCacheSnapshot(
  accountId: string,
  parentId: string,
  files: DbCacheFile[],
  updatedAt: number = Date.now(),
): void {
  const database = getDb()
  const deleteItems = database.prepare('DELETE FROM files_cache WHERE account_id = ? AND parent_id = ?')
  const insertItem = database.prepare(`
    INSERT OR REPLACE INTO files_cache (id, account_id, platform, file_id, parent_id, filename, is_dir, size, created_at, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const upsertSnapshot = database.prepare(`
    INSERT INTO files_cache_snapshots (account_id, parent_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, parent_id) DO UPDATE SET updated_at = excluded.updated_at
  `)
  database.transaction(() => {
    deleteItems.run(accountId, parentId)
    for (const file of files) {
      insertItem.run(
        file.id, file.account_id, file.platform, file.file_id, file.parent_id,
        file.filename, file.is_dir, file.size, file.created_at, file.updated_at, file.raw_json,
      )
    }
    upsertSnapshot.run(accountId, parentId, updatedAt)
  })()
}

export function getFilesCacheByParent(accountId: string, parentId: string): DbCacheFile[] {
  return getDb().prepare(
    `SELECT * FROM files_cache WHERE account_id = ? AND parent_id = ? ORDER BY is_dir DESC, filename ASC`
  ).all(accountId, parentId) as DbCacheFile[]
}

export function getFilesCacheLatestTimestamp(accountId: string, parentId: string): number | null {
  const snapshot = getDb().prepare(
    'SELECT updated_at FROM files_cache_snapshots WHERE account_id = ? AND parent_id = ?'
  ).get(accountId, parentId) as { updated_at: number } | undefined
  if (snapshot) return snapshot.updated_at
  const row = getDb().prepare(
    `SELECT MAX(updated_at) as latest FROM files_cache WHERE account_id = ? AND parent_id = ?`
  ).get(accountId, parentId) as { latest: number | null } | undefined
  return row?.latest ?? null
}

export function invalidateFilesCacheParents(accountId: string, parentIds: string[]): number {
  const ids = [...new Set(parentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return 0
  const database = getDb()
  const deleteItems = database.prepare('DELETE FROM files_cache WHERE account_id = ? AND parent_id = ?')
  const deleteSnapshot = database.prepare('DELETE FROM files_cache_snapshots WHERE account_id = ? AND parent_id = ?')
  return database.transaction(() => {
    let changes = 0
    for (const parentId of ids) {
      changes += deleteItems.run(accountId, parentId).changes
      changes += deleteSnapshot.run(accountId, parentId).changes
    }
    return changes
  })()
}

export function getCachedParentIdsForFiles(accountId: string, fileIds: string[]): string[] {
  const ids = [...new Set(fileIds.filter(Boolean))]
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb().prepare(
    `SELECT DISTINCT parent_id FROM files_cache WHERE account_id = ? AND file_id IN (${placeholders}) AND parent_id IS NOT NULL`
  ).all(accountId, ...ids) as { parent_id: string }[]
  return rows.map((row) => row.parent_id)
}

export function clearFilesCache(accountId: string): number {
  const database = getDb()
  return database.transaction(() => {
    const items = database.prepare('DELETE FROM files_cache WHERE account_id = ?').run(accountId).changes
    database.prepare('DELETE FROM files_cache_snapshots WHERE account_id = ?').run(accountId)
    return items
  })()
}

export function deleteFilesCacheByAccount(accountId: string): number {
  return clearFilesCache(accountId)
}

export function deleteTasksByAccount(accountId: string): number {
  const result = getDb().prepare('DELETE FROM tasks WHERE account_id = ?').run(accountId)
  return result.changes
}

export function deleteLogsByAccount(accountId: string): number {
  const result = getDb().prepare('DELETE FROM logs WHERE account_id = ?').run(accountId)
  return result.changes
}

export function deleteLogsByTaskId(taskId: string): number {
  const result = getDb().prepare('DELETE FROM logs WHERE task_id = ?').run(taskId)
  return result.changes
}

// ---- Share Links CRUD ----

export interface DbShareLink {
  id: string
  account_id: string
  platform: string
  share_url: string
  password: string | null
  title: string | null
  file_ids: string
  expired_at: number | null
  status: string
  created_at: number
  updated_at: number
}

export function insertShareLink(link: DbShareLink): void {
  const stmt = getDb().prepare(`
    INSERT INTO share_links (id, account_id, platform, share_url, password, title, file_ids, expired_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    link.id,
    link.account_id,
    link.platform,
    link.share_url,
    link.password,
    link.title,
    link.file_ids,
    link.expired_at,
    link.status,
    link.created_at,
    link.updated_at,
  )
}

export function listShareLinks(filters?: { accountId?: string; platform?: string; status?: string; keyword?: string }): DbShareLink[] {
  let sql = 'SELECT sl.*, a.nickname as account_nickname FROM share_links sl LEFT JOIN accounts a ON sl.account_id = a.id WHERE 1=1'
  const params: unknown[] = []

  if (filters?.accountId) {
    sql += ' AND sl.account_id = ?'
    params.push(filters.accountId)
  }
  if (filters?.platform) {
    sql += ' AND sl.platform = ?'
    params.push(filters.platform)
  }
  if (filters?.status) {
    sql += ' AND sl.status = ?'
    params.push(filters.status)
  }
  if (filters?.keyword) {
    sql += ' AND (sl.title LIKE ? OR sl.share_url LIKE ?)'
    const kw = `%${filters.keyword}%`
    params.push(kw, kw)
  }

  sql += ' ORDER BY sl.created_at DESC'
  return getDb().prepare(sql).all(...params) as (DbShareLink & { account_nickname?: string })[]
}

export function updateShareLinkStatus(id: string, status: string): void {
  getDb().prepare('UPDATE share_links SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
}

export function deleteShareLink(id: string): void {
  getDb().prepare('DELETE FROM share_links WHERE id = ?').run(id)
}

// ---- Transfer Records CRUD ----

export interface DbTransferRecord {
  id: string
  account_id: string
  platform: string
  source_url: string
  password: string | null
  target_dir_id: string | null
  target_path: string | null
  saved_count: number
  status: string
  error_message: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

export function insertTransferRecord(record: DbTransferRecord): void {
  const stmt = getDb().prepare(`
    INSERT INTO transfer_records (id, account_id, platform, source_url, password, target_dir_id, target_path, saved_count, status, error_message, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    record.id,
    record.account_id,
    record.platform,
    record.source_url,
    record.password,
    record.target_dir_id,
    record.target_path,
    record.saved_count,
    record.status,
    record.error_message,
    record.created_at,
    record.updated_at,
    record.finished_at,
  )
}

export function listTransferRecords(filters?: { accountId?: string; platform?: string; status?: string; keyword?: string }): DbTransferRecord[] {
  let sql = 'SELECT tr.*, a.nickname as account_nickname FROM transfer_records tr LEFT JOIN accounts a ON tr.account_id = a.id WHERE 1=1'
  const params: unknown[] = []

  if (filters?.accountId) {
    sql += ' AND tr.account_id = ?'
    params.push(filters.accountId)
  }
  if (filters?.platform) {
    sql += ' AND tr.platform = ?'
    params.push(filters.platform)
  }
  if (filters?.status) {
    sql += ' AND tr.status = ?'
    params.push(filters.status)
  }
  if (filters?.keyword) {
    sql += ' AND (tr.source_url LIKE ? OR tr.target_path LIKE ? OR tr.error_message LIKE ?)'
    const kw = `%${filters.keyword}%`
    params.push(kw, kw, kw)
  }

  sql += ' ORDER BY tr.created_at DESC'
  return getDb().prepare(sql).all(...params) as (DbTransferRecord & { account_nickname?: string })[]
}

export function deleteTransferRecord(id: string): void {
  getDb().prepare('DELETE FROM transfer_records WHERE id = ?').run(id)
}

export function updateTransferRecordStatus(id: string, status: string): void {
  getDb().prepare('UPDATE transfer_records SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
}

export function markTransferRecordSuccess(id: string, savedCount: number): void {
  const now = Date.now()
  getDb().prepare('UPDATE transfer_records SET status = ?, saved_count = ?, updated_at = ?, finished_at = ? WHERE id = ?')
    .run('success', savedCount, now, now, id)
}

export function markTransferRecordFailed(id: string, errorMessage: string): void {
  const now = Date.now()
  getDb().prepare('UPDATE transfer_records SET status = ?, error_message = ?, updated_at = ?, finished_at = ? WHERE id = ?')
    .run('failed', errorMessage, now, now, id)
}

// ---- Settings CRUD ----

export function getSetting(key: string): { value: string; encrypted: number } | undefined {
  return getDb().prepare('SELECT value, encrypted FROM settings WHERE key = ?').get(key) as { value: string; encrypted: number } | undefined
}

export function setSetting(key: string, value: string, encrypted: boolean = false): void {
  const ts = Date.now()
  getDb().prepare(`
    INSERT INTO settings (key, value, encrypted, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at
  `).run(key, value, encrypted ? 1 : 0, ts)
}

export function deleteSetting(key: string): boolean {
  return getDb().prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0
}

export function getAllSettings(): { key: string; value: string; encrypted: number }[] {
  return getDb().prepare('SELECT key, value, encrypted FROM settings').all() as { key: string; value: string; encrypted: number }[]
}

/**
 * Delete an account and all related data (files_cache, tasks, logs).
 * Returns counts of deleted rows per table.
 */
export function deleteShareLinksByAccount(accountId: string): number {
  const result = getDb().prepare('DELETE FROM share_links WHERE account_id = ?').run(accountId)
  return result.changes
}

export function deleteTransferRecordsByAccount(accountId: string): number {
  const result = getDb().prepare('DELETE FROM transfer_records WHERE account_id = ?').run(accountId)
  return result.changes
}

export function deleteAccountCascade(id: string): { accounts: number; files: number; tasks: number; logs: number; shares: number; transfers: number; searchCache: number; searchHistory: number } {
  const txn = getDb().transaction(() => {
    const files = deleteFilesCacheByAccount(id)
    const logs = deleteLogsByAccount(id)
    const tasks = deleteTasksByAccount(id)
    const shares = deleteShareLinksByAccount(id)
    const transfers = deleteTransferRecordsByAccount(id)
    const searchCache = clearSearchCacheByAccount(id)
    const searchHistory = clearSearchHistory(id)
    const accountResult = getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id)
    return { accounts: accountResult.changes, files, tasks, logs, shares, transfers, searchCache, searchHistory }
  })
  return txn()
}

// ---- Search Sources CRUD ----

export interface DbSearchSource {
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
  created_at: number
  updated_at: number
}

export function getAllSearchSources(): DbSearchSource[] {
  return getDb().prepare('SELECT * FROM search_sources ORDER BY weight DESC, name ASC').all() as DbSearchSource[]
}

export function getActiveSearchSources(platform?: string): DbSearchSource[] {
  if (platform) {
    return getDb().prepare('SELECT * FROM search_sources WHERE status = 1 AND (platform = ? OR platform = ?) ORDER BY weight DESC')
      .all(platform, 'all') as DbSearchSource[]
  }
  return getDb().prepare('SELECT * FROM search_sources WHERE status = 1 ORDER BY weight DESC').all() as DbSearchSource[]
}

export function insertSearchSource(source: DbSearchSource): void {
  getDb().prepare(`
    INSERT INTO search_sources (id, name, type, platform, url, method, params, headers, field_map, html_selectors, max_count, weight, status, category, risk_level, capabilities, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.id, source.name, source.type, source.platform, source.url,
    source.method, source.params, source.headers, source.field_map,
    source.html_selectors, source.max_count, source.weight, source.status,
    source.category || '网盘搜索', source.risk_level || 'medium', source.capabilities || '[]',
    source.created_at, source.updated_at,
  )
}

export function updateSearchSource(source: DbSearchSource): void {
  getDb().prepare(`
    UPDATE search_sources SET name=?, type=?, platform=?, url=?, method=?, params=?, headers=?, field_map=?, html_selectors=?, max_count=?, weight=?, status=?, category=?, risk_level=?, capabilities=?, updated_at=?
    WHERE id=?
  `).run(
    source.name, source.type, source.platform, source.url,
    source.method, source.params, source.headers, source.field_map,
    source.html_selectors, source.max_count, source.weight, source.status,
    source.category || '网盘搜索', source.risk_level || 'medium', source.capabilities || '[]',
    source.updated_at, source.id,
  )
}

export function deleteSearchSource(id: string): void {
  getDb().prepare('DELETE FROM search_sources WHERE id = ?').run(id)
}

// ---- TG Channels CRUD ----

export interface DbTgChannel {
  id: string
  name: string
  channel: string
  platform: string
  max_count: number
  weight: number
  status: number
  created_at: number
  updated_at: number
}

export function getAllTgChannels(): DbTgChannel[] {
  return getDb().prepare('SELECT * FROM tg_channels ORDER BY weight DESC, name ASC').all() as DbTgChannel[]
}

export function getActiveTgChannels(platform?: string): DbTgChannel[] {
  if (platform) {
    return getDb().prepare('SELECT * FROM tg_channels WHERE status = 1 AND platform = ? ORDER BY weight DESC')
      .all(platform) as DbTgChannel[]
  }
  return getDb().prepare('SELECT * FROM tg_channels WHERE status = 1 ORDER BY weight DESC').all() as DbTgChannel[]
}

export function insertTgChannel(channel: DbTgChannel): void {
  getDb().prepare(`
    INSERT INTO tg_channels (id, name, channel, platform, max_count, weight, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    channel.id, channel.name, channel.channel, channel.platform,
    channel.max_count, channel.weight, channel.status,
    channel.created_at, channel.updated_at,
  )
}

export function updateTgChannel(channel: DbTgChannel): void {
  getDb().prepare(`
    UPDATE tg_channels SET name=?, channel=?, platform=?, max_count=?, weight=?, status=?, updated_at=?
    WHERE id=?
  `).run(
    channel.name, channel.channel, channel.platform,
    channel.max_count, channel.weight, channel.status,
    channel.updated_at, channel.id,
  )
}

export function deleteTgChannel(id: string): void {
  getDb().prepare('DELETE FROM tg_channels WHERE id = ?').run(id)
}

/** 预置默认TG频道 */
function seedDefaultTgChannels(): void {
  const count = (getDb().prepare('SELECT COUNT(*) as cnt FROM tg_channels').get() as { cnt: number }).cnt
  if (count > 0) return // 已有数据，不重复插入

  const ts = Date.now()
  const defaults = [
    { id: 'tg_quark_share', name: '夸克资源分享', channel: 'quark_share', platform: 'quark', max_count: 20, weight: 100 },
    { id: 'tg_quark_resources', name: '夸克网盘资源', channel: 'quark_resources', platform: 'quark', max_count: 20, weight: 90 },
    { id: 'tg_baidu_share', name: '百度资源分享', channel: 'baidu_share', platform: 'baidu', max_count: 20, weight: 100 },
    { id: 'tg_baidu_resources', name: '百度网盘资源', channel: 'baidu_resources', platform: 'baidu', max_count: 20, weight: 90 },
    { id: 'tg_uc_share', name: 'UC资源分享', channel: 'uc_share', platform: 'uc', max_count: 20, weight: 100 },
    { id: 'tg_xunlei_share', name: '迅雷资源分享', channel: 'xunlei_share', platform: 'xunlei', max_count: 20, weight: 100 },
    { id: 'tg_pan_resources', name: '网盘资源合集', channel: 'pan_resources', platform: 'quark', max_count: 20, weight: 80 },
    { id: 'tg_movie_share', name: '影视资源分享', channel: 'movie_share', platform: 'quark', max_count: 20, weight: 70 },
  ]

  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO tg_channels (id, name, channel, platform, max_count, weight, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)

  const insertMany = getDb().transaction(() => {
    for (const ch of defaults) {
      stmt.run(ch.id, ch.name, ch.channel, ch.platform, ch.max_count, ch.weight, ts, ts)
    }
  })
  insertMany()
  log.info('Seeded default TG channels')
}

// ---- Crawler Sources CRUD ----

export interface DbCrawlerSource {
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

  created_at: number
  updated_at: number
}

export function getAllCrawlerSources(): DbCrawlerSource[] {
  return getDb().prepare('SELECT * FROM crawler_sources ORDER BY weight DESC, name ASC').all() as DbCrawlerSource[]
}

export function getActiveCrawlerSources(platform?: string): DbCrawlerSource[] {
  if (platform) {
    return getDb().prepare('SELECT * FROM crawler_sources WHERE status = 1 AND platform = ? ORDER BY weight DESC')
      .all(platform) as DbCrawlerSource[]
  }
  return getDb().prepare('SELECT * FROM crawler_sources WHERE status = 1 ORDER BY weight DESC').all() as DbCrawlerSource[]
}

export function insertCrawlerSource(source: DbCrawlerSource): void {
  getDb().prepare(`
    INSERT INTO crawler_sources (
      id, name, url, platform, max_count, weight, status,
      html_item, html_title, html_url, html_url2, html_type,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.id, source.name, source.url, source.platform,
    source.max_count, source.weight, source.status,
    source.html_item, source.html_title, source.html_url, source.html_url2,
    source.html_type,
    source.created_at, source.updated_at,
  )
}

export function updateCrawlerSource(source: DbCrawlerSource): void {
  getDb().prepare(`
    UPDATE crawler_sources SET
      name=?, url=?, platform=?, max_count=?, weight=?, status=?,
      html_item=?, html_title=?, html_url=?, html_url2=?, html_type=?,
      updated_at=?
    WHERE id=?
  `).run(
    source.name, source.url, source.platform,
    source.max_count, source.weight, source.status,
    source.html_item, source.html_title, source.html_url, source.html_url2,
    source.html_type,
    source.updated_at, source.id,
  )
}

export function deleteCrawlerSource(id: string): void {
  getDb().prepare('DELETE FROM crawler_sources WHERE id = ?').run(id)
}

// ---- KK Sources CRUD ----

export interface DbKkSource {
  id: string
  name: string
  platform: string
  api_type: number
  max_count: number
  weight: number
  status: number
  created_at: number
  updated_at: number
}

export function getAllKkSources(): DbKkSource[] {
  return getDb().prepare('SELECT * FROM kk_sources ORDER BY weight DESC, name ASC').all() as DbKkSource[]
}

export function getActiveKkSources(platform?: string): DbKkSource[] {
  if (platform) {
    return getDb().prepare('SELECT * FROM kk_sources WHERE status = 1 AND platform = ? ORDER BY weight DESC')
      .all(platform) as DbKkSource[]
  }
  return getDb().prepare('SELECT * FROM kk_sources WHERE status = 1 ORDER BY weight DESC').all() as DbKkSource[]
}

export function insertKkSource(source: DbKkSource): void {
  getDb().prepare(`
    INSERT INTO kk_sources (id, name, platform, api_type, max_count, weight, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.id, source.name, source.platform, source.api_type,
    source.max_count, source.weight, source.status,
    source.created_at, source.updated_at,
  )
}

export function updateKkSource(source: DbKkSource): void {
  getDb().prepare(`
    UPDATE kk_sources SET name=?, platform=?, api_type=?, max_count=?, weight=?, status=?, updated_at=?
    WHERE id=?
  `).run(
    source.name, source.platform, source.api_type,
    source.max_count, source.weight, source.status,
    source.updated_at, source.id,
  )
}

export function deleteKkSource(id: string): void {
  getDb().prepare('DELETE FROM kk_sources WHERE id = ?').run(id)
}

/** 预置默认KK搜索源 */
function seedDefaultKkSources(): void {
  const count = (getDb().prepare('SELECT COUNT(*) as cnt FROM kk_sources').get() as { cnt: number }).cnt
  if (count > 0) return // 已有数据，不重复插入

  const ts = Date.now()
  const defaults = [
    { id: 'kk_quark_all', name: 'KK夸克全部', platform: 'quark', api_type: 0, max_count: 20, weight: 100 },
    { id: 'kk_quark_juzi', name: 'KK夸克句子', platform: 'quark', api_type: 1, max_count: 20, weight: 90 },
    { id: 'kk_quark_search', name: 'KK夸克搜索', platform: 'quark', api_type: 2, max_count: 20, weight: 80 },
    { id: 'kk_baidu_all', name: 'KK百度全部', platform: 'baidu', api_type: 0, max_count: 20, weight: 100 },
    { id: 'kk_baidu_juzi', name: 'KK百度句子', platform: 'baidu', api_type: 1, max_count: 20, weight: 90 },
    { id: 'kk_baidu_search', name: 'KK百度搜索', platform: 'baidu', api_type: 2, max_count: 20, weight: 80 },
  ]

  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO kk_sources (id, name, platform, api_type, max_count, weight, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)

  const insertMany = getDb().transaction(() => {
    for (const s of defaults) {
      stmt.run(s.id, s.name, s.platform, s.api_type, s.max_count, s.weight, ts, ts)
    }
  })
  insertMany()
  log.info('Seeded default KK sources')
}

/** 预置默认网页爬虫源 */
function seedDefaultCrawlerSources(): void {
  const count = (getDb().prepare('SELECT COUNT(*) as cnt FROM crawler_sources').get() as { cnt: number }).cnt
  if (count > 0) return // 已有数据，不重复插入

  const ts = Date.now()
  const defaults = [
    // 磁力资源站
    {
      id: 'crawler_cilibao',
      name: '磁力宝',
      url: 'https://www.cilibao.me/search/{keyword}',
      platform: 'all',
      max_count: 20,
      weight: 90,
      html_item: 'div+search-item',
      html_title: 'a+title',
      html_url: 'a+',
      html_url2: 'div+info',
      html_type: 0,
    },
    // 资源搜索站
    {
      id: 'crawler_upyunso',
      name: 'UP云搜',
      url: 'https://www.upyunso.com/search?keyword={keyword}',
      platform: 'quark',
      max_count: 20,
      weight: 85,
      html_item: 'div+search-result',
      html_title: 'a+title',
      html_url: 'a+link',
      html_url2: 'div+desc',
      html_type: 0,
    },
    // 夸克资源站
    {
      id: 'crawler_quarkso',
      name: '夸克搜',
      url: 'https://www.quarkso.com/search?keyword={keyword}',
      platform: 'quark',
      max_count: 20,
      weight: 80,
      html_item: 'div+result-item',
      html_title: 'a+title',
      html_url: 'a+',
      html_url2: 'div+meta',
      html_type: 0,
    },
    // 百度网盘资源站
    {
      id: 'crawler_baiduso',
      name: '百度搜',
      url: 'https://www.baiduso.com/search?keyword={keyword}',
      platform: 'baidu',
      max_count: 20,
      weight: 75,
      html_item: 'div+search-item',
      html_title: 'a+title',
      html_url: 'a+',
      html_url2: 'div+info',
      html_type: 0,
    },
  ]

  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO crawler_sources (id, name, url, platform, max_count, weight, status, html_item, html_title, html_url, html_url2, html_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMany = getDb().transaction(() => {
    for (const s of defaults) {
      stmt.run(s.id, s.name, s.url, s.platform, s.max_count, s.weight, s.html_item, s.html_title, s.html_url, s.html_url2, s.html_type, ts, ts)
    }
  })
  insertMany()
  log.info('Seeded default crawler sources')
}

// ---- Search Cache CRUD ----

export interface DbSearchCache {
  id: string
  account_id: string
  keyword: string
  results: string  // JSON string of FileItem[]
  created_at: number
  expires_at: number
}

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export function getCachedSearchResults(accountId: string, keyword: string): string | null {
  const now = Date.now()
  const row = getDb().prepare(
    'SELECT results FROM search_cache WHERE account_id = ? AND keyword = ? AND expires_at > ?'
  ).get(accountId, keyword, now) as { results: string } | undefined
  return row?.results ?? null
}

export function setCachedSearchResults(accountId: string, keyword: string, results: string): void {
  const now = Date.now()
  const id = `${accountId}:${keyword}`
  getDb().prepare(`
    INSERT OR REPLACE INTO search_cache (id, account_id, keyword, results, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, accountId, keyword, results, now, now + SEARCH_CACHE_TTL_MS)
}

export function clearExpiredSearchCache(): number {
  const result = getDb().prepare('DELETE FROM search_cache WHERE expires_at < ?').run(Date.now())
  return result.changes
}

export function clearSearchCacheByAccount(accountId: string): number {
  const result = getDb().prepare('DELETE FROM search_cache WHERE account_id = ?').run(accountId)
  return result.changes
}

// ---- Search History CRUD ----

export interface DbSearchHistory {
  id: number
  account_id: string
  keyword: string
  result_count: number
  created_at: number
}

export function getSearchHistory(accountId: string, limit: number = 10): DbSearchHistory[] {
  return getDb().prepare(
    'SELECT * FROM search_history WHERE account_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(accountId, limit) as DbSearchHistory[]
}

export function addSearchHistory(accountId: string, keyword: string, resultCount: number): void {
  const now = Date.now()
  // 先尝试更新已有记录
  const existing = getDb().prepare(
    'SELECT id FROM search_history WHERE account_id = ? AND keyword = ?'
  ).get(accountId, keyword) as { id: number } | undefined

  if (existing) {
    getDb().prepare(
      'UPDATE search_history SET result_count = ?, created_at = ? WHERE id = ?'
    ).run(resultCount, now, existing.id)
  } else {
    getDb().prepare(
      'INSERT INTO search_history (account_id, keyword, result_count, created_at) VALUES (?, ?, ?, ?)'
    ).run(accountId, keyword, resultCount, now)
  }
}

export function clearSearchHistory(accountId: string): number {
  const result = getDb().prepare('DELETE FROM search_history WHERE account_id = ?').run(accountId)
  return result.changes
}
