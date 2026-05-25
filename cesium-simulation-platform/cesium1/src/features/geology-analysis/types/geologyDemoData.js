export const DUMMY_OREBODIES = [
  {
    id: 'ore1',
    name: '主矿体',
    grade: 2.5,
    reserves: 500,
    thickness: 12.5,
    boundingBox: { minX: 0, maxX: 100, minY: 0, maxY: 100, minZ: 0, maxZ: 50 }
  },
  {
    id: 'ore2',
    name: '北翼延伸',
    grade: 1.2,
    reserves: 120,
    thickness: 8.0,
    boundingBox: { minX: 100, maxX: 150, minY: 0, maxY: 50, minZ: 0, maxZ: 30 }
  }
]

export const DUMMY_GEOLOGY_STATS = {
  averageThickness: 15.4,
  mineralizationIntensity: 0.85,
  estimatedReserves: 620,
  averageGrade: 1.85
}
