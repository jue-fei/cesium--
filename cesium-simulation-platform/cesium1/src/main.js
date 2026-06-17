import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/styles/variables.css'
import { initializeCesiumBaseUrl } from './utils/cesiumBaseUrl.js'
import { installGlobalErrorCapture } from './utils/globalErrorCapture.js'
import { logger } from './utils/logger.js'

initializeCesiumBaseUrl()
document.documentElement.dataset.theme = 'dark'
document.documentElement.classList.add('dark')

const app = createApp(App)
app.use(createPinia())

installGlobalErrorCapture(app)

app.mount('#app')
logger.info('bootstrap', '应用启动完成')
