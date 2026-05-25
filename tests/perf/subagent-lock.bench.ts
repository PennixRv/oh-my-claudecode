/**
 * Benchmark: subagent-tracking RMW latency under no contention.
 *
 * Measures per-update wall time for N=100 sequential updates and asserts
 * p99 ≤ 8ms on Linux. On Windows and macOS, the p99 is logged without failing
 * (lock overhead varies significantly across platforms).
 */

import { describe, it, expect, afterEach } from "vitest";
import { performance } from "perf_hooks";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readTrackingState,
  writeTrackingState,
  flushPendingWrites,
  executeFlush,
  type SubagentTrackingState,
} from "../../src/hooks/subagent-tracker/index.js";
import { resolveSessionStatePaths } from "../../src/lib/worktree-paths.js";
import { lockPathFor } from "../../src/lib/file-lock.js";

const N = 100;
const P99_LIMIT_MS = 8;

function makeEmptyState(): SubagentTrackingState {
  return {
    agents: [],
    total_spawned: 0,
    total_completed: 0,
    total_failed: 0,
    last_updated: new Date().toISOString(),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

describe("subagent-lock benchmark", () => {
  const dirs: string[] = [];

  afterEach(() => {
    flushPendingWrites();
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  function makeTempDir(): string {
    const dir = join(tmpdir(), `omc-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Create the .omc/state dir so resolveSessionStatePaths can resolve paths
    mkdirSync(join(dir, ".omc", "state"), { recursive: true });
    dirs.push(dir);
    return dir;
  }

  /**
   * Run N sequential executeFlush calls and return sorted per-update timings.
   */
  function runBenchmark(dir: string, sessionId: string): number[] {
    const samples: number[] = [];

    for (let i = 0; i < N; i++) {
      const state = makeEmptyState();
      state.agents.push({
        agent_id: `agent-${i}`,
        agent_type: "oh-my-claudecode:executor",
        started_at: new Date().toISOString(),
        parent_mode: "ultrawork",
        status: "running",
        task_description: `task-${i}`,
      });
      state.total_spawned = i + 1;

      const t0 = performance.now();
      // executeFlush does the full RMW critical section under lock
      executeFlush(dir, state, sessionId);
      const elapsed = performance.now() - t0;
      samples.push(elapsed);
    }

    return samples.slice().sort((a, b) => a - b);
  }

  // Linux-only hard assert
  it.runIf(process.platform === "linux")(
    `p99 of ${N} sequential locked updates ≤ ${P99_LIMIT_MS}ms (Linux)`,
    () => {
      const dir = makeTempDir();
      const sessionId = `bench-session-${Date.now()}`;

      const sorted = runBenchmark(dir, sessionId);
      const p99 = percentile(sorted, 99);
      const p50 = percentile(sorted, 50);

      console.log(`[subagent-lock bench] Linux p50=${p50.toFixed(3)}ms  p99=${p99.toFixed(3)}ms  N=${N}`);

      expect(p99).toBeLessThanOrEqual(P99_LIMIT_MS);
    },
  );

  // All platforms: log p99 without failing
  it("logs p99 latency on all platforms (informational)", () => {
    const dir = makeTempDir();
    const sessionId = `bench-session-${Date.now()}`;

    const sorted = runBenchmark(dir, sessionId);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const max = sorted[sorted.length - 1] ?? 0;

    console.log(
      `[subagent-lock bench] platform=${process.platform}  N=${N}` +
      `  p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  p99=${p99.toFixed(3)}ms  max=${max.toFixed(3)}ms`,
    );

    // Sanity: p99 must always be positive and less than 30s (catches hangs)
    expect(p99).toBeGreaterThan(0);
    expect(p99).toBeLessThan(30_000);
  });
});
