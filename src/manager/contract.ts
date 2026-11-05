import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

const address = z.string().min(1).max(2048)
const accountFile = z.string().regex(/^workbuddy[0-9A-Za-z_-]{0,80}\.json(?:\.disabled)?$/)
const keyId = z.number().int().positive().safe()

export const managerRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('health'), address }),
  z.object({ action: z.literal('login'), address, username: z.string().trim().min(1).max(64), password: z.string().min(1).max(1024) }),
  z.object({ action: z.literal('logout'), address }),
  z.object({ action: z.literal('bridge'), address }),
  z.object({ action: z.literal('overview'), address }),
  z.object({ action: z.literal('accountDisabled'), address, file: accountFile, disabled: z.boolean() }),
  z.object({ action: z.literal('authStart'), address, realm: z.enum(['cn', 'global']), region: z.string().max(20) }),
  z.object({ action: z.literal('authPoll'), address }),
  z.object({ action: z.literal('createKey'), address, name: z.string().trim().min(1).max(64), realm: z.enum(['', 'cn', 'global']).optional() }),
  z.object({ action: z.literal('keyEnabled'), address, id: keyId, enabled: z.boolean() }),
  z.object({ action: z.literal('renameKey'), address, id: keyId, name: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal('useKey'), address, id: keyId, ref: z.string().regex(/^WORKBUDDY_MANAGER_KEY_[A-F0-9]{32}$/) }),
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
