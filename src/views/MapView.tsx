import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import L from 'leaflet'
import { Crosshair, LocateFixed, MapPin, Move, Navigation, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import type { Place, Quest } from '../types'
import { apiUrl } from '../lib/apiUrl'
import { mapSearchPrecision, mapSearchRadius, searchMapPlaces, type MapSearchResult } from '../lib/mapSearch'

interface MapViewProps {
  places: Place[]
  quests: Quest[]
  selectedPlaceId: string
  onSelect: (id: string) => void
  onUpdatePlace: (place: Place) => void
  onCreatePlace: (place: Place) => void
  onDeletePlace: (id: string) => void
}

interface ExistingPlaceEditorProps {
  place: Place
  quests: Quest[]
  editing: boolean
  coordinateDraft: PlaceDraft | null
  canDelete: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (place: Place) => void
  onPreviewCoordinate: (lat: number, lng: number) => void
  onDelete: () => void
}

interface PlaceDraft {
  lat: number
  lng: number
  name?: string
  precision?: Place['precision']
  radiusMeters?: number
}

interface MovedPlaceDraft extends PlaceDraft {
  placeId: string
}

function ExistingPlaceEditor({ place, quests, editing, coordinateDraft, canDelete, onEdit, onCancel, onSave, onPreviewCoordinate, onDelete }: ExistingPlaceEditorProps) {
  const [name, setName] = useState(place.name)
  const [category, setCategory] = useState(place.category)
  const [note, setNote] = useState(place.note)
  const [lat, setLat] = useState(String(coordinateDraft?.lat ?? place.lat))
  const [lng, setLng] = useState(String(coordinateDraft?.lng ?? place.lng))
  const [precision, setPrecision] = useState<NonNullable<Place['precision']>>(place.precision ?? 'exact')
  const [radiusMeters, setRadiusMeters] = useState(String(place.radiusMeters ?? 800))
  const [message, setMessage] = useState(coordinateDraft ? '标记已移动，保存后才会写入新坐标。' : '可编辑坐标，或直接拖动地图上的选中标记。')
  const [locating, setLocating] = useState(false)

  const save = () => {
    const trimmedName = name.trim()
    const nextLat = Number(lat)
    const nextLng = Number(lng)
    const nextRadius = Number(radiusMeters)
    if (!trimmedName) {
      setMessage('地点名称不能为空。')
      return
    }
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng) || Math.abs(nextLat) > 90 || Math.abs(nextLng) > 180) {
      setMessage('经纬度格式不正确。')
      return
    }
    if (precision === 'approximate' && (!Number.isFinite(nextRadius) || nextRadius < 50 || nextRadius > 100_000)) {
      setMessage('大致范围需在 50 米到 100 公里之间。')
      return
    }
    onSave({ ...place, name: trimmedName.slice(0, 80), category, note: note.trim().slice(0, 500), lat: nextLat, lng: nextLng, precision, radiusMeters: precision === 'approximate' ? Math.round(nextRadius) : undefined })
  }

  const locate = () => {
    if (!navigator.geolocation) {
      setMessage('当前浏览器不支持定位。')
      return
    }
    setLocating(true)
    setMessage('正在等待定位授权...')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLat = Number(position.coords.latitude.toFixed(6))
        const nextLng = Number(position.coords.longitude.toFixed(6))
        setLat(String(nextLat))
        setLng(String(nextLng))
        onPreviewCoordinate(nextLat, nextLng)
        setMessage(`已定位，精度约 ${Math.round(position.coords.accuracy)} 米；保存后生效。`)
        setLocating(false)
      },
      () => {
        setMessage('未能读取位置，请检查浏览器定位权限。')
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    )
  }

  return <aside className={`map-detail ${editing ? 'is-editing' : ''}`} aria-label={`${place.name} 地点详情`}>
    <div className="place-title-row">
      <div className="place-title"><div className={`place-icon place-icon--${place.category}`}><MapPin size={21} /></div><div><span className="section-kicker">地点与任务目标</span><h2>{place.name}</h2></div></div>
      <div className="place-title-actions">
        {!editing && <button type="button" className="icon-button" title="编辑地点" aria-label={`编辑地点 ${place.name}`} onClick={onEdit}><Pencil size={16} /></button>}
        <button type="button" className="icon-button map-delete-place" title={canDelete ? '删除地点' : '至少保留一个地点'} aria-label={`删除地点 ${place.name}`} onClick={onDelete} disabled={!canDelete}><Trash2 size={16} /></button>
      </div>
    </div>
    {!editing ? <>
      <p>{place.note || '暂无备注。'}</p>
      <div className="coordinate-row"><span>坐标</span><code>{place.lat.toFixed(6)}, {place.lng.toFixed(6)}</code></div>
      {place.precision === 'approximate' && <div className="map-range-summary"><Crosshair size={14} /><span>大致范围 · 半径约 {place.radiusMeters && place.radiusMeters >= 1000 ? `${(place.radiusMeters / 1000).toFixed(1)} 公里` : `${place.radiusMeters ?? 800} 米`}</span></div>}
      <div className="map-drag-note"><Move size={14} /><span>拖动地图上的选中标记可调整位置</span></div>
    </> : <>
      <div className="place-draft-form place-edit-form">
        <label><span>地点名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
        <label><span>类别</span><select value={category} onChange={(event) => setCategory(event.target.value as Place['category'])}><option value="home">居所</option><option value="study">学习</option><option value="health">健康</option><option value="social">社交</option><option value="explore">探索</option></select></label>
        <label><span>备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} maxLength={500} placeholder="可选" /></label>
        <div className="coordinate-fields">
          <label><span>标注方式</span><select value={precision} onChange={(event) => setPrecision(event.target.value as NonNullable<Place['precision']>)}><option value="exact">精确地点</option><option value="approximate">大致范围</option></select></label>
          {precision === 'approximate' && <label><span>范围半径（米）</span><input value={radiusMeters} inputMode="numeric" onChange={(event) => setRadiusMeters(event.target.value)} /></label>}
        </div>
        <div className="coordinate-fields">
          <label><span>纬度</span><input value={lat} inputMode="decimal" onChange={(event) => setLat(event.target.value)} /></label>
          <label><span>经度</span><input value={lng} inputMode="decimal" onChange={(event) => setLng(event.target.value)} /></label>
        </div>
      </div>
      <p className="place-edit-message" role="status">{message}</p>
      <div className="coordinate-actions place-edit-actions">
        <button type="button" className="secondary-button" onClick={locate} disabled={locating}><LocateFixed size={15} />{locating ? '定位中' : '使用当前位置'}</button>
        <button type="button" className="secondary-button" onClick={onCancel}><X size={15} />取消</button>
        <button type="button" className="primary-button" onClick={save}><Save size={15} />保存地点</button>
      </div>
    </>}
    <div className="location-quests"><div className="subsection-title"><span>此处目标</span><strong>{quests.length}</strong></div>{quests.length ? quests.map((quest) => <article key={quest.id} className={quest.status === 'locked' ? 'is-locked' : ''}><i className="quest-dot quest-dot--neutral" /><div><h3>{quest.title}</h3><span>{quest.status === 'locked' ? '等待前置任务' : '未完成目标'}</span></div></article>) : <div className="empty-note">这里暂时没有未完成目标。</div>}</div>
  </aside>
}

function PlaceDraftEditor({ draft, onCancel, onSave }: { draft: PlaceDraft; onCancel: () => void; onSave: (place: Place) => void }) {
  const [name, setName] = useState(draft.name ?? '新地点')
  const [category, setCategory] = useState<Place['category']>('explore')
  const [note, setNote] = useState('')
  const [precision, setPrecision] = useState<NonNullable<Place['precision']>>(draft.precision ?? 'exact')
  const [radiusMeters, setRadiusMeters] = useState(String(draft.radiusMeters ?? 800))

  const save = () => {
    const trimmedName = name.trim()
    if (!trimmedName) return
    onSave({
      id: `place-${Date.now().toString(36)}`,
      name: trimmedName.slice(0, 80),
      category,
      note: note.trim().slice(0, 500),
      lat: draft.lat,
      lng: draft.lng,
      precision,
      radiusMeters: precision === 'approximate' ? Math.min(100_000, Math.max(50, Number(radiusMeters) || 800)) : undefined,
    })
  }

  return <aside className="map-detail map-detail--draft" aria-label="新增地图标记">
    <div className="place-title">
      <div className="place-icon place-icon--explore"><MapPin size={21} /></div>
      <div><span className="section-kicker">NEW MAP MARKER</span><h2>新增标记</h2></div>
    </div>
    <p>已选取开放地图坐标。填写后保存，任务就可以选择此地点。</p>
    <div className="place-draft-form">
      <label><span>地点名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
      <label><span>类别</span><select value={category} onChange={(event) => setCategory(event.target.value as Place['category'])}><option value="home">居所</option><option value="study">学习</option><option value="health">健康</option><option value="social">社交</option><option value="explore">探索</option></select></label>
      <label><span>备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} maxLength={500} placeholder="可选" /></label>
      <div className="coordinate-fields">
        <label><span>标注方式</span><select value={precision} onChange={(event) => setPrecision(event.target.value as NonNullable<Place['precision']>)}><option value="exact">精确地点</option><option value="approximate">大致范围</option></select></label>
        {precision === 'approximate' && <label><span>范围半径（米）</span><input value={radiusMeters} inputMode="numeric" onChange={(event) => setRadiusMeters(event.target.value)} /></label>}
      </div>
      <div className="coordinate-row"><span>坐标</span><code>{draft.lat.toFixed(6)}, {draft.lng.toFixed(6)}</code></div>
    </div>
    <div className="coordinate-actions">
      <button type="button" className="secondary-button" onClick={onCancel}><X size={15} />取消</button>
      <button type="button" className="primary-button" onClick={save} disabled={!name.trim()}><Save size={15} />保存标记</button>
    </div>
  </aside>
}

export function MapView({ places, quests, selectedPlaceId, onSelect, onUpdatePlace, onCreatePlace, onDeletePlace }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerLayerRef = useRef<L.LayerGroup | null>(null)
  const fittedRef = useRef(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<PlaceDraft | null>(null)
  const [editingPlaceId, setEditingPlaceId] = useState('')
  const [movedPlace, setMovedPlace] = useState<MovedPlaceDraft | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<MapSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchMessage, setSearchMessage] = useState('')
  const selected = places.find((place) => place.id === selectedPlaceId) ?? places[0]
  const placeQuests = quests.filter((quest) => quest.locationId === selected?.id && quest.status !== 'done')

  const focusCoordinate = useCallback((lat: number, lng: number, zoom: number) => {
    const map = mapRef.current
    if (!map) return
    map.stop()
    map.setView([lat, lng], zoom, { animate: false })
    window.requestAnimationFrame(() => map.invalidateSize({ pan: false }))
  }, [])

  const focusPlace = useCallback((place: Place, zoom = 14) => {
    onSelect(place.id)
    focusCoordinate(place.lat, place.lng, zoom)
  }, [focusCoordinate, onSelect])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: true, preferCanvas: true }).setView([31.2304, 121.4737], 12)
    L.tileLayer(apiUrl('/api/map/tiles/{z}/{x}/{y}.png'), {
      attribution: '&copy; OpenStreetMap contributors, Humanitarian OpenStreetMap Team',
      maxZoom: 19,
    }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    markerLayerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    window.requestAnimationFrame(() => map.invalidateSize({ pan: false }))
    return () => {
      map.remove()
      mapRef.current = null
      markerLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const pickCoordinate = (event: L.LeafletMouseEvent) => {
      if (!adding) return
      setDraft({ lat: Number(event.latlng.lat.toFixed(6)), lng: Number(event.latlng.lng.toFixed(6)) })
      setAdding(false)
    }
    map.on('click', pickCoordinate)
    return () => { map.off('click', pickCoordinate) }
  }, [adding])

  useEffect(() => {
    const map = mapRef.current
    const layer = markerLayerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const validPlaces = places.filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
    validPlaces.forEach((place) => {
      const activeCount = quests.filter((quest) => quest.locationId === place.id && quest.status !== 'done' && quest.status !== 'locked').length
      const pendingPosition = movedPlace?.placeId === place.id ? movedPlace : null
      const markerLat = pendingPosition?.lat ?? place.lat
      const markerLng = pendingPosition?.lng ?? place.lng
      const draggable = place.id === selectedPlaceId
      const icon = L.divIcon({
        className: `quest-map-marker quest-map-marker--${place.category} ${draggable ? 'is-selected is-draggable' : ''} ${pendingPosition ? 'is-pending' : ''}`,
        html: `<span class="quest-marker-core"><span class="quest-marker-symbol"></span>${activeCount ? `<b>${activeCount}</b>` : ''}</span>`,
        iconSize: [42, 52],
        iconAnchor: [21, 47],
      })
      if (place.precision === 'approximate') {
        const rangeColors: Record<Place['category'], string> = { home: '#c4965f', study: '#708eb4', health: '#a76e57', social: '#ad7752', explore: '#668d6b' }
        L.circle([markerLat, markerLng], {
          radius: Math.min(100_000, Math.max(50, place.radiusMeters ?? 800)),
          color: rangeColors[place.category],
          weight: 1,
          opacity: .62,
          fillColor: rangeColors[place.category],
          fillOpacity: .14,
          interactive: false,
          className: 'quest-map-range',
        }).addTo(layer)
      }
      const marker = L.marker([markerLat, markerLng], { icon, keyboard: true, draggable, autoPan: true, title: place.name, alt: `${place.name}，${activeCount} 个未完成任务` }).addTo(layer)
      marker.getElement()?.setAttribute('aria-label', `${place.name}，${activeCount} 个未完成任务`)
      marker.getElement()?.setAttribute('role', 'button')
      marker.bindTooltip(draggable ? `${place.name} · 可拖动` : place.name, { direction: 'top', offset: [0, -38], opacity: .95 })
      marker.on('click', () => {
        if (place.id !== selectedPlaceId) {
          setEditingPlaceId('')
          setMovedPlace(null)
        }
        setDraft(null)
        onSelect(place.id)
        focusCoordinate(markerLat, markerLng, 14)
      })
      marker.on('dragstart', () => {
        setDraft(null)
        setAdding(false)
        setSearchResults([])
        onSelect(place.id)
        setEditingPlaceId(place.id)
      })
      marker.on('dragend', () => {
        const coordinate = marker.getLatLng()
        setMovedPlace({ placeId: place.id, lat: Number(coordinate.lat.toFixed(6)), lng: Number(coordinate.lng.toFixed(6)) })
        setEditingPlaceId(place.id)
      })
    })
    if (!fittedRef.current && validPlaces.length) {
      map.fitBounds(L.latLngBounds(validPlaces.map((place) => [place.lat, place.lng] as L.LatLngTuple)), { padding: [48, 48], maxZoom: 13 })
      fittedRef.current = true
    }
  }, [focusCoordinate, movedPlace, onSelect, places, quests, selectedPlaceId])

  const savePlace = (place: Place) => {
    onUpdatePlace(place)
    setMovedPlace(null)
    setEditingPlaceId('')
    focusCoordinate(place.lat, place.lng, 15)
  }

  const cancelPlaceEdit = () => {
    setMovedPlace(null)
    setEditingPlaceId('')
    if (selected) focusCoordinate(selected.lat, selected.lng, 14)
  }

  const deleteSelectedPlace = () => {
    if (!selected || places.length <= 1) return
    const linkedQuestCount = quests.filter((quest) => quest.locationId === selected.id).length
    const suffix = linkedQuestCount ? `\n关联的 ${linkedQuestCount} 个任务将移动到其他地点。` : ''
    if (!window.confirm(`确定彻底删除地点“${selected.name}”吗？${suffix}`)) return
    onDeletePlace(selected.id)
    setMovedPlace(null)
    setEditingPlaceId('')
  }

  const saveDraft = (place: Place) => {
    onCreatePlace(place)
    setDraft(null)
    focusCoordinate(place.lat, place.lng, 15)
  }

  const searchPlaces = async (event: FormEvent) => {
    event.preventDefault()
    const query = searchQuery.trim()
    if (query.length < 2 || searching) return
    setSearching(true)
    setSearchMessage('正在搜索开放地点数据…')
    try {
      const usable = await searchMapPlaces(query)
      setSearchResults(usable)
      setSearchMessage(usable.length ? `找到 ${usable.length} 个地点，请选择一个结果。` : '没有找到匹配地点。可尝试“城市 + 地点全名”，或直接在地图上添加标记。')
    } catch (error) {
      setSearchResults([])
      setSearchMessage(error instanceof Error ? error.message : '地点搜索失败，请稍后重试。')
    } finally {
      setSearching(false)
    }
  }

  const chooseSearchResult = (result: MapSearchResult) => {
    const lat = Number(Number(result.lat).toFixed(6))
    const lng = Number(Number(result.lon).toFixed(6))
    const name = result.display_name.split(',')[0]?.trim() || result.display_name
    const precision = mapSearchPrecision(result)
    const radiusMeters = precision === 'approximate' ? mapSearchRadius(result) ?? 800 : undefined
    setSearchResults([])
    setSearchMessage('')
    setSearchQuery(name)
    setDraft({ lat, lng, name, precision, radiusMeters })
    setAdding(false)
    focusCoordinate(lat, lng, 16)
  }

  return <div className="map-layout">
    <section className="life-map" aria-label="现实生活地图">
      <div className="map-toolbar">
        <div><span className="section-kicker">OPEN MAP · 本地任务标记</span><h2>现实坐标</h2></div>
        <div className="map-toolbar-actions">
          <span><Crosshair size={14} />{places.length} 个地点</span>
          <button type="button" className={`secondary-button map-add-place ${adding ? 'is-active' : ''}`} onClick={() => { setDraft(null); setAdding((current) => !current) }} title="在地图上选择一个新地点"><Plus size={15} />{adding ? '点击地图' : '添加标记'}</button>
          <button type="button" className="map-locate" aria-label="定位到居所" onClick={() => places[0] && focusPlace(places[0])} title="回到居所"><Navigation size={17} /></button>
        </div>
      </div>
      <div className="map-search-panel">
        <form className="map-search-form" onSubmit={searchPlaces}>
          <Search size={15} aria-hidden="true" />
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索现实地点、校园或地址" aria-label="搜索现实地点" />
          <button type="submit" className="icon-button" aria-label="搜索地点" title="搜索地点" disabled={searching || searchQuery.trim().length < 2}><Search size={15} /></button>
        </form>
        {searchMessage && <p className="map-search-message" role="status">{searchMessage}</p>}
        {!!searchResults.length && <div className="map-search-results" role="listbox" aria-label="地点搜索结果">{searchResults.map((result) => <button type="button" key={`${result.lat}-${result.lon}-${result.display_name}`} onClick={() => chooseSearchResult(result)}><MapPin size={14} /><span>{result.display_name}</span></button>)}</div>}
      </div>
      <div ref={containerRef} className={`real-map ${adding ? 'is-adding' : ''}`} aria-label="OpenStreetMap 地图，显示地点与任务标记" />
      <div className="map-privacy-line">底图基于 OpenStreetMap 公开镜像；地点搜索只会发送你主动提交的关键词，任务名称、人物与备注不会发送。</div>
    </section>
    {draft ? <PlaceDraftEditor key={`${draft.lat}-${draft.lng}`} draft={draft} onCancel={() => setDraft(null)} onSave={saveDraft} /> : selected && <ExistingPlaceEditor key={`${selected.id}-${editingPlaceId === selected.id ? 'edit' : 'view'}-${movedPlace?.placeId === selected.id ? `${movedPlace.lat}-${movedPlace.lng}` : 'saved'}`} place={selected} quests={placeQuests} editing={editingPlaceId === selected.id} coordinateDraft={movedPlace?.placeId === selected.id ? movedPlace : null} canDelete={places.length > 1} onEdit={() => setEditingPlaceId(selected.id)} onCancel={cancelPlaceEdit} onSave={savePlace} onPreviewCoordinate={(lat, lng) => setMovedPlace({ placeId: selected.id, lat, lng })} onDelete={deleteSelectedPlace} />}
  </div>
}
