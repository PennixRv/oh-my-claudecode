import type { TeamTaskStatus } from '../contracts.js';
import type { TeamTask, TeamTaskV2, TaskReadiness, ClaimTaskResult, TransitionTaskResult, ReleaseTaskClaimResult, TeamMonitorSnapshotState } from '../types.js';
interface TaskReadDeps {
    readTask: (teamName: string, taskId: string, cwd: string) => Promise<TeamTask | null>;
}
export declare function computeTaskReadiness(teamName: string, taskId: string, cwd: string, deps: TaskReadDeps): Promise<TaskReadiness>;
interface ClaimTaskDeps extends TaskReadDeps {
    teamName: string;
    cwd: string;
    readTeamConfig: (teamName: string, cwd: string) => Promise<{
        workers: Array<{
            name: string;
        }>;
    } | null>;
    withTaskClaimLock: <T>(teamName: string, taskId: string, cwd: string, fn: () => Promise<T>) => Promise<{
        ok: true;
        value: T;
    } | {
        ok: false;
    }>;
    normalizeTask: (task: TeamTask) => TeamTaskV2;
    isTerminalTaskStatus: (status: TeamTaskStatus) => boolean;
    taskFilePath: (teamName: string, taskId: string, cwd: string) => string;
    writeAtomic: (path: string, data: string) => Promise<void>;
}
export declare function claimTask(taskId: string, workerName: string, expectedVersion: number | null, deps: ClaimTaskDeps): Promise<ClaimTaskResult>;
interface TransitionDeps extends ClaimTaskDeps {
    canTransitionTaskStatus: (from: TeamTaskStatus, to: TeamTaskStatus) => boolean;
    appendTeamEvent: (teamName: string, event: {
        type: 'task_completed' | 'task_failed';
        worker: string;
        task_id?: string;
        message_id?: string | null;
        reason?: string;
    }, cwd: string) => Promise<unknown>;
    readMonitorSnapshot: (teamName: string, cwd: string) => Promise<TeamMonitorSnapshotState | null>;
    writeMonitorSnapshot: (teamName: string, snapshot: TeamMonitorSnapshotState, cwd: string) => Promise<void>;
}
export declare function transitionTaskStatus(taskId: string, from: TeamTaskStatus, to: TeamTaskStatus, claimToken: string, terminalData: {
    result?: string;
    error?: string;
} | undefined, deps: TransitionDeps): Promise<TransitionTaskResult>;
type ReleaseDeps = ClaimTaskDeps;
export declare function releaseTaskClaim(taskId: string, claimToken: string, _workerName: string, deps: ReleaseDeps): Promise<ReleaseTaskClaimResult>;
export declare function listTasks(teamName: string, cwd: string, deps: {
    teamDir: (teamName: string, cwd: string) => string;
    isTeamTask: (value: unknown) => value is TeamTask;
    normalizeTask: (task: TeamTask) => TeamTaskV2;
}): Promise<TeamTask[]>;
export declare const CLAIM_TTL_MS: number;
export declare const CLAIM_GRACE_MS: number;
/**
 * Renew the claim lease for a task owned by the given worker.
 * Called from the heartbeat path so long-running tasks stay claimed.
 * Does NOT require the claim token — only the worker identity.
 */
export declare function renewTaskClaim(teamName: string, taskId: string, workerName: string, cwd: string, deps: TransitionDeps): Promise<boolean>;
export {};
//# sourceMappingURL=tasks.d.ts.map