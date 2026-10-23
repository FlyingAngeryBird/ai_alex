import type { LyricLine } from '@/types/app'

export function getCurrentLyricIndex(
  lines: LyricLine[] | undefined,
  positionMs: number
): number {
  if (!lines?.length) {
    return -1
  }

  let currentIndex = -1

  for (let index = 0; index < lines.length; index += 1) {
    if (positionMs < lines[index].timeMs) {
      break
    }

    currentIndex = index
  }

  return currentIndex
}
