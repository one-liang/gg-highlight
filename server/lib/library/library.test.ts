import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppConfig, clipsDir, isInside, loadConfig, uploadsDir, videoWorkDir } from '../config'
import type { YoutubeMeta } from '../../../shared/types/domain'
import type { VideoRecord } from '../db'
import {
  cleanupOrphanDownloads, cleanupOrphanUploads, deleteInsideDataDir, downloadsDir, isInWatchFolders, listDownloadFiles,
  listWatchFolderFiles, ownedPaths, pathKey, removeVideoFiles, resolveUpload, saveUpload, toSourceVideo, VIDEO_EXTENSIONS,
} from './index'

let root: string
let config: AppConfig

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-library-'))
  config = { ...loadConfig({}, root), dataDir: path.join(root, 'data') }
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(file: string, content: string | Buffer = 'x', mtime?: Date): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mtime) fs.utimesSync(file, mtime, mtime)
  return file
}

function record(overrides: Partial<VideoRecord> = {}): VideoRecord {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    title: 'video',
    sourceKind: 'watch-folder',
    filePath: path.join(root, 'recordings', 'a.mkv'),
    youtubeUrl: null,
    youtube: null,
    language: 'zh',
    audioTrack: 0,
    media: null,
    analysis: { status: 'done', mode: 'full', version: 2, signals: null, step: null, progress: 1, error: null, startedAt: null, finishedAt: null },
    previewPath: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

describe('pathKey', () => {
  it('folds case and separators on Windows only', () => {
    expect(pathKey('C:\\Rec\\Clip.MP4', 'win32')).toBe(pathKey('c:/rec/./clip.mp4', 'win32'))
    expect(pathKey('/rec/Clip.MP4', 'linux')).not.toBe(pathKey('/rec/clip.mp4', 'linux'))
    expect(pathKey('/rec/./x/../Clip.mp4', 'linux')).toBe('/rec/Clip.mp4')
  })
})

describe('listWatchFolderFiles', () => {
  it('lists video files directly inside each folder, newest first', async () => {
    const a = path.join(root, 'obs')
    const b = path.join(root, 'phone')
    write(path.join(a, 'old.mp4'), '12345', daysAgo(3))
    write(path.join(a, 'NEW.MKV'), 'abc', daysAgo(1))
    write(path.join(a, 'notes.txt'), 'x', daysAgo(0))
    write(path.join(a, 'clip.mp4.part'), 'x', daysAgo(0))
    write(path.join(a, 'sub', 'nested.mp4'), 'x', daysAgo(0))
    fs.mkdirSync(path.join(a, 'folder.mp4'))
    write(path.join(b, 'middle.webm'), 'xy', daysAgo(2))

    const files = await listWatchFolderFiles([a, b], new Set())
    expect(files.map(f => f.name)).toEqual(['NEW.MKV', 'middle.webm', 'old.mp4'])
    expect(files[0]).toEqual({
      path: path.join(a, 'NEW.MKV'),
      name: 'NEW.MKV',
      folder: a,
      sizeBytes: 3,
      modifiedAt: fs.statSync(path.join(a, 'NEW.MKV')).mtime.toISOString(),
      inLibrary: false,
    })
    expect(files[1]!.folder).toBe(b)
  })

  it('marks files already in the Library using normalised paths', async () => {
    const a = path.join(root, 'obs')
    write(path.join(a, 'one.mp4'))
    write(path.join(a, 'two.mp4'))
    const files = await listWatchFolderFiles([a], new Set([path.join(a, 'sub', '..', 'one.mp4')]))
    expect(Object.fromEntries(files.map(f => [f.name, f.inLibrary]))).toEqual({ 'one.mp4': true, 'two.mp4': false })
  })

  it('skips missing, unusable and duplicate folders', async () => {
    const a = path.join(root, 'obs')
    write(path.join(a, 'one.mp4'))
    const notAFolder = write(path.join(root, 'file.mp4'))
    const files = await listWatchFolderFiles([path.join(root, 'missing'), notAFolder, '', 'relative', a, `${a}${path.sep}`], new Set())
    expect(files.map(f => f.path)).toEqual([path.join(a, 'one.mp4')])
  })

  it('follows symlinked files', async () => {
    const a = path.join(root, 'obs')
    const target = write(path.join(root, 'elsewhere', 'real.mp4'))
    fs.mkdirSync(a, { recursive: true })
    try {
      fs.symlinkSync(target, path.join(a, 'link.mp4'))
    }
    catch {
      return // symlinks need privileges on Windows
    }
    const files = await listWatchFolderFiles([a], new Set())
    expect(files.map(f => f.name)).toEqual(['link.mp4'])
  })

  it('returns nothing without folders', async () => {
    expect(await listWatchFolderFiles([], new Set())).toEqual([])
  })
})

describe('isInWatchFolders', () => {
  const folder = () => path.join(root, 'obs')

  it('accepts video files inside a folder', () => {
    expect(isInWatchFolders([folder()], path.join(folder(), 'a.mp4'))).toBe(true)
    expect(isInWatchFolders([path.join(root, 'other'), folder()], path.join(folder(), 'A.MKV'))).toBe(true)
    expect(isInWatchFolders([folder()], path.join(folder(), 'sub', 'a.webm'))).toBe(true)
    for (const ext of VIDEO_EXTENSIONS) expect(isInWatchFolders([folder()], path.join(folder(), `x${ext}`))).toBe(true)
  })

  it('rejects other extensions, outside paths and traversal', () => {
    expect(isInWatchFolders([folder()], path.join(folder(), 'a.txt'))).toBe(false)
    expect(isInWatchFolders([folder()], path.join(folder(), 'a.mp4.part'))).toBe(false)
    expect(isInWatchFolders([folder()], path.join(folder(), 'noext'))).toBe(false)
    expect(isInWatchFolders([folder()], path.join(root, 'a.mp4'))).toBe(false)
    expect(isInWatchFolders([folder()], `${folder()}${path.sep}..${path.sep}a.mp4`)).toBe(false)
    expect(isInWatchFolders([folder()], `${folder()}${path.sep}sub${path.sep}..${path.sep}..${path.sep}x${path.sep}a.mp4`)).toBe(false)
    expect(isInWatchFolders([folder()], `${folder()}-evil${path.sep}a.mp4`)).toBe(false)
    expect(isInWatchFolders([folder()], 'a.mp4')).toBe(false)
    expect(isInWatchFolders([], path.join(folder(), 'a.mp4'))).toBe(false)
  })

  it('ignores blank and relative folders instead of treating them as the cwd', () => {
    const inCwd = path.join(process.cwd(), 'a.mp4')
    expect(isInWatchFolders(['', '  ', '.'], inCwd)).toBe(false)
  })

  it('treats a folder named like a video as the folder, not a file inside it', () => {
    const odd = path.join(root, 'odd.mp4')
    expect(isInWatchFolders([odd], odd)).toBe(false)
  })
})

describe('uploads', () => {
  it('streams the body into uploads/<id><ext> with a sidecar', async () => {
    const content = Buffer.alloc(256 * 1024, 7)
    const saved = await saveUpload(config, '我的 錄影.MP4', Readable.from([content.subarray(0, 1000), content.subarray(1000)]))
    expect(saved.uploadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(saved.fileName).toBe('我的 錄影.MP4')
    expect(saved.filePath).toBe(path.join(uploadsDir(config), `${saved.uploadId}.mp4`))
    expect(fs.readFileSync(saved.filePath).equals(content)).toBe(true)
    const sidecar = JSON.parse(fs.readFileSync(path.join(uploadsDir(config), `${saved.uploadId}.json`), 'utf8'))
    expect(sidecar).toEqual({ fileName: '我的 錄影.MP4', createdAt: expect.any(String) })
    expect(fs.readdirSync(uploadsDir(config)).sort()).toEqual([`${saved.uploadId}.json`, `${saved.uploadId}.mp4`].sort())

    expect(await resolveUpload(config, saved.uploadId)).toEqual({ filePath: saved.filePath, fileName: '我的 錄影.MP4' })
  })

  it('keeps only the base name of the original file name', async () => {
    const saved = await saveUpload(config, 'C:\\fakepath\\..\\clip.mkv', Readable.from([Buffer.from('x')]))
    expect(saved.fileName).toBe('clip.mkv')
    expect(path.dirname(saved.filePath)).toBe(uploadsDir(config))
  })

  it('rejects unsupported extensions without writing anything', async () => {
    for (const name of ['notes.txt', 'archive.mp4.zip', 'noext', '', '../evil.json']) {
      await expect(saveUpload(config, name, Readable.from([Buffer.from('x')]))).rejects.toThrow('不支援的檔案格式')
    }
    expect(fs.existsSync(uploadsDir(config))).toBe(false)
  })

  it('removes the partial file when the stream fails', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.alloc(1024))
        this.destroy(new Error('connection reset'))
      },
    })
    await expect(saveUpload(config, 'a.mp4', body)).rejects.toThrow('connection reset')
    expect(fs.readdirSync(uploadsDir(config))).toEqual([])
  })

  it('resolves only valid, known upload ids', async () => {
    const saved = await saveUpload(config, 'a.mov', Readable.from([Buffer.from('x')]))
    // Files a traversal id would point at if ids were trusted.
    write(path.join(config.dataDir, 'secret.json'), JSON.stringify({ fileName: 'x.mp4' }))
    write(path.join(config.dataDir, 'secret.mp4'))
    for (const id of ['../secret', `${saved.uploadId}/../../secret`, '..', '', saved.uploadId.toUpperCase(), `${saved.uploadId}.mov`, `${saved.uploadId} `]) {
      expect(await resolveUpload(config, id)).toBeNull()
    }
    expect(await resolveUpload(config, '00000000-0000-4000-8000-000000000000')).toBeNull()

    fs.rmSync(saved.filePath)
    expect(await resolveUpload(config, saved.uploadId)).toBeNull()
  })

  it('returns null for a corrupt sidecar', async () => {
    const saved = await saveUpload(config, 'a.mp4', Readable.from([Buffer.from('x')]))
    fs.writeFileSync(path.join(uploadsDir(config), `${saved.uploadId}.json`), '{oops')
    expect(await resolveUpload(config, saved.uploadId)).toBeNull()
  })
})

describe('cleanupOrphanUploads', () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

  it('removes old unreferenced uploads, their sidecars and stale partial files', async () => {
    const dir = uploadsDir(config)
    const referencedOld = write(path.join(dir, `${id(1)}.mp4`), 'x', daysAgo(5))
    write(path.join(dir, `${id(1)}.json`), '{}', daysAgo(5))
    const orphanOld = write(path.join(dir, `${id(2)}.mkv`), 'x', daysAgo(5))
    const orphanOldSidecar = write(path.join(dir, `${id(2)}.json`), '{}', daysAgo(5))
    const orphanFresh = write(path.join(dir, `${id(3)}.mp4`))
    const orphanFreshSidecar = write(path.join(dir, `${id(3)}.json`), '{}')
    const stalePart = write(path.join(dir, `${id(4)}.mp4.part`), 'x', daysAgo(5))
    const freshPart = write(path.join(dir, `${id(5)}.mp4.part`))
    const freshPartSidecar = write(path.join(dir, `${id(5)}.json`), '{}', daysAgo(5))
    const lonelySidecar = write(path.join(dir, `${id(6)}.json`), '{}', daysAgo(5))
    const unrelated = write(path.join(dir, 'readme.txt'), 'x', daysAgo(5))
    const unrelatedVideo = write(path.join(dir, 'not-an-upload.mp4'), 'x', daysAgo(5))

    const referenced = new Set([path.join(dir, 'sub', '..', `${id(1)}.mp4`)])
    expect(await cleanupOrphanUploads(config, referenced, 86_400_000)).toBe(2)

    for (const kept of [referencedOld, orphanFresh, orphanFreshSidecar, freshPart, freshPartSidecar, unrelated, unrelatedVideo, path.join(dir, `${id(1)}.json`)]) {
      expect(fs.existsSync(kept), kept).toBe(true)
    }
    for (const gone of [orphanOld, orphanOldSidecar, stalePart, lonelySidecar]) {
      expect(fs.existsSync(gone), gone).toBe(false)
    }
  })

  it('treats a zero threshold as "any age"', async () => {
    const dir = uploadsDir(config)
    write(path.join(dir, `${id(1)}.mp4`))
    expect(await cleanupOrphanUploads(config, new Set(), 0)).toBe(1)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('returns 0 when there is no uploads folder', async () => {
    expect(await cleanupOrphanUploads(config, new Set(), 0)).toBe(0)
  })
})

describe('ownedPaths', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const uploadId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  function expectInsideDataDir(paths: string[]) {
    for (const p of paths) {
      expect(isInside(config.dataDir, p)).toBe(true)
      expect(path.resolve(p)).not.toBe(path.resolve(config.dataDir))
    }
  }

  it('watch-folder: only the work and clips folders', () => {
    const paths = ownedPaths(config, record({ id }))
    expect(paths).toEqual([videoWorkDir(config, id), clipsDir(config, id)])
    expectInsideDataDir(paths)
  })

  it('upload: also the uploaded copy and its sidecar', () => {
    const file = path.join(uploadsDir(config), `${uploadId}.mp4`)
    const paths = ownedPaths(config, record({ id, sourceKind: 'upload', filePath: file }))
    expect(paths).toEqual([videoWorkDir(config, id), clipsDir(config, id), file, path.join(uploadsDir(config), `${uploadId}.json`)])
    expectInsideDataDir(paths)
  })

  it('youtube: also the download, when there is one', () => {
    const file = path.join(downloadsDir(config), `${id}.mp4`)
    expect(ownedPaths(config, record({ id, sourceKind: 'youtube', filePath: file })))
      .toEqual([videoWorkDir(config, id), clipsDir(config, id), file])
    expect(ownedPaths(config, record({ id, sourceKind: 'youtube', filePath: null })))
      .toEqual([videoWorkDir(config, id), clipsDir(config, id)])
  })

  it('never claims files outside their own data folder', () => {
    const outside = path.join(root, 'recordings', 'a.mp4')
    const base = [videoWorkDir(config, id), clipsDir(config, id)]
    expect(ownedPaths(config, record({ id, sourceKind: 'upload', filePath: outside }))).toEqual(base)
    expect(ownedPaths(config, record({ id, sourceKind: 'youtube', filePath: outside }))).toEqual(base)
    // Right kind of file, wrong folder.
    expect(ownedPaths(config, record({ id, sourceKind: 'youtube', filePath: path.join(uploadsDir(config), `${uploadId}.mp4`) }))).toEqual(base)
    expect(ownedPaths(config, record({ id, sourceKind: 'upload', filePath: path.join(downloadsDir(config), 'x.mp4') }))).toEqual(base)
    // Traversal out of uploads.
    const sneaky = `${uploadsDir(config)}${path.sep}..${path.sep}..${path.sep}recordings${path.sep}a.mp4`
    expect(ownedPaths(config, record({ id, sourceKind: 'upload', filePath: sneaky }))).toEqual(base)
    // The uploads folder itself.
    expect(ownedPaths(config, record({ id, sourceKind: 'upload', filePath: uploadsDir(config) }))).toEqual(base)
  })

  it('drops the per-video folders for unsafe ids', () => {
    for (const bad of ['..', '.', '', '../..', `x${path.sep}..${path.sep}..`, '/etc']) {
      const paths = ownedPaths(config, record({ id: bad }))
      expect(paths).toEqual([])
    }
  })

  it('never includes a watch-folder original, even inside dataDir', () => {
    const inData = path.join(config.dataDir, 'recordings', 'a.mp4')
    expect(ownedPaths(config, record({ id, filePath: inData }))).toEqual([videoWorkDir(config, id), clipsDir(config, id)])
    const inUploads = path.join(uploadsDir(config), `${uploadId}.mp4`)
    expect(ownedPaths(config, record({ id, filePath: inUploads }))).toEqual([videoWorkDir(config, id), clipsDir(config, id)])
    const inWorkDir = path.join(videoWorkDir(config, id), 'original.mp4')
    expect(ownedPaths(config, record({ id, filePath: inWorkDir }))).toEqual([clipsDir(config, id)])
  })
})

describe('removeVideoFiles', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const otherId = '99999999-2222-4333-8444-555555555555'

  function populate(videoId: string) {
    write(path.join(videoWorkDir(config, videoId), 'audio.wav'))
    write(path.join(videoWorkDir(config, videoId), 'preview.mp4'))
    write(path.join(clipsDir(config, videoId), 'c.mp4'))
    write(path.join(clipsDir(config, videoId), 'c.srt'))
  }

  it('deletes the work folder, clips folder and the uploaded copy only', async () => {
    const saved = await saveUpload(config, 'a.mp4', Readable.from([Buffer.from('x')]))
    const other = await saveUpload(config, 'b.mp4', Readable.from([Buffer.from('y')]))
    populate(id)
    populate(otherId)

    await removeVideoFiles(config, record({ id, sourceKind: 'upload', filePath: saved.filePath }))
    expect(fs.existsSync(videoWorkDir(config, id))).toBe(false)
    expect(fs.existsSync(clipsDir(config, id))).toBe(false)
    expect(fs.existsSync(saved.filePath)).toBe(false)
    expect(await resolveUpload(config, saved.uploadId)).toBeNull()
    expect(fs.existsSync(path.join(uploadsDir(config), `${saved.uploadId}.json`))).toBe(false)

    expect(fs.existsSync(path.join(videoWorkDir(config, otherId), 'preview.mp4'))).toBe(true)
    expect(fs.existsSync(path.join(clipsDir(config, otherId), 'c.mp4'))).toBe(true)
    expect(await resolveUpload(config, other.uploadId)).not.toBeNull()
    expect(fs.existsSync(uploadsDir(config))).toBe(true)
  })

  it('deletes a YouTube download', async () => {
    const file = write(path.join(downloadsDir(config), `${id}.webm`))
    populate(id)
    await removeVideoFiles(config, record({ id, sourceKind: 'youtube', filePath: file }))
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(downloadsDir(config))).toBe(true)
  })

  it('never deletes Watch Folder originals, even when they sit inside dataDir', async () => {
    const cases = [
      { id: '00000000-0000-4000-8000-000000000001', filePath: write(path.join(root, 'recordings', 'a.mkv')) },
      { id: '00000000-0000-4000-8000-000000000002', filePath: write(path.join(config.dataDir, 'recordings', 'b.mkv')) },
      { id: '00000000-0000-4000-8000-000000000003', filePath: write(path.join(uploadsDir(config), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4')) },
      { id, filePath: write(path.join(videoWorkDir(config, id), 'c.mkv')) },
    ]
    for (const c of cases) populate(c.id)

    for (const c of cases) {
      await removeVideoFiles(config, record({ id: c.id, sourceKind: 'watch-folder', filePath: c.filePath }))
      expect(fs.existsSync(c.filePath), c.filePath).toBe(true)
      expect(fs.existsSync(clipsDir(config, c.id))).toBe(false)
    }
    expect(fs.existsSync(path.join(videoWorkDir(config, cases[0]!.id)))).toBe(false)
    // The work folder holding the original is kept whole.
    expect(fs.existsSync(path.join(videoWorkDir(config, id), 'preview.mp4'))).toBe(true)
  })

  it('leaves files outside dataDir alone even if the record claims ownership', async () => {
    const outside = write(path.join(root, 'recordings', 'a.mp4'))
    await removeVideoFiles(config, record({ id, sourceKind: 'upload', filePath: outside }))
    await removeVideoFiles(config, record({ id, sourceKind: 'youtube', filePath: outside }))
    await removeVideoFiles(config, record({ id: '..', sourceKind: 'upload', filePath: outside }))
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync(root)).toBe(true)
  })

  it('is idempotent when the files are already gone', async () => {
    await removeVideoFiles(config, record({ id }))
    await removeVideoFiles(config, record({ id, sourceKind: 'upload', filePath: path.join(uploadsDir(config), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4') }))
  })

  it('refuses paths outside dataDir (and dataDir itself) before deleting anything', async () => {
    const inside = write(path.join(config.dataDir, 'videos', id, 'x'))
    const outside = write(path.join(root, 'outside.txt'))
    await expect(deleteInsideDataDir(config, [path.dirname(inside), outside])).rejects.toThrow('拒絕刪除')
    await expect(deleteInsideDataDir(config, [path.dirname(inside), config.dataDir])).rejects.toThrow('拒絕刪除')
    await expect(deleteInsideDataDir(config, [`${config.dataDir}${path.sep}..${path.sep}outside.txt`])).rejects.toThrow('拒絕刪除')
    expect(fs.existsSync(inside)).toBe(true)
    expect(fs.existsSync(outside)).toBe(true)
  })
})

describe('YouTube downloads', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const otherId = '99999999-2222-4333-8444-555555555555'
  const dl = (name: string) => path.join(downloadsDir(config), name)
  /** What yt-dlp leaves behind for a video: partial streams, fragments, resume info, chat replay. */
  const partials = (videoId: string) => [
    `${videoId}.f137.mp4.part`, `${videoId}.f137.mp4.part-Frag3`, `${videoId}.f251.webm`, `${videoId}.mp4.ytdl`,
    `${videoId}.temp.mp4`, `${videoId}.live_chat.json.part`,
  ]
  const sorted = (paths: string[]) => [...paths].sort()

  it('lists every <id>.* file of the video, and nothing else', async () => {
    const mine = [`${id}.mp4`, `${id}.live_chat.json`, ...partials(id)].map(name => write(dl(name)))
    write(dl(`${otherId}.mp4`))
    write(dl(`${id}-x.mp4`))
    write(dl(id))
    write(dl('readme.txt'))
    write(path.join(dl(`${id}.folder`), 'inside.mp4'))
    expect(sorted(await listDownloadFiles(config, id))).toEqual(sorted(mine))
  })

  it('lists nothing for unsafe ids or without a downloads folder', async () => {
    expect(await listDownloadFiles(config, id)).toEqual([])
    write(dl('.mp4'))
    write(dl('...mp4'))
    for (const bad of ['', '.', '..', `..${path.sep}x`]) expect(await listDownloadFiles(config, bad), bad).toEqual([])
  })

  it('removal deletes the partial download while filePath is still null', async () => {
    const mine = partials(id).map(name => write(dl(name)))
    const others = [`${otherId}.mp4`, `${otherId}.f137.mp4.part`, 'readme.txt'].map(name => write(dl(name)))
    const folder = write(path.join(dl(`${id}.folder`), 'inside.mp4'))
    write(path.join(videoWorkDir(config, id), 'audio.wav'))

    await removeVideoFiles(config, record({ id, sourceKind: 'youtube', filePath: null }))
    for (const gone of mine) expect(fs.existsSync(gone), gone).toBe(false)
    for (const kept of [...others, folder]) expect(fs.existsSync(kept), kept).toBe(true)
    expect(fs.existsSync(videoWorkDir(config, id))).toBe(false)
    expect(fs.existsSync(downloadsDir(config))).toBe(true)
  })

  it('removal deletes the download and the chat replay', async () => {
    const file = write(dl(`${id}.mp4`))
    const chat = write(dl(`${id}.live_chat.json`))
    await removeVideoFiles(config, record({ id, sourceKind: 'youtube', filePath: file }))
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(chat)).toBe(false)
  })

  it('removal of a local video never deletes files from downloads', async () => {
    const original = write(dl(`${id}.mkv`))
    const named = write(dl(`${id}.mp4`))
    await removeVideoFiles(config, record({ id, sourceKind: 'watch-folder', filePath: original }))
    const uploaded = await saveUpload(config, 'a.mp4', Readable.from([Buffer.from('x')]))
    await removeVideoFiles(config, record({ id, sourceKind: 'upload', filePath: uploaded.filePath }))
    expect(fs.existsSync(original)).toBe(true)
    expect(fs.existsSync(named)).toBe(true)
  })

  it('removal ignores a YouTube download path outside the downloads folder', async () => {
    const outside = write(path.join(root, 'recordings', `${id}.mp4`))
    await removeVideoFiles(config, record({ id, sourceKind: 'youtube', filePath: outside }))
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('cleans up files of unknown video ids at startup, and nothing else', async () => {
    const known = [`${id}.mp4`, `${id}.live_chat.json`, ...partials(id)].map(name => write(dl(name)))
    const orphans = [`${otherId}.mp4`, `${otherId}.live_chat.json`, ...partials(otherId)].map(name => write(dl(name)))
    const unrelated = [
      'readme.txt', 'abc.mp4', '.hidden', otherId, 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE.mp4', `x${otherId}.mp4`,
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-extra.mp4',
    ].map(name => write(dl(name)))
    const folder = write(path.join(dl(`${otherId}.folder`), 'inside.mp4'))
    const elsewhere = write(path.join(uploadsDir(config), `${otherId}.mp4`))

    expect(await cleanupOrphanDownloads(config, new Set([id]))).toBe(orphans.length)
    for (const gone of orphans) expect(fs.existsSync(gone), gone).toBe(false)
    for (const kept of [...known, ...unrelated, folder, elsewhere]) expect(fs.existsSync(kept), kept).toBe(true)

    // Any iterable of ids works; nothing left to do.
    expect(await cleanupOrphanDownloads(config, [id])).toBe(0)
  })

  it('cleans up nothing without a downloads folder', async () => {
    expect(await cleanupOrphanDownloads(config, [])).toBe(0)
  })
})

describe('toSourceVideo', () => {
  it('keeps the YouTube metadata', async () => {
    const youtube: YoutubeMeta = {
      id: 'dQw4w9WgXcQ', channel: '頻道', durationSec: 60, liveStatus: 'not_live', uploadDate: null, chatAvailable: false, heatmapAvailable: true,
    }
    const video = await toSourceVideo(record({ sourceKind: 'youtube', filePath: null, youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', youtube }))
    expect(video).toMatchObject({ youtube, fileMissing: false, filePath: null })
  })

  it('checks the file on disk and drops previewPath', async () => {
    const file = write(path.join(root, 'recordings', 'a.mkv'))
    const present = await toSourceVideo(record({ filePath: file, previewPath: '/x/preview.mp4' }))
    expect(present.fileMissing).toBe(false)
    expect(present).not.toHaveProperty('previewPath')
    expect(present).toMatchObject({ id: record().id, title: 'video', sourceKind: 'watch-folder', filePath: file })

    expect((await toSourceVideo(record({ filePath: path.join(root, 'gone.mkv') }))).fileMissing).toBe(true)
    expect((await toSourceVideo(record({ sourceKind: 'youtube', filePath: null }))).fileMissing).toBe(false)
  })
})
