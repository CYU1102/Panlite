import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/files',
    },
    {
      path: '/files',
      name: 'FileManager',
      component: () => import('../pages/FileManager.vue'),
    },
    {
      path: '/accounts',
      name: 'AccountManager',
      component: () => import('../pages/AccountManager.vue'),
    },
    {
      path: '/tasks',
      name: 'TaskLog',
      component: () => import('../pages/TaskLog.vue'),
    },
    {
      path: '/share-links',
      name: 'ShareLinks',
      component: () => import('../pages/ShareLinks.vue'),
    },
    {
      path: '/transfer-records',
      name: 'TransferRecords',
      component: () => import('../pages/TransferRecords.vue'),
    },
    {
      path: '/batch-transfer',
      name: 'BatchTransfer',
      component: () => import('../pages/BatchTransfer.vue'),
    },
    {
      path: '/cloud-transfer',
      name: 'CloudTransfer',
      component: () => import('../pages/CloudTransfer.vue'),
    },
    {
      path: '/batch-share',
      name: 'BatchShare',
      component: () => import('../pages/BatchShare.vue'),
    },
    {
      path: '/resource-search',
      name: 'ResourceSearch',
      component: () => import('../pages/ResourceSearch.vue'),
    },
    {
      path: '/global-search',
      name: 'GlobalSearch',
      component: () => import('../pages/GlobalSearch.vue'),
    },
    {
      path: '/ai-workspace',
      name: 'AiWorkspace',
      component: () => import('../pages/AiWorkspace.vue'),
    },
    {
      path: '/backup-restore',
      name: 'BackupRestore',
      component: () => import('../pages/BackupRestore.vue'),
    },
    {
      path: '/security',
      name: 'Security',
      component: () => import('../pages/Security.vue'),
    },
    {
      path: '/dashboard',
      name: 'Dashboard',
      component: () => import('../pages/Dashboard.vue'),
    },
    {
      path: '/settings',
      name: 'Settings',
      component: () => import('../pages/Settings.vue'),
    },
    {
      path: '/export',
      name: 'Export',
      component: () => import('../pages/Placeholder.vue'),
      props: { title: '导出文件' },
    },
    {
      // Catch-all: redirect unknown paths to /files
      path: '/:pathMatch(.*)*',
      redirect: '/files',
    },
  ],
})

export default router
