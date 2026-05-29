const { Router } = require('express')
const db = require('../db')
const router = Router()

// 获取所有应用配置
router.get('/', (_req, res) => {
  try {
    const rows = db.prepare('SELECT setting_key, setting_value FROM app_settings ORDER BY id').all()
    const config = {}
    for (const row of rows) {
      try { config[row.setting_key] = JSON.parse(row.setting_value) } catch (_) { config[row.setting_key] = row.setting_value }
    }
    res.json({ ok: true, data: config })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// 获取单个配置项
router.get('/:key', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM app_settings WHERE setting_key = ?').get(req.params.key)
    if (!row) return res.status(404).json({ ok: false, message: '配置项不存在' })
    let value = row.setting_value
    try { value = JSON.parse(value) } catch (_) {}
    res.json({ ok: true, data: value })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

module.exports = router
