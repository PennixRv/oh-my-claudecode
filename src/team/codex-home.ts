/**
 * Codex worker CODEX_HOME isolation — durable base + runtime mirror.
 *
 * Problem: OMC Codex workers share ~/.codex/ with the user's standalone Codex,
 *          causing config/hook/session/history pollution.
 * Solution: Two-layer physical isolation.
 *   - Durable base: persisted per-project, seeded once from main path + OMC assets.
 *     API credentials dynamically inherited via symlink (auth.json) and env vars.
 *   - Runtime mirror: per-worker temp HOME, deleted on shutdown.
 *
 * This module is called from three spawn paths:
 *   - runtime-v2.ts  spawnV2Worker
 *   - runtime.ts     spawnWorkerForTask
 *   - scaling.ts     scaleUp
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { getOmcRoot } from '../lib/worktree-paths.js';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Derive a stable project-id from the OMC root path. */
function projectId(omcRoot: string): string {
  return createHash('sha256').update(resolve(omcRoot)).digest('hex').slice(0, 12);
}

export interface CodexHomeLayout {
  durableBase: string;
  runtimeMirror: string;
}

export function resolveCodexHomeLayout(
  cwd: string,
  teamName: string,
  workerName: string,
  launchId?: string,
): CodexHomeLayout {
  const omcRoot = getOmcRoot(cwd);
  const pid = projectId(omcRoot);
  const durableBase = join(omcRoot, 'codex-home', pid, 'base');
  const ts = launchId ?? String(Date.now());
  const runtimeMirror = join(omcRoot, 'codex-home', pid, 'runtime', sanitize(teamName), sanitize(workerName), ts);
  return { durableBase, runtimeMirror };
}

// ---------------------------------------------------------------------------
// Durable base: one-time seed
// ---------------------------------------------------------------------------

const MAIN_CODEX_HOME = join(homedir(), '.codex');
const MAIN_CONFIG = join(MAIN_CODEX_HOME, 'config.toml');
const MAIN_AUTH = join(MAIN_CODEX_HOME, 'auth.json');
const META_FILE = '.seed-meta.json';

/** Idempotent: create durable base if missing, seed from main path + OMC assets. */
export function ensureDurableBase(durableBase: string): void {
  if (existsSync(join(durableBase, META_FILE))) return; // already seeded

  mkdirSync(durableBase, { recursive: true });

  // 1. Symlink auth.json → main path (dynamic inheritance of credentials).
  //    Ignore EEXIST — another concurrent worker may have created it between our check and link.
  if (existsSync(MAIN_AUTH)) {
    const dest = join(durableBase, 'auth.json');
    try {
      if (!existsSync(dest)) symlinkSync(MAIN_AUTH, dest);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  // 2. Seed config.toml — minimal worker config (sandbox/approval/features).
  //    API credentials come from env vars (OMC injects them), not from file.
  seedWorkerConfig(durableBase);

  // 3. Auto-gitignore the codex-home tree
  ensureGitExclude(durableBase);

  // 4. OMC asset placeholders (skills/rules — user populates as needed)
  mkdirSync(join(durableBase, 'skills'), { recursive: true });
  mkdirSync(join(durableBase, 'rules'), { recursive: true });

  // 5. Write metadata LAST — acts as atomic "init complete" sentinel.
  //    If a concurrent worker races past the meta check above before we write,
  //    it will re-run idempotent steps harmlessly.
  writeFileSync(join(durableBase, META_FILE), JSON.stringify({
    seededAt: new Date().toISOString(),
    sourceMainPath: MAIN_CODEX_HOME,
    sourceConfigHash: existsSync(MAIN_CONFIG)
      ? createHash('sha256').update(readFileSync(MAIN_CONFIG)).digest('hex').slice(0, 16)
      : null,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// Runtime mirror: per-worker temp HOME
// ---------------------------------------------------------------------------

/** Create a per-worker runtime mirror pointing back to the durable base. */
export async function prepareRuntimeMirror(
  durableBase: string,
  runtimeMirror: string,
): Promise<void> {
  mkdirSync(runtimeMirror, { recursive: true });

  // Symlink durable config into runtime mirror (read-only from worker's view)
  const toLink = ['config.toml', 'auth.json', 'skills', 'rules'] as const;
  for (const name of toLink) {
    const src = join(durableBase, name);
    const dest = join(runtimeMirror, name);
    if (existsSync(src) && !existsSync(dest)) {
      symlinkSync(src, dest);
    }
  }
}

/** Delete runtime mirror after worker exit. */
export async function cleanupRuntimeMirror(runtimeMirror: string): Promise<void> {
  if (existsSync(runtimeMirror)) {
    await rm(runtimeMirror, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---------------------------------------------------------------------------
// Worker env
// ---------------------------------------------------------------------------

export interface CodexWorkerEnvResult {
  env: Record<string, string>;
  runtimeMirror: string;
}

/**
 * Build CODEX_HOME / CODEX_SQLITE_HOME env overrides and prepare the runtime mirror.
 * Returns empty for non-codex agent types. Handles durable base seed + mirror creation
 * as one atomic operation so callers don't need to manage layout separately.
 */
export async function buildCodexWorkerEnv(
  cwd: string,
  teamName: string,
  workerName: string,
  agentType: string,
  launchId?: string,
): Promise<CodexWorkerEnvResult> {
  if (agentType !== 'codex') return { env: {}, runtimeMirror: '' };

  const { durableBase, runtimeMirror } = resolveCodexHomeLayout(cwd, teamName, workerName, launchId);
  ensureDurableBase(durableBase);

  // CODEX_SQLITE_HOME: durable (persists across launches)
  const sqliteHome = join(durableBase, 'sqlite');
  mkdirSync(sqliteHome, { recursive: true });

  // Prepare runtime mirror for this launch
  await prepareRuntimeMirror(durableBase, runtimeMirror);

  return {
    env: { CODEX_HOME: runtimeMirror, CODEX_SQLITE_HOME: sqliteHome },
    runtimeMirror,
  };
}

// ---------------------------------------------------------------------------
// Shutdown: cleanup runtime mirrors for a team
// ---------------------------------------------------------------------------

export async function cleanupTeamCodexMirrors(
  cwd: string,
  teamName: string,
): Promise<void> {
  const omcRoot = getOmcRoot(cwd);
  const pid = projectId(omcRoot);
  const teamRuntimeDir = join(omcRoot, 'codex-home', pid, 'runtime', sanitize(teamName));
  if (existsSync(teamRuntimeDir)) {
    await rm(teamRuntimeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Write a minimal worker config.toml with sandbox/approval settings only. */
function seedWorkerConfig(durableBase: string): void {
  const dest = join(durableBase, 'config.toml');

  // Try to extract sandbox/approval/features from main config
  let sandbox = 'danger-full-access';
  let approval = 'never';
  let personality = 'pragmatic';
  let featuresBlock = '';

  if (existsSync(MAIN_CONFIG)) {
    try {
      const main = readFileSync(MAIN_CONFIG, 'utf-8');
      const sandboxM = main.match(/^sandbox_mode\s*=\s*"(.+)"/m);
      const approvalM = main.match(/^approval_policy\s*=\s*"(.+)"/m);
      const personalityM = main.match(/^personality\s*=\s*"(.+)"/m);
      if (sandboxM) sandbox = sandboxM[1];
      if (approvalM) approval = approvalM[1];
      if (personalityM) personality = personalityM[1];

      // Carry over [features] block verbatim
      const featIdx = main.indexOf('[features]');
      if (featIdx >= 0) {
        const afterFeat = main.slice(featIdx);
        const nextSection = afterFeat.indexOf('\n[');
        featuresBlock = nextSection >= 0
          ? afterFeat.slice(0, nextSection).trimEnd()
          : afterFeat.trimEnd();
      }
    } catch { /* keep defaults */ }
  }

  const config = [
    '# Worker CODEX_HOME config — seeded by OMC team runtime.',
    '# API credentials (OPENAI_API_KEY, etc.) are injected via environment variables.',
    '# Customize this file to tune worker behavior; it will not be overwritten on re-seed.',
    '',
    `sandbox_mode = "${sandbox}"`,
    `approval_policy = "${approval}"`,
    `personality = "${personality}"`,
    'check_for_update_on_startup = false',
    '',
  ].join('\n');

  writeFileSync(dest, config + (featuresBlock ? `\n${featuresBlock}\n` : '\n'));
}

function ensureGitExclude(durableBase: string): void {
  // Walk up from durableBase to find the git dir, write to info/exclude
  let dir = resolve(durableBase);
  for (let i = 0; i < 10; i++) {
    const gitDir = join(dir, '.git');
    if (existsSync(gitDir)) {
      const excludeFile = join(gitDir, 'info', 'exclude');
      const pattern = 'codex-home/';
      try {
        const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
        if (!existing.includes(pattern)) {
          writeFileSync(excludeFile, (existing ? existing + '\n' : '') + pattern + '\n');
        }
      } catch { /* best-effort */ }
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
}
