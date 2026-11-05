import { TYPERT_REMOTE } from '../manager/contract.js'
import { WorkbuddyPanel } from './panel.js'
import type { AppRemote } from './management.js'

export const inject = ['slots', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings']

interface ClientContext {
  remote: AppRemote & { $mount(contribution: typeof TYPERT_REMOTE): Promise<() => Promise<void>> }
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: { name: string; id: string; order: number; label: () => string; inject: () => { remote: AppRemote } }, component: typeof WorkbuddyPanel): unknown
  }
  inject(names: string[], register: (context: ClientContext) => void): PromiseLike<void> & { dispose(): Promise<void> }
}

export async function apply(ctx: ClientContext) {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  const ui = ctx.inject(['remote.workbuddy', 'slots', 'remote.credentials', 'remote.llm', 'remote.settings'], (context) => {
    context.slots.inject('settings.section', () => context.slots.register({
      name: 'settings.section',
      id: 'workbuddy-manager',
      order: 15,
      label: () => 'WorkBuddy',
      inject: () => ({ remote: context.remote }),
    }, WorkbuddyPanel))
  })
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmount()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmount()
  }
}
