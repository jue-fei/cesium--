const { Router } = require('express')
const db = require('../db')
const router = Router()

router.get('/metrics', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM stress_metrics ORDER BY sort_order').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/heatmap-ramp', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT value, color, label FROM heatmap_ramps ORDER BY sort_order').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/warning-rules', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM warning_rules ORDER BY sort_order').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/heatmap-panel-defaults', (_req, res) => {
  try {
    const row = db.prepare("SELECT config_value FROM simulation_configs WHERE config_key = 'heatmap_panel_defaults'").get()
    let val = row?.config_value || '{}'
    try { val = JSON.parse(val) } catch (_) {}
    res.json({ ok: true, data: val })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/defaults', (_req, res) => {
  try {
    const rows = db.prepare("SELECT config_key, config_value FROM simulation_configs WHERE config_key IN ('stress_default_metric','stress_default_unit')").all()
    const config = {}
    for (const row of rows) {
      try { config[row.config_key] = JSON.parse(row.config_value) } catch (_) { config[row.config_key] = row.config_value }
    }
    res.json({ ok: true, data: config })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

module.exports = router
