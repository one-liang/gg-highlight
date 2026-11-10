import { describe, expect, it } from 'vitest'
import { type FileDragEventLike, guardFileDrag, installFileDropGuard } from './file-drop-guard'

function dragEvent(type: string, types: string[], defaultPrevented = false) {
  const e = {
    type,
    defaultPrevented,
    dataTransfer: { types, dropEffect: 'copy' },
    preventDefault() {
      e.defaultPrevented = true
    },
  }
  return e satisfies FileDragEventLike
}

describe('guardFileDrag', () => {
  it('cancels a file drop no drop zone took, so the browser does not open the file', () => {
    const drop = dragEvent('drop', ['Files'])
    guardFileDrag(drop)
    expect(drop.defaultPrevented).toBe(true)
    const over = dragEvent('dragover', ['application/x-moz-file', 'Files'])
    guardFileDrag(over)
    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer.dropEffect).toBe('none')
  })

  it('leaves a drop zone\'s own handling alone (it already called preventDefault)', () => {
    const over = dragEvent('dragover', ['Files'], true)
    guardFileDrag(over)
    expect(over.dataTransfer.dropEffect).toBe('copy')
  })

  it('ignores drags that carry no files (text, links)', () => {
    const text = dragEvent('drop', ['text/plain', 'text/uri-list'])
    guardFileDrag(text)
    expect(text.defaultPrevented).toBe(false)
    const none = { type: 'drop', defaultPrevented: false, dataTransfer: null, preventDefault: () => { throw new Error('no') } }
    expect(() => guardFileDrag(none)).not.toThrow()
  })
})

describe('installFileDropGuard', () => {
  it('listens to dragover and drop until removed', () => {
    const added: string[] = []
    const removed: string[] = []
    const target = {
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    }
    const uninstall = installFileDropGuard(target as unknown as EventTarget)
    expect(added).toEqual(['dragover', 'drop'])
    uninstall()
    expect(removed).toEqual(['dragover', 'drop'])
  })
})
