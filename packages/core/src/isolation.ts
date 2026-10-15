/**
 * Workspace isolation + merge queue — ROADMAP P7.
 *
 * Ported from PiStudio's proven `worktree.js` / `merge.js` (their logic is
 * unchanged; this file is just a typed facade plus the pieces the runner and the
 * server need).
 *
 *   createWorktree  → each agent gets its own git worktree + branch
 *   worktreeDiff    → what one agent changed
 *   promoteWorktree → apply one agent's changes to the shared workspace
 *   integrate*      → the merge queue: merge every agent in one pass, auto-solving
 *                     the clean parts and aggregating conflicts for review
 */

import * as merge from './merge.ts'
import * as worktree from './worktree.ts'

export interface Worktree {
  path: string
  branch: string
  base: string
}

export interface DiffFile {
  path: string
  add: number
  del: number
  status: string
}

export interface WorktreeDiff {
  files: DiffFile[]
  diff: string
}

export interface PromoteResult {
  ok: boolean
  applied: string[]
  conflicts: string[]
  error?: string | null
}

export interface IntegrateBlock {
  type: 'text' | 'conflict'
  text?: string
  ours?: string
  base?: string
  theirs?: string
}

export interface IntegrateFile {
  path: string
  status: string
  clean: boolean
  content?: string
  blocks?: IntegrateBlock[]
  agents: string[]
  pending: string[]
  binary?: boolean
  skipped?: boolean
  delete?: boolean
}

export interface IntegratePreview {
  base?: string
  files: IntegrateFile[]
}

export interface IntegrateAgent {
  agentId: string
  worktree: string
  base: string
}

export const isGitRepo = (cwd: string): boolean => worktree.isGitRepo(cwd) as boolean

export const repoRoot = (cwd: string): string => worktree.repoRoot(cwd) as string

export const createWorktree = (opts: { cwd: string; taskId: string; agentId: string }): Worktree =>
  worktree.createWorktree(opts) as Worktree

export const worktreeDiff = (path: string): WorktreeDiff => worktree.worktreeDiff({ path }) as WorktreeDiff

/** Apply one agent's changes to the shared workspace (worktree is its path). */
export const promoteWorktree = (opts: { worktree: string; cwd: string }): PromoteResult =>
  worktree.promote(opts) as PromoteResult

export const removeWorktree = (opts: { cwd: string; path: string; branch: string }): void =>
  worktree.removeWorktree(opts) as void

export const integratePreview = (opts: { cwd: string; agents: IntegrateAgent[] }): IntegratePreview =>
  merge.integratePreview(opts) as IntegratePreview

export const integrateApply = (opts: {
  cwd: string
  worktrees: Record<string, string>
  files: Array<{ path: string; content?: string; delete?: boolean; takeTheirs?: boolean; agentId?: string }>
}): { applied: string[]; backup?: string } => merge.integrateApply(opts) as { applied: string[]; backup?: string }
