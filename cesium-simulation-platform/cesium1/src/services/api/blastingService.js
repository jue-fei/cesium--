import client, { safeRequest } from './apiClient'

// ---- 降级默认值（来自 blastingDataCore.js）----
const FALLBACK_CONFIG = {
  default_fragment_model_uri: { value: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb' },
  default_playback_speed_ms: { value: 120 },
  default_blast_center: { lon: 116.3915, lat: 39.9015, height: 0 },
  example_event: { id: 'BLAST-DEMO-001', name: '示例爆破事件', chargeKg: 320 },
  example_design_face_before: { width: 10, height: 8, thickness: 0.8, headingDeg: 15 },
  example_design_face_after: { width: 10.6, height: 8.5, thickness: 0.8, headingDeg: 15 },
  default_blasting_summary: { frameCount: 0, fragmentCount: 0, durationSec: 0, maxWaveRadius: 0, holeCount: 0, rockBlockCount: 0 }
}

export async function fetchBlastingConfig() {
  return safeRequest(() => client.get('/blasting/config'), FALLBACK_CONFIG)
}
