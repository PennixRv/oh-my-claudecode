/**
 * Event-driven team runtime v2 — replaces the polling watchdog from runtime.ts.
 *
 * Runtime selection:
 * - Default: v2 enabled
 * - Opt-out: set OMC_RUNTIME_V2=0|false|no|off to force legacy v1
 * NO done.json polling. Completion is detected via:
 * - CLI API lifecycle transitions (claim-task, transition-task-status)
 * - Event-driven monitor snapshots
 * - Worker heartbeat/status files
 *
 * Preserves: sentinel gate, circuit breaker, failure sidecars.
 * Removes: done.json watchdog loop, sleep-based polling.
 *
 * Architecture mirrors runtime.ts: startTeam, monitorTeam, shutdownTeam,
 * assignTask, resumeTeam as discrete operations driven by the caller.
 */

import { tmuxExecAsync } from '../cli/tmux-utils.js';
import { dirname, join, resolve } from 'path';
import { existsSync, watch } from 'fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { performance } from 'perf_hooks';
import { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { allocateTasksToWorkers } from './allocation-policy.js';
import type { TaskAllocationInput, WorkerAllocationInput } from './allocation-policy.js';
import {
  readTeamConfig,
  readWorkerStatus,
  readWorkerHeartbeat,
  readMonitorSnapshot,
  writeMonitorSnapshot,
  writeShutdownRequest,
  readShutdownAck,
  writeWorkerInbox,
  listTasksFromFiles,
  saveTeamConfig,
  cleanupTeamState,
} from './monitor.js';
import { teamRenewTaskClaim } from './team-ops.js';
import { transitionParentTask } from './state/tasks.js';
import { canTransitionTeamTaskStatus } from './contracts.js';
import { buildCodexWorkerEnv, cleanupTeamCodexMirrors } from './codex-home.js';
import { appendTeamEvent, emitMonitorDerivedEvents } from './events.js';
import {
  DEFAULT_TEAM_GOVERNANCE,
  DEFAULT_TEAM_TRANSPORT_POLICY,
  getConfigGovernance,
} from './governance.js';
import { inferPhase } from './phase-controller.js';
import type {
  TeamConfig,
  TeamManifestV2,
  TeamTask,
  TeamTaskDelegationPlan,
  TeamTaskV2,
  WorkerInfo,
  WorkerStatus,
  WorkerHeartbeat,
} from './types.js';
import type { TeamPhase } from './phase-controller.js';
import { validateTeamName } from './team-name.js';
import type { CliAgentType } from './model-contract.js';
import {
  buildWorkerArgv, getContract, resolveValidatedBinaryPath,
  getWorkerEnv as getModelWorkerEnv, isPromptModeAgent, getPromptModeArgs,
  resolveClaudeWorkerModel,
} from './model-contract.js';
import {
  createTeamSession, spawnWorkerInPane, sendToWorker, killTeamSession,
  waitForPaneReady, paneHasActiveTask, paneLooksReady, applyMainVerticalLayout, getWorkerLiveness, captureTeamPane, sendTeamPaneKey, type WorkerPaneConfig, type WorkerPaneLiveness, type TeamSessionMode,
} from './tmux-session.js';
import {
  composeInitialInbox,
  ensureWorkerStateDir,
  writeWorkerOverlay,
  generateTriggerMessage,
  generatePromptModeStartupPrompt,
} from './worker-bootstrap.js';
import { queueInboxInstruction, type DispatchOutcome } from './mcp-comm.js';
import {
  cleanupTeamWorktrees,
  inspectTeamWorktreeCleanupSafety,
  ensureWorkerWorktree,
  installWorktreeRootAgents,
  normalizeTeamWorktreeMode,
  type TeamWorktreeMode,
} from './git-worktree.js';
import { formatOmcCliInvocation } from '../utils/omc-cli-rendering.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
import type { CanonicalTeamRole, PluginConfig, RoleAssignment, TeamRoleAssignmentSpec } from '../shared/types.js';
import { CANONICAL_TEAM_ROLES } from '../shared/types.js';
import { loadConfig } from '../config/loader.js';
import { buildResolvedRoutingSnapshot, getRoleRoutingSpec } from './stage-router.js';
import { routeTaskToRole } from './role-router.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import {
  cliWorkerOutputFilePath,
  parseCliWorkerVerdict,
  renderCliWorkerOutputContract,
  shouldInjectContract,
  type CliWorkerOutputPayload,
} from './cli-worker-contract.js';
import {
  startMergeOrchestrator,
  recoverFromRestart,
  type OrchestratorHandle,
} from './merge-orchestrator.js';
import { ensureLeaderInbox, extendLeaderBootstrapPrompt, appendToLeaderInbox } from './leader-inbox.js';
import { execFileSync } from 'node:child_process';
import { isRuntimeV2Enabled } from './runtime-flags.js';
import {
  installCommitCadence,
  startFallbackPoller,
  uninstallCommitCadence,
  type FallbackPollerHandle,
  type WorkerCadenceContext,
} from './worker-commit-cadence.js';

// ---------------------------------------------------------------------------
// In-process orchestrator registry (per-team handle for the lifetime of the
// runtime-cli process). Lives at module scope so shutdownTeamV2 can find it.
// ---------------------------------------------------------------------------

const orchestratorByTeam = new Map<string, OrchestratorHandle>();
const cadenceByTeam = new Map<string, { pollers: FallbackPollerHandle[]; contexts: WorkerCadenceContext[] }>();

function registerTeamOrchestrator(teamName: string, handle: OrchestratorHandle): void {
  orchestratorByTeam.set(teamName, handle);
}

function getTeamOrchestrator(teamName: string): OrchestratorHandle | undefined {
  return orchestratorByTeam.get(teamName);
}

function unregisterTeamOrchestrator(teamName: string): void {
  orchestratorByTeam.delete(teamName);
}

function registerTeamCadence(teamName: string, context: WorkerCadenceContext, poller?: FallbackPollerHandle): void {
  const entry = cadenceByTeam.get(teamName) ?? { pollers: [], contexts: [] };
  entry.contexts.push(context);
  if (poller) entry.pollers.push(poller);
  cadenceByTeam.set(teamName, entry);
}

async function stopTeamCadence(teamName: string): Promise<void> {
  const entry = cadenceByTeam.get(teamName);
  if (!entry) return;
  cadenceByTeam.delete(teamName);
  for (const poller of entry.pollers) {
    try { poller.stop(); } catch { /* best-effort cleanup */ }
  }
  for (const context of entry.contexts) {
    try { await uninstallCommitCadence(context); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Resolve the leader's current branch via `git branch --show-current` from cwd.
 * Throws if not a git repo or HEAD is detached.
 */
function resolveLeaderBranch(cwd: string): string {
  const out = execFileSync('git', ['branch', '--show-current'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (!out) {
    throw new Error('auto-merge requires a non-detached leader branch (git branch --show-current returned empty)');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export { isRuntimeV2Enabled } from './runtime-flags.js';

// ---------------------------------------------------------------------------
// Runtime state (returned by startTeam, consumed by monitorTeam/shutdownTeam)
// ---------------------------------------------------------------------------

export interface TeamRuntimeV2 {
  teamName: string;
  sanitizedName: string;
  sessionName: string;
  config: TeamConfig;
  cwd: string;
  ownsWindow: boolean;
}

// ---------------------------------------------------------------------------
// Monitor snapshot result
// ---------------------------------------------------------------------------

export interface TeamSnapshotV2 {
  teamName: string;
  phase: TeamPhase;
  workers: Array<{
    name: string;
    alive: boolean;
    liveness: WorkerPaneLiveness;
    status: WorkerStatus;
    heartbeat: WorkerHeartbeat | null;
    assignedTasks: string[];
    working_dir?: string;
    worktree_repo_root?: string;
    worktree_path?: string;
    worktree_branch?: string;
    worktree_detached?: boolean;
    worktree_created?: boolean;
    team_state_root?: string;
    turnsWithoutProgress: number;
  }>;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
    items: TeamTask[];
  };
  allTasksTerminal: boolean;
  deadWorkers: string[];
  nonReportingWorkers: string[];
  recommendations: string[];
  performance: {
    list_tasks_ms: number;
    worker_scan_ms: number;
    total_ms: number;
    updated_at: string;
  };
}

// ---------------------------------------------------------------------------
// Shutdown options
// ---------------------------------------------------------------------------

export interface ShutdownOptionsV2 {
  force?: boolean;
  ralph?: boolean;
  timeoutMs?: number;
}

interface ShutdownGateCounts {
  total: number;
  pending: number;
  blocked: number;
  in_progress: number;
  completed: number;
  failed: number;
  allowed: boolean;
}

const MONITOR_SIGNAL_STALE_MS = 30_000;

// ---------------------------------------------------------------------------
// Helper: sanitize team name
// ---------------------------------------------------------------------------

/**
 * Resolve a per-task routing assignment from the team's routing snapshot.
 *
 * Resolution order:
 *   1. Explicit `task.role` (if present) → normalize alias → snapshot lookup.
 *   2. `routeTaskToRole(subject, description, fallbackRole)` intent inference.
 *   3. Fallback to the `fallbackAgent` round-robin pick if snapshot lookup
 *      fails (role outside canonical vocabulary or snapshot missing).
 *
 * Returns the primary assignment by default; callers swap to the Claude
 * fallback if the primary provider's CLI binary is missing at spawn time.
 */
function resolveTaskAssignment(
  task: { subject: string; description: string; role?: string },
  resolvedRouting: Record<CanonicalTeamRole, { primary: RoleAssignment; fallback: RoleAssignment }>,
  roleRoutingConfig: Partial<Record<CanonicalTeamRole, TeamRoleAssignmentSpec>> | undefined,
  resolvedBinaryPaths: Partial<Record<CliAgentType, string>>,
  fallbackAgent: CliAgentType,
): { agentType: CliAgentType; model: string; role: CanonicalTeamRole | null } {
  const canonicalRoles = new Set<string>(CANONICAL_TEAM_ROLES as readonly string[]);
  const hasExplicitRole = typeof task.role === 'string' && task.role.length > 0;
  const rawRole = hasExplicitRole
    ? task.role!
    : routeTaskToRole(task.subject, task.description, 'executor').role;
  const normalized = normalizeDelegationRole(rawRole);
  const canonical = canonicalRoles.has(normalized) ? (normalized as CanonicalTeamRole) : null;

  if (!canonical) {
    return { agentType: fallbackAgent, model: '', role: null };
  }

  // Snapshot routing only overrides the caller's CLI agentType when the user
  // has explicitly opted in — either by setting `task.role` or by configuring
  // `team.roleRouting[<canonicalRole>]` in PluginConfig. This preserves the
  // pre-patch contract: `/team N:codex ...` stays on codex when config has no
  // per-role routing, even if the task text incidentally mentions "reviewer".
  const hasConfigForRole = !!getRoleRoutingSpec(
    roleRoutingConfig as Record<string, TeamRoleAssignmentSpec | undefined> | undefined,
    canonical,
  );
  if (!hasExplicitRole && !hasConfigForRole) {
    return { agentType: fallbackAgent, model: '', role: canonical };
  }

  const pair = resolvedRouting[canonical];
  if (!pair) {
    return { agentType: fallbackAgent, model: '', role: canonical };
  }

  // AC-8 fallback: if primary provider's CLI binary is missing, swap to the
  // Claude fallback (same tier + same agent) pre-baked in the snapshot.
  const primaryProvider = pair.primary.provider as CliAgentType;
  const chosen = resolvedBinaryPaths[primaryProvider] ? pair.primary : pair.fallback;
  return {
    agentType: chosen.provider as CliAgentType,
    model: chosen.model,
    role: canonical,
  };
}

function sanitizeTeamName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  if (!sanitized) throw new Error(`Invalid team name: "${name}" produces empty slug after sanitization`);
  return sanitized;
}

function shouldUseLaunchTimeCliResolution(reason: string): boolean {
  return /untrusted location|relative path/i.test(reason);
}

function resolvePreflightBinaryPath(agentType: CliAgentType): { path: string; degraded: boolean; reason?: string } {
  try {
    return { path: resolveValidatedBinaryPath(agentType), degraded: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (shouldUseLaunchTimeCliResolution(reason)) {
      return { path: getContract(agentType).binary, degraded: true, reason };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helper: check worker liveness via tmux pane
// ---------------------------------------------------------------------------

async function getWorkerPaneLiveness(paneId: string | undefined): Promise<WorkerPaneLiveness> {
  if (!paneId) return 'dead';
  return getWorkerLiveness(paneId);
}

async function captureWorkerPane(paneId: string | undefined): Promise<string> {
  if (!paneId) return '';
  return captureTeamPane(paneId);
}

function isFreshTimestamp(value: string | undefined, maxAgeMs: number = MONITOR_SIGNAL_STALE_MS): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= maxAgeMs;
}

function findOutstandingWorkerTask(
  worker: WorkerInfo,
  taskById: Map<string, TeamTask>,
  inProgressByOwner: Map<string, TeamTask[]>,
): TeamTask | null {
  if (typeof worker.assigned_tasks === 'object') {
    for (const taskId of worker.assigned_tasks) {
      const task = taskById.get(taskId);
      if (task && (task.status === 'pending' || task.status === 'in_progress')) {
        return task;
      }
    }
  }
  const owned = inProgressByOwner.get(worker.name) ?? [];
  return owned[0] ?? null;
}

function getTaskDependencyIds(task: TeamTask): string[] {
  return task.depends_on ?? task.blocked_by ?? [];
}

function getMissingDependencyIds(
  task: TeamTask,
  taskById: Map<string, TeamTask>,
): string[] {
  return getTaskDependencyIds(task).filter((dependencyId) => !taskById.has(dependencyId));
}

// ---------------------------------------------------------------------------
// StartTeam V2 — create state, spawn workers, write initial dispatch requests
// ---------------------------------------------------------------------------

export interface StartTeamV2Config {
  teamName: string;
  workerCount: number;
  agentTypes: string[];
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[]; role?: string; delegation?: TeamTaskDelegationPlan }>;
  cwd: string;
  newWindow?: boolean;
  workerRoles?: string[];
  roleName?: string;
  rolePrompt?: string;
  /**
   * Optional pre-loaded plugin config. When omitted, `loadConfig()` is called
   * at startup. Exposed so callers (tests, bridges) can inject a config.
   * The resolved routing snapshot derived from this config is persisted to
   * `TeamConfig.resolved_routing` and is IMMUTABLE for the team's lifetime —
   * subsequent edits to the on-disk config do NOT affect an already-started
   * team (stickiness guarantee per plan AC-10 / R11).
   */
  pluginConfig?: PluginConfig;
  /**
   * v2-only: when true, start the merge orchestrator. Forces worktreeMode to
   * 'named' (worker branches must exist) and rejects 'main'/'master' leader
   * branch. See merge-orchestrator.ts.
   */
  autoMerge?: boolean;
}

// ---------------------------------------------------------------------------
// V2 task instruction builder — CLI API lifecycle, NO done.json
// ---------------------------------------------------------------------------

/**
 * Build the initial task instruction for v2 workers.
 * Workers use `omc team api` CLI commands for all lifecycle transitions.
 */
function buildV2TaskInstruction(
  teamName: string,
  workerName: string,
  task: { subject: string; description: string },
  taskId: string,
  cliOutputContract?: string,
): string {
  const claimTaskCommand = formatOmcCliInvocation(
    `team api claim-task --input '${JSON.stringify({ team_name: teamName, task_id: taskId, worker: workerName })}' --json`,
    {},
  );
  const completeTaskCommand = formatOmcCliInvocation(
    `team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: 'in_progress', to: 'completed', claim_token: '<claim_token>', result: 'Summary: <what changed>\\nVerification: <tests/checks run>\\nSubagent skip reason: worker protocol forbids nested subagents; completed focused probe in-session' })}' --json`,
  );
  const failTaskCommand = formatOmcCliInvocation(
    `team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: 'in_progress', to: 'failed', claim_token: '<claim_token>', error: '<failure reason>' })}' --json`,
  );
  return [
    `## 任务生命周期命令（必须执行）`,
    `必须依次执行以下命令，不可跳过任何步骤。`,
    ``,
    `1. 认领任务：`,
    `   ${claimTaskCommand}`,
    `   保存返回的 claim_token，后续步骤需要。`,
    `2. 执行下方描述的工作。`,
    `3. 标记完成（使用步骤 1 的 claim_token）：`,
    `   ${completeTaskCommand}`,
    `   result 字段必须包含完成证据。对委托类任务，须包含 "Subagent skip reason: worker 协议禁止嵌套子代理，所有工作在当前 session 内完成" 或（leader 明确允许时）"Subagent spawn evidence: <子任务名称/线程 ID 和整合结果>"。`,
    `4. 标记失败（使用步骤 1 的 claim_token）：`,
    `   ${failTaskCommand}`,
    `   ⚠️ 注意：--input JSON 中必须包含 "error" 字段（例如 "error":"<失败原因>"），否则报告无法被持久化。`,
    `5. ACK/进度回复不是停止信号。继续执行直到任务真正完成或失败，然后 transition 再退出。`,
    ``,
    `## 任务分配`,
    `Task ID: ${taskId}`,
    `Worker: ${workerName}`,
    `Subject: ${task.subject}`,
    ``,
    task.description,
    ``,
    `报告：如需写入报告文件，请写入 .omc/reports/ 目录。禁止写入 team state 目录（shutdown 时会删除）。报告由系统自动捕获到 .omc/reports/auto/ 并保留 7 天。`,
  ``,
  `提醒：退出前必须执行 transition-task-status。不要直接编辑 done.json 或任务文件。`,
    ...(cliOutputContract ? [cliOutputContract] : []),
  ].join('\n');
}

/**
 * Generate role-specific preface for worker inbox.
 * Prioritizes canonical role, falls back to provider-based default.
 */
function generateRolePreface(agentType: CliAgentType, role?: string | null): string {
  const normalizedRole = (role || '').toLowerCase();
  const r = ROLE_PREFACES[normalizedRole];
  if (r) return r;

  // Fallback to provider-based defaults
  switch (agentType) {
    case 'codex': return ROLE_PREFACES['codex_default'];
    case 'claude': return ROLE_PREFACES['claude_default'];
    default: return '';
  }
}

const ROLE_PREFACES: Record<string, string> = {
  'code-reviewer': `<!-- omc-role-preface: code-reviewer -->
## 角色定位
你是 **独立代码审查 worker**。使用 DSv4-Pro 做 PR 级全量覆盖扫描，GPT-5.4 聚焦逻辑缺陷/边界条件/安全隐患。
- findings > 证据 > 验证方式 > 风险列表
- 禁止使用 Write/Edit 工具
- 输出格式：严重度/文件/行号/问题描述/修复建议
---
`,

  'security-reviewer': `<!-- omc-role-preface: security-reviewer -->
## 角色定位
你是 **安全审查 worker**。使用 GPT-5.4 做深度安全审计，DSv4-Pro 做全量依赖审计。
- OWASP Top 10 / CWE 覆盖
- 每个 finding 需标注利用难度和影响范围
- 禁止使用 Write/Edit 工具
---
`,

  critic: `<!-- omc-role-preface: critic -->
## 角色定位
你是 **独立挑战者 worker**。使用 GPT-5.4 xhigh。质疑现有方案、指出边界条件、提出替代路径。
- 对每个结论提出至少一个反例
- 禁止使用 Write/Edit 工具
- 输出格式：假设/反例/风险评估/替代方案
---
`,

  architect: `<!-- omc-role-preface: architect -->
## 角色定位
你是 **架构 worker**。使用 GPT-5.4 high。系统边界、接口设计、技术选型权衡分析。
- 跨服务/数据迁移场景触发 DSv4-Pro 全量扫描辅助
- 输出格式：设计方案/权衡分析/风险评估/实施路径
---
`,

  analyst: `<!-- omc-role-preface: analyst -->
## 角色定位
你是 **分析 worker**。使用 GPT-5.4 high。需求分析、系统分析、完整性检查。
- 识别隐藏约束和需求冲突
- 安全合规场景触发 DSv4-Pro 辅助
---
`,

  debugger: `<!-- omc-role-preface: debugger -->
## 角色定位
你是 **调试 worker**。使用 GPT-5.4 high。根因分析、竞态条件检测、内存泄漏诊断。
- 连续 3 次假设失败触发 DSv4-Pro 辅助
- 输出格式：根因/证据/修复方案/验证步骤
---
`,

  verifier: `<!-- omc-role-preface: verifier -->
## 角色定位
你是 **验证 worker**。使用 GPT-5.4 high。验证完成证据、测试充分性、安全合规。
- executor 同模型族时触发异构验证
- 输出格式：PASS/FAIL/验证证据/回归风险
---
`,

  executor: `<!-- omc-role-preface: executor -->
## 角色定位
你是 **执行 worker**。默认 DSv4-Flash 快速执行。>3 文件/>200 行升级 DSv4-Pro。安全/支付/认证逻辑升级 GPT-5.4。
- 持有全工具权限（唯一写代码的 worker）
- 输出格式：变更摘要/验证证据
---
`,

  'test-engineer': `<!-- omc-role-preface: test-engineer -->
## 角色定位
你是 **测试 worker**。默认 DSv4-Flash。集成测试/E2E/安全测试升级 DSv4-Pro。不稳定测试诊断升级 GPT-5.4。
- 输出格式：测试用例/覆盖率/不稳定测试分析
---
`,

  'qa-tester': `<!-- omc-role-preface: qa-tester -->
## 角色定位
你是 **QA 测试 worker**。默认 DSv4-Flash。长交互 E2E/环境密集型测试升级 DSv4-Pro。
- tmux 会话管理、服务就绪轮询
- 输出格式：PASS/FAIL/捕获输出
---
`,

  'git-master': `<!-- omc-role-preface: git-master -->
## 角色定位
你是 **Git worker**。默认 DSv4-Flash。冲突密集 rebase/历史手术升级 DSv4-Pro。
- 原子提交、commit 消息风格检测
- 禁止 rebase main/master
---
`,

  planner: `<!-- omc-role-preface: planner -->
## 角色定位
你是 **规划 worker**。使用 GPT-5.4 xhigh。任务分解、依赖分析、风险识别。
- 探索>50 文件或>5 服务边界触发 DSv4-Pro 全量扫描辅助
- 输出格式：任务清单/依赖图/风险矩阵/验收标准
---
`,

  designer: `<!-- omc-role-preface: designer -->
## 角色定位
你是 **设计 worker**。使用 GPT-5.4 medium。UI/UX 设计、组件设计、交互设计。
- 匹配现有框架惯用法
- 输出格式：设计稿/组件规范/交互流程
---
`,

  'code-simplifier': `<!-- omc-role-preface: code-simplifier -->
## 角色定位
你是 **简化 worker**。使用 DSv4-Pro。代码简化、死代码清理、可维护性改进。
- 保持行为等价，不引入过度抽象
- 输出格式：简化前后对比/行为等价验证
---
`,

  'document-specialist': `<!-- omc-role-preface: document-specialist -->
## 角色定位
你是 **文档 worker**。英文文档使用 GPT-5.4 medium，中文文档使用 DSv4-Flash。
- 版本感知搜索、来源引用
- 输出格式：引用来源/代码示例/兼容性说明
---
`,

  explore: `<!-- omc-role-preface: explore -->
## 角色定位
你是 **搜索 worker**。使用 DSv4-Flash。速度高于一切。代码库搜索、文件查找、模式匹配。
- 禁止使用 Write/Edit 工具
- 永不升级
- 输出格式：文件路径/匹配行/搜索摘要
---
`,

  writer: `<!-- omc-role-preface: writer -->
## 角色定位
你是 **写作 worker**。默认 DSv4-Flash（中文），英文文档使用 GPT-5.4 low。
- 匹配现有文档风格
- 验证所有代码示例
- 输出格式：可扫描结构/已验证代码块
---
`,

  tracer: `<!-- omc-role-preface: tracer -->
## 角色定位
你是 **追踪 worker**。使用 GPT-5.4 high。因果追踪、竞争假设、证据分级。
- 观察与解释分离
- 输出格式：假设/证据（支持/反对）/不确定性/下一探测建议
---
`,

  scientist: `<!-- omc-role-preface: scientist -->
## 角色定位
你是 **科学 worker**。使用 GPT-5.4 high。数据分析、统计验证、假设框架。
- 使用 python_repl 执行代码（不用 Bash heredocs）
- 输出格式：发现/证据/局限性/可视化
---
`,

  codex_default: `<!-- omc-role-preface: codex default -->
## 角色定位
你是 **默认主力 worker**（GPT-5.4/Codex）。覆盖场景：研究分析、代码审查、安全审计、架构设计、Shell/CLI 自动化、代码撰写。
- 审查/审计：findings > 证据 > 验证方式 > 风险列表
- 架构/设计：指出反例和边界条件
- 实现任务：先验证前提假设再动手
- 你的价值在于独立判断——与 Leader（DSv4）形成异构视角互补
---
`,


  claude_default: `<!-- omc-role-preface: claude default -->
## 角色定位
你是 **专长补充 worker**（DSv4/Claude）。中文文档撰写、1M 长上下文搜索/预扫、与 codex 配对的异构交叉验证。
- 中文输出优先
- 长上下文任务利用 1M 窗口优势
- 交叉验证时从不同视角审视 codex 的结论
---
`,
};

// ---------------------------------------------------------------------------
// V2 worker spawning — direct tmux pane creation, no v1 delegation
// ---------------------------------------------------------------------------


async function notifyStartupInbox(
  sessionName: string,
  paneId: string,
  message: string,
): Promise<DispatchOutcome> {
  // Startup inbox triggers are only safe to type once after readiness. If the
  // pane still rejects the send (for example Claude is showing a startup
  // banner), repeated tmux send-keys calls append duplicate trigger text.
  const notified = await notifyPaneWithRetry(sessionName, paneId, message, 1);
  return notified
    ? { ok: true, transport: 'tmux_send_keys', reason: 'worker_pane_notified' }
    : { ok: false, transport: 'tmux_send_keys', reason: 'worker_notify_failed' };
}

async function notifyPaneWithRetry(
  sessionName: string,
  paneId: string,
  message: string,
  maxAttempts = 6,
  retryDelayMs = 350,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await sendToWorker(sessionName, paneId, message)) {
      return true;
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}

interface SpawnV2WorkerOptions {
  sessionName: string;
  leaderPaneId: string;
  existingWorkerPaneIds: string[];
  teamName: string;
  workerName: string;
  workerIndex: number;
  agentType: CliAgentType;
  task: { subject: string; description: string };
  taskId: string;
  cwd: string;
  workerCwd?: string;
  worktreePath?: string;
  autoMerge?: boolean;
  resolvedBinaryPaths: Partial<Record<CliAgentType, string>>;
  /**
   * Pre-resolved model ID from the team's routing snapshot. When set, overrides
   * env-based model inference inside spawnV2Worker. Enables per-role model
   * selection (e.g. codex with gpt-5-codex for reviewer, claude opus for critic).
   */
  model?: string;
  /**
   * Canonical role resolved from the task. When set to a reviewer role AND
   * agentType is codex/gemini, the CLI-worker output contract (AC-7) is
   * injected into the task instruction + startup prompt, and `output_file`
   * is populated for the completion handler.
   */
  role?: CanonicalTeamRole;
}

interface SpawnV2WorkerResult {
  paneId: string | null;
  startupAssigned: boolean;
  startupFailureReason?: string;
  /**
   * Set when the CLI-worker output contract (AC-7) was injected. The
   * completion handler reads this file to parse the structured verdict.
   */
  outputFile?: string;
}

function hasWorkerStatusProgress(status: WorkerStatus, taskId: string): boolean {
  if (status.current_task_id === taskId) return true;
  return ['working', 'blocked', 'done', 'failed'].includes(status.state);
}

async function hasWorkerTaskClaimEvidence(
  teamName: string,
  workerName: string,
  cwd: string,
  taskId: string,
): Promise<boolean> {
  try {
    const raw = await readFile(absPath(cwd, TeamPaths.taskFile(teamName, taskId)), 'utf-8');
    const task = JSON.parse(raw) as TeamTask;
    return task.owner === workerName && ['in_progress', 'completed', 'failed'].includes(task.status);
  } catch {
    return false;
  }
}

async function hasWorkerStartupEvidence(
  teamName: string,
  workerName: string,
  taskId: string,
  cwd: string,
): Promise<boolean> {
  const [hasClaimEvidence, status] = await Promise.all([
    hasWorkerTaskClaimEvidence(teamName, workerName, cwd, taskId),
    readWorkerStatus(teamName, workerName, cwd),
  ]);
  return hasClaimEvidence || hasWorkerStatusProgress(status, taskId);
}

async function waitForWorkerStartupEvidence(
  teamName: string,
  workerName: string,
  taskId: string,
  cwd: string,
  attempts = 3,
  delayMs = 250,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await hasWorkerStartupEvidence(teamName, workerName, taskId, cwd)) {
      return true;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

interface SpawnDualWorkerPairOptions {
  sessionName: string;
  leaderPaneId: string;
  existingWorkerPaneIds: string[];
  teamName: string;
  primaryWorkerName: string;
  primaryWorkerIndex: number;
  primaryAssignment: { agentType: CliAgentType; model: string; role: CanonicalTeamRole | null };
  secondaryAssignment: RoleAssignment;
  taskIndex: number;
  task: { subject: string; description: string };
  taskId: string;
  cwd: string;
  workerCwd: string;
  worktreePath?: string;
  resolvedBinaryPaths: Partial<Record<CliAgentType, string>>;
  role: CanonicalTeamRole;
  synthesis: import('../shared/types.js').SynthesisConfig;
}

/**
 * Spawn a DUAL worker pair: creates 2 child workers each claiming
 * one side of the review. Parent task state transitions happen
 * through the monitor synthesis path (processCliWorkerVerdicts).
 */
async function spawnDualWorkerPair(opts: SpawnDualWorkerPairOptions): Promise<{
  primary: SpawnV2WorkerResult;
  secondary: SpawnV2WorkerResult | null;
}> {
  // Use taskId * 1000 as base to avoid collision with sequential task files written by startTeamV2
  const baseId = Number(opts.taskId) * 1000;
  const childTaskId1 = String(baseId + 1);
  const childTaskId2 = String(baseId + 2);
  const secondaryWorkerName = `${opts.primaryWorkerName}-secondary`;
  const secondaryWorkerIndex = opts.primaryWorkerIndex + 1;

  // Create parent task JSON (dual_pending)
  const parentTaskPath = absPath(opts.cwd, TeamPaths.taskFile(opts.teamName, opts.taskId));
  await mkdir(dirname(parentTaskPath), { recursive: true });
  await writeFile(parentTaskPath, JSON.stringify({
    id: opts.taskId, subject: opts.task.subject, description: opts.task.description,
    status: 'dual_pending', role: opts.role,
    created_at: new Date().toISOString(),
    metadata: { dual: { childIds: [childTaskId1, childTaskId2], synthesis: 'pending' } },
  }, null, 2));

  // Create child task JSONs (pending — workers will claim them)
  for (const [childId, label] of [[childTaskId1, 'primary'], [childTaskId2, 'secondary']] as const) {
    const childPath = absPath(opts.cwd, TeamPaths.taskFile(opts.teamName, childId));
    await writeFile(childPath, JSON.stringify({
      id: childId, subject: `[${label}] ${opts.task.subject}`,
      description: opts.task.description, status: 'pending',
      role: opts.role, parentTaskId: opts.taskId,
      created_at: new Date().toISOString(),
    }, null, 2));
  }

  // Spawn primary worker (child task 1)
  const primaryResult = await spawnV2Worker({
    sessionName: opts.sessionName, leaderPaneId: opts.leaderPaneId,
    existingWorkerPaneIds: opts.existingWorkerPaneIds,
    teamName: opts.teamName, workerName: opts.primaryWorkerName,
    workerIndex: opts.primaryWorkerIndex, agentType: opts.primaryAssignment.agentType,
    task: { ...opts.task, subject: `[primary] ${opts.task.subject}` },
    taskId: childTaskId1, cwd: opts.cwd, workerCwd: opts.workerCwd,
    worktreePath: opts.worktreePath, resolvedBinaryPaths: opts.resolvedBinaryPaths,
    model: opts.primaryAssignment.model || undefined,
    role: opts.primaryAssignment.role ?? undefined,
  });

  // Persist both primary + pre-registered secondary to config.workers
  // BEFORE spawning the secondary, so queueInboxInstruction
  // inside spawnV2Worker can find the secondary worker pane.
  try {
    const config = await readTeamConfig(opts.teamName, opts.cwd);
    if (config && primaryResult.paneId) {
      const secWorkerEntry: WorkerInfo = {
        name: secondaryWorkerName, index: secondaryWorkerIndex,
        role: opts.role, worker_cli: opts.secondaryAssignment.provider as WorkerInfo['worker_cli'],
        assigned_tasks: [childTaskId2],
      };
      // Merge with existing workers
      const existing = config.workers.filter(w => w.name !== secondaryWorkerName);
      config.workers = [...existing, secWorkerEntry];
      await saveTeamConfig(config, opts.cwd);
    }
  } catch { /* best-effort */ }

  // Spawn secondary worker (child task 2).
  let secondaryResult: SpawnV2WorkerResult | null = null;
  if (opts.secondaryAssignment) {
    const secAgentType = opts.secondaryAssignment.provider;
    secondaryResult = await spawnV2Worker({
      sessionName: opts.sessionName, leaderPaneId: opts.leaderPaneId,
      existingWorkerPaneIds: [...opts.existingWorkerPaneIds, ...(primaryResult.paneId ? [primaryResult.paneId] : [])],
      teamName: opts.teamName, workerName: secondaryWorkerName,
      workerIndex: secondaryWorkerIndex, agentType: secAgentType as CliAgentType,
      task: { ...opts.task, subject: `[secondary] ${opts.task.subject}` },
      taskId: childTaskId2, cwd: opts.cwd, workerCwd: opts.workerCwd,
      worktreePath: opts.worktreePath, resolvedBinaryPaths: opts.resolvedBinaryPaths,
      model: opts.secondaryAssignment.model || undefined, role: opts.role,
    });
  }

  // Transition parent from dual_pending → dual_in_progress
  // after both workers have been spawned (best-effort, monitor will catch up)
  if (primaryResult.paneId || secondaryResult?.paneId) {
    const deps = {
      teamName: opts.teamName, cwd: opts.cwd,
      readTask: async (t: string, id: string, c: string) => {
        const { readFile } = await import('fs/promises');
        try { const raw = await readFile(absPath(c, TeamPaths.taskFile(t, id)), 'utf-8'); return JSON.parse(raw) as TeamTask; } catch { return null; }
      },
      withTaskClaimLock: async <T>(_t: string, _id: string, _c: string, fn: () => Promise<T>) => { try { return { ok: true as const, value: await fn() }; } catch { return { ok: false as const }; } },
      normalizeTask: (t: TeamTask) => ({ ...t, version: (t as unknown as Record<string, unknown>).version as number ?? 0 }) as unknown as TeamTaskV2,
      canTransitionTaskStatus: canTransitionTeamTaskStatus,
      taskFilePath: (t: string, id: string, c: string) => absPath(c, TeamPaths.taskFile(t, id)),
      writeAtomic: async (p: string, d: string) => { const { writeFile } = await import('fs/promises'); await writeFile(p, d, 'utf-8'); },
    };
    await transitionParentTask(opts.taskId, 'dual_pending', 'dual_in_progress', undefined, deps).catch(() => {});
  }

  return { primary: primaryResult, secondary: secondaryResult };
}

/**
 * Spawn a single v2 worker in a tmux pane.
 * Writes CLI API inbox (no done.json), waits for ready, sends inbox path.
 */
async function spawnV2Worker(opts: SpawnV2WorkerOptions): Promise<SpawnV2WorkerResult> {
  // Split new pane off the last existing pane (or leader if first worker)
  const splitTarget = opts.existingWorkerPaneIds.length === 0
    ? opts.leaderPaneId
    : opts.existingWorkerPaneIds[opts.existingWorkerPaneIds.length - 1];
  const splitType = opts.existingWorkerPaneIds.length === 0 ? '-h' : '-v';

  const splitResult = await tmuxExecAsync([
    'split-window', splitType, '-t', splitTarget,
    '-d', '-P', '-F', '#{pane_id}',
    '-c', opts.workerCwd ?? opts.cwd,
  ]);
  const paneId = splitResult.stdout.split('\n')[0]?.trim();
  if (!paneId) {
    return { paneId: null, startupAssigned: false, startupFailureReason: 'pane_id_missing' };
  }

  const usePromptMode = isPromptModeAgent(opts.agentType);

  // AC-7: render the CLI-worker output contract when a reviewer-style role
  // is routed to an external provider (codex/gemini). Claude workers speak
  // through the team messaging API and do not use the verdict-file contract.
  const injectContract = shouldInjectContract(opts.role ?? null, opts.agentType);
  const outputFile = injectContract && opts.role
    ? cliWorkerOutputFilePath(teamStateRoot(opts.cwd, opts.teamName), opts.workerName)
    : undefined;
  const cliOutputContract = injectContract && opts.role && outputFile
    ? renderCliWorkerOutputContract(opts.role, outputFile)
    : undefined;

  // Build v2 task instruction (CLI API, NO done.json)
  const instruction = `${generateRolePreface(opts.agentType, opts.role)}${buildV2TaskInstruction(
    opts.teamName, opts.workerName, opts.task, opts.taskId, cliOutputContract,
  )}`;
  const instructionStateRoot = opts.worktreePath ? '$OMC_TEAM_STATE_ROOT' : undefined;
  const inboxTriggerMessage = generateTriggerMessage(opts.teamName, opts.workerName, instructionStateRoot);
  const promptModeStartupPrompt = generatePromptModeStartupPrompt(
    opts.teamName, opts.workerName, instructionStateRoot, cliOutputContract,
  );
  if (usePromptMode) {
    await composeInitialInbox(
      opts.teamName, opts.workerName, instruction, opts.cwd, cliOutputContract,
    );
  }

  // Build env and launch command
  // Codex worker CODEX_HOME isolation (durable base + runtime mirror)
  const codexHomeResult = await buildCodexWorkerEnv(
    opts.cwd, opts.teamName, opts.workerName, opts.agentType,
  );

  const envVars = {
    ...getModelWorkerEnv(opts.teamName, opts.workerName, opts.agentType),
    OMC_TEAM_STATE_ROOT: teamStateRoot(opts.cwd, opts.teamName),
    OMC_TEAM_LEADER_CWD: opts.cwd,
    ...(opts.worktreePath ? { OMC_TEAM_WORKTREE_PATH: opts.worktreePath } : {}),
    ...(opts.workerCwd ? { OMC_TEAM_WORKER_CWD: opts.workerCwd } : {}),
    ...codexHomeResult.env,
  };
  const resolvedBinaryPath = opts.resolvedBinaryPaths[opts.agentType]
    ?? resolveValidatedBinaryPath(opts.agentType);

  // Resolve model from environment variables.
  // For Claude agents on Bedrock/Vertex, resolve the provider-specific model
  // so workers don't fall back to invalid Anthropic API model names. (#1695)
  // Snapshot-provided model (from resolved_routing) takes precedence so
  // per-role routing (codex/gemini/claude-tier) is honored at spawn time.
  const modelForAgent = opts.model ?? (() => {
    if (opts.agentType === 'codex') {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL
        || process.env.OMC_CODEX_DEFAULT_MODEL
        || undefined;
    }
    if (opts.agentType === 'gemini') {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL
        || process.env.OMC_GEMINI_DEFAULT_MODEL
        || undefined;
    }
    if (opts.agentType === 'grok') {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL
        || process.env.OMC_GROK_DEFAULT_MODEL
        || undefined;
    }
    // Claude agents: resolve Bedrock/Vertex model when on those providers
    return resolveClaudeWorkerModel();
  })();

  const [launchBinary, ...launchArgs] = buildWorkerArgv(opts.agentType, {
    teamName: opts.teamName,
    workerName: opts.workerName,
    cwd: opts.workerCwd ?? opts.cwd,
    resolvedBinaryPath,
    model: modelForAgent,
  });

  // For prompt-mode agents (currently gemini), keep the full instruction in
  // inbox.md and pass only a short file-pointer prompt via CLI args. This
  // avoids echoing reviewer/seed prompt text into tmux scrollback.
  if (usePromptMode) {
    launchArgs.push(...getPromptModeArgs(opts.agentType, promptModeStartupPrompt));
  }

  if (opts.autoMerge && opts.worktreePath) {
    const cadenceContext: WorkerCadenceContext = {
      teamName: opts.teamName,
      workerName: opts.workerName,
      worktreePath: opts.worktreePath,
      agentType: opts.agentType,
      enabled: true,
    };
    const cadence = await installCommitCadence(cadenceContext);
    const poller = cadence.method === 'fallback-poll'
      ? startFallbackPoller(opts.worktreePath, opts.workerName)
      : undefined;
    registerTeamCadence(opts.teamName, cadenceContext, poller);
  }

  const paneConfig: WorkerPaneConfig = {
    teamName: opts.teamName,
    workerName: opts.workerName,
    envVars,
    launchBinary,
    launchArgs,
    cwd: opts.workerCwd ?? opts.cwd,
  };

  await spawnWorkerInPane(opts.sessionName, paneId, paneConfig);

  // Apply layout
  await applyMainVerticalLayout(opts.sessionName);

  // Settle delay for non-first workers: layout adjustments from split-window
  // and applyMainVerticalLayout can disturb a freshly spawned pane's TUI.
  // First worker (split from stable leader pane) doesn't need this.
  if (opts.existingWorkerPaneIds.length > 0) {
    await new Promise(r => setTimeout(r, 1500));
  }

  // For interactive agents, wait for pane readiness before dispatching startup inbox.
  let paneReadyFailed = false;
  if (!usePromptMode) {
    const paneReady = await waitForPaneReady(paneId);
    if (!paneReady) {
      // Don't return early — still write inbox and attempt dispatch.
      // The worker may become ready shortly after.
      paneReadyFailed = true;
    }
  }

  const dispatchOutcome = await queueInboxInstruction({
    teamName: opts.teamName,
    workerName: opts.workerName,
    workerIndex: opts.workerIndex + 1,
    paneId,
    inbox: instruction,
    triggerMessage: inboxTriggerMessage,
    cwd: opts.cwd,
    transportPreference: usePromptMode ? 'prompt_stdin' : 'transport_direct',
    fallbackAllowed: DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode === 'hook_preferred_with_fallback',
    inboxCorrelationKey: `startup:${opts.workerName}:${opts.taskId}`,
    notify: async (_target, triggerMessage) => {
      if (usePromptMode) {
        return { ok: true, transport: 'prompt_stdin', reason: 'prompt_mode_launch_args' };
      }
      if (opts.agentType === 'gemini') {
        const confirmed = await notifyPaneWithRetry(opts.sessionName, paneId, '1');
        if (!confirmed) {
          return { ok: false, transport: 'tmux_send_keys', reason: 'worker_notify_failed:trust-confirm' };
        }
        await new Promise(r => setTimeout(r, 800));
      }
      return notifyStartupInbox(opts.sessionName, paneId, triggerMessage);
    },
    deps: {
      writeWorkerInbox,
    },
  });
  if (!dispatchOutcome.ok) {
    return {
      paneId,
      startupAssigned: false,
      startupFailureReason: dispatchOutcome.reason,
    };
  }

  if (opts.agentType === 'claude') {
    let settled = await waitForWorkerStartupEvidence(
      opts.teamName,
      opts.workerName,
      opts.taskId,
      opts.cwd,
      6,
    );
    // Claude Code v2.1.x sometimes swallows the Enter key sent immediately
    // after a fresh pane reports ready — the TUI is still binding input
    // handlers. Resubmit Enter directly and re-check evidence.
    for (let attempt = 1; !settled && attempt <= 4; attempt++) {
      try {
        await sendTeamPaneKey(paneId, 'Enter');
      } catch {
        break;
      }
      settled = await waitForWorkerStartupEvidence(
        opts.teamName,
        opts.workerName,
        opts.taskId,
        opts.cwd,
        12,
      );
    }
    if (!settled) {
      return {
        paneId,
        startupAssigned: false,
        startupFailureReason: 'claude_startup_evidence_missing',
      };
    }
  }

  if (usePromptMode) {
    const settled = await waitForWorkerStartupEvidence(
      opts.teamName,
      opts.workerName,
      opts.taskId,
      opts.cwd,
    );
    if (!settled) {
      return {
        paneId,
        startupAssigned: false,
        startupFailureReason: `${opts.agentType}_startup_evidence_missing`,
      };
    }
  }

  return {
    paneId,
    startupAssigned: !paneReadyFailed,
    startupFailureReason: paneReadyFailed ? 'worker_pane_not_ready' : undefined,
    ...(outputFile ? { outputFile } : {}),
  };
}


async function rollbackUnpersistedNativeWorktreeStartup(teamName: string, cwd: string, cause: unknown): Promise<void> {
  const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
  if (!safety.hasEvidence) return;

  const teamRoot = absPath(cwd, TeamPaths.root(teamName));
  const errorMessage = cause instanceof Error ? cause.message : String(cause);
  try {
    const cleanup = cleanupTeamWorktrees(teamName, cwd);
    await cleanupTeamCodexMirrors(cwd, teamName);
    if (cleanup.preserved.length === 0) {
      await rm(teamRoot, { recursive: true, force: true });
      return;
    }
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'startup-failure.json'), JSON.stringify({
      reason: 'startup_failed_before_config_persisted',
      error: errorMessage,
      preserved: cleanup.preserved,
      recorded_at: new Date().toISOString(),
    }, null, 2), 'utf-8');
  } catch (rollbackError) {
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'startup-failure.json'), JSON.stringify({
      reason: 'startup_failed_before_config_persisted',
      error: errorMessage,
      rollback_error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      recorded_at: new Date().toISOString(),
    }, null, 2), 'utf-8');
  }
}

async function rollbackStartedNativeWorktreeStartup(args: {
  teamName: string;
  cwd: string;
  cause: unknown;
  sessionName: string;
  leaderPaneId?: string | null;
  workerPaneIds: string[];
  sessionMode: TeamSessionMode;
}): Promise<void> {
  try {
    await killTeamSession(
      args.sessionName,
      args.workerPaneIds,
      args.leaderPaneId ?? undefined,
      { sessionMode: args.sessionMode },
    );
  } catch (killError) {
    process.stderr.write(
      `[team/runtime-v2] startup rollback tmux cleanup failed: ${killError instanceof Error ? killError.message : String(killError)}
`,
    );
  }
  await rollbackUnpersistedNativeWorktreeStartup(args.teamName, args.cwd, args.cause);
}

// ---------------------------------------------------------------------------
// startTeamV2 — direct tmux creation, CLI API inbox, NO watchdog
// ---------------------------------------------------------------------------

/**
 * Start a team with the v2 event-driven runtime.
 * Creates state directories, writes config + task files, spawns workers via
 * tmux split-panes, and writes CLI API inbox instructions. NO done.json.
 * NO watchdog polling — the leader drives monitoring via monitorTeamV2().
 */
export async function startTeamV2(config: StartTeamV2Config): Promise<TeamRuntimeV2> {
  const sanitized = sanitizeTeamName(config.teamName);
  const leaderCwd = resolve(config.cwd);
  validateTeamName(sanitized);

  // Resolve routing snapshot ONCE at team creation. The snapshot is immutable
  // for the team's lifetime (stickiness per plan AC-10): spawn/scaleUp/restart
  // all read this snapshot and never re-resolve. Config edits mid-lifetime
  // do NOT change routing — user must recreate the team to pick up changes.
  const pluginCfg: PluginConfig = config.pluginConfig ?? loadConfig();
  const resolvedRouting = buildResolvedRoutingSnapshot(pluginCfg);
  let worktreeMode: TeamWorktreeMode = normalizeTeamWorktreeMode(
    process.env.OMC_TEAM_WORKTREE_MODE ?? pluginCfg.team?.ops?.worktreeMode,
  );

  // Auto-merge gate (M5 + M3 hardening). Forces worktreeMode='named' so each
  // worker has a real branch the orchestrator can merge from.
  let autoMergeLeaderBranch: string | undefined;
  if (config.autoMerge) {
    if (!isRuntimeV2Enabled()) {
      throw new Error('auto-merge requires OMC_RUNTIME_V2=1 (this feature is v2-only).');
    }
    autoMergeLeaderBranch = resolveLeaderBranch(leaderCwd);
    const stripped = autoMergeLeaderBranch.replace(/^refs\/heads\//i, '').toLowerCase();
    if (stripped === 'main' || stripped === 'master') {
      throw new Error('auto-merge refuses main/master leader branch — use a feature branch');
    }
    if (worktreeMode !== 'named') {
      // Force named-branch worktree mode so workers get a real branch.
      worktreeMode = 'named';
    }
  }

  const workspaceMode = worktreeMode === 'disabled' ? 'single' as const : 'worktree' as const;

  // Validate CLIs and pin absolute binary paths for user-declared agentTypes.
  // AC-8: missing/untrusted binaries fall back to the snapshot's Claude tuple at
  // spawn time; emit a loud warning naming the binary so operators can fix it.
  const agentTypes = config.agentTypes as CliAgentType[];
  const resolvedBinaryPaths: Partial<Record<CliAgentType, string>> = {};
  const missingBinaryReasons: Array<{ agentType: CliAgentType; reason: string }> = [];
  for (const agentType of [...new Set(agentTypes)]) {
    try {
      resolvedBinaryPaths[agentType] = resolvePreflightBinaryPath(agentType).path;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      missingBinaryReasons.push({ agentType, reason });
    }
  }
  // Best-effort resolve extra providers referenced by the routing snapshot
  // (codex/gemini critic, reviewer, etc.). Missing binaries are tolerated —
  // the spawn path falls back to the snapshot's Claude fallback (AC-8).
  for (const { primary } of Object.values(resolvedRouting)) {
    const provider = primary.provider as CliAgentType;
    if (resolvedBinaryPaths[provider]) continue;
    if (missingBinaryReasons.some((m) => m.agentType === provider)) continue;
    try {
      resolvedBinaryPaths[provider] = resolvePreflightBinaryPath(provider).path;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      missingBinaryReasons.push({ agentType: provider, reason });
    }
  }
  // AC-8: guarantee at least the Claude fallback CLI is resolvable. If every
  // declared provider is unavailable AND Claude is not resolvable either, the
  // caller gets a loud error rather than a silently-broken team.
  if (!resolvedBinaryPaths.claude) {
    try {
      resolvedBinaryPaths.claude = resolveValidatedBinaryPath('claude');
    } catch {
      // Keep going — startup will emit warnings below and spawnV2Worker may
      // still succeed if Claude is resolvable via PATH at exec time.
    }
  }

  // Create state directories
  await mkdir(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
  await mkdir(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });
  await mkdir(join(getOmcRoot(leaderCwd), 'state', 'team', sanitized, 'mailbox'), { recursive: true });

  // AC-8: emit a loud team-event warning naming every missing/untrusted CLI
  // binary so the leader surfaces the fallback decision instead of silently
  // swapping providers.
  const missingBinaryLogFailure = createSwallowedErrorLogger(
    'team.runtime-v2.startTeamV2 cli_binary_missing event failed',
  );
  for (const { agentType, reason } of missingBinaryReasons) {
    process.stderr.write(
      `[team/runtime-v2] cli_binary_missing:${agentType}: ${reason} — falling back to claude snapshot (AC-8)\n`,
    );
    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `cli_binary_missing:${agentType}:${reason}`,
    }, leaderCwd).catch(missingBinaryLogFailure);
  }

  // Write task files
  for (let i = 0; i < config.tasks.length; i++) {
    const taskId = String(i + 1);
    const taskFilePath = absPath(leaderCwd, TeamPaths.taskFile(sanitized, taskId));
    await mkdir(join(taskFilePath, '..'), { recursive: true });
    await writeFile(taskFilePath, JSON.stringify({
      id: taskId,
      subject: config.tasks[i].subject,
      description: config.tasks[i].description,
      status: 'pending',
      owner: null,
      result: null,
      ...(config.tasks[i].role ? { role: config.tasks[i].role } : {}),
      ...(config.tasks[i].delegation ? { delegation: config.tasks[i].delegation } : {}),
      created_at: new Date().toISOString(),
    }, null, 2), 'utf-8');
  }

  // Build allocation inputs for the new role-aware allocator
  const workerNames = Array.from({ length: config.workerCount }, (_, index) => `worker-${index + 1}`);
  const workerWorktrees = new Map<string, NonNullable<ReturnType<typeof ensureWorkerWorktree>>>();
  try {
    if (worktreeMode !== 'disabled') {
      for (const workerName of workerNames) {
        const worktree = ensureWorkerWorktree(sanitized, workerName, leaderCwd, {
          mode: worktreeMode,
          requireCleanLeader: true,
        });
        if (worktree) workerWorktrees.set(workerName, worktree);
      }
    }
  } catch (error) {
    await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
    throw error;
  }
  const workerNameSet = new Set(workerNames);

  // Respect explicit owner fields first, then allocate remaining tasks
  const startupAllocations: Array<{ workerName: string; taskIndex: number }> = [];
  const unownedTaskIndices: number[] = [];
  for (let i = 0; i < config.tasks.length; i++) {
    const owner = config.tasks[i]?.owner;
    if (typeof owner === 'string' && workerNameSet.has(owner)) {
      startupAllocations.push({ workerName: owner, taskIndex: i });
    } else {
      unownedTaskIndices.push(i);
    }
  }

  if (unownedTaskIndices.length > 0) {
    const allocationTasks: TaskAllocationInput[] = unownedTaskIndices.map(idx => ({
      id: String(idx),
      subject: config.tasks[idx].subject,
      description: config.tasks[idx].description,
      ...(config.tasks[idx].role ? { role: config.tasks[idx].role } : {}),
    }));
    const allocationWorkers: WorkerAllocationInput[] = workerNames.map((name, i) => ({
      name,
      role: config.workerRoles?.[i]
        ?? (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude') as string,
      currentLoad: 0,
    }));
    for (const r of allocateTasksToWorkers(allocationTasks, allocationWorkers)) {
      startupAllocations.push({ workerName: r.workerName, taskIndex: Number(r.taskId) });
    }
  }

  // Set up worker state dirs and overlays (with v2 CLI API instructions)
  try {
    for (let i = 0; i < workerNames.length; i++) {
      const wName = workerNames[i];
      const agentType = (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude') as CliAgentType;
      await ensureWorkerStateDir(sanitized, wName, leaderCwd);
      const overlayPath = await writeWorkerOverlay({
        teamName: sanitized, workerName: wName, agentType,
        tasks: config.tasks.map((t, idx) => ({
          id: String(idx + 1), subject: t.subject, description: t.description,
        })),
        cwd: leaderCwd,
        ...(config.rolePrompt ? { bootstrapInstructions: config.rolePrompt } : {}),
        ...(workerWorktrees.has(wName) ? { instructionStateRoot: '$OMC_TEAM_STATE_ROOT' } : {}),
      });
      const worktree = workerWorktrees.get(wName);
      if (worktree) {
        const overlayContent = await readFile(overlayPath, 'utf-8');
        installWorktreeRootAgents(sanitized, wName, leaderCwd, worktree.path, overlayContent);
      }
    }
  } catch (error) {
    await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
    throw error;
  }

  // Create tmux session (leader only — workers spawned below)
  let session: Awaited<ReturnType<typeof createTeamSession>>;
  try {
    session = await createTeamSession(sanitized, 0, leaderCwd, {
      newWindow: Boolean(config.newWindow),
    });
  } catch (error) {
    await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
    throw error;
  }
  const sessionName = session.sessionName;
  const leaderPaneId = session.leaderPaneId;
  const ownsWindow = session.sessionMode !== 'split-pane';
  const workerPaneIds: string[] = [];

  // Build workers info for config
  const workersInfo: WorkerInfo[] = workerNames.map((wName, i) => {
    const worktree = workerWorktrees.get(wName);
    return {
      name: wName,
      index: i + 1,
      role: config.workerRoles?.[i]
        ?? (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude') as string,
      assigned_tasks: [] as string[],
      working_dir: worktree?.path ?? leaderCwd,
      team_state_root: teamStateRoot(leaderCwd, sanitized),
      ...(worktree ? {
        worktree_repo_root: leaderCwd,
        worktree_path: worktree.path,
        worktree_branch: worktree.branch,
        worktree_detached: worktree.detached,
        worktree_created: worktree.created,
      } : {}),
    };
  });

  // Write initial v2 config
  const teamConfig: TeamConfig = {
    name: sanitized,
    task: config.tasks.map(t => t.subject).join('; '),
    agent_type: agentTypes[0] || 'claude',
    worker_launch_mode: 'interactive',
    policy: DEFAULT_TEAM_TRANSPORT_POLICY,
    governance: DEFAULT_TEAM_GOVERNANCE,
    worker_count: config.workerCount,
    max_workers: 5,
    workers: workersInfo,
    created_at: new Date().toISOString(),
    tmux_session: sessionName,
    tmux_window_owned: ownsWindow,
    next_task_id: config.tasks.length + 1,
    leader_cwd: leaderCwd,
    team_state_root: teamStateRoot(leaderCwd, sanitized),
    leader_pane_id: leaderPaneId,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    resolved_routing: resolvedRouting,
    workspace_mode: workspaceMode,
    worktree_mode: worktreeMode,
  };
  try {
    await saveTeamConfig(teamConfig, leaderCwd);
  } catch (error) {
    await rollbackStartedNativeWorktreeStartup({
      teamName: sanitized,
      cwd: leaderCwd,
      cause: error,
      sessionName,
      leaderPaneId,
      workerPaneIds,
      sessionMode: session.sessionMode,
    });
    throw error;
  }
  const permissionsSnapshot = {
    approval_mode: process.env.OMC_APPROVAL_MODE || 'default',
    sandbox_mode: process.env.OMC_SANDBOX_MODE || 'default',
    network_access: process.env.OMC_NETWORK_ACCESS === '1',
  };
  const teamManifest: TeamManifestV2 = {
    schema_version: 2,
    name: sanitized,
    task: teamConfig.task,
    leader: {
      session_id: sessionName,
      worker_id: 'leader-fixed',
      role: 'leader',
    },
    policy: DEFAULT_TEAM_TRANSPORT_POLICY,
    governance: DEFAULT_TEAM_GOVERNANCE,
    permissions_snapshot: permissionsSnapshot,
    tmux_session: sessionName,
    worker_count: teamConfig.worker_count,
    workers: workersInfo,
    next_task_id: teamConfig.next_task_id,
    created_at: teamConfig.created_at,
    leader_cwd: leaderCwd,
    team_state_root: teamConfig.team_state_root,
    workspace_mode: teamConfig.workspace_mode,
    worktree_mode: teamConfig.worktree_mode,
    leader_pane_id: leaderPaneId,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    next_worker_index: teamConfig.next_worker_index,
  };
  try {
    await writeFile(absPath(leaderCwd, TeamPaths.manifest(sanitized)), JSON.stringify(teamManifest, null, 2), 'utf-8');
  } catch (error) {
    await rollbackStartedNativeWorktreeStartup({
      teamName: sanitized,
      cwd: leaderCwd,
      cause: error,
      sessionName,
      leaderPaneId,
      workerPaneIds,
      sessionMode: session.sessionMode,
    });
    throw error;
  }

  // Spawn workers for initial tasks (at most one startup task per worker)
  const initialStartupAllocations: typeof startupAllocations = [];
  const seenStartupWorkers = new Set<string>();
  for (const decision of startupAllocations) {
    if (seenStartupWorkers.has(decision.workerName)) continue;
    initialStartupAllocations.push(decision);
    seenStartupWorkers.add(decision.workerName);
    if (initialStartupAllocations.length >= config.workerCount) break;
  }

  try {
    for (const decision of initialStartupAllocations) {
    const wName = decision.workerName;
    const workerIndex = Number.parseInt(wName.replace('worker-', ''), 10) - 1;
    const taskId = String(decision.taskIndex + 1);
    const task = config.tasks[decision.taskIndex];
    if (!task || workerIndex < 0) continue;

    // Route the task through the team's immutable snapshot (Option E).
    const fallbackAgent = (agentTypes[workerIndex % agentTypes.length] ?? agentTypes[0] ?? 'claude') as CliAgentType;
    const assignment = resolveTaskAssignment(
      task,
      resolvedRouting,
      pluginCfg.team?.roleRouting as Partial<Record<CanonicalTeamRole, TeamRoleAssignmentSpec>> | undefined,
      resolvedBinaryPaths,
      fallbackAgent,
    );

    // DUAL / DUAL* / SINGLE+ mode dispatch
    const routingEntry = assignment.role ? resolvedRouting[assignment.role as CanonicalTeamRole] : undefined;
    const mode = routingEntry?.mode ?? 'SINGLE';

    // Only modes that require special handling.
    // Guard: auto-inferred roles (no explicit task.role) never trigger DUAL/DUAL*/SINGLE+.
    // This prevents the role-router from upgrading a plain `1:codex "scan code"` dispatch
    // to DUAL just because the task text mentions "审查" keywords.
    const isExplicitRole = typeof task.role === 'string' && task.role.length > 0;
    if (routingEntry && mode !== 'SINGLE' && isExplicitRole) {
      const re = routingEntry;

      // DUAL: always spawn pair
      if (mode === 'DUAL' && re.secondary) {
      const dualResults = await spawnDualWorkerPair({
        sessionName, leaderPaneId, existingWorkerPaneIds: workerPaneIds,
        teamName: sanitized, primaryWorkerName: wName,
        primaryWorkerIndex: workerIndex, primaryAssignment: assignment,
        secondaryAssignment: re.secondary,
        taskIndex: decision.taskIndex, task, taskId,
        cwd: leaderCwd, workerCwd: workersInfo[workerIndex]?.working_dir ?? leaderCwd,
        worktreePath: workersInfo[workerIndex]?.worktree_path,
        resolvedBinaryPaths, role: assignment.role ?? 'executor' as CanonicalTeamRole,
        synthesis: re.synthesis ?? { maxReviseCycles: 2 },
      });
      // Track primary worker
      const childId1 = String(Number(taskId) * 1000 + 1);
      if (dualResults.primary.paneId) {
        workerPaneIds.push(dualResults.primary.paneId);
        const wi = workersInfo[workerIndex];
        if (wi) {
          wi.pane_id = dualResults.primary.paneId;
          wi.worker_cli = assignment.agentType;
          wi.assigned_tasks = [childId1];
          wi.dualPairWorker = `${wName}-secondary`;
          wi.dualIndex = 0;
          wi.dualTaskId = taskId;
        }
      }
      // Track secondary worker in config.workers so claimTask accepts it
      if (dualResults.secondary?.paneId) {
        workerPaneIds.push(dualResults.secondary.paneId);
        const childId2 = String(Number(taskId) * 1000 + 2);
        const secWorkerIndex = workerIndex + 1;
        const secAgentType = re.secondary?.provider ?? 'claude';
        // Ensure workersInfo has room for the secondary entry
        while (workersInfo.length <= secWorkerIndex) {
          workersInfo.push({ name: `worker-${workersInfo.length + 1}`, index: workersInfo.length, role: assignment.role ?? 'executor', assigned_tasks: [] });
        }
        workersInfo[secWorkerIndex] = {
          ...workersInfo[secWorkerIndex],
          name: `${wName}-secondary`,
          index: secWorkerIndex,
          role: assignment.role ?? 'executor',
          worker_cli: secAgentType as 'codex' | 'claude' | 'gemini' | 'cursor' | 'grok',
          assigned_tasks: [childId2],
          pane_id: dualResults.secondary.paneId,
          dualPairWorker: wName,
          dualIndex: 1,
          dualTaskId: taskId,
        };
      }
      continue;
    }

    // DUAL_STAR: evaluate pre-dispatch triggers, upgrade to DUAL if matched
    if (mode === 'DUAL_STAR' && re.secondary) {
      const { estimateTaskComplexity, evaluateDualStarTriggers } = await import('./dual-star-evaluator.js');
      const metrics = estimateTaskComplexity(task.subject, task.description);
      if (assignment.role === 'verifier') {
        const execRouting = resolvedRouting['executor' as CanonicalTeamRole];
        if (execRouting) {
          metrics.executorVerifierSameFamily = assignment.agentType === execRouting.primary.provider;
        }
      }
      const triggerResult = evaluateDualStarTriggers(re.dualStarTriggers ?? [], metrics);
      if (triggerResult.shouldUpgrade) {
        const dualResults = await spawnDualWorkerPair({
          sessionName, leaderPaneId, existingWorkerPaneIds: workerPaneIds,
          teamName: sanitized, primaryWorkerName: wName,
          primaryWorkerIndex: workerIndex, primaryAssignment: assignment,
          secondaryAssignment: re.secondary,
          taskIndex: decision.taskIndex, task, taskId,
          cwd: leaderCwd, workerCwd: workersInfo[workerIndex]?.working_dir ?? leaderCwd,
          worktreePath: workersInfo[workerIndex]?.worktree_path,
          resolvedBinaryPaths, role: assignment.role ?? 'executor' as CanonicalTeamRole,
          synthesis: re.synthesis ?? { maxReviseCycles: 2 },
        });
        if (dualResults.primary.paneId) {
          workerPaneIds.push(dualResults.primary.paneId);
          const wi = workersInfo[workerIndex];
          if (wi) { wi.pane_id = dualResults.primary.paneId; wi.worker_cli = assignment.agentType; wi.assigned_tasks = [String(Number(taskId) * 1000 + 1)]; }
        }
        continue;
      }
      // Fall through to single worker spawn below
    }

    // SINGLE_PLUS: resolve ladder step for model selection
    if (mode === 'SINGLE_PLUS' && re.ladder && re.ladder.length > 0) {
      const { classifyTaskShape } = await import('./role-router.js');
      const { estimateTaskComplexity } = await import('./dual-star-evaluator.js');
      const { resolveLadderStep } = await import('./ladder-resolver.js');
      const shape = classifyTaskShape(`${task.subject} ${task.description}`);
      const metrics = estimateTaskComplexity(task.subject, task.description);
      const ladderResult = resolveLadderStep(re.ladder, metrics, shape, 0);
      // Override model with ladder selection (single worker, just different model)
      assignment.model = ladderResult.model;
      assignment.agentType = ladderResult.provider as CliAgentType;
    }
    } // end routingEntry mode dispatch block

    const workerLaunch = await spawnV2Worker({
      sessionName,
      leaderPaneId,
      existingWorkerPaneIds: workerPaneIds,
      teamName: sanitized,
      workerName: wName,
      workerIndex,
      agentType: assignment.agentType,
      task,
      taskId,
      cwd: leaderCwd,
      workerCwd: workersInfo[workerIndex]?.working_dir ?? leaderCwd,
      worktreePath: workersInfo[workerIndex]?.worktree_path,
      autoMerge: Boolean(config.autoMerge),
      resolvedBinaryPaths,
      ...(assignment.model ? { model: assignment.model } : {}),
      ...(assignment.role ? { role: assignment.role } : {}),
    });

    if (workerLaunch.paneId) {
      workerPaneIds.push(workerLaunch.paneId);
      const workerInfo = workersInfo[workerIndex];
      if (workerInfo) {
        workerInfo.pane_id = workerLaunch.paneId;
        workerInfo.assigned_tasks = workerLaunch.startupAssigned ? [taskId] : [];
        workerInfo.worker_cli = assignment.agentType;
        if (workerLaunch.outputFile) {
          workerInfo.output_file = workerLaunch.outputFile;
        }
      }
    }

    if (workerLaunch.startupFailureReason) {
      const logEventFailure = createSwallowedErrorLogger(
        'team.runtime-v2.startTeamV2 appendTeamEvent failed',
      );
      appendTeamEvent(sanitized, {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: `startup_manual_intervention_required:${wName}:${workerLaunch.startupFailureReason}`,
      }, leaderCwd).catch(logEventFailure);
    }
    }
  } catch (error) {
    await rollbackStartedNativeWorktreeStartup({
      teamName: sanitized,
      cwd: leaderCwd,
      cause: error,
      sessionName,
      leaderPaneId,
      workerPaneIds,
      sessionMode: session.sessionMode,
    });
    throw error;
  }

  // Persist config with pane IDs
  teamConfig.workers = workersInfo;
  try {
    await saveTeamConfig(teamConfig, leaderCwd);
  } catch (error) {
    await rollbackStartedNativeWorktreeStartup({
      teamName: sanitized,
      cwd: leaderCwd,
      cause: error,
      sessionName,
      leaderPaneId,
      workerPaneIds,
      sessionMode: session.sessionMode,
    });
    throw error;
  }

  const logEventFailure = createSwallowedErrorLogger(
    'team.runtime-v2.startTeamV2 appendTeamEvent failed',
  );
  // Emit start event — NO watchdog, leader drives via monitorTeamV2()
  appendTeamEvent(sanitized, {
    type: 'team_leader_nudge',
    worker: 'leader-fixed',
    reason: `start_team_v2: workers=${config.workerCount} tasks=${config.tasks.length} panes=${workerPaneIds.length}`,
  }, leaderCwd).catch(logEventFailure);

  // Auto-merge orchestrator startup. Because --auto-merge is an explicit
  // safety opt-in, startup/registration failures are fatal: continuing would
  // leave users believing worker edits are being merged when they are not.
  if (config.autoMerge && autoMergeLeaderBranch) {
    try {
      await ensureLeaderInbox(sanitized, leaderCwd);
      // Seed an introductory leader-inbox note so the leader knows the inbox
      // exists and where to read it. This mirrors the worker bootstrap pattern.
      await appendToLeaderInbox(
        sanitized,
        extendLeaderBootstrapPrompt(sanitized),
        leaderCwd,
      );

      // M6: try to recover from a previous run before starting fresh.
      try {
        await recoverFromRestart({
          teamName: sanitized,
          repoRoot: leaderCwd,
          leaderBranch: autoMergeLeaderBranch,
          cwd: leaderCwd,
        });
      } catch (recErr) {
        process.stderr.write(`[team/runtime-v2] auto-merge recover-from-restart failed: ${recErr}\n`);
      }

      const orchestrator = await startMergeOrchestrator({
        teamName: sanitized,
        repoRoot: leaderCwd,
        leaderBranch: autoMergeLeaderBranch,
        cwd: leaderCwd,
      });
      registerTeamOrchestrator(sanitized, orchestrator);

      // Register every spawned worker (named worktree mode is enforced above
      // when autoMerge is on, so worker branches exist). A single failed
      // registration makes the auto-merge contract unsafe, so fail loudly.
      for (const w of workersInfo) {
        await orchestrator.registerWorker(w.name);
      }
    } catch (orchErr) {
      await stopTeamCadence(sanitized);
      unregisterTeamOrchestrator(sanitized);
      await rollbackStartedNativeWorktreeStartup({
        teamName: sanitized,
        cwd: leaderCwd,
        cause: orchErr,
        sessionName,
        leaderPaneId,
        workerPaneIds,
        sessionMode: session.sessionMode,
      });
      const reason = orchErr instanceof Error ? orchErr.message : String(orchErr);
      throw new Error(`auto-merge startup failed: ${reason}`);
    }
  }

  return {
    teamName: sanitized,
    sanitizedName: sanitized,
    sessionName,
    config: teamConfig,
    cwd: leaderCwd,
    ownsWindow: ownsWindow,
  };
}

// ---------------------------------------------------------------------------
// Circuit breaker — 3 consecutive failures -> write watchdog-failed.json
// ---------------------------------------------------------------------------

const CIRCUIT_BREAKER_THRESHOLD = 3;

export async function writeWatchdogFailedMarker(
  teamName: string,
  cwd: string,
  reason: string,
): Promise<void> {
  const { writeFile } = await import('fs/promises');
  const marker = {
    failedAt: Date.now(),
    reason,
    writtenBy: 'runtime-v2',
  };
  const root = absPath(cwd, TeamPaths.root(sanitizeTeamName(teamName)));
  const markerPath = join(root, 'watchdog-failed.json');
  await mkdir(root, { recursive: true });
  await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
}

/**
 * Circuit breaker context for tracking consecutive monitor failures.
 * The caller (runtime-cli v2 loop) should call recordSuccess on each
 * successful monitor cycle and recordFailure on each error. When the
 * threshold is reached, the breaker trips and writes watchdog-failed.json.
 */
export class CircuitBreakerV2 {
  private consecutiveFailures = 0;
  private tripped = false;

  constructor(
    private readonly teamName: string,
    private readonly cwd: string,
    private readonly threshold: number = CIRCUIT_BREAKER_THRESHOLD,
  ) {}

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  async recordFailure(reason: string): Promise<boolean> {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold && !this.tripped) {
      this.tripped = true;
      await writeWatchdogFailedMarker(this.teamName, this.cwd, reason);
      return true; // breaker tripped
    }
    return false;
  }

  isTripped(): boolean {
    return this.tripped;
  }
}

// ---------------------------------------------------------------------------
// Failure sidecars — requeue tasks from dead workers
// ---------------------------------------------------------------------------

/**
 * Requeue tasks from dead workers by writing failure sidecars and resetting
 * task status back to pending so they can be claimed by other workers.
 */
export async function requeueDeadWorkerTasks(
  teamName: string,
  deadWorkerNames: string[],
  cwd: string,
): Promise<string[]> {
  const logEventFailure = createSwallowedErrorLogger(
    'team.runtime-v2.requeueDeadWorkerTasks appendTeamEvent failed',
  );
  const sanitized = sanitizeTeamName(teamName);
  const tasks = await listTasksFromFiles(sanitized, cwd);
  const requeued: string[] = [];

  const deadSet = new Set(deadWorkerNames);

  for (const task of tasks) {
    if (task.status !== 'in_progress') continue;
    if (!task.owner || !deadSet.has(task.owner)) continue;

    // Write failure sidecar
    const sidecarPath = absPath(cwd, `${TeamPaths.tasks(sanitized)}/${task.id}.failure.json`);
    const sidecar = {
      taskId: task.id,
      lastError: `worker_dead:${task.owner}`,
      retryCount: 0,
      lastFailedAt: new Date().toISOString(),
    };
    const { writeFile } = await import('fs/promises');
    await mkdir(absPath(cwd, TeamPaths.tasks(sanitized)), { recursive: true });
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');

    // Reset task to pending (locked to prevent race with concurrent claimTask)
    const taskPath = absPath(cwd, TeamPaths.taskFile(sanitized, task.id));
    try {
      const { readFileSync, writeFileSync } = await import('fs');
      const { withFileLockSync } = await import('../lib/file-lock.js');
      withFileLockSync(taskPath + '.lock', () => {
        const raw = readFileSync(taskPath, 'utf-8');
        const taskData = JSON.parse(raw);
        // Only requeue if still in_progress — another worker may have already claimed it
        if (taskData.status === 'in_progress') {
          taskData.status = 'pending';
          taskData.owner = undefined;
          taskData.claim = undefined;
          writeFileSync(taskPath, JSON.stringify(taskData, null, 2), 'utf-8');
          requeued.push(task.id);
        }
      });
    } catch {
      // Task file may have been removed or lock failed; skip
    }

    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      task_id: task.id,
      reason: `requeue_dead_worker:${task.owner}`,
    }, cwd).catch(logEventFailure);
  }

  return requeued;
}

// ---------------------------------------------------------------------------
// AC-7: CLI worker verdict completion handler
// ---------------------------------------------------------------------------

export type CliWorkerVerdictStatus =
  | 'completed'
  | 'failed'
  | 'file_missing'
  | 'parse_failed'
  | 'no_in_progress_task'
  | 'already_terminal'
  | 'skipped';

export interface CliWorkerVerdictResult {
  workerName: string;
  taskId: string | null;
  status: CliWorkerVerdictStatus;
  verdict?: CliWorkerOutputPayload['verdict'];
  reason?: string;
}

/**
 * Post-exit handler for CLI workers that emitted a structured verdict
 * (AC-7). Scans workers whose panes have exited and whose WorkerInfo
 * carries `output_file`. For each:
 *   - Reads + validates the JSON payload via `parseCliWorkerVerdict`.
 *   - Locates the worker's in_progress task and writes a terminal status
 *     (completed for `approve`, failed for `revise`/`reject`) plus verdict
 *     metadata directly to the task file — the worker process is gone and
 *     cannot re-enter `transitionTaskStatus` with its claim token.
 *   - Renames `verdict.json` to `verdict.processed.json` so a subsequent
 *     monitor cycle does not reprocess it.
 *   - Emits a team event describing the outcome.
 * On parse failure, emits a warning event and leaves the task untouched
 * for human review (per plan AC-7).
 */
/**
 * Tri-state synthesis for DUAL mode verdicts.
 * Maps two worker verdicts to a single synthesis result.
 */
export function synthesizeDualVerdicts(
  primaryVerdict: 'approve' | 'concern' | 'block',
  secondaryVerdict: 'approve' | 'concern' | 'block',
  reviseCount: number,
  maxReviseCycles: number,
): 'completed' | 'needs_revise' | 'blocked_for_human' {
  // Both approve → pass
  if (primaryVerdict === 'approve' && secondaryVerdict === 'approve') return 'completed';
  // Approve + concern → pass with advisory note
  if (primaryVerdict === 'approve' && secondaryVerdict === 'concern') return 'completed';
  if (primaryVerdict === 'concern' && secondaryVerdict === 'approve') return 'completed';
  // Both concern → needs revise
  if (primaryVerdict === 'concern' && secondaryVerdict === 'concern') return 'needs_revise';
  // Any block: check revise cap
  if (primaryVerdict === 'block' || secondaryVerdict === 'block') {
    if (reviseCount >= maxReviseCycles) return 'blocked_for_human';
    return 'needs_revise';
  }
  return 'blocked_for_human';
}

export async function processCliWorkerVerdicts(
  teamName: string,
  cwd: string,
): Promise<CliWorkerVerdictResult[]> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return [];

  const results: CliWorkerVerdictResult[] = [];
  const logEventFailure = createSwallowedErrorLogger(
    'team.runtime-v2.processCliWorkerVerdicts appendTeamEvent failed',
  );

  const { rename } = await import('fs/promises');
  const { readFileSync, writeFileSync, existsSync: fsExistsSync } = await import('fs');
  const { withFileLockSync } = await import('../lib/file-lock.js');

  for (const worker of config.workers) {
    const outputFile = worker.output_file;
    if (!outputFile) continue;

    const liveness = await getWorkerPaneLiveness(worker.pane_id);
    if (liveness !== 'dead') continue;
    if (!fsExistsSync(outputFile)) {
      results.push({ workerName: worker.name, taskId: null, status: 'file_missing' });
      continue;
    }

    let payload: CliWorkerOutputPayload;
    try {
      const raw = await readFile(outputFile, 'utf-8');
      payload = parseCliWorkerVerdict(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await appendTeamEvent(sanitized, {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: `cli_worker_verdict_parse_failed:${worker.name}:${reason}`,
      }, cwd).catch(logEventFailure);
      results.push({ workerName: worker.name, taskId: null, status: 'parse_failed', reason });
      continue;
    }

    const candidateTaskIds = new Set<string>();
    if (payload.task_id) candidateTaskIds.add(payload.task_id);
    for (const id of worker.assigned_tasks ?? []) candidateTaskIds.add(id);

    let targetTaskId: string | null = null;
    let targetTaskPath: string | null = null;
    for (const taskId of candidateTaskIds) {
      const taskPath = absPath(cwd, TeamPaths.taskFile(sanitized, taskId));
      if (!fsExistsSync(taskPath)) continue;
      try {
        const taskRaw = readFileSync(taskPath, 'utf-8');
        const taskData = JSON.parse(taskRaw) as TeamTask;
        if (taskData.owner === worker.name && taskData.status === 'in_progress') {
          targetTaskId = taskId;
          targetTaskPath = taskPath;
          break;
        }
      } catch {
        // skip malformed task file
      }
    }

    if (!targetTaskId || !targetTaskPath) {
      await appendTeamEvent(sanitized, {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: `cli_worker_verdict_no_in_progress_task:${worker.name}:verdict=${payload.verdict}`,
      }, cwd).catch(logEventFailure);
      results.push({
        workerName: worker.name,
        taskId: payload.task_id,
        status: 'no_in_progress_task',
        verdict: payload.verdict,
      });
      continue;
    }

    const terminalStatus = (payload.verdict === 'approve' || payload.verdict === 'concern') ? 'completed' : 'failed';
    let transitionOk = false;
    try {
      withFileLockSync(targetTaskPath + '.lock', () => {
        const raw = readFileSync(targetTaskPath!, 'utf-8');
        const taskData = JSON.parse(raw) as Record<string, unknown>;
        if (taskData.status !== 'in_progress' || taskData.owner !== worker.name) {
          return;
        }
        const prevMetadata = (taskData.metadata && typeof taskData.metadata === 'object')
          ? taskData.metadata as Record<string, unknown>
          : {};
        taskData.status = terminalStatus;
        taskData.completed_at = new Date().toISOString();
        taskData.claim = undefined;
        taskData.metadata = {
          ...prevMetadata,
          verdict: payload.verdict,
          verdict_summary: payload.summary,
          verdict_findings: payload.findings,
          verdict_role: payload.role,
          verdict_source: 'cli_worker_output_contract',
        };
        if (terminalStatus === 'failed') {
          taskData.error = `cli_worker_verdict:${payload.verdict}:${payload.summary}`;
        }
        writeFileSync(targetTaskPath!, JSON.stringify(taskData, null, 2), 'utf-8');
        transitionOk = true;
      });
    } catch {
      // lock or filesystem failure — leave task in_progress, do not rename verdict file
    }

    if (!transitionOk) {
      results.push({
        workerName: worker.name,
        taskId: targetTaskId,
        status: 'already_terminal',
        verdict: payload.verdict,
      });
      continue;
    }

    await appendTeamEvent(sanitized, {
      type: terminalStatus === 'completed' ? 'task_completed' : 'task_failed',
      worker: worker.name,
      task_id: targetTaskId,
      reason: `cli_worker_verdict:${payload.verdict}`,
    }, cwd).catch(logEventFailure);

    // Fork: persist verdict-based report
    const { captureTaskReport: captureVerdictReport } = await import('./report-persistence.js');
    captureVerdictReport({
      teamName: sanitized,
      taskId: targetTaskId,
      workerName: worker.name,
      status: terminalStatus,
      result: payload.summary
        ? `${payload.verdict.toUpperCase()} (${payload.role ?? 'reviewer'}): ${payload.summary}${payload.findings ? '\n\n## Findings\n\n' + (Array.isArray(payload.findings) ? payload.findings.map((f: unknown) => typeof f === 'string' ? `- ${f}` : `- ${JSON.stringify(f)}`).join('\n') : String(payload.findings)) : ''}`
        : undefined,
      cwd,
    }).catch(() => { /* non-blocking */ });

    try {
      await rename(outputFile, outputFile + '.processed');
    } catch {
      // best-effort; reprocess is idempotent (already_terminal on rerun)
    }

    results.push({
      workerName: worker.name,
      taskId: targetTaskId,
      status: terminalStatus,
      verdict: payload.verdict,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// DUAL parent-task synthesis — called from monitor when all child tasks terminal
// ---------------------------------------------------------------------------

/**
 * Check all DUAL parent tasks and advance synthesis when all children are terminal.
 * Called from monitorTeamV2 after each task snapshot.
 */
// Dedup set: prevent same parent task from being synthesized twice in one monitor cycle.
const _dualSynthesisSeen = new Set<string>();

async function advanceDualParentSynthesis(
  teamName: string,
  cwd: string,
  allTasks: Array<{ id: string; status: string; parentTaskId?: string; metadata?: Record<string, unknown> }>,
): Promise<void> {
  // Clear seen set each cycle so stalled parents can be retried next cycle.
  // Within a single cycle, each parent ID is processed at most once.
  const cycleSeen = new Set<string>();
  const deps = {
    teamName, cwd,
    readTask: async (t: string, id: string, c: string) => {
      const { readFile } = await import('fs/promises');
      try {
        const raw = await readFile(absPath(c, TeamPaths.taskFile(t, id)), 'utf-8');
        return JSON.parse(raw) as TeamTask;
      } catch { return null; }
    },
    withTaskClaimLock: async <T>(_t: string, _id: string, _c: string, fn: () => Promise<T>) => {
      try { return { ok: true as const, value: await fn() }; } catch { return { ok: false as const }; }
    },
    normalizeTask: (t: TeamTask) => ({ ...t, version: (t as unknown as Record<string, unknown>).version as number ?? 0 }) as unknown as TeamTaskV2,
    canTransitionTaskStatus: canTransitionTeamTaskStatus,
    taskFilePath: (t: string, id: string, c: string) => absPath(c, TeamPaths.taskFile(t, id)),
    writeAtomic: async (p: string, d: string) => { const { writeFile } = await import('fs/promises'); await writeFile(p, d, 'utf-8'); },
  };

  // Step 1: dual_in_progress → dual_synthesis (all children terminal)
  const inProgressParents = allTasks.filter(t => t.status === 'dual_in_progress');
  for (const pt of inProgressParents) {
    if (cycleSeen.has(pt.id)) continue;
    cycleSeen.add(pt.id);
    const dualMeta = pt.metadata?.dual as Record<string, unknown> | undefined;
    const childIds: string[] = dualMeta?.childIds as string[] ?? [];
    if (childIds.length < 2) continue;
    const childTasks = childIds.map(id => allTasks.find(t => t.id === id)).filter(Boolean);
    if (childTasks.length < 2) continue;
    const allTerminal = childTasks.every(ct => ct && (ct.status === 'completed' || ct.status === 'failed'));
    if (!allTerminal) continue;
    await transitionParentTask(pt.id, 'dual_in_progress', 'dual_synthesis', undefined, deps).catch(() => {});
  }

  // Step 2: dual_synthesis → completed/failed (apply synthesizeDualVerdicts)
  const synthesisParents = allTasks.filter(t => t.status === 'dual_synthesis');
  for (const pt of synthesisParents) {
    if (cycleSeen.has(pt.id)) continue;
    cycleSeen.add(pt.id);
    const dualMeta = pt.metadata?.dual as Record<string, unknown> | undefined;
    const childIds: string[] = dualMeta?.childIds as string[] ?? [];
    const reviseCount: number = (dualMeta?.reviseCount as number) ?? 0;
    if (childIds.length < 2) continue;
    const childTasks = childIds.map(id => allTasks.find(t => t.id === id)).filter(Boolean);
    if (childTasks.length < 2) continue;

    // Map child verdicts to block/approve/concern
    const mapVerdict = (ct: typeof childTasks[0]): 'approve' | 'concern' | 'block' => {
      if (!ct) return 'block';
      const verdictMeta = ct.metadata as Record<string, unknown> | undefined;
      const v = verdictMeta?.verdict as string;
      if (v === 'approve') return 'approve';
      if (v === 'concern') return 'concern';
      // 'revise' and 'reject' from old contracts map to block
      return 'block';
    };

    const primaryVerdict = mapVerdict(childTasks[0]);
    const secondaryVerdict = mapVerdict(childTasks[1]);
    const maxRevise = (dualMeta?.maxReviseCycles as number) ?? 2;
    const result = synthesizeDualVerdicts(primaryVerdict, secondaryVerdict, reviseCount, maxRevise);

    if (result === 'completed') {
      await transitionParentTask(pt.id, 'dual_synthesis', 'completed', {
        completed_at: new Date().toISOString(),
      }, deps).catch(() => {});
    } else if (result === 'blocked_for_human') {
      await transitionParentTask(pt.id, 'dual_synthesis', 'failed', {
        metadata: { dual: { childIds, reviseCount, synthesis: 'blocked_for_human' } },
      }, deps).catch(() => {});
    } else if (result === 'needs_revise') {
      // Create new child task pair for the revision round.
      // Use parentId * 10000 + round * 2 to avoid collisions with other parents and sequential task files.
      const newBase = Number(pt.id) * 10000 + (reviseCount + 1) * 2;
      const newChildId1 = String(newBase);
      const newChildId2 = String(newBase + 1);
      try {
        for (const [cid, label] of [[newChildId1, 'primary'], [newChildId2, 'secondary']] as const) {
          const childPath = absPath(cwd, TeamPaths.taskFile(teamName, cid));
          const { writeFile } = await import('fs/promises');
          await writeFile(childPath, JSON.stringify({
            id: cid, subject: `[${label}] (revise ${reviseCount + 1}) task-${pt.id}`,
            description: `Revision round ${reviseCount + 1} for parent task ${pt.id}`,
            status: 'pending', parentTaskId: pt.id,
            created_at: new Date().toISOString(),
          }, null, 2));
        }
        await transitionParentTask(pt.id, 'dual_synthesis', 'dual_in_progress', {
          metadata: { dual: { childIds: [newChildId1, newChildId2], reviseCount: reviseCount + 1, synthesis: 'pending' } },
        }, deps).catch(() => {});
      } catch { /* non-blocking */ }
    }
  }
}

// ---------------------------------------------------------------------------
// monitorTeam — snapshot-based, event-driven (no watchdog)
// ---------------------------------------------------------------------------

/**
 * Take a single monitor snapshot of team state.
 * Caller drives the loop (e.g., runtime-cli poll interval or event trigger).
 */
export async function monitorTeamV2(
  teamName: string,
  cwd: string,
): Promise<TeamSnapshotV2 | null> {
  const monitorStartMs = performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;

  // AC-7: Convert CLI-worker verdict files into task transitions before counting.
  // Runs best-effort so monitor cycles never fail because of verdict handling.
  try {
    await processCliWorkerVerdicts(sanitized, cwd);
  } catch (err) {
    process.stderr.write(
      `[team/runtime-v2] processCliWorkerVerdicts failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);

  // Load all tasks
  const listTasksStartMs = performance.now();
  const allTasks = await listTasksFromFiles(sanitized, cwd);
  const listTasksMs = performance.now() - listTasksStartMs;

  const taskById = new Map(allTasks.map((task) => [task.id, task] as const));
  const inProgressByOwner = new Map<string, TeamTask[]>();
  for (const task of allTasks) {
    if (task.status !== 'in_progress' || !task.owner) continue;
    const existing = inProgressByOwner.get(task.owner) || [];
    existing.push(task);
    inProgressByOwner.set(task.owner, existing);
  }

  // Scan workers
  const workers: TeamSnapshotV2['workers'] = [];
  const deadWorkers: string[] = [];
  const nonReportingWorkers: string[] = [];
  const recommendations: string[] = [];

  const workerScanStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const liveness = await getWorkerPaneLiveness(worker.pane_id);
      const alive = liveness === 'alive';
      const [status, heartbeat, paneCapture] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
        alive ? captureWorkerPane(worker.pane_id) : Promise.resolve(''),
      ]);
      return { worker, alive, liveness, status, heartbeat, paneCapture };
    }),
  );
  const workerScanMs = performance.now() - workerScanStartMs;

  for (const { worker: w, alive, liveness, status, heartbeat, paneCapture } of workerSignals) {
    const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
    const outstandingTask = currentTask ?? findOutstandingWorkerTask(w, taskById, inProgressByOwner);
    const expectedTaskId = status.current_task_id ?? outstandingTask?.id ?? w.assigned_tasks[0] ?? '';
    const previousTurns = previousSnapshot ? (previousSnapshot.workerTurnCountByName[w.name] ?? 0) : null;
    const previousTaskId = previousSnapshot?.workerTaskIdByName[w.name] ?? '';
    const currentTaskId = status.current_task_id ?? '';
    const turnsWithoutProgress =
      heartbeat &&
      previousTurns !== null &&
      status.state === 'working' &&
      currentTask &&
      (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
      currentTaskId !== '' &&
      previousTaskId === currentTaskId
        ? Math.max(0, heartbeat.turn_count - previousTurns)
        : 0;

    workers.push({
      name: w.name,
      alive,
      liveness,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      working_dir: w.working_dir,
      worktree_repo_root: w.worktree_repo_root,
      worktree_path: w.worktree_path,
      worktree_branch: w.worktree_branch,
      worktree_detached: w.worktree_detached,
      worktree_created: w.worktree_created,
      team_state_root: w.team_state_root,
      turnsWithoutProgress,
    });

    if (liveness === 'dead') {
      deadWorkers.push(w.name);
      const deadWorkerTasks = inProgressByOwner.get(w.name) || [];
      for (const t of deadWorkerTasks) {
        recommendations.push(`Reassign task-${t.id} from dead ${w.name}`);
      }
    }

    const paneSuggestsIdle = alive && paneLooksReady(paneCapture) && !paneHasActiveTask(paneCapture);
    const statusFresh = isFreshTimestamp(status.updated_at);
    const heartbeatFresh = isFreshTimestamp(heartbeat?.last_turn_at);

    // Renew claim lease for in_progress tasks so long-running tasks
    // don't expire. For Claude workers this relies on heartbeatFresh;
    // for Codex workers (no heartbeat.json), use pane liveness + work
    // evidence (pane alive, not idle, status fresh) as a fallback.
    const paneActive = alive && !paneLooksReady(paneCapture) && statusFresh;
    if (currentTask?.status === 'in_progress' && (heartbeatFresh || paneActive)) {
      teamRenewTaskClaim(sanitized, currentTask.id, w.name, cwd).catch(() => {});
    }

    const hasWorkStartEvidence = expectedTaskId !== '' && hasWorkerStatusProgress(status, expectedTaskId);
    const missingDependencyIds = outstandingTask
      ? getMissingDependencyIds(outstandingTask, taskById)
      : [];

    let stallReason: string | null = null;
    if (paneSuggestsIdle && missingDependencyIds.length > 0) {
      stallReason = 'missing_dependency';
    } else if (paneSuggestsIdle && expectedTaskId !== '' && !hasWorkStartEvidence) {
      stallReason = 'no_work_start_evidence';
    } else if (paneSuggestsIdle && expectedTaskId !== '' && (!statusFresh || !heartbeatFresh)) {
      stallReason = 'stale_or_missing_worker_reports';
    } else if (paneSuggestsIdle && turnsWithoutProgress > 5) {
      stallReason = 'no_meaningful_turn_progress';
    }

    if (stallReason) {
      nonReportingWorkers.push(w.name);
      if (stallReason === 'missing_dependency') {
        recommendations.push(
          `Investigate ${w.name}: task-${outstandingTask?.id ?? expectedTaskId} is blocked by missing task ids [${missingDependencyIds.join(', ')}]; pane is idle at prompt`,
        );
      } else if (stallReason === 'no_work_start_evidence') {
        recommendations.push(`Investigate ${w.name}: assigned work but no work-start evidence; pane is idle at prompt`);
      } else if (stallReason === 'stale_or_missing_worker_reports') {
        recommendations.push(`Investigate ${w.name}: pane is idle while status/heartbeat are stale or missing`);
      } else {
        recommendations.push(`Investigate ${w.name}: no meaningful turn progress and pane is idle at prompt`);
      }
    }
  }

  // Count tasks
  const taskCounts = {
    total: allTasks.length,
    pending: allTasks.filter((t) => t.status === 'pending').length,
    blocked: allTasks.filter((t) => t.status === 'blocked').length,
    in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
    completed: allTasks.filter((t) => t.status === 'completed').length,
    failed: allTasks.filter((t) => t.status === 'failed').length,
    dual: allTasks.filter((t) =>
      t.status === 'dual_pending' || t.status === 'dual_in_progress' || t.status === 'dual_synthesis'
    ).length,
  };

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 &&
    taskCounts.in_progress === 0 && taskCounts.dual === 0;

  // Advance DUAL parent tasks whose children have all completed
  advanceDualParentSynthesis(sanitized, cwd, allTasks).catch(() => { /* non-blocking */ });

  for (const task of allTasks) {
    const missingDependencyIds = getMissingDependencyIds(task, taskById);
    if (missingDependencyIds.length === 0) {
      continue;
    }

    recommendations.push(
      `Investigate task-${task.id}: depends on missing task ids [${missingDependencyIds.join(', ')}]`,
    );
  }

  // Infer phase from task distribution
  const phase = inferPhase(allTasks.map((t) => ({
    status: t.status,
    metadata: undefined,
  })));

  // Emit monitor-derived events (task completions, worker state changes)
  await emitMonitorDerivedEvents(
    sanitized,
    allTasks,
    workers.map((w) => ({ name: w.name, alive: w.alive, liveness: w.liveness, status: w.status })),
    previousSnapshot,
    cwd,
  );

  // Persist snapshot for next cycle
  const updatedAt = new Date().toISOString();
  const totalMs = performance.now() - monitorStartMs;
  await writeMonitorSnapshot(sanitized, {
    taskStatusById: Object.fromEntries(allTasks.map((t) => [t.id, t.status])),
    workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
    workerLivenessByName: Object.fromEntries(workers.map((w) => [w.name, w.liveness])),
    workerStateByName: Object.fromEntries(workers.map((w) => [w.name, w.status.state])),
    workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.name, w.heartbeat?.turn_count ?? 0])),
    workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.name, w.status.current_task_id ?? ''])),
    mailboxNotifiedByMessageId: previousSnapshot?.mailboxNotifiedByMessageId ?? {},
    completedEventTaskIds: previousSnapshot?.completedEventTaskIds ?? {},
    monitorTimings: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      mailbox_delivery_ms: 0,
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt,
    },
  }, cwd);

  return {
    teamName: sanitized,
    phase,
    workers,
    tasks: {
      ...taskCounts,
      items: allTasks,
    },
    allTasksTerminal,
    deadWorkers,
    nonReportingWorkers,
    recommendations,
    performance: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// shutdownTeam — graceful shutdown with gate, ack, force kill
// ---------------------------------------------------------------------------

/**
 * Graceful team shutdown:
 * 1. Shutdown gate check (unless force)
 * 2. Send shutdown request to all workers via inbox
 * 3. Wait for ack or timeout
 * 4. Force kill remaining tmux panes
 * 5. Clean up state
 */
export async function shutdownTeamV2(
  teamName: string,
  cwd: string,
  options: ShutdownOptionsV2 = {},
): Promise<void> {
  const logEventFailure = createSwallowedErrorLogger(
    'team.runtime-v2.shutdownTeamV2 appendTeamEvent failed',
  );
  const force = options.force === true;
  const ralph = options.ralph === true;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);

  const finalizeAutoMerge = async (): Promise<void> => {
    const orchestrator = getTeamOrchestrator(sanitized);
    if (orchestrator) {
      try {
        const drainResult = await orchestrator.drainAndStop();
        if (drainResult.unmerged.length > 0) {
          await appendTeamEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: `auto_merge_drain_unmerged:${drainResult.unmerged.map((u) => `${u.workerName}:${u.reason}`).join(',')}`,
          }, cwd).catch(logEventFailure);
        }
        for (const w of config?.workers ?? []) {
          try {
            await orchestrator.unregisterWorker(w.name);
          } catch (err) {
            process.stderr.write(
              `[team/runtime-v2] orchestrator.unregisterWorker(${w.name}) failed: ${err}\n`,
            );
          }
        }
      } catch (err) {
        process.stderr.write(`[team/runtime-v2] orchestrator drainAndStop: ${err}\n`);
      } finally {
        await stopTeamCadence(sanitized);
        unregisterTeamOrchestrator(sanitized);
      }
    } else {
      await stopTeamCadence(sanitized);
    }
  };

  if (!config) {
    // No config means worker liveness cannot be proven. Worktree metadata and
    // root AGENTS backups live under the scoped state tree, so use non-mutating
    // inspection and preserve state whenever any worktree recovery evidence exists.
    const cleanupSafety = inspectTeamWorktreeCleanupSafety(sanitized, cwd);
    if (cleanupSafety.hasEvidence) {
      process.stderr.write('[team/runtime-v2] preserving team state because config is missing and worktree cleanup evidence remains\n');
      return;
    }
    await cleanupTeamCodexMirrors(cwd, sanitized);
    await cleanupTeamState(sanitized, cwd);
    return;
  }

  // 1. Shutdown gate check
  if (!force) {
    const allTasks = await listTasksFromFiles(sanitized, cwd);
    const governance = getConfigGovernance(config);
    const gate: ShutdownGateCounts = {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === 'pending').length,
      blocked: allTasks.filter((t) => t.status === 'blocked').length,
      in_progress: allTasks.filter((t) =>
        t.status === 'in_progress' || t.status === 'dual_pending' || t.status === 'dual_in_progress' || t.status === 'dual_synthesis'
      ).length,
      completed: allTasks.filter((t) => t.status === 'completed').length,
      failed: allTasks.filter((t) => t.status === 'failed').length,
      allowed: false,
    };
    gate.allowed = gate.pending === 0 && gate.blocked === 0 && gate.in_progress === 0 && gate.failed === 0;

    await appendTeamEvent(sanitized, {
      type: 'shutdown_gate',
      worker: 'leader-fixed',
      reason: `allowed=${gate.allowed} total=${gate.total} pending=${gate.pending} blocked=${gate.blocked} in_progress=${gate.in_progress} completed=${gate.completed} failed=${gate.failed}${ralph ? ' policy=ralph' : ''}`,
    }, cwd).catch(logEventFailure);

    if (!gate.allowed) {
      const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
      if (!governance.cleanup_requires_all_workers_inactive) {
        await appendTeamEvent(sanitized, {
          type: 'team_leader_nudge',
          worker: 'leader-fixed',
          reason: `cleanup_override_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
        }, cwd).catch(logEventFailure);
      } else if (ralph && !hasActiveWork) {
        // Ralph policy: bypass on failure-only scenarios
        await appendTeamEvent(sanitized, {
          type: 'team_leader_nudge',
          worker: 'leader-fixed',
          reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
        }, cwd).catch(logEventFailure);
      } else {
        throw new Error(
          `shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
        );
      }
    }
  }

  if (force) {
    await appendTeamEvent(sanitized, {
      type: 'shutdown_gate_forced',
      worker: 'leader-fixed',
      reason: 'force_bypass',
    }, cwd).catch(logEventFailure);
  }

  // 2. Send shutdown request to each worker
  const shutdownRequestTimes = new Map<string, string>();
  for (const w of config.workers) {
    try {
      const requestedAt = new Date().toISOString();
      await writeShutdownRequest(sanitized, w.name, 'leader-fixed', cwd);
      shutdownRequestTimes.set(w.name, requestedAt);
      // Write shutdown inbox
      const shutdownAckPath = w.worktree_path
        ? `$OMC_TEAM_STATE_ROOT/workers/${w.name}/shutdown-ack.json`
        : TeamPaths.shutdownAck(sanitized, w.name);
      const shutdownInbox = `# Shutdown Request\n\nAll tasks are complete. Please wrap up and respond with a shutdown acknowledgement.\n\nWrite your ack to: ${shutdownAckPath}\nFormat: {"status":"accept","reason":"ok","updated_at":"<iso>"}\n\nThen exit your session.\n`;
      await writeWorkerInbox(sanitized, w.name, shutdownInbox, cwd);
    } catch (err) {
      process.stderr.write(`[team/runtime-v2] shutdown request failed for ${w.name}: ${err}\n`);
    }
  }

  // 3. Wait for ack or timeout
  const deadline = Date.now() + timeoutMs;
  const rejected: Array<{ worker: string; reason: string }> = [];
  const ackedWorkers = new Set<string>();

  while (Date.now() < deadline) {
    for (const w of config.workers) {
      if (ackedWorkers.has(w.name)) continue;
      const ack = await readShutdownAck(sanitized, w.name, cwd, shutdownRequestTimes.get(w.name));
      if (ack) {
        ackedWorkers.add(w.name);
        await appendTeamEvent(sanitized, {
          type: 'shutdown_ack',
          worker: w.name,
          reason: ack.status === 'reject' ? `reject:${ack.reason || 'no_reason'}` : 'accept',
        }, cwd).catch(logEventFailure);
        if (ack.status === 'reject') {
          rejected.push({ worker: w.name, reason: ack.reason || 'no_reason' });
        }
      }
    }

    if (rejected.length > 0 && !force) {
      const detail = rejected.map((r) => `${r.worker}:${r.reason}`).join(',');
      throw new Error(`shutdown_rejected:${detail}`);
    }

    // Check if all workers have acked or exited
    const allDone = config.workers.every((w) => ackedWorkers.has(w.name));
    if (allDone) break;

    await new Promise((r) => setTimeout(r, 2_000));
  }

  // 4. Force kill remaining tmux panes
  const recordedWorkerPaneIds = config.workers
    .map((w) => w.pane_id)
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  try {
    const { killWorkerPanes, killTeamSession, resolveSplitPaneWorkerPaneIds, getWorkerLiveness } = await import('./tmux-session.js');
    const ownsWindow = config.tmux_window_owned === true;
    const workerPaneIds = ownsWindow
      ? recordedWorkerPaneIds
      : await resolveSplitPaneWorkerPaneIds(
        config.tmux_session,
        recordedWorkerPaneIds,
        config.leader_pane_id ?? undefined,
      );
    await killWorkerPanes({
      paneIds: workerPaneIds,
      leaderPaneId: config.leader_pane_id ?? undefined,
      teamName: sanitized,
      cwd,
    });
    if (config.tmux_session && (ownsWindow || !config.tmux_session.includes(':'))) {
      const sessionMode = ownsWindow
        ? (config.tmux_session.includes(':') ? 'dedicated-window' : 'detached-session')
        : 'detached-session';
      await killTeamSession(
        config.tmux_session,
        workerPaneIds,
        config.leader_pane_id ?? undefined,
        { sessionMode },
      );
    }
    const paneById = new Map(config.workers
      .filter((w) => typeof w.pane_id === 'string' && w.pane_id.trim().length > 0)
      .map((w) => [w.pane_id as string, w.name]));
    const liveness = await Promise.all(workerPaneIds.map(async (paneId) => [paneId, await getWorkerLiveness(paneId)] as const));
    const aliveWorkers = liveness
      .filter(([, state]) => state === 'alive')
      .map(([paneId]) => paneById.get(paneId) ?? paneId);
    if (aliveWorkers.length > 0) {
      process.stderr.write(`[team/runtime-v2] preserving worktrees/state because worker pane(s) are still alive: ${aliveWorkers.join(', ')}
`);
      await finalizeAutoMerge();
      return;
    }
    const unknownWorkers = liveness
      .filter(([, state]) => state === 'unknown')
      .map(([paneId]) => paneById.get(paneId) ?? paneId);
    if (unknownWorkers.length > 0) {
      process.stderr.write(`[team/runtime-v2] preserving worktrees/state because worker pane liveness is unknown: ${unknownWorkers.join(', ')}
`);
      await finalizeAutoMerge();
      return;
    }
  } catch (err) {
    process.stderr.write(`[team/runtime-v2] tmux cleanup: ${err}\n`);
    if (recordedWorkerPaneIds.length > 0) {
      process.stderr.write('[team/runtime-v2] preserving worktrees/state because tmux cleanup did not prove worker panes exited\n');
      await finalizeAutoMerge();
      return;
    }
  }

  // 5. Ralph completion logging
  if (ralph) {
    const finalTasks = await listTasksFromFiles(sanitized, cwd).catch(() => [] as TeamTask[]);
    const completed = finalTasks.filter((t) => t.status === 'completed').length;
    const failed = finalTasks.filter((t) => t.status === 'failed').length;
    const pending = finalTasks.filter((t) => t.status === 'pending').length;
    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `ralph_cleanup_summary: total=${finalTasks.length} completed=${completed} failed=${failed} pending=${pending} force=${force}`,
    }, cwd).catch(logEventFailure);
  }

  // 6a. Drain the merge orchestrator (if attached). Final merge sweep before
  // cleanupTeamWorktrees touches per-worker worktrees. Also used by preserve-state
  // exits above so auto-merge shutdown is not skipped when pane liveness is unknown.
  await finalizeAutoMerge();

  // 6. Clean up state. If worktree cleanup preserved dirty worktrees, keep the
  // team state directory too; it contains the metadata and root AGENTS.md backups
  // needed for a later safe cleanup attempt.
  let preservedWorktrees = 0;
  try {
    const worktreeCleanup = cleanupTeamWorktrees(sanitized, cwd);
    preservedWorktrees = worktreeCleanup.preserved.length;
  } catch (err) {
    preservedWorktrees = 1;
    process.stderr.write(`[team/runtime-v2] worktree cleanup: ${err}\n`);
  }
  if (preservedWorktrees === 0) {
    await cleanupTeamCodexMirrors(cwd, sanitized);
    await cleanupTeamState(sanitized, cwd);
  } else {
    process.stderr.write(`[team/runtime-v2] preserved ${preservedWorktrees} worktree(s); keeping team state for follow-up cleanup\n`);
  }
}

// ---------------------------------------------------------------------------
// resumeTeam — reconstruct runtime from persisted state
// ---------------------------------------------------------------------------

export async function resumeTeamV2(
  teamName: string,
  cwd: string,
): Promise<TeamRuntimeV2 | null> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;

  // Verify tmux session is alive
  try {
    const sessionName = config.tmux_session || `omc-team-${sanitized}`;
    await tmuxExecAsync(['has-session', '-t', sessionName.split(':')[0]]);

    return {
      teamName: sanitized,
      sanitizedName: sanitized,
      sessionName,
      ownsWindow: config.tmux_window_owned === true,
      config,
      cwd,
    };
  } catch {
    return null; // Session not alive
  }
}

// ---------------------------------------------------------------------------
// findActiveTeams — discover running teams
// ---------------------------------------------------------------------------

export async function findActiveTeamsV2(cwd: string): Promise<string[]> {
  const root = join(getOmcRoot(cwd), 'state', 'team');
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const active: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const teamName = e.name;
    const config = await readTeamConfig(teamName, cwd);
    if (config) {
      active.push(teamName);
    }
  }
  return active;
}

// ---------------------------------------------------------------------------
// waitForTeamCompletion — pure TS event-driven team lifecycle
// ---------------------------------------------------------------------------

export interface WaitForTeamOptions {
  teamName: string;
  cwd: string;
  /** Task ID to wait for. Default: '1' (root/parent task). */
  taskId?: string;
  /** Total timeout in ms. Default: 30 min. */
  timeoutMs?: number;
  /** Poll fallback interval in ms. Default: 5s. */
  fallbackMs?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface WaitForTeamResult {
  status: 'completed' | 'failed' | 'timeout';
  taskId: string;
  result?: string;
  error?: string;
}

/**
 * Wait for a team task to reach terminal state, then auto-shutdown.
 * Uses fs.watch (event-driven, <1s latency) with setInterval fallback.
 * Calls monitorTeamV2() internally to drive DUAL synthesis.
 */
export async function waitForTeamCompletion(
  opts: WaitForTeamOptions,
): Promise<WaitForTeamResult> {
  const sanitized = sanitizeTeamName(opts.teamName);
  const taskId = opts.taskId ?? '1';
  const taskDir = absPath(opts.cwd, TeamPaths.tasks(sanitized));
  const taskFile = absPath(opts.cwd, TeamPaths.taskFile(sanitized, taskId));
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60 * 1000);
  const fallbackMs = opts.fallbackMs ?? 5000;
  let pendingCheck = false;
  let resolved = false;
  let watcher: ReturnType<typeof watch> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const logEventFailure = createSwallowedErrorLogger(
    'team.runtime-v2.waitForTeamCompletion',
  );

  const cleanup = (): void => {
    watcher?.close();
    watcher = undefined;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    opts.signal?.removeEventListener('abort', onAbort);
  };

  const finish = async (status: 'completed' | 'failed' | 'timeout'): Promise<WaitForTeamResult> => {
    if (resolved) return { status, taskId };
    resolved = true;
    cleanup();

    const result: WaitForTeamResult = { status, taskId };
    try {
      const raw = await readFile(taskFile, 'utf-8');
      const t = JSON.parse(raw) as TeamTask;
      result.result = t.result;
      result.error = t.error;
    } catch { /* best effort */ }

    // Auto-shutdown
    try {
      await shutdownTeamV2(sanitized, opts.cwd, { force: status !== 'completed' });
    } catch (err) {
      logEventFailure(err);
    }

    return result;
  };

  const checkOnce = async (): Promise<boolean> => {
    const snap = await monitorTeamV2(sanitized, opts.cwd);
    if (!snap) return false;
    if (snap.allTasksTerminal) return true;
    // Also check the specific task file directly as a fast path
    try {
      const raw = await readFile(taskFile, 'utf-8');
      const task = JSON.parse(raw) as TeamTask;
      if (task.status === 'completed' || task.status === 'failed') return true;
    } catch { /* task file may not exist yet */ }
    return false;
  };

  const onAbort = (): void => {
    finish('timeout').catch(logEventFailure);
  };

  opts.signal?.addEventListener('abort', onAbort, { once: true });

  // ---- 主路径：fs.watch ----
  if (typeof watch === 'function') {
    try {
      watcher = watch(taskDir, (_event, filename) => {
        if (filename && filename.startsWith('task-')) {
          pendingCheck = true;
        }
      });
    } catch {
      // fs.watch unavailable → fall through to poll-only
    }
  }

  // ---- poll loop（主路径 + 降级共用） ----
  return new Promise((resolve) => {
    pollTimer = setInterval(async () => {
      if (Date.now() > deadline) {
        resolve(await finish('timeout'));
        return;
      }
      // Debounce: if fs.watch hasn't signaled and we're not on fallback-only, skip
      if (!pendingCheck && watcher && !resolved) return;
      pendingCheck = false;

      try {
        const terminal = await checkOnce();
        if (terminal) {
          resolve(await finish('completed'));
        }
      } catch (err) {
        logEventFailure(err);
      }
    }, fallbackMs);
  });
}
