import process from 'node:process'

import { runtimePaths } from '../server/runtimePaths.mjs'
import { listSharedStateBackups, restoreSharedStateBackup } from '../server/schemaMigrations.mjs'

const backups = await listSharedStateBackups(runtimePaths.migrationDirectoryPath)
const requested = process.argv[2]

if (!requested || requested === '--list') {
  console.log(backups.length ? backups.join('\n') : '没有可用的共享状态迁移备份。')
  process.exitCode = backups.length ? 0 : 1
} else {
  const backupName = requested === '--latest' ? backups.at(-1) : requested
  if (!backupName) throw new Error('没有可恢复的共享状态迁移备份。')
  const result = await restoreSharedStateBackup(runtimePaths.sharedStatePath, runtimePaths.migrationDirectoryPath, backupName)
  console.log(`已恢复：${result.backupPath}`)
  console.log(`回滚前状态已另存为：${result.safetyPath}`)
}
