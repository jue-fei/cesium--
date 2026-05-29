const express = require('express')
const cors = require('cors')
const db = require('./db')

const modelConfigsRouter = require('./routes/modelConfigs')
const appConfigsRouter = require('./routes/appConfigs')
const monitoringRouter = require('./routes/monitoring')
const stressAnalysisRouter = require('./routes/stressAnalysis')
const geologyRouter = require('./routes/geology')
const experimentRouter = require('./routes/experiment')
const blastingRouter = require('./routes/blasting')
const systemConfigsRouter = require('./routes/systemConfigs')

const app = express()
const PORT = process.env.API_PORT || 3001

app.use(cors())
app.use(express.json())

// 浏览器数据查看页面（无需外部工具）
app.get('/db-view', (_req, res) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  const data = {}
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT * FROM [${name}]`).all()
    data[name] = { count: rows.length, rows: rows.slice(0, 100) }
  }
  const html = renderDbView(data)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
})

// API 路由
app.use('/api/models', modelConfigsRouter)
app.use('/api/app-config', appConfigsRouter)
app.use('/api/monitoring', monitoringRouter)
app.use('/api/stress', stressAnalysisRouter)
app.use('/api/geology', geologyRouter)
app.use('/api/experiment', experimentRouter)
app.use('/api/blasting', blastingRouter)
app.use('/api/system', systemConfigsRouter)

// 健康检查
app.get('/api/health', (_req, res) => {
  const count = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get().c
  res.json({ status: 'ok', db: 'connected', tables: count })
})

app.listen(PORT, () => {
  console.log(`[API Server] 运行在 http://localhost:${PORT}`)
  console.log(`[API Server] 数据库浏览: http://localhost:${PORT}/db-view`)
})

function renderDbView(data) {
  const tableNames = Object.keys(data)
  const nav = tableNames.map(n => `<a href="#${n}" style="display:inline-block;margin:4px 8px;color:#409EFF;text-decoration:none">${n} (${data[n].count})</a>`).join('')
  const sections = tableNames.map(name => {
    const d = data[name]
    if (d.rows.length === 0) return `<div id="${name}"><h3>${name} <small>(空)</small></h3></div>`
    const cols = Object.keys(d.rows[0])
    const thead = `<tr>${cols.map(c => `<th style="position:sticky;top:0;background:#f5f7fa;padding:6px 12px;border-bottom:2px solid #dcdfe6;white-space:nowrap">${c}</th>`).join('')}</tr>`
    const tbody = d.rows.map(r => `<tr>${cols.map(c => `<td style="padding:6px 12px;border-bottom:1px solid #ebeef5;max-width:350px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:top" title="${String(r[c] ?? '').replace(/"/g,'&quot;')}">${String(r[c] ?? '—')}</td>`).join('')}</tr>`).join('')
    return `<div id="${name}" style="margin-bottom:24px"><h3 style="margin:16px 0 8px 0;color:#303133">${name} <small style="color:#909399">(${d.count} 条)</small></h3><div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:13px;min-width:100%">${thead}${tbody}</table></div></div>`
  }).join('')

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>数据库浏览 - cesium_platform</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f2f5;color:#303133;padding:20px}h1{color:#1f2f3d;margin-bottom:8px}a:hover{text-decoration:underline!important}#nav{background:#fff;padding:12px 16px;border-radius:8px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.08);position:sticky;top:8px;z-index:10}#content{background:#fff;padding:16px 24px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}table{width:100%}tr:hover td{background:#f5f7fa}</style></head>
<body><h1>cesium_platform 数据库浏览</h1><p style="color:#909399;margin-bottom:16px">数据库文件: server/data.db</p>
<div id="nav">${nav}</div><div id="content">${sections}</div></body></html>`
}
