/**
 * Slash commands, prompt templates and skills — ROADMAP P5.
 *
 * A *prompt template* is a markdown file with optional frontmatter (`name`,
 * `description`) whose body becomes the prompt. Placeholders: `$ARGUMENTS` (all
 * args) and `$1`…`$9` (positional). A *skill* is the same shape but is injected
 * into the system prompt rather than turned into a user message. Both are plain
 * files so users can add their own without touching code.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export interface PromptTemplate {
  name: string
  description?: string
  body: string
}

export interface Skill {
  name: string
  description?: string
  body: string
  file: string
}

/** Split an optional `---` frontmatter block from the markdown body. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { meta, body: match[2]! }
}

export function parsePromptTemplate(text: string, fallbackName: string): PromptTemplate {
  const { meta, body } = parseFrontmatter(text)
  const template: PromptTemplate = { name: meta.name || fallbackName, body: body.trim() }
  if (meta.description) template.description = meta.description
  return template
}

export function parseSkill(text: string, fallbackName: string, file = ''): Skill {
  const { meta, body } = parseFrontmatter(text)
  const skill: Skill = { name: meta.name || fallbackName, body: body.trim(), file }
  if (meta.description) skill.description = meta.description
  return skill
}

/** Load `*.md` prompt templates from a directory (missing dir → none). */
export function loadPromptTemplates(dir: string): PromptTemplate[] {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  return files
    .sort()
    .map((f) => parsePromptTemplate(readFileSync(path.join(dir, f), 'utf8'), f.replace(/\.md$/, '')))
}

/** Load skills from `skills/<name>/SKILL.md` or `skills/<name>.md` (missing dir → none). */
export function loadSkills(dir: string): Skill[] {
  let entries: string[] = []
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return []
  }
  const skills: Skill[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry)
    const skillFile = path.join(full, 'SKILL.md')
    if (existsSync(skillFile)) {
      skills.push(parseSkill(readFileSync(skillFile, 'utf8'), entry, skillFile))
    } else if (entry.endsWith('.md')) {
      skills.push(parseSkill(readFileSync(full, 'utf8'), entry.replace(/\.md$/, ''), full))
    }
  }
  return skills
}

/** Expand `$ARGUMENTS` / `$1`…`$9`; append args when there is no placeholder. */
export function expandTemplate(template: PromptTemplate, args: string[]): string {
  const positional = (n: number): string => args[n - 1] ?? ''
  let out = template.body
    .replace(/\$ARGUMENTS/g, args.join(' '))
    .replace(/\$([1-9])/g, (_, n: string) => positional(Number(n)))
  if (!/\$ARGUMENTS|\$[1-9]/.test(template.body) && args.length) {
    out = (out + '\n\n' + args.join(' ')).trim()
  }
  return out
}

/** Render skills as a system-prompt appendix. */
export function skillsToPrompt(skills: Skill[]): string {
  if (!skills.length) return ''
  const blocks = skills.map((s) => `### Skill: ${s.name}\n${s.body}`)
  return ['', 'You have the following skills available:', ...blocks].join('\n')
}
