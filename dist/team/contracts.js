export const TEAM_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const WORKER_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TASK_ID_SAFE_PATTERN = /^\d{1,20}$/;
export const TEAM_TASK_STATUSES = [
    'pending', 'blocked', 'in_progress', 'completed', 'failed',
    // DUAL parent task statuses (system-only, not for worker claim/transition)
    'dual_pending', 'dual_in_progress', 'dual_synthesis',
];
export const TEAM_TERMINAL_TASK_STATUSES = new Set(['completed', 'failed']);
/** Statuses that indicate a DUAL parent task — used for gates that need to differentiate. */
export const TEAM_DUAL_TASK_STATUSES = new Set(['dual_pending', 'dual_in_progress', 'dual_synthesis']);
/** Statuses that should block team shutdown (non-terminal, including dual workflow states). */
export const TEAM_ACTIVE_TASK_STATUSES = new Set([
    'pending', 'blocked', 'in_progress', 'dual_pending', 'dual_in_progress', 'dual_synthesis',
]);
export const TEAM_TASK_STATUS_TRANSITIONS = {
    pending: [],
    blocked: [],
    in_progress: ['completed', 'failed'],
    completed: [],
    failed: [],
    // DUAL parent task transitions (system-only via transitionParentTask)
    dual_pending: ['dual_in_progress', 'failed'],
    dual_in_progress: ['dual_synthesis', 'failed'],
    dual_synthesis: ['completed', 'failed', 'dual_in_progress'],
};
export function isTerminalTeamTaskStatus(status) {
    return TEAM_TERMINAL_TASK_STATUSES.has(status);
}
export function canTransitionTeamTaskStatus(from, to) {
    return TEAM_TASK_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
/** Returns true when a task is a DUAL parent (not claimable by workers). */
export function isDualParentTask(status) {
    return TEAM_DUAL_TASK_STATUSES.has(status);
}
export const TEAM_EVENT_TYPES = [
    'task_completed',
    'task_failed',
    'worker_idle',
    'worker_stopped',
    'message_received',
    'shutdown_ack',
    'shutdown_gate',
    'shutdown_gate_forced',
    'approval_decision',
    'team_leader_nudge',
];
export const TEAM_TASK_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];
//# sourceMappingURL=contracts.js.map