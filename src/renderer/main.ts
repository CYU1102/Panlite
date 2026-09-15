import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { provideGlobalConfig } from 'element-plus/es/components/config-provider/index.mjs'
import 'element-plus/theme-chalk/base.css'
import 'element-plus/es/components/message/style/css.mjs'
import 'element-plus/es/components/message-box/style/css.mjs'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/tokens.css'
import App from './App.vue'
import router from './router'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// Template components and styles are imported within their route by Vite.
// Keep the same global defaults as ElementPlus's default plugin.
provideGlobalConfig({ size: 'default', zIndex: 3000 }, app)

app.mount('#app')

void router.isReady().then(async () => {
  await nextTick()
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('panlite-first-screen')))
})
