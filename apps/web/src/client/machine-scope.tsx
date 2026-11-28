import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext } from 'react'
import * as sameOriginApi from '../api'
import { type CottaApi, createCottaApi } from '../api'
import type { CottaTransport } from './transport'

/**
 * Everything a view needs to talk to one machine: its API bound to one transport, and its own query cache. Views inside
 * a scope never see another machine's responses — two scopes can show the same project path or session id side by
 * side, and a slow response always lands in the cache of the machine that was asked.
 */
export type MachineScope = {
  machineId: string
  api: CottaApi
  /** Absent only for the page's own daemon, which uses the application-wide cache. */
  queryClient?: QueryClient
}

/**
 * The page's own daemon (same origin) — the only machine the transitional web app talks to. It is the context default so
 * the single-machine app needs no wrapper; any view for another machine must be mounted inside a `MachineScopeProvider`.
 */
export const SAME_ORIGIN_MACHINE_ID = 'same-origin'
const sameOriginScope: MachineScope = { machineId: SAME_ORIGIN_MACHINE_ID, api: sameOriginApi }

const MachineScopeContext = createContext<MachineScope>(sameOriginScope)

export function createMachineScope(machineId: string, transport: CottaTransport): Required<MachineScope> {
  return { machineId, api: createCottaApi(transport), queryClient: new QueryClient() }
}

export function MachineScopeProvider({ scope, children }: { scope: MachineScope; children: ReactNode }) {
  const content = <MachineScopeContext.Provider value={scope}>{children}</MachineScopeContext.Provider>
  return scope.queryClient ? <QueryClientProvider client={scope.queryClient}>{content}</QueryClientProvider> : content
}

export function useMachineScope(): MachineScope {
  return useContext(MachineScopeContext)
}

/** The API of the machine this view belongs to. */
export function useMachineApi(): CottaApi {
  return useContext(MachineScopeContext).api
}
