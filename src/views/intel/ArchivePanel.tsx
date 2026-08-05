import type { ChangeEventHandler, RefObject } from 'react'
import { ChevronDown, FileJson, FileText, FolderOpen, FolderSync, GraduationCap, LockKeyhole, MessageCircle, RefreshCw, ShieldCheck, Upload } from 'lucide-react'

import type { ArchiveSummary } from '../../types'

export type AutomationState = 'idle' | 'restoring' | 'watching' | 'needs-permission' | 'unsupported' | 'error'

interface ArchivePanelProps {
  open: boolean
  automationState: AutomationState
  automationLabel: string
  folderName: string
  message: string
  lastScan: string
  busy: boolean
  archive: ArchiveSummary
  archiveLoadError?: string
  scanStats: { files: number; changed: number; records: number; rebuilt: boolean }
  inputRef: RefObject<HTMLInputElement | null>
  onToggleOpen: () => void
  onConnect: () => void
  onScan: () => void
  onRebuild: () => void
  onImportFiles: ChangeEventHandler<HTMLInputElement>
}

const connectors = [
  { name: '微信', detail: '识别微信导出文本和结构化记录', icon: MessageCircle },
  { name: 'QQ', detail: '识别 QQ 聊天导出记录', icon: FileText },
  { name: '校园平台', detail: '接收课程、缴费和通知导出文件', icon: GraduationCap },
]

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function ArchivePanel({
  open,
  automationState,
  automationLabel,
  folderName,
  message,
  lastScan,
  busy,
  archive,
  archiveLoadError,
  scanStats,
  inputRef,
  onToggleOpen,
  onConnect,
  onScan,
  onRebuild,
  onImportFiles,
}: ArchivePanelProps) {
  return (
    <section className={`intel-overview intel-collapsible-section ${open ? 'is-open' : 'is-collapsed'}`}>
      <div className="page-intro">
        <div><span className="section-kicker">LOCAL AUTOMATION · 自动捕获导出记录</span><h2><button type="button" className="intel-section-toggle" aria-expanded={open} onClick={onToggleOpen}>情报接入<ChevronDown size={17} /></button></h2></div>
        <div className="privacy-note"><ShieldCheck size={18} /><span>本机控制上传</span></div>
      </div>

      {open && <>
        <div className={`automation-console automation-console--${automationState}`}>
          <div className="automation-pulse"><FolderSync size={23} /></div>
          <div className="automation-copy"><div><span>{automationLabel}</span>{automationState === 'watching' && <em>启动时已扫描一次</em>}</div><p>{message}</p><small>{lastScan}</small></div>
          <div className="automation-actions">
            {automationState === 'watching' && <button type="button" className="secondary-button batch-button" onClick={onRebuild} disabled={busy}><RefreshCw size={15} />按目录重建</button>}
            {automationState === 'watching' && <button type="button" className="icon-button" aria-label="立即扫描目录" onClick={onScan} disabled={busy}><RefreshCw size={17} /></button>}
            <button type="button" className="primary-button" onClick={onConnect} disabled={busy || automationState === 'unsupported'}><FolderOpen size={16} />{folderName ? '重新连接' : '连接目录'}</button>
          </div>
        </div>
        {archiveLoadError && <p className="archive-load-error" role="alert">{archiveLoadError}</p>}
        {automationState === 'watching' && <div className="scan-stats" aria-label="扫描统计"><span><strong>{formatCount(scanStats.files)}</strong>个可解析导出文件</span><span><strong>{formatCount(scanStats.changed)}</strong>个{scanStats.rebuilt ? '重建处理' : '新增或变动'}文件</span><span><strong>{formatCount(scanStats.records)}</strong>条本次解析消息（导入前）</span></div>}
        <div className="scan-stats scan-stats--archive" aria-label="归档对话分类"><span>已归档 <strong>{formatCount(archive.conversationCount)}</strong> 个对话</span>{archive.directConversationCount !== undefined && <span>私聊 <strong>{formatCount(archive.directConversationCount)}</strong> 个</span>}{archive.groupConversationCount !== undefined && <span>群聊 <strong>{formatCount(archive.groupConversationCount)}</strong> 个</span>}</div>
        {archive.lastImport && <div className="scan-stats scan-stats--archive" aria-label="最近导入结果"><span>最近导入：解析 <strong>{formatCount(archive.lastImport.parsedMessageCount)}</strong> 条</span><span>新增 <strong>{formatCount(archive.lastImport.addedMessageCount)}</strong> 条</span><span>更新 <strong>{formatCount(archive.lastImport.updatedMessageCount)}</strong> 条</span><span>已存在 <strong>{formatCount(archive.lastImport.duplicateMessageCount)}</strong> 条</span></div>}
        <div className="connector-grid">{connectors.map(({ name, detail, icon: Icon }) => <article className="connector" key={name}><div className="connector-icon"><Icon size={21} /></div><div><h3>{name}</h3><p>{detail}</p></div><span>{automationState === 'watching' ? '自动识别' : '待目录'}</span></article>)}</div>
        <div className="import-zone"><div className="import-icon"><Upload size={23} /></div><div><h3>临时导入文本</h3><p>不连接目录时，也可以一次选择多份 JSON、CSV 或 TXT 导出记录。</p></div><input ref={inputRef} type="file" accept=".json,.csv,.txt" multiple onChange={onImportFiles} hidden /><button type="button" className="secondary-button" onClick={() => inputRef.current?.click()} disabled={busy}><FileJson size={17} />{busy ? '处理中…' : '选择文件'}</button></div>
        <div className="security-line"><LockKeyhole size={14} />不绕过登录或解密私人数据库；只读取你明确授权的导出目录。</div>
      </>}
    </section>
  )
}
