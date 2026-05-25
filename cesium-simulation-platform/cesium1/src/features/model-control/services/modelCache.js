const cachedTilesets = new Set()

export function hasCachedTileset(path) {
  if (!path) return false
  return cachedTilesets.has(path)
}

export function markTilesetCached(path) {
  if (!path) return
  cachedTilesets.add(path)
}

export function removeCachedTileset(path) {
  if (!path) return
  cachedTilesets.delete(path)
}

export function clearCachedTilesets() {
  cachedTilesets.clear()
}

export function getCachedTilesetPaths() {
  return Array.from(cachedTilesets)
}
