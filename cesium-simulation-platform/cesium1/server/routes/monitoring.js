const { Router } = require('express')
const db = require('../db')
const router = Router()

router.get('/cameras', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM camera_presets ORDER BY sort_order').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/minerals', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM mineral_types ORDER BY sort_order').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/transport-units', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM transport_units ORDER BY sort_order').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/mining-pits', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM mining_pit_specs').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/trucks', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM truck_configs').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/simulation', (_req, res) => {
  try {
    const rows = db.prepare('SELECT config_key, config_value FROM simulation_configs').all()
    const config = {}
    for (const row of rows) {
      try { config[row.config_key] = JSON.parse(row.config_value) } catch (_) { config[row.config_key] = row.config_value }
    }
    res.json({ ok: true, data: config })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/full-config', (_req, res) => {
  try {
    res.json({ ok: true, data: {
      cameras: db.prepare('SELECT * FROM camera_presets ORDER BY sort_order').all(),
      minerals: db.prepare('SELECT * FROM mineral_types ORDER BY sort_order').all(),
      transportUnits: db.prepare('SELECT * FROM transport_units ORDER BY sort_order').all(),
      miningPits: db.prepare('SELECT * FROM mining_pit_specs').all(),
      trucks: db.prepare('SELECT * FROM truck_configs').all()
    }})
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

module.exports = router
