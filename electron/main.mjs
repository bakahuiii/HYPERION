import { app, BrowserWindow, dialog, Menu, protocol } from 'electron'
import { createServer } from 'vite'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
app.setName('THEIA')
protocol.registerSchemesAsPrivileged([{
  scheme: 'theia',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}])
// A packaged executable cannot persist data inside app.asar or its temporary
// extraction directory, so resolve mutable paths before loading server code.
if (app.isPackaged) {
  process.env.THEIA_RELEASE_LAYOUT ??= '1'
  process.env.THEIA_RUNTIME_ROOT ??= app.getPath('userData')
  process.env.AI_PORT ??= '0'
  process.env.THEIA_ALLOW_FILE_ORIGIN = '1'
}

const [{ server, startAiProxy }, { runtimePaths }] = await Promise.all([
  import('../server/index.mjs'),
  import('../server/runtimePaths.mjs'),
])
const { recordRuntimeFailure } = await import('../server/crashRecovery.mjs')

let viteServer
let mainWindow
let ownsAiProxy = false
const { electronUserDataPath: userDataPath, desktopPidPath, crashLogPath } = runtimePaths

// Large task maps and Leaflet tiles need Chromium compositing and raster work
// on the GPU. Software rendering remains an explicit fallback for a broken
// graphics driver, rather than the default for every desktop session.
const softwareRendering = process.env.THEIA_SOFTWARE_RENDERING === '1'
if (softwareRendering) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('in-process-gpu')
} else {
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization')
}
app.setPath('userData', userDataPath)
app.setPath('sessionData', resolve(userDataPath, 'session'))

// A shared Chromium profile cannot be opened by two Electron instances. Besides
// preventing conflicting writes, the lock prevents Windows cache access errors.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function writeDesktopPid() {
  mkdirSync(dirname(desktopPidPath), { recursive: true })
  writeFileSync(desktopPidPath, `${process.pid}\n`, 'utf8')
}

function clearDesktopPid() {
  try {
    if (readFileSync(desktopPidPath, 'utf8').trim() === String(process.pid)) unlinkSync(desktopPidPath)
  } catch { /* A stale or already-removed marker is harmless. */ }
}

async function startLocalServices() {
  if (app.isPackaged) {
    await startAiProxy()
    ownsAiProxy = true
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('THEIA local service did not expose a loopback port.')
    return `http://127.0.0.1:${address.port}/`
  }

  try {
    await startAiProxy()
    ownsAiProxy = true
  } catch (error) {
    // A web development session may already own the local-only proxy port.
    // It is safe for the desktop shell to reuse that proxy.
    if (error?.code !== 'EADDRINUSE') throw error
  }

  // Do not reuse an arbitrary Vite instance on 5173. It may be a prior THEIA
  // session serving stale source, which makes the desktop app appear unchanged.
  // Vite selects the next free loopback port when a browser dev session exists.
  viteServer = await createServer({
    root,
    configFile: resolve(root, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 5173, strictPort: false },
  })
  await viteServer.listen()
  return viteServer.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5173/'
}

async function registerPackagedProtocol() {
  if (!app.isPackaged) return
  const staticRoot = resolve(root, 'dist')
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }
  protocol.handle('theia', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
      const candidate = resolve(staticRoot, decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html')
      const pathFromRoot = relative(staticRoot, candidate)
      if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) return new Response('Not found', { status: 404 })
      return new Response(await readFile(candidate), {
        headers: { 'content-type': contentTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function createWindow(apiBase) {
  const pageUrl = app.isPackaged ? 'theia://app/index.html' : apiBase
  const window = new BrowserWindow({
    title: 'THEIA',
    icon: resolve(import.meta.dirname, 'app-icon.png'),
    width: 1600,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    aspectRatio: 16 / 9,
    autoHideMenuBar: true,
    backgroundColor: '#101713',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolve(import.meta.dirname, 'preload.mjs'),
      additionalArguments: app.isPackaged ? [`--theia-api-base=${apiBase}`] : [],
    },
  })
  mainWindow = window
  window.setMenuBarVisibility(false)
  window.setAutoHideMenuBar(true)
  window.webContents.on('before-input-event', (event, input) => {
    if ((input.key === 'Alt' || input.key === 'F10') && !input.control && !input.meta) event.preventDefault()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    void recordRuntimeFailure(crashLogPath, 'electron-renderer', details).catch(() => undefined)
  })
  let closeReady = false
  let closeInProgress = false
  window.on('close', (event) => {
    if (closeReady || window.webContents.isDestroyed()) return
    event.preventDefault()
    if (closeInProgress) return
    closeInProgress = true
    let closeTimeout
    const timeout = new Promise((resolveTimeout) => { closeTimeout = setTimeout(resolveTimeout, 8_000) })
    void Promise.race([
      window.webContents.executeJavaScript('window.theiaFlush ? window.theiaFlush() : Promise.resolve()'),
      timeout,
    ]).finally(() => {
      clearTimeout(closeTimeout)
      closeReady = true
      if (!window.isDestroyed()) window.close()
    })
  })
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  void window.loadURL(pageUrl)
}

async function enableAutomaticUpdates() {
  const updateMetadata = resolve(process.resourcesPath, 'app-update.yml')
  if (!app.isPackaged || !existsSync(updateMetadata)) return
  try {
    const module = await import('electron-updater')
    const autoUpdater = module.autoUpdater ?? module.default?.autoUpdater
    if (!autoUpdater) throw new Error('electron-updater did not expose autoUpdater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', (error) => console.warn(`[THEIA] update check failed: ${error instanceof Error ? error.message : String(error)}`))
    autoUpdater.on('update-downloaded', (info) => {
      void dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'THEIA 更新已就绪',
        message: `THEIA ${info.version} 已下载完成。`,
        detail: '立即重启会先等待当前本地数据写入完成；也可以稍后在退出应用时自动安装。',
        buttons: ['立即重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(false, true) })
    })
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (error) {
    console.warn(`[THEIA] automatic updates unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  app.setName('THEIA')
  await registerPackagedProtocol()
  writeDesktopPid()
  const apiBase = await startLocalServices()
  createWindow(apiBase)
  setTimeout(() => { void enableAutomaticUpdates() }, 8_000)
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow(apiBase)
  })
}).catch((error) => {
  console.error('Desktop startup failed:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Keep loopback persistence services alive while BrowserWindow's close handler
// awaits window.theiaFlush(). `before-quit` fires before windows close, whereas
// `will-quit` runs after their close handlers have completed.
app.on('will-quit', () => {
  clearDesktopPid()
  void viteServer?.close()
  if (ownsAiProxy && server.listening) server.close()
})
