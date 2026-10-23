/** Presentation syntax is not speech. Keep real words, numbers and operators. */
export function speechText(text: string): string {
  return text
    .replace(/^\s*Sources?:.*$/gim, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s]*[^\s.,;:!?)\]]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '')
    .replace(/-{3,}|_{3,}|\*{3,}/g, ' ')
    .replace(/^\s*(?:[-+•]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+)/gm, '')
    .replace(/(?:<[-=]+>|[-=]+>|<[-=]+|[\u2190-\u21ff\u27f0-\u27ff\u2900-\u297f➔➜➞])/g, ', ')
    .replace(/[|]/g, ', ')
    .replace(/[*_`~#]/g, '')
    // Unknown-speaker labels and repeated question marks are visual notation.
    // Leave ordinary questions (¿Qué pasó?) intact for the voice's intonation.
    .replace(/[?¿]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
    .trim()
}

/** Remove fenced code BEFORE sentence splitting; delimiters may span tokens.
 * Inline code remains speakable. No answer-wide buffering or extra network hop. */
export function createSpeechFilter() {
  let fence = ''
  let run = ''
  const flush = () => {
    const marker = run
    run = ''
    if (marker.length >= 3) {
      if (!fence) fence = marker[0]
      else if (fence === marker[0]) fence = ''
      return ' '
    }
    return fence ? '' : marker
  }
  return {
    push(text: string) {
      let out = ''
      for (const char of text) {
        if (char === '`' || char === '~') {
          if (run && run[0] !== char) out += flush()
          run += char
        } else {
          if (run) out += flush()
          if (!fence) out += char
        }
      }
      return out
    },
    end: () => flush(),
  }
}
