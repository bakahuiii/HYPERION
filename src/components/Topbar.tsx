import { Menu, Plus } from 'lucide-react'
import { AvatarImage } from './AvatarImage'
import type { Profile, ViewId } from '../types'

const titles: Record<ViewId, { eyebrow: string; title: string }> = {
  quests: { eyebrow: '行动总览', title: '任务图' },
  timeline: { eyebrow: '时间与节奏', title: '行程' },
  map: { eyebrow: '地点与记忆', title: '生活地图' },
  people: { eyebrow: '关系与同行者', title: '人物' },
  intel: { eyebrow: '来源与线索', title: '情报库' },
  settings: { eyebrow: '本机与模型配置', title: '选项' },
}

interface TopbarProps {
  view: ViewId
  profile: Profile
  onMenu: () => void
  onNewQuest: () => void
}

export function Topbar({ view, profile, onMenu, onNewQuest }: TopbarProps) {

  return (
    <header className="topbar">
      <div className="title-cluster">
        <button type="button" className="icon-button menu-button" onClick={onMenu} aria-label="打开导航">
          <Menu size={20} />
        </button>
        <div>
          <span>{titles[view].eyebrow}</span>
          <h1>{titles[view].title}</h1>
        </div>
      </div>

      <div className="topbar-actions">
        <span className="topbar-avatar"><AvatarImage source={profile.avatarUrl} alt="" /><i>{profile.name.replace(/\s+/g, '').slice(-2) || '你'}</i></span>
        <strong className="profile-name">{profile.name}</strong>
        <button type="button" className="primary-button" onClick={onNewQuest} aria-label="新任务">
          <Plus size={17} />
          <span>新任务</span>
        </button>
      </div>
    </header>
  )
}
