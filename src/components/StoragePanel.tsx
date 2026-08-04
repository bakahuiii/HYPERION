import { ChevronDown, ChevronRight, HardDrive, RefreshCw, RotateCcw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react'

import type { StorageOverview } from '../lib/storageOverview'

interface StoragePanelProps {
  open: boolean
  storage: StorageOverview | null
  message: string
  personCount: number
  questCount: number
  onToggle: () => void
  onRefresh: () => void
  onClearPeople: () => void
  onClearQuests: () => void
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value) || value === undefined) return '未计算大小'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(value?: string | null) {
  if (!value) return '尚未写入'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}

export function StoragePanel({ open, storage, message, personCount, questCount, onToggle, onRefresh, onClearPeople, onClearQuests }: StoragePanelProps) {
  const health = storage?.health
  const recoveryWarning = health?.recovery.uncleanShutdownDetected
  return (
    <section className={`options-section storage-section ${open ? 'is-open' : ''}`}>
      <div className="options-heading"><div><HardDrive size={18} /><div><h3>数据与存储</h3><p>{open ? '所有持久化文件统一位于当前 THEIA 工作目录；这里可确认版本、恢复状态、位置与占用。' : '已折叠；展开后查看本地数据的位置、用途和健康状态。'}</p></div></div><div className="storage-actions">{open && <button type="button" className="icon-button" title="刷新存储概览" aria-label="刷新存储概览" onClick={onRefresh}><RefreshCw size={15} /></button>}<button type="button" className="icon-button" title={open ? '折叠数据与存储' : '展开数据与存储'} aria-label={open ? '折叠数据与存储' : '展开数据与存储'} aria-expanded={open} onClick={onToggle}>{open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button></div></div>
      {open && <div className="storage-panel">
        <p className="storage-message" role="status">{message}</p>
        {storage && <>
          <div className="storage-workspace"><span>工作目录</span><code>{storage.workspace}</code></div>
          {health && <div className="storage-health-grid" aria-label="数据健康状态">
            <article className={health.sharedState.migration.state === 'failed' ? 'is-warning' : ''}><ShieldCheck size={17} /><div><strong>共享状态 schema v{health.sharedState.schemaVersion}</strong><span>{health.sharedState.migration.state === 'pending' ? '正在检查迁移' : health.sharedState.migration.state === 'failed' ? `迁移失败：${health.sharedState.migration.error ?? '原因未知'}` : health.sharedState.migration.migrated ? '本次启动已完成迁移' : '当前版本，无需迁移'}</span></div></article>
            <article className={health.archive.migration.state === 'failed' ? 'is-warning' : ''}><HardDrive size={17} /><div><strong>{health.archive.recordCount.toLocaleString('zh-CN')} 条 · {health.archive.segmentCount} 个归档段</strong><span>{health.archive.storageEngine} · {formatTime(health.archive.updatedAt)}</span></div></article>
            <article className={recoveryWarning ? 'is-warning' : ''}>{recoveryWarning ? <TriangleAlert size={17} /> : <ShieldCheck size={17} />}<div><strong>{recoveryWarning ? '检测到上次非正常退出' : '本次启动状态正常'}</strong><span>{recoveryWarning ? `上次会话开始于 ${formatTime(health.recovery.previous?.startedAt)}` : '崩溃恢复标记已建立，正常退出后会自动清除。'}</span></div></article>
            <article><RotateCcw size={17} /><div><strong>{health.sharedState.rollbackBackups.length} 份迁移回滚备份</strong><span>关闭 THEIA 后运行 <code>{health.rollbackCommand}</code></span></div></article>
          </div>}
          <div className="storage-list">{storage.entries.map((entry) => <article className={`storage-entry ${entry.exists ? '' : 'is-missing'}`} key={entry.id}><div><strong>{entry.exists ? entry.kind === 'directory' ? '文件夹' : '文件' : '尚未创建'}</strong><code>{entry.path}</code><p>{entry.description}</p></div><span>{entry.exists ? entry.kind === 'directory' ? `${entry.entryCount ?? 0} 项${entry.sizeBytes !== undefined ? ` · ${formatBytes(entry.sizeBytes)}` : ''}` : formatBytes(entry.sizeBytes) : '未创建'}</span></article>)}</div>
        </>}
        <div className="bulk-delete-panel"><div><strong>批量清除卡片</strong><p>只删除界面中的人物卡、任务和长期事件；原始聊天、地点和模型通道配置会保留。</p></div><div className="bulk-delete-actions"><button type="button" className="danger-button" onClick={onClearPeople} disabled={!personCount}><Trash2 size={15} />删除人物卡 {personCount}</button><button type="button" className="danger-button" onClick={onClearQuests} disabled={!questCount}><Trash2 size={15} />删除任务 {questCount}</button></div></div>
        <div className="storage-note">浏览器版还会使用 localStorage 与 IndexedDB 作为界面缓存；桌面版 Chromium 数据位于 Electron 用户数据目录。任务、人物和候选使用版本化共享状态，原始聊天使用追加式 gzip JSONL 分段；实际路径以上方列表为准。</div>
      </div>}
    </section>
  )
}
