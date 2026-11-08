import { defineEventHandler, type EventHandler, setResponseHeader } from 'h3'
import { allowedMethods, httpError, type MatchedRoute, notFound } from '../lib/api'

/** This file's own route (`[...].ts`; a named `[...path].ts` is never reached as h3's method fallback). */
const CATCH_ALL = '/api/**'

/**
 * Unknown /api/* routes, and known ones asked with a method they do not answer, get JSON errors
 * instead of the SPA page.
 */
export default defineEventHandler((event) => {
  const route = event.context.matchedRoute as MatchedRoute | undefined
  const allowed = allowedMethods(route, CATCH_ALL)
  if (!allowed.length) throw notFound('找不到這個 API')
  // HEAD is a GET without the body (Node leaves the body out of HEAD responses).
  const get = route?.handlers?.get as EventHandler | undefined
  if (event.method === 'HEAD' && get) return get(event)
  setResponseHeader(event, 'Allow', allowed.join(', '))
  throw httpError(405, '不支援這個請求方法')
})
