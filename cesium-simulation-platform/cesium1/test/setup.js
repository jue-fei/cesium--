class Color {
  constructor(r, g, b, a = 1.0) {
    this.red = r
    this.green = g
    this.blue = b
    this.alpha = a
  }
  withAlpha(alpha) {
    return new Color(this.red, this.green, this.blue, alpha)
  }
  toCssColorString() {
    return `rgba(${this.red * 255},${this.green * 255},${this.blue * 255},${this.alpha})`
  }
}

// Add static methods/properties
Color.fromCssColorString = str => {
  void str
  return new Color(0, 0, 0, 1)
}
Color.fromAlpha = (color, alpha) => new Color(color.red, color.green, color.blue, alpha)
Color.YELLOW = new Color(1, 1, 0, 1)
Color.RED = new Color(1, 0, 0, 1)
Color.BLUE = new Color(0, 0, 1, 1)
Color.GREEN = new Color(0, 1, 0, 1)
Color.WHITE = new Color(1, 1, 1, 1)

global.Cesium = {
  Color: Color,
  Cartesian3: {
    fromDegrees: (x, y, z) => ({ x, y, z }),
    distance: (a, b) => {
      void a
      void b
      return 0
    }
  },
  Math: {
    toRadians: deg => deg * (Math.PI / 180)
  },
  ScreenSpaceEventHandler: class {
    setInputAction() {}
    destroy() {}
  },
  ScreenSpaceEventType: {
    LEFT_CLICK: 0,
    MOUSE_MOVE: 1
  },
  defined: val => val !== undefined && val !== null
}

globalThis['Cesium'] = global.Cesium
