import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MAX_PROJECT_INSTRUCTIONS,
  defaultSystemPrompt,
  projectInstructions,
  withProjectInstructions,
} from '../src/harness.ts'

test('AGENTS.md is appended to the default system prompt', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-agents-'))
  try {
    expect(defaultSystemPrompt(dir)).not.toContain('Project instructions')
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Run tests with `bun test`.\n')
    const prompt = defaultSystemPrompt(dir)
    expect(prompt).toContain('Project instructions (AGENTS.md; these override general defaults)')
    expect(prompt).toContain('Run tests with `bun test`.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a custom prompt gets the same instructions appended', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-agents-'))
  try {
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Prefer pnpm.')
    expect(withProjectInstructions('BASE', dir)).toBe(
      'BASE\n\nProject instructions (AGENTS.md; these override general defaults):\n\nPrefer pnpm.',
    )
    expect(withProjectInstructions('BASE', path.join(dir, 'missing'))).toBe('BASE')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('project instructions are capped so they cannot crowd out the task', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-agents-'))
  try {
    writeFileSync(path.join(dir, 'AGENTS.md'), 'x'.repeat(MAX_PROJECT_INSTRUCTIONS + 500))
    const text = projectInstructions(dir)
    expect(text.length).toBeLessThan(MAX_PROJECT_INSTRUCTIONS + 120)
    expect(text).toContain('truncated')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
