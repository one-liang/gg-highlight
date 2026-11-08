import { apiErrorMessage } from '../utils/api-error'

/** Toast helpers: API errors show the server's statusMessage. */
export function useNotify() {
  const toast = useToast()
  return {
    success(title: string, description?: string) {
      toast.add({ title, description, color: 'success', icon: 'i-lucide-circle-check' })
    },
    error(err: unknown, fallback: string) {
      const description = apiErrorMessage(err, fallback)
      if (description === '已取消') return
      toast.add({ title: fallback, description: description === fallback ? undefined : description, color: 'error', icon: 'i-lucide-circle-alert' })
    },
    message(title: string, description?: string) {
      toast.add({ title, description, color: 'error', icon: 'i-lucide-circle-alert' })
    },
  }
}
