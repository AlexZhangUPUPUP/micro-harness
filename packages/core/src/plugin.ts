/**
 * core as a kernel plugin — ARCHITECTURE.md §1 ("core runs on the kernel").
 *
 * Provides the services the rest of the platform consumes:
 *   - `tools`     : the tool registry (array of Tool)
 *   - `providers` : the model registry (register/get/list)
 *
 * The loop itself stays a plain class (`Harness`) so it can be used without the
 * kernel; mounting it as a plugin is how the server and CLI get to it.
 */

import type { Plugin } from '@micro-harness/kernel'
import { makeTools, type Tool } from './tools.ts'
import type { Provider } from './provider.ts'
import { DEFAULT_ROLE, createAgentRegistry, loadAgentRoles, type AgentRegistry, type AgentRole } from './agents.ts'

export interface ProviderRegistry {
  register(name: string, provider: Provider): void
  get(name: string): Provider
  has(name: string): boolean
  list(): string[]
}

export interface CoreConfig {
  tools?: Tool[]
  providers?: Record<string, Provider>
}

export function createProviderRegistry(initial?: Record<string, Provider>): ProviderRegistry {
  const providers = new Map<string, Provider>(Object.entries(initial ?? {}))
  return {
    register(name, provider) {
      providers.set(name, provider)
    },
    get(name) {
      const p = providers.get(name)
      if (!p) throw new Error(`provider not found: ${name}`)
      return p
    },
    has(name) {
      return providers.has(name)
    },
    list() {
      return [...providers.keys()]
    },
  }
}

/** Mount the harness core on a kernel context. */
export const corePlugin: Plugin<CoreConfig> = {
  name: 'core',
  apply(ctx, config) {
    ctx.provide('tools', config?.tools ?? makeTools())
    ctx.provide('providers', createProviderRegistry(config?.providers))
  },
}

/** The `agents` service: a registry of agent roles for the `task` tool. */
export interface AgentsService {
  roles: AgentRegistry
  register(role: AgentRole): void
  get(name: string): AgentRole | undefined
  list(): string[]
}

export interface AgentsConfig {
  roles?: AgentRole[]
  /** Directory of `agents/*.md` role definitions (optional). */
  dir?: string
}

export function createAgentsService(roles: AgentRole[] = []): AgentsService {
  const registry = createAgentRegistry(roles)
  if (!registry.has(DEFAULT_ROLE.name)) registry.register(DEFAULT_ROLE)
  return {
    roles: registry,
    register: (role) => registry.register(role),
    get: (name) => registry.get(name),
    list: () => registry.list(),
  }
}

/** Mount the multi-agent role registry on a kernel context. */
export const agentsPlugin: Plugin<AgentsConfig> = {
  name: 'agents',
  apply(ctx, config) {
    const roles = [...(config?.roles ?? [])]
    if (config?.dir) roles.push(...loadAgentRoles(config.dir))
    ctx.provide('agents', createAgentsService(roles))
  },
}
