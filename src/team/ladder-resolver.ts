/**
 * SINGLE+ ladder resolver — selects the appropriate ladder step
 * based on task complexity metrics.
 */
import type { LadderStep, LadderTrigger } from '../shared/types.js';
import type { TaskShape } from './role-router.js';
import type { TaskShapeMetrics } from './dual-star-evaluator.js';

export interface LadderResolutionResult {
  selectedStep: number;
  model: string;
  provider: string;
  thinkingDepth?: 'low' | 'medium' | 'high' | 'xhigh';
  reason: string;
}

/**
 * Resolve the ladder step for a task. Walks from highest step downward;
 * the first step where all triggers match wins.
 */
export function resolveLadderStep(
  ladder: LadderStep[],
  metrics: TaskShapeMetrics,
  shape: TaskShape,
  priorFailureCount?: number,
): LadderResolutionResult {
  if (!ladder || ladder.length === 0) {
    return { selectedStep: 0, model: '', provider: 'claude', reason: 'empty ladder' };
  }

  // Walk from highest step downward
  for (let step = ladder.length - 1; step >= 0; step--) {
    const rung = ladder[step];
    if (evaluateLadderTriggers(rung.triggers, metrics, shape, priorFailureCount)) {
      return {
        selectedStep: step,
        model: rung.model,
        provider: rung.provider,
        thinkingDepth: rung.thinkingDepth,
        reason: `ladder step ${step}`,
      };
    }
  }

  // Fallback to step 0
  const rung = ladder[0];
  return {
    selectedStep: 0,
    model: rung.model,
    provider: rung.provider,
    thinkingDepth: rung.thinkingDepth,
    reason: 'ladder step 0 (default)',
  };
}

function evaluateLadderTriggers(
  triggers: LadderTrigger[],
  metrics: TaskShapeMetrics,
  shape: TaskShape,
  priorFailureCount?: number,
): boolean {
  if (!triggers || triggers.length === 0) return false;
  return triggers.every(t => evaluateLadderTrigger(t, metrics, shape, priorFailureCount));
}

function evaluateLadderTrigger(
  trigger: LadderTrigger,
  m: TaskShapeMetrics,
  shape: TaskShape,
  priorFailureCount?: number,
): boolean {
  switch (trigger.type) {
    case 'file_count_gt':
      return m.estimatedFileCount > (typeof trigger.value === 'number' ? trigger.value : 3);
    case 'line_count_gt':
      return m.estimatedLineCount > (typeof trigger.value === 'number' ? trigger.value : 200);
    case 'module_span_gt':
      return m.crossServiceChange;
    case 'task_type':
      return shape === (trigger.value as string);
    case 'security_relevant':
      return m.securityDomain;
    case 'is_bug_fix':
      return shape === 'bug_fix';
    case 'is_regression_fix':
      return shape === 'bug_fix' && m.highAmbiguityFix;
    case 'flaky_test_diagnosis':
      return shape === 'testing' && (priorFailureCount ?? 0) > 0;
    case 'history_surgery':
      return false; // manual trigger
    case 'manual_override':
      return false; // manual trigger
    default:
      return false;
  }
}
