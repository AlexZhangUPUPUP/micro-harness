// @ts-nocheck — ported verbatim from PiStudio (worktree.js/merge.js); logic unchanged.
'use strict';

/**
 * Git worktree isolation for PiStudio task agents.
 *
 * Each task agent runs inside its own git worktree so that parallel agents in
 * the same task cannot clobber each other's files. A worktree is a full
 * checkout of HEAD in a throwaway directory under ~/.pistudio/worktrees; the
 * agent's changes are captured as a patch and can be promoted back into the
 * task's working tree.
 *
 * Pure helpers — no project imports, only node's child_process/fs/path/os.
 *
 * Every git call is guarded and forced to LC_ALL=C so the output stays
 * parseable regardless of the user's locale. Buffers are generous and the
 * diff returned to callers is capped at ~20 MB.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MAX_BUFFER = 64 * 1024 * 1024; // generous: large/binary diffs
const PATCH_CAP = 20 * 1024 * 1024; // patches handed back to callers are capped

// git output is localised (e.g. "错误" vs "error"); force English for parsing.
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

/** Run git and return stdout as a Buffer. Throws (with .stdout/.stderr) on failure. */
function gitBuf(args, opts = {}) {
  return execFileSync('git', args, {
    env: GIT_ENV,
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

/** Run git and return stdout as utf8 text. */
function gitText(args, opts = {}) {
  return gitBuf(args, opts).toString('utf8');
}

/** Human-readable, single-line message for a git failure. */
function describe(err) {
  if (!err) return 'unknown git error';
  const stderr = err && err.stderr ? String(err.stderr).trim() : '';
  const line = stderr.split('\n').find((l) => l.trim());
  if (line) return line.trim();
  const msg = String((err && err.message) || err);
  return msg.replace(/^Command failed:.*?\n/, '').trim().split('\n')[0] || 'git command failed';
}

/** True when cwd is inside a git work tree that has a commit to branch from. */
function isGitRepo(cwd) {
  try {
    gitBuf(['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    return false;
  }
  try {
    gitBuf(['-C', cwd, 'rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Top level of the repository containing cwd (the common/main root). */
function repoRoot(cwd) {
  return gitText(['-C', cwd, 'rev-parse', '--show-toplevel']).trim();
}

/** Short sha1 of a string, via git hash-object (falls back to a djb2 hex). */
function shortHash(text) {
  try {
    const out = execFileSync('git', ['hash-object', '--stdin'], {
      env: GIT_ENV,
      maxBuffer: MAX_BUFFER,
      input: String(text),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString('utf8')
      .trim();
    if (out) return out.slice(0, 12);
  } catch {
    /* fall through to the pure-js fallback */
  }
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Filesystem/branch safe segment. */
function safeSeg(s) {
  const t = String(s || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return t || '_';
}

/**
 * Create a git worktree for one task agent.
 *
 *   git -C <root> worktree add -b pistudio/<taskId>/<agentId> <path> HEAD
 *
 * Returns { path, branch, base } where base is the HEAD sha before the add.
 * Throws a clear Error when the repo cannot branch (no commit, dirty failure,
 * path already exists, …) so the caller can fall back to the task cwd.
 */
function createWorktree({ cwd, taskId, agentId }) {
  const root = repoRoot(cwd);
  const base = gitText(['-C', root, 'rev-parse', 'HEAD']).trim();
  const branch = `pistudio/${safeSeg(taskId)}/${safeSeg(agentId)}`;
  const dirName =
    (path.basename(root) || 'repo').replace(/[^A-Za-z0-9._-]/g, '_') + '-' + shortHash(root);
  const dir = path.join(os.homedir(), '.pistudio', 'worktrees', dirName, safeSeg(taskId), safeSeg(agentId));
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  } catch {
    /* git worktree add will report a clearer error if it cannot create the dir */
  }
  gitBuf(['-C', root, 'worktree', 'add', '-b', branch, dir, 'HEAD']);
  return { path: dir, branch, base };
}

/**
 * Stage everything in a worktree and return the staged changes as
 * [{ path, add, del, status }]. numstat supplies add/del (null for binary);
 * status --porcelain supplies the two-letter code (trimmed).
 */
function changedFiles(wt) {
  gitBuf(['-C', wt, 'add', '-A']);
  const numstat = gitText(['-C', wt, 'diff', '--cached', '--numstat', 'HEAD']);
  const status = gitText(['-C', wt, 'status', '--porcelain=v1']);

  const codeByPath = new Map();
  for (const line of status.split('\n')) {
    if (!line || line.length < 4) continue;
    const code = line.slice(0, 2).trim();
    let f = line.slice(3);
    if (code === 'R' || code === 'C') {
      const arrow = f.indexOf(' -> ');
      if (arrow !== -1) f = f.slice(arrow + 4);
    }
    if (f) codeByPath.set(f, code);
  }

  const files = [];
  for (const line of numstat.split('\n')) {
    if (!line) continue;
    const [a, d, ...rest] = line.split('\t');
    const f = rest.join('\t');
    if (!f) continue;
    files.push({
      path: f,
      add: a === '-' ? null : Number(a) || 0,
      del: d === '-' ? null : Number(d) || 0,
      status: codeByPath.get(f) || null,
    });
  }
  // Anything visible to status but absent from numstat (should not happen after
  // `git add -A`, but keep the list complete regardless).
  for (const [f, code] of codeByPath) {
    if (!files.some((x) => x.path === f)) files.push({ path: f, add: null, del: null, status: code });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Diff a worktree against its base. Stages first (git add -A), then reports
 * per-file add/del/status plus the cached binary patch, capped at ~20 MB.
 */
function worktreeDiff({ path: wt }) {
  const files = changedFiles(wt);
  const raw = gitBuf(['-C', wt, 'diff', '--cached', '--binary', 'HEAD']);
  const diff =
    raw.length > PATCH_CAP ? raw.subarray(0, PATCH_CAP).toString('utf8') : raw.toString('utf8');
  return { files, diff };
}

/** Apply a patch to cwd. Returns { ok, stdout, stderr, error }. */
function applyPatch(cwd, patch, threeWay) {
  const args = ['-C', cwd, 'apply'];
  if (threeWay) args.push('--3way');
  args.push('--binary', '-');
  try {
    gitBuf(args, { input: patch });
    return { ok: true, stdout: '', stderr: '', error: null };
  } catch (err) {
    return {
      ok: false,
      stdout: err && err.stdout ? err.stdout.toString('utf8') : '',
      stderr: err && err.stderr ? err.stderr.toString('utf8') : '',
      error: describe(err),
    };
  }
}

/** Unstage paths so a --3way apply (which implies --index) leaves no index residue. */
function unstage(cwd, paths) {
  if (!paths.length) return;
  try {
    gitBuf(['-C', cwd, 'reset', '-q', '--', ...paths]);
  } catch {
    /* best effort */
  }
}

/** Extract cleanly-applied and conflicted path names from git apply output. */
function parseApplyOutput(text) {
  const clean = new Set();
  const conflicted = new Set();
  let m;
  const reClean = /Applied patch to '([^']+)' cleanly\./g;
  const reConflict = /Applied patch to '([^']+)' with conflicts\./g;
  while ((m = reClean.exec(text))) clean.add(m[1]);
  while ((m = reConflict.exec(text))) conflicted.add(m[1]);
  for (const line of text.split('\n')) {
    if (/^U\s+\S/.test(line)) {
      const f = line.replace(/^U\s+/, '').trim();
      if (f) conflicted.add(f);
      continue;
    }
    let mm = line.match(/^error: (.+?): (?:patch does not apply|already exists in (?:working directory|index)|does not exist in index)\s*$/);
    if (mm) {
      conflicted.add(mm[1]);
      continue;
    }
    mm = line.match(/^error: patch failed: (.+?):\d+\s*$/);
    if (mm) conflicted.add(mm[1]);
  }
  return { clean, conflicted };
}

/**
 * Promote a worktree's staged changes back into cwd.
 *
 * Feeds `git diff --cached --binary HEAD` into `git apply --3way --binary -`,
 * retrying with a plain `git apply --binary -` on failure. Returns
 * { ok, applied, conflicts, error } — on a failed apply the failure output is
 * parsed for the file names involved.
 */
function promote({ worktree, cwd }) {
  let files;
  try {
    files = changedFiles(worktree);
  } catch (err) {
    return { ok: false, applied: [], conflicts: [], error: describe(err) };
  }
  const paths = files.map((f) => f.path);

  let patch;
  try {
    patch = gitBuf(['-C', worktree, 'diff', '--cached', '--binary', 'HEAD']);
  } catch (err) {
    return { ok: false, applied: [], conflicts: [], error: describe(err) };
  }

  const first = applyPatch(cwd, patch, true);
  if (first.ok) {
    // `--3way` implies --index, so unstage to leave only working-tree changes.
    unstage(cwd, paths);
    return { ok: true, applied: paths, conflicts: [], error: null };
  }

  const second = applyPatch(cwd, patch, false);
  if (second.ok) {
    return { ok: true, applied: paths, conflicts: [], error: null };
  }

  const parsed = parseApplyOutput([first.stdout, first.stderr, second.stdout, second.stderr].join('\n'));
  unstage(cwd, [...parsed.clean]);
  return {
    ok: false,
    applied: [...parsed.clean],
    conflicts: [...parsed.conflicted],
    error: second.error || first.error || 'apply failed',
  };
}

/**
 * Remove a worktree and its branch (best effort, never throws):
 *   git -C <root> worktree remove --force <path>
 *   git -C <root> branch -D <branch>
 *   git -C <root> worktree prune
 */
function removeWorktree({ cwd, path: wt, branch }) {
  let root = null;
  try {
    root = repoRoot(cwd);
  } catch {
    /* repo already gone — nothing to clean */
  }
  if (root && wt) {
    try {
      gitBuf(['-C', root, 'worktree', 'remove', '--force', wt]);
    } catch {}
  }
  if (root && branch) {
    try {
      gitBuf(['-C', root, 'branch', '-D', branch]);
    } catch {}
  }
  if (root) {
    try {
      gitBuf(['-C', root, 'worktree', 'prune']);
    } catch {}
  }
  // `git worktree remove` leaves the now-empty parent dirs behind; tidy them.
  const base = path.join(os.homedir(), '.pistudio', 'worktrees');
  let dir = wt ? path.resolve(wt) : null;
  while (dir && dir !== base && dir.startsWith(base + path.sep)) {
    try {
      fs.rmdirSync(dir);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') break; // not empty / other error — stop
    }
    dir = path.dirname(dir);
  }
}

export {
  isGitRepo,
  repoRoot,
  createWorktree,
  worktreeDiff,
  promote,
  removeWorktree,
};
