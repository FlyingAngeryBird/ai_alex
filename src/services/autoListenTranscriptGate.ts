export type AutoListenTranscriptRejectionReason = 'empty' | 'filler' | 'too_short'

export type AutoListenTranscriptDecision =
  | {
      accepted: true
      text: string
    }
  | {
      accepted: false
      message: string
      reason: AutoListenTranscriptRejectionReason
      text: string
    }

export type AutoListenTranscriptGateOptions = {
  durationMs?: number
}

const USEFUL_SHORT_PHRASES = new Set([
  '不用',
  '不是',
  '下一首',
  '上一个',
  '上一首',
  '你好',
  '再见',
  '可以',
  '后退',
  '听歌',
  '在吗',
  '好的',
  '开始',
  '录音',
  '播放',
  '暂停',
  '继续',
  '返回',
  '退出',
  '停止',
  '取消',
  '是的',
  '灵粒'
])

const REJECTION_MESSAGE = '我听到一点声音，但不像完整的一句话。'

function compactTranscript(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s,.!?;:()[\]{}'"，。！？；：（）【】「」『』“”‘’、…~～·-]/g, '')
}

function countMeaningfulCharacters(text: string): number {
  return Array.from(text).filter((character) => /[a-z0-9\u3400-\u9fff]/i.test(character)).length
}

function isFiller(compactText: string): boolean {
  return /^(嗯+|恩+|啊+|呀+|呃+|额+|哦+|喔+|唔+|哈+|呵+|哎+|喂+|uh+|um+|ah+|oh+|hmm+)$/.test(compactText)
}

function reject(
  text: string,
  reason: AutoListenTranscriptRejectionReason
): AutoListenTranscriptDecision {
  return {
    accepted: false,
    message: REJECTION_MESSAGE,
    reason,
    text
  }
}

export function evaluateAutoListenTranscript(
  text: string,
  options: AutoListenTranscriptGateOptions = {}
): AutoListenTranscriptDecision {
  const normalizedText = text.trim()
  const compactText = compactTranscript(normalizedText)

  if (!compactText) {
    return reject(normalizedText, 'empty')
  }

  if (isFiller(compactText)) {
    return reject(normalizedText, 'filler')
  }

  if (USEFUL_SHORT_PHRASES.has(compactText)) {
    return {
      accepted: true,
      text: normalizedText
    }
  }

  const meaningfulCharacters = countMeaningfulCharacters(compactText)

  if (meaningfulCharacters < 2) {
    return reject(normalizedText, 'too_short')
  }

  if ((options.durationMs ?? Number.POSITIVE_INFINITY) < 450 && meaningfulCharacters < 4) {
    return reject(normalizedText, 'too_short')
  }

  return {
    accepted: true,
    text: normalizedText
  }
}
