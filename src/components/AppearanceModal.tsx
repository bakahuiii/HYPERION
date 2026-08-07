import { ImagePlus, Palette, RotateCcw, UserRound, X } from 'lucide-react'
import { useState, type CSSProperties, type ChangeEvent } from 'react'
import { defaultAppearance } from '../lib/appearance'
import { AvatarImage } from './AvatarImage'
import { uploadBackgroundAsset } from '../lib/settingsClient'
import type { AppearanceSettings, AppearanceTheme } from '../types'

interface AppearanceModalProps {
  open: boolean
  name: string
  avatarUrl?: string
  appearance: AppearanceSettings
  onClose: () => void
  onPreview: (value: { name: string; avatarUrl?: string; appearance: AppearanceSettings }) => void
  onSave: (value: { name: string; avatarUrl?: string; appearance: AppearanceSettings }) => void
}

const themes: { id: AppearanceTheme; name: string; detail: string; colors: string[] }[] = [
  { id: 'verdant', name: '苔原', detail: '深绿与琥珀', colors: ['#18201d', '#d87851', '#d3b16d'] },
  { id: 'nocturne', name: '夜航', detail: '蓝黑与冰蓝', colors: ['#131827', '#7799db', '#91c5d8'] },
  { id: 'paper', name: '纸页', detail: '米白与朱砂', colors: ['#f3efe5', '#ae503e', '#856537'] },
  { id: 'sakura', name: '花信', detail: '墨紫与樱粉', colors: ['#251f2d', '#df7898', '#c9a4de'] },
]

function initialsFor(value: string) {
  return value.replace(/\s+/g, '').slice(-2) || '你'
}

function imageCss(url?: string) {
  return url ? `url(${JSON.stringify(url)})` : 'none'
}

export function AppearanceModal({ open, name, avatarUrl, appearance, onClose, onPreview, onSave }: AppearanceModalProps) {
  const [nextName, setNextName] = useState(name)
  const [nextAvatarUrl, setNextAvatarUrl] = useState(avatarUrl ?? '')
  const [draft, setDraft] = useState(appearance)
  const [message, setMessage] = useState('预览不会保存；确认后才会同步到桌面端与浏览器端。')

  if (!open) return null

  const emitPreview = (next: { name?: string; avatarUrl?: string; appearance?: AppearanceSettings }) => {
    const previewAvatarUrl = next.avatarUrl === undefined ? nextAvatarUrl : next.avatarUrl
    onPreview({
      name: next.name?.trim() || nextName.trim() || '访客',
      avatarUrl: previewAvatarUrl || undefined,
      appearance: next.appearance ?? draft,
    })
  }

  const updateDraft = (recipe: (current: AppearanceSettings) => AppearanceSettings) => {
    const next = recipe(draft)
    setDraft(next)
    emitPreview({ appearance: next })
  }

  const changeBackground = (update: Partial<AppearanceSettings['backgrounds']['app']>) => {
    updateDraft((current) => ({ ...current, backgrounds: { app: { ...current.backgrounds.app, ...update } } }))
  }

  const selectImage = async (event: ChangeEvent<HTMLInputElement>, target: 'background' | 'avatar') => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const url = await uploadBackgroundAsset(file)
      if (target === 'avatar') {
        setNextAvatarUrl(url)
        emitPreview({ avatarUrl: url })
        setMessage('已更新用户头像预览。')
      } else {
        changeBackground({ imageId: undefined, url })
        setMessage('已更新全局背景图片预览。')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '图片保存失败。')
    }
  }

  const previewStyle = {
    '--preview-background': imageCss(draft.backgrounds.app.url),
    '--preview-background-size': `${draft.backgrounds.app.scale}%`,
    '--preview-background-blur': `${draft.backgrounds.app.blur}px`,
  } as CSSProperties

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal appearance-modal" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
        <div className="modal-header">
          <div><span className="section-kicker">LOCAL APPEARANCE · 本地外观</span><h2 id="appearance-title">界面自定义</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </div>
        <div className="appearance-body">
          <div className={`appearance-preview theme--${draft.theme}`} style={previewStyle} aria-label="外观预览">
            <div className="appearance-preview-image" />
            <div className="appearance-preview-content"><span>HYPERION</span><div className="appearance-preview-identity">{nextAvatarUrl ? <AvatarImage source={nextAvatarUrl} alt="" /> : <UserRound size={20} />}<strong>{nextName.trim() || '访客'}</strong></div></div>
          </div>

          <div className="appearance-profile-grid">
            <label className="appearance-name"><span>显示名称</span><input value={nextName} onChange={(event) => { const value = event.target.value; setNextName(value); emitPreview({ name: value }) }} maxLength={32} placeholder="访客" /></label>
            <div className="appearance-avatar-control"><span>用户头像</span><div><div className="appearance-avatar"><AvatarImage source={nextAvatarUrl} alt="" /><i>{initialsFor(nextName)}</i></div><label className="background-upload"><ImagePlus size={14} /><span>上传</span><input type="file" accept="image/*" onChange={(event) => void selectImage(event, 'avatar')} /></label>{nextAvatarUrl && <button type="button" className="background-clear" onClick={() => { setNextAvatarUrl(''); emitPreview({ avatarUrl: '' }) }}>移除</button>}</div></div>
          </div>

          <div className="appearance-section">
            <div className="appearance-section-heading"><Palette size={16} /><span>配色风格</span></div>
            <div className="theme-options">
              {themes.map((theme) => <button type="button" key={theme.id} className={`theme-option theme-option--${theme.id} ${draft.theme === theme.id ? 'is-active' : ''}`} onClick={() => updateDraft((current) => ({ ...current, theme: theme.id }))}><i>{theme.colors.map((color) => <b style={{ background: color }} key={color} />)}</i><strong>{theme.name}</strong><small>{theme.detail}</small></button>)}
            </div>
          </div>

          <div className="appearance-section">
            <div className="appearance-section-heading"><ImagePlus size={16} /><span>背景图片</span></div>
            <article className="background-option background-option--global">
              <div><strong>全局大背景</strong><small>{draft.backgrounds.app.imageId ? '旧版本地图片' : draft.backgrounds.app.url?.startsWith('/api/settings/background/') ? '已使用本机共享图片' : draft.backgrounds.app.url ? '已使用图片地址' : '未设置图片'}</small></div>
              <label className="background-upload"><ImagePlus size={14} /><span>上传</span><input type="file" accept="image/*" onChange={(event) => void selectImage(event, 'background')} /></label>
              <label className="background-url"><span>图片地址</span><input type="url" value={draft.backgrounds.app.url ?? ''} onChange={(event) => changeBackground({ url: event.target.value, imageId: undefined })} placeholder="https://..." /></label>
              <label><span>缩放 {draft.backgrounds.app.scale}%</span><input type="range" min="60" max="180" step="5" value={draft.backgrounds.app.scale} onChange={(event) => changeBackground({ scale: Number(event.target.value) })} /></label>
              <label><span>模糊 {draft.backgrounds.app.blur}px</span><input type="range" min="0" max="24" step="1" value={draft.backgrounds.app.blur} onChange={(event) => changeBackground({ blur: Number(event.target.value) })} /></label>
              {(draft.backgrounds.app.imageId || draft.backgrounds.app.url) && <button type="button" className="background-clear" onClick={() => changeBackground({ imageId: undefined, url: undefined })}>移除图片</button>}
            </article>
          </div>

          <label className="motion-toggle"><input type="checkbox" checked={draft.motionEnabled} onChange={(event) => updateDraft((current) => ({ ...current, motionEnabled: event.target.checked, performanceVersion: 1 }))} /><span>启用动态背景与轻微视差</span><small>开启后全局背景会随鼠标轻微移动；不再使用额外动态特效。</small></label>
          <p className="appearance-message">{message}</p>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => { setDraft(defaultAppearance); setNextAvatarUrl(''); setNextName('访客'); onPreview({ name: '访客', appearance: defaultAppearance }); setMessage('已恢复默认外观预览。') }}><RotateCcw size={15} />恢复默认</button>
            <button type="button" className="primary-button" onClick={() => { onSave({ name: nextName.trim() || '访客', avatarUrl: nextAvatarUrl || undefined, appearance: draft }); onClose() }}>保存外观</button>
          </div>
        </div>
      </section>
    </div>
  )
}
