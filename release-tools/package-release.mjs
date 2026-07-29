import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, relative, resolve } from 'node:path'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destinationArgument = process.argv[2]

if (!destinationArgument) {
  throw new Error('Usage: node release-tools/package-release.mjs <destination-directory>')
}

const destination = resolve(destinationArgument)
const relativeDestination = relative(sourceRoot, destination)
if (!relativeDestination || (!relativeDestination.startsWith('..') && !relativeDestination.includes(':'))) {
  throw new Error('The release destination must be outside the source workspace.')
}

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

if (await exists(destination)) {
  throw new Error(`Refusing to overwrite an existing directory: ${destination}`)
}

const appDestination = resolve(destination, 'app')
const appDirectories = ['electron', 'public', 'scripts', 'server', 'src']
const appFiles = [
  '.env.example',
  '.gitignore',
  'eslint.config.js',
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.app.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
]

async function copyDirectory(source, target, filter) {
  await cp(source, target, { recursive: true, filter })
}

const excludedNames = new Set(['node_modules', 'dist', '.git', '.npm-cache', '.theia-user-data'])
const sourceFilter = (entry) => !excludedNames.has(basename(entry))

await mkdir(appDestination, { recursive: true })
for (const directory of appDirectories) {
  await copyDirectory(resolve(sourceRoot, directory), resolve(appDestination, directory), sourceFilter)
}
for (const file of appFiles) {
  await cp(resolve(sourceRoot, file), resolve(appDestination, file))
}

await copyDirectory(resolve(sourceRoot, 'release', 'assets'), resolve(destination, 'assets'))
await copyDirectory(resolve(sourceRoot, 'release', 'data'), resolve(destination, 'data'))
await copyDirectory(resolve(sourceRoot, 'release', 'logs'), resolve(destination, 'logs'))
// The repository docs directory is canonical. Keeping a second hand-edited
// release copy caused installation requirements and model behavior to drift.
await copyDirectory(resolve(sourceRoot, 'docs'), resolve(destination, 'docs'))
for (const file of ['README.md', '启动 THEIA 桌面版.cmd', '启动 THEIA 浏览器版.cmd', '.gitignore', 'LICENSE']) {
  await cp(resolve(sourceRoot, 'release', file), resolve(destination, file))
}

const manifest = {
  product: 'THEIA',
  format: 'source-release',
  generatedAt: new Date().toISOString(),
  sourceVersion: JSON.parse(await readFile(resolve(sourceRoot, 'package.json'), 'utf8')).version,
  excluded: [
    'chat archives',
    'tasks and people',
    'saved model provider settings and API keys',
    'browser and Electron profiles',
    'debug and model task logs',
    'downloaded contact avatars',
    'custom user backgrounds',
    'node_modules, dist, and git metadata',
  ],
}
await writeFile(resolve(destination, 'RELEASE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const listing = await readdir(destination)
console.log(`Created clean THEIA release at ${destination}`)
console.log(`Top-level entries: ${listing.join(', ')}`)
