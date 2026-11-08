// Keeps a file dropped outside an upload drop zone from making the browser open it in place of
// the app (which unloads the page and kills a running upload).

/** The parts of a DragEvent the guard looks at. */
export interface FileDragEventLike {
  type: string
  defaultPrevented: boolean
  dataTransfer: { types: ReadonlyArray<string>, dropEffect: string } | null
  preventDefault: () => void
}

/**
 * Window-level dragover / drop listener. A file drag that no drop zone took (drop zones call
 * preventDefault while the event bubbles up to the window) is cancelled, and dragover shows the
 * "no drop here" cursor. Other drags (text, links) keep their default behaviour.
 */
export function guardFileDrag(e: FileDragEventLike): void {
  if (e.defaultPrevented || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
  e.preventDefault()
  if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
}

type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/** Puts guardFileDrag on `target` (the window) for dragover and drop; returns the function that removes it. */
export function installFileDropGuard(target: ListenerTarget): () => void {
  const listener = (e: Event) => guardFileDrag(e as unknown as FileDragEventLike)
  target.addEventListener('dragover', listener)
  target.addEventListener('drop', listener)
  return () => {
    target.removeEventListener('dragover', listener)
    target.removeEventListener('drop', listener)
  }
}
