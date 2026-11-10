import type { MaybeRefOrGetter } from 'vue'
import { createPoller, DEFAULT_POLL_MS } from '../utils/poller'

/** Calls `refresh` every `intervalMs` while `active` is true; stops when false or on unmount. */
export function usePolling(refresh: () => unknown, active: MaybeRefOrGetter<boolean>, intervalMs = DEFAULT_POLL_MS) {
  const poller = createPoller({ refresh, isActive: () => toValue(active), intervalMs })
  watch(() => toValue(active), () => poller.sync(), { immediate: true })
  onScopeDispose(() => poller.dispose())
  return poller
}
