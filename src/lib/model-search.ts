import type { ModelOption } from './models'

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
export function filterModels(models: ModelOption[], query: string) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean)
  return models.filter(m => terms.every(term => normalize(`${m.provider} ${m.name} ${m.id} ${m.free ? 'gratis free' : 'plan pago'}`).includes(term)))
}
