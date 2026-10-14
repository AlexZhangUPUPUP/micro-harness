import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  expandTemplate,
  loadPromptTemplates,
  loadSkills,
  parsePromptTemplate,
  parseSkill,
  skillsToPrompt,
} from '../src/commands.ts'

function sandbox(): string {
  return mkdtempSync(path.join(tmpdir(), 'mh-cmd-'))
}

test('parses frontmatter, description and body for a prompt template', () => {
  const t = parsePromptTemplate('---\nname: review\ndescription: review a diff\n---\nReview $ARGUMENTS carefully.\n', 'fallback')
  expect(t.name).toBe('review')
  expect(t.description).toBe('review a diff')
  expect(t.body).toBe('Review $ARGUMENTS carefully.')
})

test('expands $ARGUMENTS, positional args, and appends when no placeholder', () => {
  expect(expandTemplate({ name: 't', body: 'fix $1 then $2' }, ['a', 'b'])).toBe('fix a then b')
  expect(expandTemplate({ name: 't', body: 'do $ARGUMENTS' }, ['a', 'b'])).toBe('do a b')
  expect(expandTemplate({ name: 't', body: 'plain body' }, ['extra'])).toBe('plain body\n\nextra')
  expect(expandTemplate({ name: 't', body: 'plain body' }, [])).toBe('plain body')
})

test('loads templates from a directory and skills from SKILL.md files', () => {
  const dir = sandbox()
  try {
    mkdirSync(path.join(dir, 'prompts'))
    writeFileSync(path.join(dir, 'prompts', 'ship.md'), '---\ndescription: ship it\n---\nShip it now')
    const templates = loadPromptTemplates(path.join(dir, 'prompts'))
    expect(templates.map((t) => t.name)).toEqual(['ship'])
    expect(templates[0]!.description).toBe('ship it')

    mkdirSync(path.join(dir, 'skills', 'pdf'), { recursive: true })
    writeFileSync(path.join(dir, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: read pdfs\n---\nUse pdftotext.')
    writeFileSync(path.join(dir, 'skills', 'notes.md'), 'Plain notes skill')
    const skills = loadSkills(path.join(dir, 'skills'))
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['notes', 'pdf'])
    expect(skillsToPrompt(skills)).toContain('### Skill: pdf')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseSkill keeps the file path and description', () => {
  const s = parseSkill('---\ndescription: d\n---\nbody', 'x', '/tmp/x/SKILL.md')
  expect(s.name).toBe('x')
  expect(s.description).toBe('d')
  expect(s.file).toBe('/tmp/x/SKILL.md')
})

test('missing directories yield empty lists', () => {
  expect(loadPromptTemplates('/definitely/not/here')).toEqual([])
  expect(loadSkills('/definitely/not/here')).toEqual([])
})
