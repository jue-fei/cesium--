import fs from 'node:fs/promises'
import path from 'node:path'

const projectRoot = process.cwd()
const srcRoot = path.join(projectRoot, 'src')
const targets = [
  path.join(srcRoot, 'App.vue'),
  path.join(srcRoot, 'components'),
  path.join(srcRoot, 'composables')
]
const fileExtensions = new Set(['.js', '.vue'])
const directFeatureImportPattern = /from\s+['"]@\/features\/(?!shared\/)([^'"]+)['"]/g

async function walk(entryPath) {
  const stat = await fs.stat(entryPath)
  if (stat.isFile()) return [entryPath]

  const entries = await fs.readdir(entryPath, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const resolvedPath = path.join(entryPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(resolvedPath)))
      continue
    }
    if (fileExtensions.has(path.extname(entry.name))) {
      files.push(resolvedPath)
    }
  }
  return files
}

function toRelative(filePath) {
  return path.relative(projectRoot, filePath).replaceAll('\\', '/')
}

async function main() {
  const files = (await Promise.all(targets.map(walk))).flat()
  const violations = []

  for (const filePath of files) {
    const content = await fs.readFile(filePath, 'utf8')
    let match
    while ((match = directFeatureImportPattern.exec(content))) {
      violations.push({
        file: toRelative(filePath),
        importPath: `@/features/${match[1]}`
      })
    }
  }

  if (violations.length > 0) {
    console.error('发现越过 shared 入口的直接 feature 导入：')
    for (const violation of violations) {
      console.error(`- ${violation.file}: ${violation.importPath}`)
    }
    process.exit(1)
  }

  console.log('导入边界检查通过。')
}

main().catch(error => {
  console.error('导入边界检查失败:', error)
  process.exit(1)
})
