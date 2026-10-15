// @ts-nocheck — ported verbatim from PiStudio (worktree.js/merge.js); logic unchanged.
'use strict';

/**
 * Conflict-resolution preview/apply helpers for isolated task agents.
 *
 * mergePreview({ cwd, worktree, base }) builds a per-file 3-way merge between
 * the main working tree ("ours"), the worktree's base commit ("base") and the
 * agent's worktree ("theirs"), returning a parseable block list for every
 * conflicted file.
 *
 * mergeApply({ cwd, worktree, files }) writes resolved contents back into the
 * main working tree, backing up any overwritten file to
 * traces/merge-<stamp>/<path>. Text entries (`{ path, content }`) are written
 * as UTF-8; binary/skipped entries (`{ path, takeTheirs: true }`) copy raw
 * bytes from the agent's worktree.
 *
 * Pure helpers — no project imports, only node's child_process/fs/path/os.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MAX_BUFFER = 64 * 1024 * 1024; // generous: large diffs / file blobs
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than ~2 MB
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' }; // force parseable git output

/** Run git and return stdout as a Buffer. Throws (with .stdout/.stderr/.status) on failure. */
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

/** Resolve p inside root; return null when it escapes (absolute, `..`, …). */
function safeResolve(root, p) {
  const abs = path.resolve(root, String(p == null ? '' : p));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** Read a file, returning null when it is missing or larger than `cap`. */
function readCapped(abs, cap) {
  try {
    const st = fs.statSync(abs);
    if (st.size > cap) return null;
    return fs.readFileSync(abs);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Blob for `base:path` (empty when new); `tooLarge` when it exceeds the cap. */
function baseBlob(wt, base, p) {
  let size;
  try {
    size = Number(gitText(['-C', wt, 'cat-file', '-s', base + ':' + p]).trim());
  } catch {
    return { exists: false };
  }
  if (!Number.isFinite(size)) return { exists: false };
  if (size > MAX_FILE_BYTES) return { exists: true, tooLarge: true };
  return { exists: true, buf: gitBuf(['-C', wt, 'show', base + ':' + p]) };
}

/**
 * List files the worktree changed vs `base` (status letter + path).
 * `git add -A` first so brand-new (untracked) files show up in the diff.
 */
function changedPaths(worktree, base) {
  try {
    gitBuf(['-C', worktree, 'add', '-A']);
  } catch {
    /* best effort — a non-git worktree simply reports nothing */
  }
  const out = gitText(['-C', worktree, 'diff', '--name-status', base]);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const status = (parts[0] || '').trim();
    if (!status) continue;
    // Renames print `R100\told\tnew`; the current path is always the last field.
    const p = parts[parts.length - 1];
    if (!p) continue;
    files.push({ path: p, status });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Parse `git merge-file -p --diff3` output into blocks:
 *   { type: 'text', text } | { type: 'conflict', ours, base, theirs }
 * Markers are exactly 7 chars (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`).
 */
function parseDiff3(text) {
  const raw = String(text == null ? '' : text);
  const endsWithNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (endsWithNewline) lines.pop(); // drop the trailing empty line

  // lines[i] is newline-terminated iff it is not the very last line or the
  // whole output ended with a newline.
  const joinIdx = (idx) => {
    let out = '';
    for (let j = 0; j < idx.length; j += 1) {
      out += lines[idx[j]];
      if (idx[j] < lines.length - 1 || endsWithNewline) out += '\n';
    }
    return out;
  };
  const joinRange = (from, to) => {
    let out = '';
    for (let i = from; i <= to; i += 1) {
      out += lines[i];
      if (i < lines.length - 1 || endsWithNewline) out += '\n';
    }
    return out;
  };

  const blocks = [];
  let textFrom = 0;
  let cur = null; // { ours:[], base:[], theirs:[], mode }
  const flushText = (upto) => {
    if (upto > textFrom) blocks.push({ type: 'text', text: joinRange(textFrom, upto - 1) });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<')) {
      flushText(i);
      cur = { ours: [], base: [], theirs: [], mode: 'ours' };
    } else if (line.startsWith('|||||||')) {
      if (cur) cur.mode = 'base';
    } else if (line.startsWith('=======')) {
      if (cur) cur.mode = 'theirs';
    } else if (line.startsWith('>>>>>>>')) {
      if (cur) {
        blocks.push({
          type: 'conflict',
          ours: joinIdx(cur.ours),
          base: joinIdx(cur.base),
          theirs: joinIdx(cur.theirs),
        });
        cur = null;
        textFrom = i + 1;
      }
    } else if (cur) {
      cur[cur.mode].push(i);
    }
    // otherwise: a plain text line, covered by the [textFrom, …) range
  }
  flushText(lines.length);
  return blocks;
}

/**
 * 3-way merge preview between the main working tree and an agent's worktree.
 *
 * Returns { files: [{ path, status, conflict, blocks?, content?, binary?, skipped? }] }.
 * `content` carries the merged text for non-conflicted files; conflicted files
 * carry `blocks` instead.
 */
function mergePreview({ cwd, worktree, base }) {
  if (!worktree) throw new Error('worktree is required');
  if (!base) throw new Error('base is required');
  const root = path.resolve(cwd);
  const wt = path.resolve(worktree);

  const entries = changedPaths(wt, base);
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pistudio-merge-'));
  const files = [];
  try {
    for (const entry of entries) {
      const file = { path: entry.path, status: entry.status, conflict: false };

      const absOurs = safeResolve(root, entry.path);
      const absTheirs = safeResolve(wt, entry.path);
      if (!absOurs || !absTheirs) {
        file.skipped = true;
        files.push(file);
        continue;
      }

      const baseInfo = baseBlob(wt, base, entry.path);
      if (baseInfo.tooLarge) {
        file.skipped = true;
        files.push(file);
        continue;
      }
      const baseBuf = baseInfo.exists ? baseInfo.buf : Buffer.alloc(0);

      const oursBuf = readCapped(absOurs, MAX_FILE_BYTES);
      const theirsBuf = readCapped(absTheirs, MAX_FILE_BYTES);
      if (oursBuf === null || theirsBuf === null) {
        file.skipped = true;
        files.push(file);
        continue;
      }

      if (oursBuf.includes(0) || baseBuf.includes(0) || theirsBuf.includes(0)) {
        file.binary = true;
        files.push(file);
        continue;
      }

      const ourFile = path.join(tmpdir, 'ours');
      const baseFile = path.join(tmpdir, 'base');
      const theirFile = path.join(tmpdir, 'theirs');
      fs.writeFileSync(ourFile, oursBuf);
      fs.writeFileSync(baseFile, baseBuf);
      fs.writeFileSync(theirFile, theirsBuf);

      let merged;
      let code;
      try {
        merged = gitBuf(['merge-file', '-p', '--diff3', '--marker-size=7', ourFile, baseFile, theirFile]);
        code = 0;
      } catch (err) {
        // exit 0 = clean, >0 = number of conflicts, <0 = error
        code = err && typeof err.status === 'number' ? err.status : -1;
        merged = err && err.stdout ? Buffer.from(err.stdout) : Buffer.alloc(0);
      }

      if (code < 0) {
        file.skipped = true;
        files.push(file);
        continue;
      }

      const text = merged.toString('utf8');
      if (code > 0) {
        file.conflict = true;
        file.blocks = parseDiff3(text);
      } else {
        file.conflict = false;
        file.content = text;
      }
      files.push(file);
    }
    return { files };
  } finally {
    try {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    } catch {
      /* temp files are best-effort; never mask the real result */
    }
  }
}

/** Refuse write targets that escape `root` through a symlink. */
function guardedTarget(root, abs) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }
  const inside = (r) => r === realRoot || r.startsWith(realRoot + path.sep);
  try {
    const r = fs.realpathSync(abs);
    if (!inside(r)) return null;
    return abs;
  } catch {
    // `abs` does not exist — walk up to the nearest existing ancestor.
    let dir = path.dirname(abs);
    for (;;) {
      try {
        const r = fs.realpathSync(dir);
        if (!inside(r)) return null;
        return abs;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    }
  }
}

/**
 * Write resolved files back into `cwd`, backing up overwritten files to
 * traces/merge-<stamp>/<path>. Returns { applied, backup } where `backup` is
 * the backup directory (or null when nothing needed backing up).
 */
function mergeApply({ cwd, worktree, files }) {
  const root = path.resolve(cwd);
  const wt = worktree ? path.resolve(worktree) : null;
  const list = Array.isArray(files) ? files : [];
  const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const backupDir = path.join(root, 'traces', 'merge-' + stamp);
  const applied = [];
  let madeBackup = false;

  for (const f of list) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    const abs = safeResolve(root, f.path);
    if (!abs) continue;
    const target = guardedTarget(root, abs);
    if (!target) continue;

    // Binary / previously-skipped files: copy raw bytes from the worktree.
    if (f.takeTheirs) {
      if (!wt) continue;
      const src = safeResolve(wt, f.path);
      if (!src) continue;
      try {
        if (fs.existsSync(target)) {
          const dest = path.join(backupDir, f.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(target, dest);
          madeBackup = true;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
        applied.push(f.path);
      } catch {
        /* skip this file on any failure */
      }
      continue;
    }

    const content = f.content == null ? '' : String(f.content);
    try {
      if (fs.existsSync(target)) {
        const dest = path.join(backupDir, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(target, dest);
        madeBackup = true;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      applied.push(f.path);
    } catch {
      /* skip this file on any failure */
    }
  }
  return { applied, backup: madeBackup ? backupDir : null };
}

/**
 * "Integrate all" preview: merge EVERY isolated agent's changes onto the
 * current working tree in one pass, without touching the working tree.
 *
 * agents = [{ agentId, worktree, base }]. For each path changed by any agent,
 * the contributing agents are merged in order via `git merge-file`;
 * non-conflicting parts auto-merge and the first conflict stops that path
 * (later agents are listed in `pending`). The working tree is only read.
 *
 * Returns
 *   { base, files: [{ path, status, clean, content?, blocks?, agents, pending,
 *                     binary?, skipped?, delete? }] }
 * where `base` is the first agent's base commit.
 */
function integratePreview({ cwd, agents }) {
  const list = Array.isArray(agents) ? agents.filter((a) => a && a.agentId != null && a.worktree && a.base) : [];
  if (!list.length) throw new Error('agents are required');
  const root = path.resolve(cwd);
  const base = list[0].base;

  // index agents by id for O(1) lookups (worktree resolved once, absolute)
  const byId = new Map();
  for (const a of list) {
    byId.set(String(a.agentId), { agentId: String(a.agentId), worktree: path.resolve(a.worktree), base: a.base });
  }

  // 1+2. union of paths, first-seen status, ordered contributing agents
  const byPath = new Map();
  for (const a of list) {
    const id = String(a.agentId);
    let entries;
    try {
      entries = changedPaths(a.worktree, a.base);
    } catch {
      continue; // a broken worktree simply contributes nothing
    }
    for (const entry of entries) {
      let rec = byPath.get(entry.path);
      if (!rec) {
        rec = { status: entry.status, agents: [] };
        byPath.set(entry.path, rec);
      }
      if (!rec.agents.includes(id)) rec.agents.push(id);
    }
  }

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pistudio-integrate-'));
  const files = [];
  try {
    for (const p of [...byPath.keys()].sort((x, y) => x.localeCompare(y))) {
      const rec = byPath.get(p);
      const file = { path: p, status: rec.status, clean: false, agents: rec.agents, pending: [] };

      // Path-gate: refuse anything that escapes cwd.
      const absOurs = safeResolve(root, p);
      if (!absOurs) {
        file.skipped = true;
        files.push(file);
        continue;
      }

      // `content` starts as the current file in cwd (empty when absent).
      let content;
      try {
        const st = fs.statSync(absOurs);
        if (st.size > MAX_FILE_BYTES) {
          file.skipped = true;
          files.push(file);
          continue;
        }
        content = fs.readFileSync(absOurs);
      } catch {
        content = Buffer.alloc(0);
      }

      // Gather each contributor's base + theirs, checking gates on the way.
      const contribs = [];
      let bad = false;
      for (const id of rec.agents) {
        const a = byId.get(id);
        const absTheirs = safeResolve(a.worktree, p);
        if (!absTheirs) {
          file.skipped = true;
          bad = true;
          break;
        }
        let theirs;
        let deleted = false;
        try {
          const st = fs.statSync(absTheirs);
          if (st.size > MAX_FILE_BYTES) {
            file.skipped = true;
            bad = true;
            break;
          }
          theirs = fs.readFileSync(absTheirs);
        } catch {
          theirs = Buffer.alloc(0);
          deleted = true;
        }
        const baseInfo = baseBlob(a.worktree, a.base, p);
        if (baseInfo.tooLarge) {
          file.skipped = true;
          bad = true;
          break;
        }
        const baseBuf = baseInfo.exists ? baseInfo.buf : Buffer.alloc(0);

        if (theirs.includes(0) || baseBuf.includes(0) || content.includes(0)) {
          file.binary = true;
          bad = true;
          break;
        }
        contribs.push({ id, baseBuf, theirs, deleted });
      }
      if (bad) {
        files.push(file);
        continue;
      }

      // 3. sequential 3-way merge onto the current content.
      let conflicted = false;
      for (let i = 0; i < contribs.length; i += 1) {
        const c = contribs[i];
        const ourFile = path.join(tmpdir, 'ours');
        const baseFile = path.join(tmpdir, 'base');
        const theirFile = path.join(tmpdir, 'theirs');
        fs.writeFileSync(ourFile, content);
        fs.writeFileSync(baseFile, c.baseBuf);
        fs.writeFileSync(theirFile, c.theirs);

        let merged;
        let code;
        try {
          merged = gitBuf(['merge-file', '-p', '--diff3', '--marker-size=7', ourFile, baseFile, theirFile]);
          code = 0;
        } catch (err) {
          // exit 0 = clean, >0 = number of conflicts, <0 = error
          code = err && typeof err.status === 'number' ? err.status : -1;
          merged = err && err.stdout ? Buffer.from(err.stdout) : Buffer.alloc(0);
        }

        if (code < 0) {
          file.skipped = true;
          files.push(file);
          break;
        }
        content = merged;
        if (code > 0) {
          conflicted = true;
          // The conflicting agent's change is NOT merged, and later agents
          // are skipped — both counts are "pending".
          file.pending = contribs.slice(i).map((x) => x.id);
          break;
        }
      }
      if (file.skipped) continue; // already pushed above

      if (conflicted) {
        file.blocks = parseDiff3(content.toString('utf8'));
      } else {
        file.clean = true;
        file.content = content.toString('utf8');
        // Deletion: merged result empty AND every contributing agent deleted it.
        if (content.length === 0 && contribs.length && contribs.every((c) => c.deleted)) {
          file.delete = true;
        }
      }
      files.push(file);
    }
    return { base, files };
  } finally {
    try {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    } catch {
      /* temp files are best-effort; never mask the real result */
    }
  }
}

/**
 * Apply an "integrate all" resolution back into cwd.
 *
 *   { path, content }              -> write text (UTF-8)
 *   { path, delete: true }         -> back up then unlink
 *   { path, takeTheirs, agentId }  -> copy raw bytes from that agent's
 *                                     worktree (missing source = delete)
 *
 * Every overwritten target is backed up to traces/integrate-<stamp>/<path>.
 * Returns { applied, backup } (backup is null when nothing needed backing up).
 */
function integrateApply({ cwd, worktrees, files }) {
  const root = path.resolve(cwd);
  const wts = worktrees && typeof worktrees === 'object' ? worktrees : {};
  const list = Array.isArray(files) ? files : [];
  const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const backupDir = path.join(root, 'traces', 'integrate-' + stamp);
  const applied = [];
  let madeBackup = false;

  for (const f of list) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    const abs = safeResolve(root, f.path);
    if (!abs) continue;
    const target = guardedTarget(root, abs);
    if (!target) continue;

    const backup = () => {
      try {
        if (fs.existsSync(target)) {
          const dest = path.join(backupDir, f.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(target, dest);
          madeBackup = true;
        }
      } catch {
        /* backup is best-effort */
      }
    };

    try {
      if (f.takeTheirs) {
        const wtRaw = wts[f.agentId];
        const wt = wtRaw ? path.resolve(String(wtRaw)) : null;
        if (!wt) continue;
        const src = safeResolve(wt, f.path);
        if (!src) continue;
        backup();
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(src, target);
        } else {
          try {
            fs.unlinkSync(target);
          } catch (err) {
            if (err && err.code !== 'ENOENT') throw err;
          }
        }
        applied.push(f.path);
        continue;
      }

      if (f.delete) {
        backup();
        try {
          fs.unlinkSync(target);
        } catch (err) {
          if (err && err.code !== 'ENOENT') throw err;
        }
        applied.push(f.path);
        continue;
      }

      const content = f.content == null ? '' : String(f.content);
      backup();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      applied.push(f.path);
    } catch {
      /* skip this file on any failure */
    }
  }
  return { applied, backup: madeBackup ? backupDir : null };
}

export { mergePreview, mergeApply, parseDiff3, integratePreview, integrateApply };
