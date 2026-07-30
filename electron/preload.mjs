import { contextBridge } from 'electron'

const apiBase = process.argv.find((argument) => argument.startsWith('--theia-api-base='))?.slice('--theia-api-base='.length) ?? ''

contextBridge.exposeInMainWorld('theiaRuntime', { apiBase })
