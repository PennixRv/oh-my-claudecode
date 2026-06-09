/**
 * CLI entry point for team runtime.
 * Reads JSON config from stdin, runs startTeam/monitorTeam/shutdownTeam,
 * writes structured JSON result to stdout.
 *
 * Bundled as CJS via esbuild (scripts/build-runtime-cli.mjs).
 */
export declare function assertAutoMergeRuntimeSupported(useV2: boolean, autoMerge: boolean): void;
interface TaskResult {
    taskId: string;
    status: string;
    summary: string;
}
interface CliOutput {
    status: 'completed' | 'failed';
    teamName: string;
    taskResults: TaskResult[];
    duration: number;
    workerCount: number;
}
export type TerminalPhaseResult = 'complete' | 'failed' | 'cancelled';
export interface TerminalCliResult {
    output: CliOutput;
    exitCode: number;
    notice: string;
}
type TerminalStatus = 'completed' | 'failed' | null;
export declare function getTerminalStatus(taskCounts: {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
}, expectedTaskCount: number): TerminalStatus;
export declare function checkWatchdogFailedMarker(stateRoot: string, startTime: number): Promise<{
    failed: boolean;
    reason?: string;
}>;
export declare function writeResultArtifact(output: CliOutput, finishedAt: string, jobId?: string | undefined, omcJobsDir?: string | undefined): Promise<void>;
export declare function buildCliOutput(stateRoot: string, teamName: string, status: 'completed' | 'failed', workerCount: number, startTimeMs: number): CliOutput;
export declare function buildTerminalCliResult(stateRoot: string, teamName: string, phase: TerminalPhaseResult, workerCount: number, startTimeMs: number): TerminalCliResult;
/**
 * A task "final" is terse when it carries no substantive content: empty/
 * whitespace, or a bare acknowledgement like "Done." / "Ready." / "OK".
 * Such finals hide the real work that lives in the task's `.output` file,
 * so they are candidates for substitution. Anything else is treated as a
 * substantive final and preserved as-is.
 */
export declare function isTerseFinalSummary(summary: string): boolean;
/**
 * Locate the newest `.output` file recorded for a task under the team's
 * outputs directory and return its (bounded) content. Returns null when no
 * non-empty output file exists. Best-effort: never throws.
 */
export declare function readTaskOutputFallback(outputsDir: string, teamName: string, taskId: string): string | null;
export {};
//# sourceMappingURL=runtime-cli.d.ts.map