import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

const accountFile = z.string().regex(/^workbuddy-[0-9A-Za-z_.-]{1,120}\.json$/)

export const managerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('health') }),
  z.object({ action: z.literal('overview') }),
  z.object({ action: z.literal('bridge') }),
  z.object({ action: z.literal('authStart'), realm: z.enum(['cn', 'global']) }),
  z.object({ action: z.literal('authPoll') }),
  z.object({ action: z.literal('authDesktop'), realm: z.enum(['cn', 'global']) }),
  z.object({ action: z.literal('authKey'), realm: z.enum(['cn', 'global']), key: z.string().min(1).max(512), nickname: z.string().max(120).optional() }),
  z.object({ action: z.literal('accountDisabled'), file: accountFile, disabled: z.boolean() }),
  z.object({ action: z.literal('accountDelete'), file: accountFile }),
  z.object({ action: z.literal('accountRefresh'), file: accountFile.optional() }),
  z.object({ action: z.literal('accountCheckin'), file: accountFile.optional() }),
  z.object({ action: z.literal('gatewayOptions'), freeOnly: z.boolean().optional(), hideDsh: z.boolean().optional() }),
])
export type ManagerRequest = z.infer<typeof managerRequest>

const inputCodec = { mode: 'strict' as const, typeSymbol: 'dsh-workbuddy-manager#workbuddy/manage:request', create: () => managerRequest }
const outputCodec = { mode: 'strict' as const, typeSymbol: 'dsh-workbuddy-manager#workbuddy/manage:result', create: () => z.json() }

/** This explicit descriptor is shared by the host registry and browser Remote. */
export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: 'dsh-workbuddy-manager',
  methods: {
    'workbuddy/manage': {
      service: 'workbuddyManager',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', source: 'json', codec: inputCodec, strictCodec: inputCodec }],
      result: outputCodec,
    },
  },
}, z)

export const TYPERT = {
  package: 'dsh-workbuddy-manager',
  face: 'host',
  schemas: [],
  get invocations() { return TYPERT_REMOTE.descriptors },
  model: { services: [{ key: 'workbuddyManager', exportName: 'ManagerRemote', tags: [], members: [], types: [] }], events: [], objects: [] },
}
