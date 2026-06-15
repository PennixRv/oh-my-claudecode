/**
 * Per-role tool restrictions.
 *
 * Code-reviewers, security-reviewers, critics, and explorers
 * should not write files. For Claude workers this is enforced at
 * the schema level (disallowedTools in agent definitions). For
 * Codex/Gemini workers it is prompt-level guidance backed by
 * worktree isolation.
 */
import type { CanonicalTeamRole } from '../shared/types.js';

export const ROLE_DISALLOWED_TOOLS: Partial<Record<CanonicalTeamRole, string[]>> = {
  'code-reviewer': ['Write', 'Edit', 'MultiEdit'],
  'security-reviewer': ['Write', 'Edit', 'MultiEdit'],
  critic: ['Write', 'Edit', 'MultiEdit'],
  explore: ['Write', 'Edit', 'MultiEdit'],
};

export function getDisallowedToolsForRole(role: string): string[] {
  return ROLE_DISALLOWED_TOOLS[role as CanonicalTeamRole] ?? [];
}
