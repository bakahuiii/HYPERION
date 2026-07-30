import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageInfo = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'))
const destination = resolve(process.argv[2] || resolve(projectRoot, 'release-bin', `THEIA-${packageInfo.version}-portable`))
const electronDistribution = resolve(projectRoot, 'node_modules', 'electron', 'dist')
const bundledApp = resolve(destination, 'resources', 'app')
const executablePath = resolve(destination, 'THEIA.exe')
const iconPath = resolve(projectRoot, 'release', 'app-icon.ico')

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

if (await exists(destination)) {
  throw new Error(`Refusing to overwrite an existing directory: ${destination}`)
}
if (!await exists(resolve(electronDistribution, 'electron.exe'))) {
  throw new Error('The local Electron Windows runtime is missing. Run npm install before packaging.')
}

try {
  await mkdir(destination, { recursive: true })
  await cp(electronDistribution, destination, { recursive: true })
  await rename(resolve(destination, 'electron.exe'), executablePath)
  await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', resolve(projectRoot, 'release-tools', 'set-windows-icon.ps1'),
    '-Executable', executablePath,
    '-Icon', iconPath,
  ], projectRoot)
  await rm(resolve(destination, 'resources', 'default_app.asar'), { force: true })
  await mkdir(bundledApp, { recursive: true })

  for (const directory of ['dist', 'electron', 'server']) {
    await cp(resolve(projectRoot, directory), resolve(bundledApp, directory), { recursive: true })
  }
  for (const file of ['package.json', 'package-lock.json']) {
    await cp(resolve(projectRoot, file), resolve(bundledApp, file))
  }
  await mkdir(resolve(bundledApp, 'runtime'), { recursive: true })
  await cp(process.execPath, resolve(bundledApp, 'runtime', 'node.exe'))

  // Only runtime dependencies are installed beside the packaged app.
  const npmCommand = process.platform === 'win32' ? process.execPath : 'npm'
  const npmArguments = process.platform === 'win32'
    ? [resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : []
  await run(npmCommand, [
    ...npmArguments,
    'ci', '--omit=dev', '--ignore-scripts', '--offline', '--cache', resolve(projectRoot, '.npm-cache'),
  ], bundledApp)

  await writeFile(resolve(destination, 'README-EXE.txt'), [
    'THEIA Windows x64 portable edition',
    '',
    'Run THEIA.exe. Node.js and npm are not required.',
    'Your tasks, settings, chat archive, logs, backgrounds, and avatar cache are stored locally under:',
    '%APPDATA%\\THEIA',
    '',
    'Do not share that data directory or data/settings.ini because it can contain imported chats and API keys.',
  ].join('\r\n'), 'utf8')
  console.log(`Created portable THEIA executable at ${destination}`)
} catch (error) {
  await rm(destination, { recursive: true, force: true })
  throw error
}
