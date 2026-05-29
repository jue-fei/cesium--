const { Router } = require('express')
const db = require('../db')
const router = Router()

router.get('/orebodies', (_req, res) => {
  try { res.json({ ok: true, data: db.prepare('SELECT * FROM geology_orebodies').all() }) }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/stats', (_req, res) => {
  try {
    const rows = db.prepare('SELECT stat_key, stat_value FROM geology_stats').all()
    const stats = {}
    for (const row of rows) stats[row.stat_key] = row.stat_value
    res.json({ ok: true, data: stats })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

router.get('/full', (_req, res) => {
  try {
    const orebodies = db.prepare('SELECT * FROM geology_orebodies').all()
    const rows = db.prepare('SELECT stat_key, stat_value FROM geology_stats').all()
    const stats = {}
    for (const row of rows) stats[row.stat_key] = row.stat_value
    res.json({ ok: true, data: { orebodies, stats } })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

module.exports = router
