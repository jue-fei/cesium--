const fs = require('fs')
const path = require('path')

function walk(dir, ignoreDirs) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ignoreDirs.has(ent.name)) continue
      out.push(...walk(p, ignoreDirs))
    } else {
      out.push(p)
    }
  }
  return out
}

function countLines(filePath) {
  const buf = fs.readFileSync(filePath)
  let lines = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) lines++
  }
  return lines + 1
}

function extOf(p) {
  return path.extname(p).toLowerCase()
}

function summarize(files) {
  const byExt = new Map()
  let totalLines = 0

  for (const f of files) {
    const ext = extOf(f)
    if (!byExt.has(ext)) byExt.set(ext, { files: 0, lines: 0 })
    const bucket = byExt.get(ext)
    bucket.files++
    const lines = countLines(f)
    bucket.lines += lines
    totalLines += lines
  }

  const exts = Array.from(byExt.keys()).sort()
  const out = []
  for (const ext of exts) {
    const b = byExt.get(ext)
    out.push({ ext, files: b.files, lines: b.lines })
  }
  return { files: files.length, lines: totalLines, byExt: out }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function pick(files, exts) {
  const set = new Set(exts)
  return files.filter(f => set.has(extOf(f)))
}

function main() {
  const root = process.cwd()
  const src = path.join(root, 'src')
  const ignoreDirs = new Set(['node_modules', 'dist', '.git'])

  const srcFiles = walk(src, ignoreDirs)

  const codeFiles = pick(srcFiles, ['.js', '.vue', '.css', '.json'])
  const summary = summarize(codeFiles)

  const featuresFiles = walk(path.join(src, 'features'), ignoreDirs)
  const featuresSummary = summarize(pick(featuresFiles, ['.js', '.vue', '.css', '.json']))

  const utilsFiles = walk(path.join(src, 'utils'), ignoreDirs)
  const utilsSummary = summarize(pick(utilsFiles, ['.js', '.vue', '.css', '.json']))

  const componentsFiles = walk(path.join(src, 'components'), ignoreDirs)
  const componentsSummary = summarize(pick(componentsFiles, ['.js', '.vue', '.css', '.json']))

  const configFiles = walk(path.join(src, 'config'), ignoreDirs)
  const configSummary = summarize(pick(configFiles, ['.js', '.vue', '.css', '.json']))

  const pkg = readJson(path.join(root, 'package.json'))
  const deps = Object.keys(pkg.dependencies || {}).length
  const devDeps = Object.keys(pkg.devDependencies || {}).length

  console.log('src_files', summary.files)
  console.log('src_lines', summary.lines)
  console.log('deps', deps)
  console.log('dev_deps', devDeps)
  for (const row of summary.byExt) {
    console.log(`src_ext ${row.ext} files=${row.files} lines=${row.lines}`)
  }

  console.log('features_files', featuresSummary.files)
  console.log('features_lines', featuresSummary.lines)
  console.log('utils_files', utilsSummary.files)
  console.log('utils_lines', utilsSummary.lines)
  console.log('components_files', componentsSummary.files)
  console.log('components_lines', componentsSummary.lines)
  console.log('config_files', configSummary.files)
  console.log('config_lines', configSummary.lines)
}

main()
