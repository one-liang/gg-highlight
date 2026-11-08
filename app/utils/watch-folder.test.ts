import { describe, expect, it } from 'vitest'
import type { WatchFolderFile } from '../../shared/types/domain'
import { filterWatchFolderFiles, isAbsoluteFolderPath, normalizeFolderInput, sameFolderPath, validateFolderInput } from './watch-folder'

function file(name: string, folder: string, modifiedAt: string): WatchFolderFile {
  return { path: `${folder}\\${name}`, name, folder, sizeBytes: 1, modifiedAt, inLibrary: false }
}

describe('filterWatchFolderFiles', () => {
  const files = [
    file('2026-10-18 20-00-00.mkv', 'C:\\Users\\me\\Videos', '2026-10-18T12:00:00Z'),
    file('2026-10-19 21-00-00.mkv', 'C:\\Users\\me\\Videos', '2026-10-19T13:00:00Z'),
    file('clip.mp4', 'D:\\Recordings', '2026-10-01T00:00:00Z'),
  ]

  it('sorts newest first', () => {
    expect(filterWatchFolderFiles(files, '').map(f => f.name)).toEqual(['2026-10-19 21-00-00.mkv', '2026-10-18 20-00-00.mkv', 'clip.mp4'])
  })

  it('matches name or folder, ignoring case', () => {
    expect(filterWatchFolderFiles(files, 'CLIP').map(f => f.name)).toEqual(['clip.mp4'])
    expect(filterWatchFolderFiles(files, 'recordings').map(f => f.name)).toEqual(['clip.mp4'])
    expect(filterWatchFolderFiles(files, '10-18')).toHaveLength(1)
  })

  it('does not mutate the input', () => {
    filterWatchFolderFiles(files, '')
    expect(files[0]!.name).toBe('2026-10-18 20-00-00.mkv')
  })
})

describe('folder paths', () => {
  it('normalizes pasted paths', () => {
    expect(normalizeFolderInput('  "C:\\Users\\me\\Videos"  ')).toBe('C:\\Users\\me\\Videos')
    expect(normalizeFolderInput('C:\\Users\\me\\Videos\\')).toBe('C:\\Users\\me\\Videos')
    expect(normalizeFolderInput('C:\\')).toBe('C:\\')
    expect(normalizeFolderInput('/home/me/videos/')).toBe('/home/me/videos')
    expect(normalizeFolderInput('/')).toBe('/')
  })

  it('detects absolute paths', () => {
    expect(isAbsoluteFolderPath('C:\\Users\\me')).toBe(true)
    expect(isAbsoluteFolderPath('d:/obs')).toBe(true)
    expect(isAbsoluteFolderPath('\\\\nas\\videos')).toBe(true)
    expect(isAbsoluteFolderPath('/home/me')).toBe(true)
    expect(isAbsoluteFolderPath('Videos')).toBe(false)
    expect(isAbsoluteFolderPath('C:Videos')).toBe(false)
  })

  it('compares folders loosely', () => {
    expect(sameFolderPath('C:\\Users\\Me\\Videos', 'c:/users/me/videos/')).toBe(true)
    expect(sameFolderPath('C:\\A', 'C:\\B')).toBe(false)
  })

  it('validates new folder input', () => {
    expect(validateFolderInput('  ', [])).toBe('請輸入資料夾路徑')
    expect(validateFolderInput('Videos', [])).toContain('完整的資料夾路徑')
    expect(validateFolderInput('C:\\Videos\\', ['c:\\videos'])).toBe('這個資料夾已經在清單裡了')
    expect(validateFolderInput('"C:\\Videos"', [])).toBeNull()
  })
})
