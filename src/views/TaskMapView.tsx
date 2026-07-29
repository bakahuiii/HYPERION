import { BookOpen, CheckCircle2, Circle, Clock3, FileText, GraduationCap, Heart, MapPin, Maximize2, Minus, Pencil, Plus, RotateCcw, Sparkles, Trash2, UsersRound, X, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react'
import { formatQuestTime } from '../lib/questTime'
import { avatarImageUrl } from '../lib/mediaProxy'
import type { IntelItem, Person, Place, Profile, Quest, TaskAtlasCategory, TaskAtlasLayout, TaskAtlasPosition } from '../types'

interface CategoryDefinition {
  id: TaskAtlasCategory
  label: string
  note: string
  icon: LucideIcon
  x: number
  y: number
}

const categories: CategoryDefinition[] = [
  { id: 'campus', label: '校园', note: '课程、校务与校园安排', icon: GraduationCap, x: 19, y: 22 },
  { id: 'romance', label: '恋爱', note: '仅保留明确提及的关系事项', icon: Heart, x: 50, y: 18 },
  { id: 'friends', label: '朋友', note: '见面、联络与社交安排', icon: UsersRound, x: 82, y: 24 },
  { id: 'study', label: '学习', note: '阅读、作业与个人成长', icon: BookOpen, x: 25, y: 69 },
  { id: 'wellbeing', label: '身心', note: '健康、休息与恢复', icon: Sparkles, x: 58, y: 67 },
  { id: 'life', label: '生活', note: '其余明确待办', icon: Circle, x: 87, y: 70 },
]

const categoryById = new Map(categories.map((category) => [category.id, category]))
const categoryIds = new Set<TaskAtlasCategory>(categories.map((category) => category.id))
const MIN_ZOOM = .55
const MAX_ZOOM = 1.65
const BASE_WORLD_WIDTH = 1220
const BASE_WORLD_HEIGHT = 760
const NODE_ARC_LENGTH = 76
const DRAG_THRESHOLD = 6

export interface TaskAtlasArrangement {
  questId: string
  sourceCategory: TaskAtlasCategory
  targetCategory: TaskAtlasCategory
  sourceOrder: string[]
  targetOrder: string[]
}

function textFor(quest: Quest, place?: Place) {
  return `${quest.title} ${quest.description} ${quest.tags.join(' ')} ${quest.source ?? ''} ${place?.name ?? ''}`.toLocaleLowerCase('zh-CN')
}

function includesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text))
}

function categoryForQuest(quest: Quest, place?: Place): TaskAtlasCategory {
  if (quest.atlasCategory && categoryIds.has(quest.atlasCategory)) return quest.atlasCategory
  const text = textFor(quest, place)
  if (includesAny(text, [/恋爱|情侣|约会|表白|恋人|对象|纪念日/])) return 'romance'
  if (includesAny(text, [/校园|学校|大学|学院|开学|选课|课程|校务|报到|社团|宿舍/]) || quest.sourcePlatforms?.includes('校园平台')) return 'campus'
  if (includesAny(text, [/朋友|同学|聚会|聚餐|见面|联络|聊天|回信|回复/])) return 'friends'
  if (includesAny(text, [/学习|阅读|作业|论文|考试|复习|练习|图书馆|写作/])) return 'study'
  if (includesAny(text, [/健康|训练|锻炼|运动|医院|睡眠|休息|恢复|心理/])) return 'wellbeing'
  return 'life'
}

function initialsFor(name?: string) {
  return name?.replace(/\s+/g, '').slice(-2) || '?'
}

function guidanceUpdatedLabel(value?: string) {
  const timestamp = new Date(value ?? '').getTime()
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}

function positionFor(category: CategoryDefinition, layout: TaskAtlasLayout): TaskAtlasPosition {
  const saved = layout.categoryPositions[category.id]
  return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : { x: category.x, y: category.y }
}

function clampPosition(position: TaskAtlasPosition): TaskAtlasPosition {
  // Topic positions intentionally have no canvas boundary. The user can drag
  // a topic beyond the initial world and pan back to it later.
  return {
    x: Number.isFinite(position.x) ? position.x : 0,
    y: Number.isFinite(position.y) ? position.y : 0,
  }
}

function ClusterEmblem({ category, quests, people }: { category: TaskAtlasCategory; quests: Quest[]; people: Person[] }) {
  const Icon = categoryById.get(category)?.icon ?? Circle
  const linked = people.filter((person) => quests.some((quest) => quest.characterIds.includes(person.id))).slice(0, 3)
  if (category !== 'campus' && linked.length) {
    return <div className="task-atlas-portraits" aria-label={`关联人物：${linked.map((person) => person.name).join('、')}`}>
      {linked.map((person) => <span key={person.id} title={person.name}>{person.avatarUrl && <img src={avatarImageUrl(person.avatarUrl)} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none' }} />}<i>{initialsFor(person.name)}</i></span>)}
    </div>
  }
  return <span className="task-atlas-emblem-icon"><Icon size={category === 'campus' ? 27 : 25} /></span>
}

function ringRadius(total: number) {
  return Math.max(92, Math.ceil((Math.max(total, 1) * NODE_ARC_LENGTH) / (Math.PI * 2)))
}

function nodeStyle(index: number, total: number, scale: number) {
  const angle = -90 + (360 / Math.max(total, 1)) * index
  return { '--node-angle': `${angle}deg`, '--node-radius': `${ringRadius(total) * scale}px` } as CSSProperties
}

function TaskNodeContent({ quest, peopleById, intelById }: { quest: Quest; peopleById: Map<string, Person>; intelById: Map<string, IntelItem> }) {
  const sourceItem = quest.sourceIds?.map((id) => intelById.get(id)).find((item) => item?.avatarUrl)
  const person = quest.characterIds.map((id) => peopleById.get(id)).find(Boolean)
  const avatarUrl = sourceItem?.avatarUrl || person?.avatarUrl
  const avatarName = sourceItem?.speaker || person?.name
  if (avatarUrl || avatarName) {
    return <span className="task-atlas-node-core task-atlas-node-core--person">
      {avatarUrl && <img src={avatarImageUrl(avatarUrl)} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none' }} />}
      <i>{initialsFor(avatarName)}</i>
      <b className={`task-atlas-status-dot task-atlas-status-dot--${quest.status}`} />
    </span>
  }
  return <span className="task-atlas-node-core"><i>{quest.status === 'done' ? <CheckCircle2 size={15} /> : quest.status === 'locked' ? <Circle size={15} /> : <FileText size={15} />}</i></span>
}

interface TaskMapViewProps {
  profile: Profile
  quests: Quest[]
  places: Place[]
  people: Person[]
  intel: IntelItem[]
  atlas: TaskAtlasLayout
  onToggle: (id: string) => void
  onEdit: (quest: Quest) => void
  onViewSource: (quest: Quest) => void
  onDelete: (id: string) => void
  onGenerateGuidance: (quest: Quest) => Promise<void>
  onArrange: (arrangement: TaskAtlasArrangement) => void
  onMoveCategory: (category: TaskAtlasCategory, position: TaskAtlasPosition) => void
}

type Camera = { x: number; y: number; scale: number }

export function TaskMapView({ profile, quests, places, people, intel, atlas, onToggle, onEdit, onViewSource, onDelete, onGenerateGuidance, onArrange, onMoveCategory }: TaskMapViewProps) {
  const [selectedId, setSelectedId] = useState('')
  const [expandedCategory, setExpandedCategory] = useState<TaskAtlasCategory | null>(null)
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 })
  const [contextMenu, setContextMenu] = useState<{ questId: string; x: number; y: number } | null>(null)
  const [guidanceBusy, setGuidanceBusy] = useState(false)
  const cameraRef = useRef(camera)
  const fieldRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const initialFitRef = useRef(false)
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const taskDragRef = useRef<{ pointerId: number; quest: Quest; sourceCategory: TaskAtlasCategory; startX: number; startY: number; node: HTMLButtonElement; dragged: boolean } | null>(null)
  const categoryDragRef = useRef<{ pointerId: number; category: TaskAtlasCategory; startX: number; startY: number; origin: TaskAtlasPosition; worldWidth: number; worldHeight: number; cluster: HTMLElement; dragged: boolean } | null>(null)
  const pendingCameraRef = useRef<Camera | null>(null)
  const dragFrameRef = useRef<number>(0)
  const taskDragFrameRef = useRef<number>(0)
  const categoryDragFrameRef = useRef<number>(0)
  const pendingTaskDragRef = useRef<{ node: HTMLButtonElement; x: number; y: number } | null>(null)
  const pendingCategoryDragRef = useRef<{ cluster: HTMLElement; position: TaskAtlasPosition } | null>(null)
  const wheelZoomRef = useRef<number | null>(null)
  const wheelFrameRef = useRef<number>(0)
  const suppressClickRef = useRef(false)
  const placesById = useMemo(() => new Map(places.map((place) => [place.id, place])), [places])
  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people])
  const intelById = useMemo(() => new Map(intel.map((item) => [item.id, item])), [intel])
  const byCategory = useMemo(() => {
    const groups = new Map<TaskAtlasCategory, Quest[]>(categories.map((category) => [category.id, []]))
    quests.forEach((quest) => groups.get(categoryForQuest(quest, placesById.get(quest.locationId)))?.push(quest))
    groups.forEach((items) => items.sort((left, right) => {
      const leftOrder = Number.isFinite(left.atlasOrder) ? left.atlasOrder as number : Number.POSITIVE_INFINITY
      const rightOrder = Number.isFinite(right.atlasOrder) ? right.atlasOrder as number : Number.POSITIVE_INFINITY
      return leftOrder - rightOrder || Number(left.status === 'done') - Number(right.status === 'done') || left.title.localeCompare(right.title, 'zh-CN')
    }))
    return groups
  }, [placesById, quests])
  const worldBaseSize = useMemo(() => {
    const largestRadius = Math.max(...categories.map((category) => ringRadius(byCategory.get(category.id)?.length ?? 0)))
    return { width: Math.max(BASE_WORLD_WIDTH, largestRadius * 6 + 360), height: Math.max(BASE_WORLD_HEIGHT, largestRadius * 4 + 360) }
  }, [byCategory])
  const selected = selectedId ? quests.find((quest) => quest.id === selectedId) : undefined
  const selectedPlace = selected ? placesById.get(selected.locationId) : undefined
  const selectedCategory = selected ? categoryForQuest(selected, selectedPlace) : 'life'
  const selectedDefinition = categoryById.get(selectedCategory) ?? categoryById.get('life')!
  const SelectedIcon = selectedDefinition.icon
  const linkedPeople = selected ? people.filter((person) => selected.characterIds.includes(person.id)) : []
  const overflowCategory = expandedCategory ? categoryById.get(expandedCategory) : undefined
  const contextQuest = contextMenu ? quests.find((quest) => quest.id === contextMenu.questId) : undefined

  useEffect(() => {
    const close = () => setContextMenu(null)
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keydown)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', keydown) }
  }, [])

  useEffect(() => () => {
    if (taskDragFrameRef.current) window.cancelAnimationFrame(taskDragFrameRef.current)
    if (categoryDragFrameRef.current) window.cancelAnimationFrame(categoryDragFrameRef.current)
  }, [])

  const chooseQuest = (quest: Quest) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setSelectedId(quest.id)
    setExpandedCategory(null)
  }

  const closeDetail = () => {
    setSelectedId('')
    setExpandedCategory(null)
  }

  const suppressNextClick = () => {
    suppressClickRef.current = true
    // Pointer-up is followed by click synchronously; clearing on the next turn
    // prevents a cancelled pointer sequence from swallowing a later user click.
    window.setTimeout(() => { suppressClickRef.current = false }, 0)
  }

  const applyCamera = (next: Camera) => {
    cameraRef.current = next
    if (worldRef.current) {
      const width = `${worldBaseSize.width * next.scale}px`
      const height = `${worldBaseSize.height * next.scale}px`
      // During a pan only the compositor transform changes. Avoiding width and
      // height writes prevents a full layout pass for every pointer frame.
      if (worldRef.current.style.width !== width) worldRef.current.style.width = width
      if (worldRef.current.style.height !== height) worldRef.current.style.height = height
      worldRef.current.style.transform = `translate(-50%, -50%) translate3d(${next.x}px, ${next.y}px, 0)`
    }
  }

  const fittedScale = () => {
    const field = fieldRef.current
    if (!field) return 1
    const bounds = field.getBoundingClientRect()
    return Math.min(1, Math.max(MIN_ZOOM, Math.min((bounds.width - 56) / worldBaseSize.width, (bounds.height - 76) / worldBaseSize.height)))
  }

  useLayoutEffect(() => {
    if (initialFitRef.current) return
    initialFitRef.current = true
    const frame = window.requestAnimationFrame(() => {
      const scale = fittedScale()
      const next = { x: 0, y: 0, scale }
      applyCamera(next)
      setCamera(next)
    })
    return () => window.cancelAnimationFrame(frame)
  // Initial fit is intentionally one-shot; a task arriving later must not reset a user view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldBaseSize.height, worldBaseSize.width])

  const updateZoom = (next: number) => {
    const current = cameraRef.current
    const nextCamera = { ...current, scale: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) }
    applyCamera(nextCamera)
    setCamera(nextCamera)
  }

  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    event.preventDefault()
    const currentScale = wheelZoomRef.current ?? cameraRef.current.scale
    wheelZoomRef.current = currentScale + (event.deltaY < 0 ? .1 : -.1)
    if (wheelFrameRef.current) return
    wheelFrameRef.current = window.requestAnimationFrame(() => {
      wheelFrameRef.current = 0
      const nextScale = wheelZoomRef.current
      wheelZoomRef.current = null
      if (nextScale !== null) updateZoom(nextScale)
    })
  }

  const startPan = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, a, .task-atlas-detail, .task-atlas-context-menu')) return
    setContextMenu(null)
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: cameraRef.current.x, originY: cameraRef.current.y }
  }

  const movePan = (event: PointerEvent<HTMLElement>) => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    pendingCameraRef.current = { ...cameraRef.current, x: pan.originX + event.clientX - pan.startX, y: pan.originY + event.clientY - pan.startY }
    if (dragFrameRef.current) return
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = 0
      if (pendingCameraRef.current) applyCamera(pendingCameraRef.current)
    })
  }

  const endPan = (event: PointerEvent<HTMLElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return
    if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current)
    dragFrameRef.current = 0
    if (pendingCameraRef.current) {
      applyCamera(pendingCameraRef.current)
      setCamera(pendingCameraRef.current)
      pendingCameraRef.current = null
    }
    panRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const startTaskDrag = (event: PointerEvent<HTMLButtonElement>, quest: Quest, category: TaskAtlasCategory) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu(null)
    event.currentTarget.setPointerCapture(event.pointerId)
    taskDragRef.current = { pointerId: event.pointerId, quest, sourceCategory: category, startX: event.clientX, startY: event.clientY, node: event.currentTarget, dragged: false }
  }

  const moveTaskDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = taskDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.dragged && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      drag.dragged = true
      drag.node.classList.add('is-dragging')
    }
    if (!drag.dragged) return
    // Pointer events can arrive substantially faster than a frame. Coalescing
    // the visual write keeps drag motion stable without a React re-render.
    pendingTaskDragRef.current = { node: drag.node, x: dx, y: dy }
    if (taskDragFrameRef.current) return
    taskDragFrameRef.current = window.requestAnimationFrame(() => {
      taskDragFrameRef.current = 0
      const pending = pendingTaskDragRef.current
      pendingTaskDragRef.current = null
      if (!pending) return
      pending.node.style.setProperty('--atlas-drag-x', `${pending.x}px`)
      pending.node.style.setProperty('--atlas-drag-y', `${pending.y}px`)
    })
  }

  const dropIndex = (category: TaskAtlasCategory, clientX: number, clientY: number, finalTotal: number) => {
    const element = fieldRef.current?.querySelector<HTMLElement>(`.task-atlas-cluster[data-category="${category}"]`)
    if (!element || finalTotal <= 1) return 0
    const rect = element.getBoundingClientRect()
    const degrees = Math.atan2(clientY - (rect.top + rect.height / 2), clientX - (rect.left + rect.width / 2)) * 180 / Math.PI
    const ringAngle = (degrees + 90 + 360) % 360
    const step = 360 / finalTotal
    return Math.min(finalTotal - 1, Math.floor((ringAngle + step / 2) / step))
  }

  const categoryAtPoint = (x: number, y: number, fallback: TaskAtlasCategory) => {
    // A dragged node keeps its original DOM parent. Resolve the drop target by
    // distance to topic centers instead of the element directly under the node.
    const nearest = categories.map((category) => {
      const element = fieldRef.current?.querySelector<HTMLElement>(`.task-atlas-cluster[data-category="${category.id}"]`)
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      const distance = Math.hypot(x - (bounds.left + bounds.width / 2), y - (bounds.top + bounds.height / 2))
      return { category: category.id, distance, radius: Math.max(bounds.width, bounds.height) * .7 }
    }).filter((item): item is { category: TaskAtlasCategory; distance: number; radius: number } => Boolean(item)).sort((left, right) => left.distance - right.distance)[0]
    if (nearest && nearest.distance <= nearest.radius) return nearest.category
    const target = document.elementsFromPoint(x, y).map((element) => element.closest<HTMLElement>('.task-atlas-cluster[data-category]')).find(Boolean)
    const id = target?.dataset.category as TaskAtlasCategory | undefined
    return id && categoryIds.has(id) ? id : fallback
  }

  const endTaskDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = taskDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (taskDragFrameRef.current) window.cancelAnimationFrame(taskDragFrameRef.current)
    taskDragFrameRef.current = 0
    pendingTaskDragRef.current = null
    drag.node.style.removeProperty('--atlas-drag-x')
    drag.node.style.removeProperty('--atlas-drag-y')
    drag.node.classList.remove('is-dragging')
    taskDragRef.current = null
    if (!drag.dragged) {
      chooseQuest(drag.quest)
      return
    }
    suppressNextClick()
    const targetCategory = categoryAtPoint(event.clientX, event.clientY, drag.sourceCategory)
    const sourceItems = (byCategory.get(drag.sourceCategory) ?? []).filter((quest) => quest.id !== drag.quest.id).map((quest) => quest.id)
    const destinationItems = (targetCategory === drag.sourceCategory ? sourceItems : (byCategory.get(targetCategory) ?? []).map((quest) => quest.id)).filter((id) => id !== drag.quest.id)
    const index = dropIndex(targetCategory, event.clientX, event.clientY, destinationItems.length + 1)
    destinationItems.splice(index, 0, drag.quest.id)
    onArrange({
      questId: drag.quest.id,
      sourceCategory: drag.sourceCategory,
      targetCategory,
      sourceOrder: targetCategory === drag.sourceCategory ? destinationItems : sourceItems,
      targetOrder: destinationItems,
    })
  }

  const startCategoryDrag = (event: PointerEvent<HTMLButtonElement>, category: CategoryDefinition) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu(null)
    const cluster = event.currentTarget.closest<HTMLElement>('.task-atlas-cluster')
    if (!cluster) return
    const bounds = worldRef.current?.getBoundingClientRect()
    const worldWidth = bounds?.width ?? 1
    const worldHeight = bounds?.height ?? 1
    event.currentTarget.setPointerCapture(event.pointerId)
    categoryDragRef.current = { pointerId: event.pointerId, category: category.id, startX: event.clientX, startY: event.clientY, origin: positionFor(category, atlas), worldWidth, worldHeight, cluster, dragged: false }
  }

  const moveCategoryDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = categoryDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.dragged && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      drag.dragged = true
      drag.cluster.classList.add('is-dragging')
    }
    if (!drag.dragged) return
    const next = clampPosition({ x: drag.origin.x + (dx / drag.worldWidth) * 100, y: drag.origin.y + (dy / drag.worldHeight) * 100 })
    pendingCategoryDragRef.current = { cluster: drag.cluster, position: next }
    if (categoryDragFrameRef.current) return
    categoryDragFrameRef.current = window.requestAnimationFrame(() => {
      categoryDragFrameRef.current = 0
      const pending = pendingCategoryDragRef.current
      pendingCategoryDragRef.current = null
      if (!pending) return
      pending.cluster.style.left = `${pending.position.x}%`
      pending.cluster.style.top = `${pending.position.y}%`
    })
  }

  const endCategoryDrag = (event: PointerEvent<HTMLButtonElement>, category: CategoryDefinition) => {
    const drag = categoryDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (categoryDragFrameRef.current) window.cancelAnimationFrame(categoryDragFrameRef.current)
    categoryDragFrameRef.current = 0
    pendingCategoryDragRef.current = null
    drag.cluster.classList.remove('is-dragging')
    categoryDragRef.current = null
    if (!drag.dragged) {
      setExpandedCategory(category.id)
      return
    }
    suppressNextClick()
    onMoveCategory(category.id, clampPosition({
      x: drag.origin.x + ((event.clientX - drag.startX) / drag.worldWidth) * 100,
      y: drag.origin.y + ((event.clientY - drag.startY) / drag.worldHeight) * 100,
    }))
  }

  const requestGuidance = async () => {
    if (!selected || guidanceBusy) return
    setGuidanceBusy(true)
    try { await onGenerateGuidance(selected) }
    catch (error) { window.alert(error instanceof Error ? error.message : '生成建议失败。') }
    finally { setGuidanceBusy(false) }
  }

  return <div className="task-atlas-view">
    <section className="task-atlas-canvas" aria-label="按主题组织的任务图">
      <header className="task-atlas-hud"><div><span className="section-kicker">THEIA · OBJECTIVE ATLAS</span><h2>任务图</h2></div><p>{quests.length} 项行动 · {categories.filter((category) => byCategory.get(category.id)?.length).length} 个主题</p></header>
      <div className="task-atlas-controls" aria-label="任务图视图控制">
        <button type="button" className="icon-button" title="放大任务图" aria-label="放大任务图" onClick={() => updateZoom(cameraRef.current.scale + .12)}><Plus size={16} /></button>
        <button type="button" className="icon-button" title="缩小任务图" aria-label="缩小任务图" onClick={() => updateZoom(cameraRef.current.scale - .12)}><Minus size={16} /></button>
        <button type="button" className="icon-button" title="重置任务图视角" aria-label="重置任务图视角" onClick={() => { const reset = { x: 0, y: 0, scale: fittedScale() }; applyCamera(reset); setCamera(reset) }}><RotateCcw size={15} /></button>
        {selected && <button type="button" className="icon-button" title="生成个性化建议" aria-label="生成个性化建议" onClick={() => void requestGuidance()} disabled={guidanceBusy}><Sparkles size={15} /></button>}
        <span>{Math.round(camera.scale * 100)}%</span>
      </div>
      <div ref={fieldRef} className={`task-atlas-field ${camera.scale < .75 ? 'is-overview' : ''}`} onWheel={handleWheel} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
        <div ref={worldRef} className="task-atlas-world" style={{ width: `${worldBaseSize.width * camera.scale}px`, height: `${worldBaseSize.height * camera.scale}px`, transform: `translate(-50%, -50%) translate3d(${camera.x}px, ${camera.y}px, 0)` }}>
          <div className="task-atlas-user-marker" aria-label={`${profile.name}的任务图中心`}>
            <span>{profile.avatarUrl && <img src={avatarImageUrl(profile.avatarUrl)} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} />}<i>{initialsFor(profile.name)}</i></span>
            <strong>{profile.name}</strong>
          </div>
          {categories.map((category) => {
            const items = byCategory.get(category.id) ?? []
            const scaledRadius = ringRadius(items.length) * camera.scale
            const position = positionFor(category, atlas)
            return <section className={`task-atlas-cluster task-atlas-cluster--${category.id}`} data-category={category.id} key={category.id} style={{ left: `${position.x}%`, top: `${position.y}%`, '--ring-radius': `${scaledRadius}px`, '--cluster-size': `${scaledRadius * 2 + 96}px` } as CSSProperties}>
              <div className="task-atlas-orbit" />
              <button type="button" className="task-atlas-center" onPointerDown={(event) => startCategoryDrag(event, category)} onPointerMove={moveCategoryDrag} onPointerUp={(event) => endCategoryDrag(event, category)} onPointerCancel={(event) => endCategoryDrag(event, category)} onClick={(event) => { event.preventDefault(); if (suppressClickRef.current) { suppressClickRef.current = false; return } setExpandedCategory(category.id) }} title={`拖动${category.label}主题，或点击查看任务`} aria-label={`拖动${category.label}主题，或查看任务`}><ClusterEmblem category={category.id} quests={items} people={people} /><span className="task-atlas-center-label">{category.label}</span><small>{items.length}</small></button>
              {items.map((quest, index) => <button type="button" key={quest.id} className={`task-atlas-node task-atlas-node--${quest.status} ${selected?.id === quest.id && !expandedCategory ? 'is-selected' : ''}`} style={nodeStyle(index, items.length, camera.scale)} onPointerDown={(event) => startTaskDrag(event, quest, category.id)} onPointerMove={moveTaskDrag} onPointerUp={endTaskDrag} onPointerCancel={endTaskDrag} onClick={() => chooseQuest(quest)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setSelectedId(quest.id); setExpandedCategory(null); setContextMenu({ questId: quest.id, x: Math.min(event.clientX, window.innerWidth - 178), y: Math.min(event.clientY, window.innerHeight - 96) }) }} title={`${quest.title}（拖动排序，右键编辑）`} aria-label={`查看任务：${quest.title}`}><TaskNodeContent quest={quest} peopleById={peopleById} intelById={intelById} /><small>{quest.title}</small></button>)}
            </section>
          })}
        </div>
        {(overflowCategory || selected) && <aside className="task-atlas-detail" aria-live="polite">
          {overflowCategory ? <div className="task-atlas-overflow-detail"><div className={`task-atlas-detail-art task-atlas-detail-art--${overflowCategory.id}`}><ClusterEmblem category={overflowCategory.id} quests={byCategory.get(overflowCategory.id) ?? []} people={people} /></div><div className="task-atlas-detail-content"><div className="task-atlas-detail-heading"><span><overflowCategory.icon size={15} />{overflowCategory.label}</span><button type="button" className="icon-button" title="关闭详情" aria-label="关闭详情" onClick={closeDetail}><X size={16} /></button></div><h2>{overflowCategory.label}任务</h2><p>{overflowCategory.note}。该主题共有 {(byCategory.get(overflowCategory.id) ?? []).length} 项任务。</p><div className="task-atlas-overflow-list">{(byCategory.get(overflowCategory.id) ?? []).map((quest) => <button type="button" key={quest.id} onClick={() => chooseQuest(quest)}><span className={`status-pip status-pip--${quest.status}`} /><div><strong>{quest.title}</strong><small>{formatQuestTime(quest, intel)}</small></div></button>)}</div></div></div> : selected ? <><div className={`task-atlas-detail-art task-atlas-detail-art--${selectedCategory}`}><ClusterEmblem category={selectedCategory} quests={[selected]} people={people} /></div><div className="task-atlas-detail-content"><div className="task-atlas-detail-heading"><span><SelectedIcon size={15} />{selectedDefinition.label} · {selected.kind === 'long-event' ? '长期事件' : '任务'}</span><div><button type="button" className="icon-button" title="关闭详情" aria-label="关闭详情" onClick={closeDetail}><X size={16} /></button><button type="button" className="icon-button" title="编辑任务" aria-label={`编辑 ${selected.title}`} onClick={() => onEdit(selected)}><Pencil size={16} /></button><button type="button" className="icon-button task-delete-button" title="删除任务" aria-label={`删除 ${selected.title}`} onClick={() => { if (window.confirm(`确定彻底删除“${selected.title}”？此操作不可撤销。`)) onDelete(selected.id) }}><Trash2 size={16} /></button></div></div><h2>{selected.title}</h2><p>{selected.description}</p><dl className="task-atlas-facts"><div><dt><Clock3 size={14} />时间</dt><dd>{formatQuestTime(selected, intel)}</dd></div><div><dt><MapPin size={14} />地点</dt><dd>{selectedPlace?.name ?? '未标注地点'}</dd></div><div><dt><FileText size={14} />来源</dt><dd>{selected.sourcePlatforms?.join(' / ') || selected.source || '手动记录'}</dd></div></dl>{!!selected.guidance?.length && <div className="task-atlas-guidance"><span>行动建议{guidanceUpdatedLabel(selected.guidanceUpdatedAt) && <small>基于人物新资料更新于 {guidanceUpdatedLabel(selected.guidanceUpdatedAt)}</small>}</span>{selected.guidance.map((item, index) => <p key={`${selected.id}-guidance-${index}`}>{item}</p>)}</div>}{!!linkedPeople.length && <div className="task-atlas-linked-people"><span>关联人物</span><div>{linkedPeople.map((person) => <span key={person.id}>{person.avatarUrl && <img src={avatarImageUrl(person.avatarUrl)} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} />}<i>{initialsFor(person.name)}</i><strong>{person.name}</strong></span>)}</div></div>}<div className="task-atlas-detail-actions"><button type="button" className={`primary-button ${selected.status === 'done' ? 'is-done' : ''}`} onClick={() => onToggle(selected.id)} disabled={selected.status === 'locked'}>{selected.status === 'done' ? <CheckCircle2 size={16} /> : <Circle size={16} />}{selected.status === 'done' ? '已完成' : '标记完成'}</button><button type="button" className="secondary-button" onClick={() => onViewSource(selected)}><FileText size={15} />查看来源</button></div></div></> : null}
        </aside>}
      </div>
      {contextMenu && contextQuest && <div className="task-atlas-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}><strong>{contextQuest.title}</strong><button type="button" onClick={() => { setContextMenu(null); onEdit(contextQuest) }}><Pencil size={15} />编辑任务</button><button type="button" className="is-danger" onClick={() => { setContextMenu(null); if (window.confirm(`确定彻底删除“${contextQuest.title}”？此操作不可撤销。`)) onDelete(contextQuest.id) }}><Trash2 size={15} />删除任务</button></div>}
      <div className="task-atlas-footer"><span><Maximize2 size={13} />拖动空白处移动图面，滚轮缩放</span><span>拖动主题或任务调整结构，右键任务编辑或删除</span></div>
    </section>
  </div>
}
