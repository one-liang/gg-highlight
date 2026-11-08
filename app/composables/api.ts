import type { MaybeRefOrGetter } from 'vue'
import { describeApiError, InvalidResponseError } from '../utils/api-error'

const NOT_JSON = Symbol('not-json')

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: Record<string, unknown> | object
  query?: Record<string, string | number | boolean | undefined>
}

/**
 * $fetch for our JSON API. Rejects when the answer is not JSON (e.g. the SPA HTML shell
 * for a route the server does not have), so callers never treat HTML as data.
 */
export async function apiFetch<T>(url: string, options: ApiFetchOptions = {}): Promise<T> {
  const result = await $fetch<unknown>(url, {
    method: options.method ?? 'GET',
    body: options.body as Record<string, unknown> | undefined,
    query: options.query,
    headers: { accept: 'application/json' },
    parseResponse: (text: string) => {
      if (!text) return null
      try {
        return JSON.parse(text)
      }
      catch {
        return NOT_JSON
      }
    },
  })
  if (result === NOT_JSON) throw new InvalidResponseError()
  return result as T
}

export interface ApiDataError {
  message: string
  status: number | null
}

/**
 * Loads a JSON resource and keeps the last good data when a later refresh fails,
 * so polling never blanks the page.
 */
export function useApiData<T>(url: MaybeRefOrGetter<string | null>, fallbackMessage = '讀取資料失敗') {
  const data = shallowRef<T | null>(null)
  const error = shallowRef<ApiDataError | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  let seq = 0

  async function refresh(): Promise<void> {
    const target = toValue(url)
    if (!target) return
    const id = ++seq
    loading.value = true
    try {
      const value = await apiFetch<T>(target)
      if (id !== seq) return
      data.value = value
      error.value = null
    }
    catch (err) {
      if (id !== seq) return
      error.value = describeApiError(err, fallbackMessage)
    }
    finally {
      if (id === seq) {
        loading.value = false
        loaded.value = true
      }
    }
  }

  /** Replace local data (e.g. with a mutation result) and drop any in-flight older response. */
  function set(value: T | null) {
    seq++
    loading.value = false
    loaded.value = true
    error.value = null
    data.value = value
  }

  watch(() => toValue(url), (next, prev) => {
    if (next === prev) return
    data.value = null
    error.value = null
    loaded.value = false
    void refresh()
  }, { immediate: true })

  return { data, error, loading, loaded, refresh, set }
}
