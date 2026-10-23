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

/** Pipes inside inline code or escaped as \| belong to the cell, not its border. */
function tableCells(line: string): string[] | null {
  const cells: string[] = []
  let cell = '', code = false, separated = false
  for (let n = 0; n < line.length; n++) {
    const char = line[n]
    if (char === '\\' && (line[n + 1] === '|' || line[n + 1] === '\\')) {
      cell += line[++n]; continue
    }
    if (char === '`') code = !code
    if (char === '|' && !code) { cells.push(cell.trim()); cell = ''; separated = true }
    else cell += char
  }
  if (!separated) return null
  cells.push(cell.trim())
  if (!cells[0] && line.trimStart().startsWith('|')) cells.shift()
  if (!cells[cells.length - 1] && line.trimEnd().endsWith('|')) cells.pop()
  return cells
}

export function ResponseText({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const tableAt = (at: number) => {
    const header = tableCells(lines[at] || '')
    const divider = tableCells(lines[at + 1] || '')
    if (!header?.length || !divider || header.length !== divider.length ||
      !divider.every(cell => /^:?-{3,}:?$/.test(cell))) return null
    const align = divider.map(cell => cell.endsWith(':')
      ? cell.startsWith(':') ? 'center' as const : 'right' as const : 'left' as const)
    return { header, align }
  }
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
    const table = tableAt(i)
    if (table) {
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim()) {
        const cells = tableCells(lines[i])
        // Malformed extra columns remain visible as text, never silently discarded.
        if (!cells || cells.length > table.header.length) break
        rows.push(cells); i++
      }
      blocks.push(<div className="response-table-scroll" role="region" aria-label="Tabla de la respuesta" tabIndex={0} key={blocks.length}>
        <table>
          <thead><tr>{table.header.map((cell, n) => <th scope="col" style={{ textAlign: table.align[n] }} key={n}>{inline(cell)}</th>)}</tr></thead>
          <tbody>{rows.map((cells, row) => <tr key={row}>{table.header.map((_, n) =>
            <td style={{ textAlign: table.align[n] }} key={n}>{inline(cells[n] || '')}</td>)}</tr>)}</tbody>
        </table>
      </div>)
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
    while (i < lines.length && lines[i].trim() && !tableAt(i) && !/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|`{3}|~{3}|-{3,}\s*$)/.test(lines[i])) paragraph.push(lines[i++].replace(/^\s*>\s?/, ''))
    blocks.push(<p key={blocks.length}>{paragraph.map((part, n) => <Fragment key={n}>{n > 0 && <br />}{inline(part)}</Fragment>)}</p>)
  }
  return <div className="response-text">{blocks}</div>
}
