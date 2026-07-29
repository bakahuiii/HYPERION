import { X } from 'lucide-react'
import { useState } from 'react'
import type { Person, Place, Quest, QuestKind } from '../types'

interface QuestModalProps {
  open: boolean
  places: Place[]
  people: Person[]
  quest?: Quest
  onClose: () => void
  onSave: (quest: Quest) => void
}

function toLocalInput(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(0, 16)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function QuestModal({ open, places, people, quest, onClose, onSave }: QuestModalProps) {
  const [title, setTitle] = useState(quest?.title ?? '')
  const [description, setDescription] = useState(quest?.description ?? '')
  const [locationId, setLocationId] = useState(quest?.locationId ?? places[0]?.id ?? '')
  const [kind, setKind] = useState<QuestKind>(quest?.kind === 'long-event' ? 'long-event' : 'task')
  const [startAt, setStartAt] = useState(toLocalInput(quest?.startAt))
  const [dueAt, setDueAt] = useState(toLocalInput(quest?.dueAt))
  const [characterIds, setCharacterIds] = useState<string[]>(quest?.characterIds ?? [])
  const [validationMessage, setValidationMessage] = useState('')

  if (!open) return null
  const isEditing = Boolean(quest)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    if (kind === 'long-event' && (!startAt || !dueAt)) {
      setValidationMessage('长期事件需要明确的开始与结束时间。')
      return
    }
    if (startAt && dueAt && new Date(dueAt).getTime() < new Date(startAt).getTime()) {
      setValidationMessage('结束时间不能早于开始时间。')
      return
    }
    onSave({
      id: quest?.id ?? `q-${Date.now()}`,
      title: title.trim(),
      description: description.trim() || '尚未补充任务说明。',
      status: quest?.status ?? 'available',
      locationId,
      characterIds,
      startAt: startAt || undefined,
      dueAt: dueAt || undefined,
      parentId: quest?.parentId,
      source: quest?.source ?? '手动记录',
      sourceIds: quest?.sourceIds,
      sourcePlatforms: quest?.sourcePlatforms,
      providers: quest?.providers,
      tags: quest?.tags ?? [],
      previousStatus: quest?.previousStatus,
      unlockedByParent: quest?.unlockedByParent,
      guidance: quest?.guidance,
      atlasCategory: quest?.atlasCategory,
      atlasOrder: quest?.atlasOrder,
      kind,
    })
    onClose()
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="quest-modal-title">
        <div className="modal-header"><div><span className="section-kicker">TASK DETAILS</span><h2 id="quest-modal-title">{isEditing ? '编辑任务' : '新建任务'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>
        <form onSubmit={submit}>
          <fieldset className="quest-kind-picker">
            <legend>条目类型</legend>
            <button type="button" className={kind === 'task' ? 'is-active' : ''} onClick={() => { setKind('task'); setValidationMessage('') }}>任务</button>
            <button type="button" className={kind === 'long-event' ? 'is-active' : ''} onClick={() => { setKind('long-event'); setValidationMessage('') }}>长期事件</button>
          </fieldset>
          <label><span>任务名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label><span>任务说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
          <div className="form-grid">
            <label><span>地点</span><select value={locationId} onChange={(event) => setLocationId(event.target.value)}>{places.map((place) => <option value={place.id} key={place.id}>{place.name}</option>)}</select></label>
            <label><span>{kind === 'long-event' ? '开始时间' : '开始或发生时间'}</span><input type="datetime-local" value={startAt} onChange={(event) => { setStartAt(event.target.value); setValidationMessage('') }} required={kind === 'long-event'} /></label>
            <label><span>{kind === 'long-event' ? '结束时间' : '截止时间'}</span><input type="datetime-local" value={dueAt} onChange={(event) => { setDueAt(event.target.value); setValidationMessage('') }} required={kind === 'long-event'} /></label>
          </div>
          {!!people.length && <fieldset className="quest-people-picker"><legend>关联人物</legend><div>{people.map((person) => <label key={person.id}><input type="checkbox" checked={characterIds.includes(person.id)} onChange={() => setCharacterIds((current) => current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id])} /><span>{person.name}</span></label>)}</div></fieldset>}
          {validationMessage && <p className="modal-validation" role="alert">{validationMessage}</p>}
          {isEditing && <p className="modal-source-note">来源信息不可在此改写，使用“查看来源”核对对应记录。</p>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">{isEditing ? '保存修改' : '加入任务列表'}</button></div>
        </form>
      </section>
    </div>
  )
}
