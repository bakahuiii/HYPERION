import { BookOpenText, Clock3, ListTodo, Map, RadioTower, RefreshCw, RotateCcw, Settings2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getAtlasQuote, type AtlasQuote } from '../lib/quotes'
import { AvatarImage } from './AvatarImage'
import type { Profile, ViewId } from '../types'

const navItems: { id: ViewId; label: string; icon: typeof ListTodo }[] = [
  { id: 'quests', label: '任务图', icon: ListTodo },
  { id: 'timeline', label: '行程', icon: Clock3 },
  { id: 'map', label: '地图', icon: Map },
  { id: 'people', label: '人物', icon: BookOpenText },
  { id: 'intel', label: '情报库', icon: RadioTower },
  { id: 'settings', label: '选项', icon: Settings2 },
]

interface SidebarProps {
  profile: Profile
  active: ViewId
  open: boolean
  onChange: (view: ViewId) => void
  onClose: () => void
  onReset: () => void
  newIntelCount: number
}

export function Sidebar({ profile, active, open, onChange, onClose, onReset, newIntelCount }: SidebarProps) {
  const [resetPending, setResetPending] = useState(false)
  const [quote, setQuote] = useState<AtlasQuote>({ text: '在抵达之前，先把今天走完。', from: '离线句库', online: false })

  const refreshQuote = () => {
    void getAtlasQuote().then(setQuote).catch(() => {
      setQuote({ text: '在抵达之前，先把今天走完。', from: '离线句库', online: false })
    })
  }

  useEffect(() => { refreshQuote() }, [])

  const navigate = (view: ViewId) => {
    onChange(view)
    onClose()
  }

  return (
    <>
      <aside className={`sidebar ${open ? 'sidebar--open' : ''}`} aria-label="主要导航">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <strong>THEIA</strong>
            <span>PERSONAL INTELLIGENCE</span>
          </div>
        </div>
        <button type="button" className="icon-button sidebar-close" onClick={onClose} aria-label="关闭导航">
          <X size={19} />
        </button>

        <nav className="nav-list">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={`nav-item ${active === id ? 'is-active' : ''}`}
              onClick={() => navigate(id)}
              aria-current={active === id ? 'page' : undefined}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{label}</span>
              {id === 'intel' && newIntelCount > 0 && <em>{newIntelCount}</em>}
            </button>
          ))}
        </nav>

        <div className="sidebar-profile">
          <div className="sidebar-profile-avatar"><AvatarImage source={profile.avatarUrl} alt="" /><i>{profile.name.replace(/\s+/g, '').slice(-2) || '你'}</i></div>
          <div><span>THEIA USER</span><strong>{profile.name}</strong></div>
        </div>

        <div className="sidebar-quote">
          <div className="quote-heading"><span>今日铭文</span><button type="button" className="quote-refresh" onClick={refreshQuote} aria-label="更换随机二次元铭文" title="更换铭文"><RefreshCw size={13} /></button></div>
          <p>{quote.text}</p>
          <small>《{quote.from}》</small>
          <button
            type="button"
            className={`reset-button ${resetPending ? 'is-pending' : ''}`}
            onClick={() => {
              if (resetPending) {
                onReset()
                setResetPending(false)
              } else {
                setResetPending(true)
              }
            }}
          >
            <RotateCcw size={13} />{resetPending ? '再次点击确认' : '重置示例数据'}
          </button>
        </div>
      </aside>
      {open && <button type="button" className="sidebar-scrim" onClick={onClose} aria-label="关闭导航" />}
      <nav className="mobile-nav" aria-label="移动端导航">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button type="button" key={id} className={active === id ? 'is-active' : ''} onClick={() => onChange(id)}>
            <Icon size={19} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
  )
}
