import type { InjectionKey, Ref, ShallowRef } from 'vue'

/**
 * State of the preview <video> on the video page, shared with the timeline,
 * highlight list and transcript through provide/inject (so the 60 fps time
 * updates never re-render components that don't read them).
 */
export interface Player {
  currentTime: Ref<number>
  playing: Ref<boolean>
  /** Set while "播放" plays a range; playback pauses here. */
  stopAt: Ref<number | null>
  /** Id of whatever started the range playback (a Highlight id). */
  rangeOwner: Ref<string | null>
  mediaError: Ref<string | null>
  ready: Ref<boolean>
  seek: (time: number) => void
  play: () => void
  pause: () => void
  toggle: () => void
  /** Plays from `start`; pauses at `end` unless `stopAtEnd` is false. */
  playRange: (start: number, end: number, owner?: string | null, stopAtEnd?: boolean) => void
  stopRange: () => void
  handlers: {
    onPlay: () => void
    onPause: () => void
    onTimeupdate: () => void
    onSeeked: () => void
    onLoadedmetadata: () => void
    onError: () => void
  }
}

const PLAYER_KEY: InjectionKey<Player> = Symbol('player')

const MEDIA_ERRORS: Record<number, string> = {
  1: '播放被中止',
  2: '讀取影片時發生網路錯誤',
  3: '瀏覽器無法解碼這支影片',
  4: '找不到可以播放的影片，或瀏覽器不支援這個格式',
}

export function createPlayer(el: Readonly<ShallowRef<HTMLVideoElement | null>>): Player {
  const currentTime = ref(0)
  const playing = ref(false)
  const stopAt = ref<number | null>(null)
  const rangeOwner = ref<string | null>(null)
  const mediaError = ref<string | null>(null)
  const ready = ref(false)
  let raf = 0
  let rangeStart = 0
  let rangeEnd = 0

  function sync() {
    const v = el.value
    if (!v) return
    currentTime.value = v.currentTime
    if (stopAt.value !== null && v.currentTime >= stopAt.value) {
      v.pause()
      stopRange()
    }
    else if (rangeOwner.value !== null && v.currentTime > rangeEnd + 0.25) {
      rangeOwner.value = null
    }
  }

  function loop() {
    sync()
    const v = el.value
    raf = v && !v.paused ? requestAnimationFrame(loop) : 0
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  function seek(time: number) {
    const t = Math.max(0, time)
    currentTime.value = t
    const v = el.value
    if (v) v.currentTime = t
  }

  function play() {
    el.value?.play().catch(() => {})
  }

  function pause() {
    el.value?.pause()
  }

  function stopRange() {
    stopAt.value = null
    rangeOwner.value = null
  }

  function toggle() {
    const v = el.value
    if (!v) return
    if (v.paused) play()
    else pause()
  }

  function playRange(start: number, end: number, owner: string | null = null, stopAtEnd = true) {
    rangeStart = start
    rangeEnd = end
    seek(start)
    stopAt.value = stopAtEnd ? end : null
    rangeOwner.value = owner
    play()
  }

  const handlers = {
    onPlay() {
      playing.value = true
      stopLoop()
      raf = requestAnimationFrame(loop)
    },
    onPause() {
      playing.value = false
      stopLoop()
      sync()
    },
    onTimeupdate() {
      if (!raf) sync()
    },
    onSeeked() {
      // seeking away from the range (native controls, timeline) ends range playback
      const t = el.value?.currentTime ?? currentTime.value
      if ((stopAt.value !== null || rangeOwner.value !== null) && (t < rangeStart - 0.25 || t > rangeEnd + 0.25)) stopRange()
      sync()
    },
    onLoadedmetadata() {
      ready.value = true
      mediaError.value = null
      sync()
    },
    onError() {
      const code = el.value?.error?.code ?? 0
      mediaError.value = MEDIA_ERRORS[code] ?? '無法播放這支影片'
    },
  }

  onScopeDispose(stopLoop)

  return { currentTime, playing, stopAt, rangeOwner, mediaError, ready, seek, play, pause, toggle, playRange, stopRange, handlers }
}

export function providePlayer(player: Player) {
  provide(PLAYER_KEY, player)
}

export function usePlayer(): Player {
  const player = inject(PLAYER_KEY, null)
  if (!player) throw new Error('usePlayer() needs providePlayer() in a parent component')
  return player
}
