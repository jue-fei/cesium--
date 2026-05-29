const { Router } = require('express')
const db = require('../db')
const router = Router()

router.get('/config', (_req, res) => {
  try {
    const rows = db.prepare('SELECT config_key, config_value FROM blasting_configs').all()
    const config = {}
    for (const row of rows) {
      try { config[row.config_key] = JSON.parse(row.config_value) } catch (_) { config[row.config_key] = row.config_value }
    }
    res.json({ ok: true, data: config })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

module.exports = router
