import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const exports = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/speech-text.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports })
const { speechText, createSpeechFilter } = exports

test('voice skips unknown-speaker markers without changing actual questions', () => {
  assert.equal(speechText('**???**: "It’s over..."'), '"It’s over..."')
  assert.equal(speechText('**???**: "Goddess..."\nLos ??? son habitantes.'), '"Goddess..." Los son habitantes.')
  assert.equal(speechText('¿Qué pasó? Why? ¿De verdad??? Sí.'), '¿Qué pasó? Why? ¿De verdad Sí.')
  assert.equal(speechText('???'), '')
})

test('voice removes Markdown separators and arrows instead of naming symbols', () => {
  const text = speechText('## Claves\n\n---\n**wielder** → empuñar; grant -> otorgar.\n- Uno\n2. Dos\n| A | B |\n| --- | :---: |')
  assert.equal(text, 'Claves wielder , empuñar; grant , otorgar. Uno Dos , A , B')
  assert.doesNotMatch(text, /---|\*|→|->|\|/)
})
test('voice preserves meaningful negative numbers, hyphenated words and arithmetic', () => {
  assert.equal(speechText('-5 y −5; never-ending; 10 - 3 = 7.'), '-5 y −5; never-ending; 10 - 3 = 7.')
  assert.equal(speechText('[documentación](https://example.com) y `código`.'), 'documentación y código.')
})
test('fenced code never reaches voice, even with delimiters split at every token boundary', () => {
  const input = 'Antes.\n```js\nconsole.log("No leer. ");\n```\nDespués.\n~~~py\nprint("Tampoco")\n~~~\nFin.'
  const filter = createSpeechFilter()
  const result = [...input].map(c => filter.push(c)).join('') + filter.end()
  assert.equal(speechText(result), 'Antes. Después. Fin.')
  const other = createSpeechFilter()
  assert.equal(speechText(other.push('Inline `x` y texto. Un bloque ```no terminado') + other.end()), 'Inline x y texto. Un bloque')
})
