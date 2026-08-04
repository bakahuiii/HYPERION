import { ExternalLink, Map, Save } from 'lucide-react'
import { useEffect, useState } from 'react'

import { loadMapConfig, saveMapConfig, type MapConfig } from '../lib/mapConfig'

export function MapProviderSettings() {
  const [config, setConfig] = useState<MapConfig | null>(null)
  const [draft, setDraft] = useState<Pick<MapConfig, 'tileProvider' | 'searchProvider' | 'cacheMaxMb'> | null>(null)
  const [message, setMessage] = useState('正在读取地图服务设置…')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    void loadMapConfig(true).then((next) => {
      if (!active) return
      setConfig(next)
      setDraft({ tileProvider: next.tileProvider, searchProvider: next.searchProvider, cacheMaxMb: next.cacheMaxMb })
      setMessage(next.usageNotice)
    }).catch((error) => { if (active) setMessage(error instanceof Error ? error.message : '地图服务设置读取失败。') })
    return () => { active = false }
  }, [])

  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    setMessage('正在保存地图服务设置…')
    try {
      const next = await saveMapConfig(draft)
      setConfig(next)
      setDraft({ tileProvider: next.tileProvider, searchProvider: next.searchProvider, cacheMaxMb: next.cacheMaxMb })
      setMessage('地图服务设置已保存；已打开的地图会立即切换底图。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '地图服务设置保存失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="options-section map-provider-settings">
      <div className="options-heading"><div><Map size={18} /><div><h3>公共地图服务</h3><p>选择免费底图和地点搜索源，并限制本机瓦片缓存占用。服务仅用于人工交互，不会批量预取地图。</p></div></div></div>
      {draft && config ? <>
        <div className="ai-controls">
          <label><span>底图源</span><select value={draft.tileProvider} onChange={(event) => setDraft((current) => current ? { ...current, tileProvider: event.target.value as MapConfig['tileProvider'] } : current)}>{config.tileProviders.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label>
          <label><span>地点搜索</span><select value={draft.searchProvider} onChange={(event) => setDraft((current) => current ? { ...current, searchProvider: event.target.value as MapConfig['searchProvider'] } : current)}>{config.searchProviders.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label>
          <label><span>瓦片缓存上限</span><select value={draft.cacheMaxMb} onChange={(event) => setDraft((current) => current ? { ...current, cacheMaxMb: Number(event.target.value) } : current)}>{[32, 64, 128, 256, 512, 1024].map((value) => <option value={value} key={value}>{value} MB</option>)}</select></label>
        </div>
        <div className="map-policy-links">
          {[...config.tileProviders, ...config.searchProviders.filter((provider) => provider.id !== 'balanced')].map((provider) => <a href={provider.policyUrl} target="_blank" rel="noreferrer" key={`${provider.id}-${provider.policyUrl}`}>{provider.name}<ExternalLink size={12} /></a>)}
        </div>
        <div className="provider-actions"><button type="button" className="primary-button" onClick={() => void save()} disabled={saving}><Save size={15} />{saving ? '保存中…' : '保存地图设置'}</button><span role="status">{message}</span></div>
      </> : <p className="provider-message" role="status">{message}</p>}
    </section>
  )
}
