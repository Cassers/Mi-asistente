type Question = { id: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] }
export function nativeQuestions(value: unknown): Question[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) return []
  const ids = new Set<string>()
  const questions: Question[] = []
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.question !== 'string') return []
    ids.add(item.id)
    const options = Array.isArray(item.options) ? item.options.filter((option: unknown): option is { label: string; description: string } =>
      !!option && typeof option === 'object' && 'label' in option && typeof option.label === 'string').map((option: { label: string; description?: string }) => ({ label: option.label, description: option.description || '' })) : []
    questions.push({ id: item.id, question: item.question, isOther: item.isOther === true, isSecret: item.isSecret === true, options })
  }
  return questions
}
