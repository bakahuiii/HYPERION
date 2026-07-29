import { app, BrowserWindow, Menu } from 'electron'
import { createServer } from 'vite'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { server, startAiProxy } from '../server/index.mjs'
import { runtimePaths } from '../server/runtimePaths.mjs'

const root = resolve(import.meta.dirname, '..')
let viteServer
let mainWindow
let ownsAiProxy = false
const { electronUserDataPath: userDataPath, desktopPidPath } = runtimePaths

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
app.commandLine.appendSwitch('disable-http-cache')
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

function createWindow(url) {
  mainWindow = new BrowserWindow({
    title: 'THEIA',
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
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setAutoHideMenuBar(true)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.key === 'Alt' || input.key === 'F10') && !input.control && !input.meta) event.preventDefault()
  })
  void mainWindow.loadURL(url)
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  app.setName('THEIA')
  writeDesktopPid()
  const url = await startLocalServices()
  createWindow(url)
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow(url)
  })
}).catch((error) => {
  console.error('Desktop startup failed:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  clearDesktopPid()
  void viteServer?.close()
  if (ownsAiProxy && server.listening) server.close()
})
