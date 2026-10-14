/**
 * @micro-harness/kernel — the plugin kernel.
 *
 * Implements the design in ARCHITECTURE.md §3: a Context with services + dependency
 * injection, plugin lifecycle (activate/waiting/failed/dispose), scoped isolation
 * (`fork` / `isolate`) and a typed event bus.
 *
 * This file is the public surface; the implementation lands in P1 (see ROADMAP.md).
 */

export const KERNEL_VERSION = '0.1.0'

export interface Disposable {
  dispose(): void | Promise<void>
}

/** Placeholder — replaced by the real implementation in P1. */
export type { Disposable as KernelDisposable }
