import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import useMessage from '@/composables/useMessage.js'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/styles/variables.css'

// 配置 Cesium 静态资源路径
window.CESIUM_BASE_URL = '/'

document.documentElement.dataset.theme = 'dark'
document.documentElement.classList.add('dark')

const app = createApp(App)
app.use(createPinia())

// 全局错误处理
const { showMessage } = useMessage()

// 1. Vue 应用内错误
app.config.errorHandler = (err, instance, info) => {
  console.error('Vue Error:', err)
  console.error('Info:', info)
  showMessage(`系统错误: ${err.message || '未知错误'}`, 'error')
}

// 2. 全局未捕获异常
window.onerror = (message, source, lineno, colno, error) => {
  console.error('Global Error:', { message, source, lineno, colno, error })
  showMessage(`全局错误: ${message}`, 'error')
  return true // 阻止默认处理（如在控制台再次打印）
}

// 3. 未处理的 Promise 拒绝
window.onunhandledrejection = event => {
  console.error('Unhandled Promise Rejection:', event.reason)
  showMessage(`异步错误: ${event.reason?.message || event.reason || '未知异步错误'}`, 'error')
}

app.mount('#app')
