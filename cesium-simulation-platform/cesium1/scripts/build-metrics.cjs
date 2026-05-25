const fs = require('fs')
const path = require('path')

function walkFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}

function sumBytes(files) {
  let total = 0
  for (const f of files) total += fs.statSync(f).size
  return total
}

function toKB(bytes) {
  return Math.round((bytes / 1024) * 100) / 100
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function getManifestEntry(manifest) {
  if (!manifest) return null
  for (const [key, value] of Object.entries(manifest)) {
    if (value && value.isEntry) return { key, value }
  }
  return null
}

function unique(arr) {
  return Array.from(new Set(arr))
}

function main() {
  const cwd = process.cwd()
  const distDir = path.join(cwd, 'dist')
  const assetsDir = path.join(distDir, 'assets')
  const distFiles = walkFiles(distDir)
  const assetFiles = walkFiles(assetsDir)
  console.log('dist_bytes', sumBytes(distFiles))
  console.log('dist_kb', toKB(sumBytes(distFiles)))
  console.log('assets_bytes', sumBytes(assetFiles))
  console.log('assets_kb', toKB(sumBytes(assetFiles)))

  const manifest =
    readJson(path.join(distDir, '.vite', 'manifest.json')) ||
    readJson(path.join(distDir, 'manifest.json'))
  const entry = getManifestEntry(manifest)
  if (entry) {
    const { value } = entry
    const entryFiles = unique([
      value.file,
      ...(value.imports || []),
      ...(value.dynamicImports || []),
      ...(value.css || [])
    ])
    const entryPaths = entryFiles.map(f => path.join(distDir, f))
    const entryBytes = sumBytes(entryPaths.filter(p => fs.existsSync(p)))
    console.log('first_load_files', entryFiles.length)
    console.log('first_load_bytes', entryBytes)
    console.log('first_load_kb', toKB(entryBytes))
  } else {
    console.log('first_load_files', 0)
    console.log('first_load_bytes', 0)
    console.log('first_load_kb', 0)
  }

  const top = assetFiles
    .map(f => ({ f, s: fs.statSync(f).size }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 15)
  for (const item of top) {
    console.log('asset', path.basename(item.f), item.s)
  }
}

main()
