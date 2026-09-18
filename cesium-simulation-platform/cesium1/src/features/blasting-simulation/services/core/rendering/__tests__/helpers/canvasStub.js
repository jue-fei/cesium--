/**
 * 测试共享 canvas stub：SceneBuilder 依赖浏览器 canvas（createRockTexture/文字 Sprite），
 * Node 环境注入最小 stub。此前该 stub 在 8 个测试/调试文件中各复制一份，收拢到此单源。
 */

/** 最小 2D context stub：只提供 SceneBuilder 用到的方法 */
export function makeCtxStub() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textBaseline: 'alphabetic',
    font: '',
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    measureText(text) {
      return { width: String(text || '').length * 12 }
    },
    fillText() {},
    scale() {},
    translate() {},
    rotate() {},
    setTransform() {},
    save() {},
    restore() {},
    clearRect() {},
    createRadialGradient() {
      return { addColorStop() {} }
    },
    createLinearGradient() {
      return { addColorStop() {} }
    },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    },
    putImageData() {},
    getImageData() {
      return { data: [] }
    }
  }
}

/** 最小 HTMLCanvasElement stub */
export function makeCanvasStub() {
  return {
    width: 0,
    height: 0,
    getContext() {
      return makeCtxStub()
    }
  }
}

/**
 * 注入全局 document stub（幂等：已有真实/既有 document 时不覆盖）。
 * 在 beforeAll(installCanvasStub) 中调用。
 */
export function installCanvasStub() {
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = { createElement: () => makeCanvasStub() }
  }
}
