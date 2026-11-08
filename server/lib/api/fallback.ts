// /api/** requests that no route handles: a JSON 405 for a known path asked with another method,
// a JSON 404 otherwise (never the SPA page, which the renderer would send with a 200).

/** The route record h3's router puts on `event.context.matchedRoute`: its path and handlers by method. */
export interface MatchedRoute {
  path?: string
  handlers?: Record<string, unknown>
}

/**
 * Methods the route that matched the request path answers (upper-case, sorted, HEAD with GET), or
 * [] when only the catch-all itself matched. 'all' is left out: on a specific route it can only be
 * the catch-all, which h3 caches there after falling back to it.
 */
export function allowedMethods(route: MatchedRoute | null | undefined, catchAllPath: string): string[] {
  if (!route?.handlers || route.path === catchAllPath) return []
  const methods = new Set(Object.keys(route.handlers).filter(m => m !== 'all').map(m => m.toUpperCase()))
  if (methods.has('GET')) methods.add('HEAD')
  return [...methods].sort()
}
