const { Router } = require('express')
const db = require('../db')
const router = Router()

router.get('/tools', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM tool_registry ORDER BY sort_order').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/display-profiles', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM display_quality_profiles').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/full', (_req, res) => {
  try {
    const tools = db.prepare('SELECT * FROM tool_registry ORDER BY sort_order').all()
    const displayProfiles = db.prepare('SELECT * FROM display_quality_profiles').all()
    res.json({ ok: true, data: { tools, displayProfiles } })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

module.exports = router
