const { Router } = require('express')
const db = require('../db')
const router = Router()

router.get('/presets', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM experiment_presets ORDER BY sort_order').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/methods', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM experiment_methods').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/default-config', (_req, res) => {
  try {
    const row = db.prepare('SELECT config_json FROM experiment_default_config LIMIT 1').get()
    let val = row?.config_json || '{}'
    try { val = JSON.parse(val) } catch (_) {}
    res.json({ ok: true, data: val })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/full', (_req, res) => {
  try {
    const presets = db.prepare('SELECT * FROM experiment_presets ORDER BY sort_order').all()
    const methods = db.prepare('SELECT * FROM experiment_methods').all()
    const configRow = db.prepare('SELECT config_json FROM experiment_default_config LIMIT 1').get()
    let defaultConfig = configRow?.config_json || '{}'
    try { defaultConfig = JSON.parse(defaultConfig) } catch (_) {}
    res.json({ ok: true, data: { presets, methods, defaultConfig } })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

module.exports = router
