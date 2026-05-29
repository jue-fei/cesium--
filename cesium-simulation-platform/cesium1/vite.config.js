import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteExternalsPlugin } from 'vite-plugin-externals'
import path from 'path'
import fs from 'fs/promises'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import viteCompression from 'vite-plugin-compression'

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'model-config-writer',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.method !== 'POST' || req.url !== '/api/model-config/save') return next()
          let body = ''
          req.on('data', chunk => {
            body += chunk
          })
          req.on('end', async () => {
            try {
              const payload = JSON.parse(body || '{}')
              const configPath = payload.path
              const data = payload.data
              if (
                !configPath ||
                typeof configPath !== 'string' ||
                !configPath.startsWith('/3d/') ||
                !configPath.endsWith('.json')
              ) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ success: false, message: '无效路径' }))
                return
              }
              const publicRoot = path.resolve(__dirname, 'public')
              const targetPath = path.resolve(publicRoot, `.${configPath}`)
              if (!targetPath.startsWith(publicRoot)) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ success: false, message: '路径越界' }))
                return
              }
              await fs.writeFile(targetPath, JSON.stringify(data || {}, null, 2), 'utf-8')
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ success: true }))
            } catch (e) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ success: false, message: '写入失败' }))
            }
          })
        })
      }
    },
    viteExternalsPlugin({
      cesium: 'Cesium'
    }),
    AutoImport({
      resolvers: [ElementPlusResolver()]
    }),
    Components({
      resolvers: [ElementPlusResolver()]
    }),
    viteCompression({
      verbose: true,
      disable: false,
      threshold: 10240,
      algorithm: 'gzip',
      ext: '.gz'
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          'element-plus': ['element-plus'],
          vendor: ['vue', 'pinia']
        }
      }
    }
  }
})
