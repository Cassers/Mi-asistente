import { Fragment, type ReactNode } from 'react'

// Deliberately small Markdown subset. React escapes all source text; no HTML parser.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('*') && part.endsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      // Only web destinations. Model-produced javascript:, file: and data: stay text.
      if (/^https?:\/\//i.test(link[2])) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>
      return <Fragment key={i}>{link[1]}</Fragment>
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}

export function ResponseText({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      const marker = line.trim()[0]
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker.repeat(3))) code.push(lines[i++])
      i++
      blocks.push(<pre key={blocks.length}><code>{code.join('\n')}</code></pre>)
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push(<hr key={blocks.length} />); i++; continue }
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line)
    if (heading) { blocks.push(<h3 key={blocks.length}>{inline(heading[1])}</h3>); i++; continue }
    const list = /^\s*(?:[-+*]|\d+[.)])\s+/.exec(line)
    if (list) {
      const ordered = /^\s*\d/.test(line)
      const items: ReactNode[] = []
      const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-+*]\s+(.*)$/
      while (i < lines.length) {
        const item = pattern.exec(lines[i])
        if (!item) break
        items.push(<li key={items.length}>{inline(item[1])}</li>); i++
      }
      blocks.push(ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>)
      continue
    }
    const paragraph: string[] = [line.replace(/^\s*>\s?/, '')]
    i++
    while (i < lines.length && lines[i].trim() && !/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|`{3}|~{3}|-{3,}\s*$)/.test(lines[i])) paragraph.push(lines[i++].replace(/^\s*>\s?/, ''))
    blocks.push(<p key={blocks.length}>{paragraph.map((part, n) => <Fragment key={n}>{n > 0 && <br />}{inline(part)}</Fragment>)}</p>)
  }
  return <div className="response-text">{blocks}</div>
}
