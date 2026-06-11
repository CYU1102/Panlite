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
