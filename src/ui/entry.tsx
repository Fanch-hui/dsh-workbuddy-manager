import { WorkbuddyPanel } from './panel.js'
import type { Remote } from './connection.js'

export const inject = ['slots', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings']

interface ClientContext {
  remote: Remote
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: { name: string; id: string; order: number; label: () => string; inject: () => { remote: Remote } }, component: typeof WorkbuddyPanel): unknown
  }
}

export function apply(ctx: ClientContext) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'workbuddy-manager',
    order: 15,
    label: () => 'WorkBuddy',
    inject: () => ({ remote: ctx.remote }),
  }, WorkbuddyPanel))
}
