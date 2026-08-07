import { contextBridge } from 'electron'

const apiBase = process.argv.find((argument) => argument.startsWith('--hyperion-api-base='))?.slice('--hyperion-api-base='.length) ?? ''

contextBridge.exposeInMainWorld('hyperionRuntime', { apiBase })
