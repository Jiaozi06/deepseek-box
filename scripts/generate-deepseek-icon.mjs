import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const sourcePath = path.join(root, 'resources', 'deepseek-logo-mark-light.svg')
const source = await fs.readFile(sourcePath, 'utf8')
const mark = source.match(/<path\b[^>]*\/>/)?.[0]
if (!mark) throw new Error('DeepSeek whale SVG mark was not found')
const blackMark = mark.replace(/fill="#[0-9a-fA-F]{6}"/, 'fill="#000000"')
const transparentSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="translate(176 236) scale(25)">${blackMark}</g></svg>`
const whiteSvg = transparentSvg.replace('<g ', '<rect width="1024" height="1024" fill="#ffffff"/><g ')
await fs.writeFile(path.join(root, 'resources', 'deepseek-whale-icon.svg'), whiteSvg)
await sharp(Buffer.from(whiteSvg)).png().toFile(path.join(root, 'resources', 'icon-only.png'))
await sharp(Buffer.from(transparentSvg)).png().toFile(path.join(root, 'resources', 'icon-foreground.png'))
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' } })
  .png()
  .toFile(path.join(root, 'resources', 'icon-background.png'))
