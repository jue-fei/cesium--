/**
 * 二进制帧打包/解析对称性测试
 *
 * 验证后端 Python `struct.pack('>')`（大端）打包的二进制帧
 * 能被前端 `BlastingWsConnector._parseFloatFieldFrame / _parseDamageField`
 * 正确解析（DataView bigEndian=true 读取）。
 *
 * 测试策略：
 *   1. 在 JS 中用 DataView（大端）构造与后端完全相同格式的二进制帧
 *   2. 用前端解析器解析
 *   3. 逐字段验证 round-trip 一致性
 *
 * 后端帧格式（blast_physics.py pack_ppv/stress/damage_binary，45 字节头）：
 *   偏移  长度  类型      含义
 *   0     1    uint8    type_id (0x02/0x03/0x04)
 *   1     4    uint32   sim_frame
 *   5     4    float32  t
 *   9     4    uint32   grid_w (nx)
 *   13    4    uint32   grid_h (ny)
 *   17    4    uint32   grid_d (nz)
 *   21    24   6×float32 bounds_min(xyz) + bounds_max(xyz)
 *   45    N×4  float32[N] / N×1 int8[N] 载荷
 *
 * 后端载荷轴序：_webgl_flatten_3d 转置 (nx,ny,nz)→(nz,ny,nx)，x-最快
 */
import { describe, it, expect } from 'vitest'
import { BlastingWsConnector } from '../blastingWsConnector.js'

// ─── 工具：构造大端二进制帧 ──────────────────────────

/**
 * 构造与后端 pack_ppv/stress_binary 相同格式的 float32 体素帧
 * @param {number} typeId - 0x02 (PPV) 或 0x03 (STRESS)
 * @returns {{ buffer: ArrayBuffer, meta: Object }}
 */
function buildFloatFrame(typeId) {
  const nx = 3, ny = 2, nz = 4
  const voxelCount = nx * ny * nz // 24
  const headerSize = 45
  const buf = new ArrayBuffer(headerSize + voxelCount * 4)
  const view = new DataView(buf)

  const frame = 42
  const t = 1.5
  const bmin = [-10.5, -5.0, 0.0]
  const bmax = [10.5, 15.0, 25.0]

  // 头部（大端，与 Python struct.pack('>...') 一致）
  view.setUint8(0, typeId)
  view.setUint32(1, frame, false)        // false = big-endian
  view.setFloat32(5, t, false)
  view.setUint32(9, nx, false)
  view.setUint32(13, ny, false)
  view.setUint32(17, nz, false)
  view.setFloat32(21, bmin[0], false)
  view.setFloat32(25, bmin[1], false)
  view.setFloat32(29, bmin[2], false)
  view.setFloat32(33, bmax[0], false)
  view.setFloat32(37, bmax[1], false)
  view.setFloat32(41, bmax[2], false)

  // 载荷：构造已知值（x*100 + y*10 + z），按 WebGL x-最快轴序写入
  // 后端 _webgl_flatten_3d: reshape(nx,ny,nz) → transpose(2,1,0) → (nz,ny,nx)
  // 即 data[z*nx*ny + y*nx + x] = field[x,y,z]
  const values = new Float32Array(voxelCount)
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const idx = iz * nx * ny + iy * nx + ix
        values[idx] = ix * 100 + iy * 10 + iz
      }
    }
  }
  // 写入大端 float32
  for (let i = 0; i < voxelCount; i++) {
    view.setFloat32(headerSize + i * 4, values[i], false)
  }

  return {
    buffer: buf,
    meta: { frame, t, nx, ny, nz, bmin, bmax, values, voxelCount },
  }
}

/**
 * 构造与后端 pack_damage_binary 相同格式的 int8 体素帧
 * @returns {{ buffer: ArrayBuffer, meta: Object }}
 */
function buildDamageFrame() {
  const nx = 3, ny = 2, nz = 2
  const voxelCount = nx * ny * nz // 12
  const headerSize = 45
  const buf = new ArrayBuffer(headerSize + voxelCount) // int8 = 1 byte/voxel
  const view = new DataView(buf)

  const frame = 99
  const t = 2.5
  const bmin = [-8.0, -4.0, 0.0]
  const bmax = [8.0, 12.0, 20.0]

  view.setUint8(0, 0x04)
  view.setUint32(1, frame, false)
  view.setFloat32(5, t, false)
  view.setUint32(9, nx, false)
  view.setUint32(13, ny, false)
  view.setUint32(17, nz, false)
  view.setFloat32(21, bmin[0], false)
  view.setFloat32(25, bmin[1], false)
  view.setFloat32(29, bmin[2], false)
  view.setFloat32(33, bmax[0], false)
  view.setFloat32(37, bmax[1], false)
  view.setFloat32(41, bmax[2], false)

  // 载荷：int8 分区 id 0~4，按 x-最快轴序
  const zones = new Int8Array(voxelCount)
  for (let i = 0; i < voxelCount; i++) {
    zones[i] = i % 5 // 循环 0,1,2,3,4
    view.setInt8(headerSize + i, zones[i])
  }

  return { buffer: buf, meta: { frame, t, nx, ny, nz, bmin, bmax, zones, voxelCount } }
}


// ─── 创建解析器实例（不连接 WebSocket） ────────────────
function createParser() {
  // 传入 url 避免 _buildUrl 访问 window.location
  return new BlastingWsConnector('test-event', { url: 'ws://localhost/test', autoReconnect: false })
}


// ============================================================
// PPV 帧（0x02）对称性
// ============================================================
describe('二进制帧对称性 - PPV (0x02)', () => {
  it('头部字段 round-trip 一致', () => {
    const { buffer, meta } = buildFloatFrame(0x02)
    const parser = createParser()
    const view = new DataView(buffer)
    const result = parser._parsePpvField(view, buffer)

    expect(result.frame).toBe(meta.frame)
    expect(result.t).toBeCloseTo(meta.t, 5)
    expect(result.gridShape).toEqual([meta.nx, meta.ny, meta.nz])
    expect(result.boundsMin).toEqual(meta.bmin.map(v => expect.closeTo(v, 3)))
    expect(result.boundsMax).toEqual(meta.bmax.map(v => expect.closeTo(v, 3)))
  })

  it('载荷数据 round-trip 一致（float32 大端）', () => {
    const { buffer, meta } = buildFloatFrame(0x02)
    const parser = createParser()
    const view = new DataView(buffer)
    const result = parser._parsePpvField(view, buffer)

    expect(result.ppv).toBeInstanceOf(Float32Array)
    expect(result.ppv).toHaveLength(meta.voxelCount)
    for (let i = 0; i < meta.voxelCount; i++) {
      expect(result.ppv[i]).toBeCloseTo(meta.values[i], 3)
    }
  })

  it('WebGL x-最快轴序：data[z*nx*ny + y*nx + x] == field[x,y,z]', () => {
    const { buffer, meta } = buildFloatFrame(0x02)
    const parser = createParser()
    const view = new DataView(buffer)
    const result = parser._parsePpvField(view, buffer)

    const { nx, ny, nz } = meta
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const webglIdx = iz * nx * ny + iy * nx + ix
          const expected = ix * 100 + iy * 10 + iz
          expect(result.ppv[webglIdx]).toBeCloseTo(expected, 3)
        }
      }
    }
  })
})


// ============================================================
// STRESS 帧（0x03）对称性
// ============================================================
describe('二进制帧对称性 - STRESS (0x03)', () => {
  it('头部与载荷 round-trip 一致', () => {
    const { buffer, meta } = buildFloatFrame(0x03)
    const parser = createParser()
    const view = new DataView(buffer)
    const result = parser._parseStressField(view, buffer)

    expect(result.frame).toBe(meta.frame)
    expect(result.t).toBeCloseTo(meta.t, 5)
    expect(result.gridShape).toEqual([meta.nx, meta.ny, meta.nz])
    expect(result.sigmaVm).toBeInstanceOf(Float32Array)
    expect(result.sigmaVm).toHaveLength(meta.voxelCount)
    for (let i = 0; i < meta.voxelCount; i++) {
      expect(result.sigmaVm[i]).toBeCloseTo(meta.values[i], 3)
    }
  })
})


// ============================================================
// DAMAGE 帧（0x04）对称性
// ============================================================
describe('二进制帧对称性 - DAMAGE (0x04)', () => {
  it('头部字段 round-trip 一致', () => {
    const { buffer, meta } = buildDamageFrame()
    const parser = createParser()
    const view = new DataView(buffer)
    const result = parser._parseDamageField(view, buffer)

    expect(result.frame).toBe(meta.frame)
    expect(result.t).toBeCloseTo(meta.t, 5)
    expect(result.gridShape).toEqual([meta.nx, meta.ny, meta.nz])
    expect(result.boundsMin).toEqual(meta.bmin.map(v => expect.closeTo(v, 3)))
    expect(result.boundsMax).toEqual(meta.bmax.map(v => expect.closeTo(v, 3)))
  })

  it('载荷数据 round-trip 一致（int8 单字节）', () => {
    const { buffer, meta } = buildDamageFrame()
    const parser = createParser()
    const view = new DataView(buffer)
    const result = parser._parseDamageField(view, buffer)

    expect(result.zones).toBeInstanceOf(Int8Array)
    expect(result.zones).toHaveLength(meta.voxelCount)
    for (let i = 0; i < meta.voxelCount; i++) {
      expect(result.zones[i]).toBe(meta.zones[i])
    }
  })

  it('分区 id 取值范围 0~4', () => {
    const { buffer } = buildDamageFrame()
    const parser = createParser()
    const view = new DataView(buffer)
    const result = parser._parseDamageField(view, buffer)

    for (let i = 0; i < result.zones.length; i++) {
      expect(result.zones[i]).toBeGreaterThanOrEqual(0)
      expect(result.zones[i]).toBeLessThanOrEqual(4)
    }
  })
})


// ============================================================
// 帧分发与错误处理
// ============================================================
describe('二进制帧分发', () => {
  it('_handleBinaryFrame 按 type_id 正确分发 PPV 帧', () => {
    const { buffer, meta } = buildFloatFrame(0x02)
    const parser = createParser()
    let received = null
    parser.on('ppv_field', (payload) => { received = payload })
    parser._handleBinaryFrame(buffer)
    expect(received).not.toBeNull()
    expect(received.frame).toBe(meta.frame)
  })

  it('_handleBinaryFrame 按 type_id 正确分发 DAMAGE 帧', () => {
    const { buffer, meta } = buildDamageFrame()
    const parser = createParser()
    let received = null
    parser.on('damage_field', (payload) => { received = payload })
    parser._handleBinaryFrame(buffer)
    expect(received).not.toBeNull()
    expect(received.frame).toBe(meta.frame)
  })

  it('未知 type_id 被跳过（不抛异常）', () => {
    const buf = new ArrayBuffer(45)
    const view = new DataView(buf)
    view.setUint8(0, 0xFF) // 未知 type_id
    const parser = createParser()
    expect(() => parser._handleBinaryFrame(buf)).not.toThrow()
  })

  it('过短帧被安全跳过（不抛异常）', () => {
    const buf = new ArrayBuffer(10) // 远小于 45 字节头
    const parser = createParser()
    expect(() => parser._handleBinaryFrame(buf)).not.toThrow()
  })
})
