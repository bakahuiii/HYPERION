import type { Place } from '../types'

export interface WeatherContext {
  date: string
  condition: string
  temperatureMin?: number
  temperatureMax?: number
  precipitationProbability?: number
}

function localDate(value: Date) {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function weatherCondition(code: number) {
  const conditions: Record<number, string> = {
    0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog',
    51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'heavy rain showers',
    95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
  }
  return conditions[code] ?? 'unknown conditions'
}

/** Uses Open-Meteo's public, no-key daily forecast only for nearby future dates. */
export async function fetchTaskWeather(place: Pick<Place, 'lat' | 'lng'> | undefined, scheduledAt?: string, signal?: AbortSignal): Promise<WeatherContext | undefined> {
  if (!place || !scheduledAt) return undefined
  const date = scheduledAt.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const today = localDate(new Date())
  const daysAway = Math.round((new Date(`${date}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86_400_000)
  if (daysAway < 0 || daysAway > 16) return undefined
  try {
    const query = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lng),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      start_date: date,
      end_date: date,
    })
    const timeout = AbortSignal.timeout(8_000)
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const payload = await response.json() as { daily?: { weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] } }
    if (!response.ok || !payload.daily) return undefined
    const code = Number(payload.daily.weather_code?.[0])
    return {
      date,
      condition: weatherCondition(code),
      temperatureMin: Number.isFinite(Number(payload.daily.temperature_2m_min?.[0])) ? Number(payload.daily.temperature_2m_min?.[0]) : undefined,
      temperatureMax: Number.isFinite(Number(payload.daily.temperature_2m_max?.[0])) ? Number(payload.daily.temperature_2m_max?.[0]) : undefined,
      precipitationProbability: Number.isFinite(Number(payload.daily.precipitation_probability_max?.[0])) ? Number(payload.daily.precipitation_probability_max?.[0]) : undefined,
    }
  } catch {
    return undefined
  }
}
