const { Router } = require('express')
const db = require('../db')
const router = Router()

// 获取所有模型配置
router.get('/', (_req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM model_configs ORDER BY sort_order').all()
    res.json({ ok: true, data: rows })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// 获取指定模型的全部特征（modelMappings + globalProperties）
router.get('/:id/feature', (req, res) => {
  try {
    const features = db.prepare('SELECT * FROM model_features WHERE model_config_id = ?').all(req.params.id)
    res.json({ ok: true, data: { modelMappings: features } })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

module.exports = router
