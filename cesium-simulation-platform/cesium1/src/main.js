import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import useMessage from './composables/useMessage.js'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/styles/variables.css'

window.CESIUM_BASE_URL = '/'
document.documentElement.dataset.theme = 'dark'
document.documentElement.classList.add('dark')

const app = createApp(App)
app.use(createPinia())

const { showMessage } = useMessage()

app.config.errorHandler = (err, _instance, info) => {
  if (import.meta.env.DEV) {
  }
  showMessage(`系统错误: ${err.message || '未知错误'}`, 'error')
}

window.onerror = (message, source, lineno, colno, error) => {
  if (import.meta.env.DEV) {
  }
  showMessage(`全局错误: ${message}`, 'error')
  return true
}

window.onunhandledrejection = event => {
  if (import.meta.env.DEV) {
  }
  showMessage(`异步错误: ${event.reason?.message || event.reason || '未知'}`, 'error')
}

app.mount('#app')
