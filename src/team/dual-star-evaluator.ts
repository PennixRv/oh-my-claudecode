/**
 * DUAL* trigger evaluation engine.
 * Evaluates whether a task should upgrade from single-model to DUAL
 * based on pre-dispatch heuristics (known at spawn time).
 */
import type { DualStarTrigger } from '../shared/types.js';
import type { TaskShape } from './role-router.js';

export interface TaskShapeMetrics {
  estimatedFileCount: number;
  estimatedLineCount: number;
  crossServiceChange: boolean;
  securityDomain: boolean;
  dataMigration: boolean;
  contextExceeds128K: boolean;
  paymentOrAuthChange: boolean;
  highAmbiguityFix: boolean;
  executorVerifierSameFamily: boolean;
}

/**
 * Evaluate pre-dispatch DUAL* triggers against task metrics.
 * Returns true if ANY trigger condition is met.
 */
export function evaluateDualStarTriggers(
  triggers: DualStarTrigger[],
  metrics: TaskShapeMetrics,
): { shouldUpgrade: boolean; reason: string } {
  if (!triggers || triggers.length === 0) {
    return { shouldUpgrade: false, reason: 'no triggers configured' };
  }

  for (const trigger of triggers) {
    const match = evaluateTrigger(trigger, metrics);
    if (match) return { shouldUpgrade: true, reason: `trigger:${trigger.type}` };
  }

  return { shouldUpgrade: false, reason: 'no triggers matched' };
}

function evaluateTrigger(trigger: DualStarTrigger, m: TaskShapeMetrics): boolean {
  switch (trigger.type) {
    case 'cross_service_change': return m.crossServiceChange;
    case 'data_migration': return m.dataMigration;
    case 'auth_boundary_redesign': return m.securityDomain;
    case 'distributed_consistency': return m.crossServiceChange;
    case 'doc_exceeds_5000_words': return m.contextExceeds128K;
    case 'security_compliance': return m.securityDomain;
    case 'payment_or_auth_change': return m.paymentOrAuthChange;
    case 'critical_release': return false; // manual trigger only
    case 'high_ambiguity_fix': return m.highAmbiguityFix;
    case 'executor_same_model_family': return m.executorVerifierSameFamily;
    default: return false;
  }
}

/**
 * Estimate task complexity from task text (pre-dispatch heuristics only).
 * Used to populate TaskShapeMetrics for DUAL* trigger evaluation.
 */
export function estimateTaskComplexity(
  subject: string,
  description: string,
): TaskShapeMetrics {
  const combined = `${subject} ${description}`.trim();
  const wordCount = combined.split(/\s+/).length;
  const estimatedTokens = Math.ceil(wordCount * 1.3); // rough estimate

  return {
    estimatedFileCount: countReferences(combined),
    estimatedLineCount: 0, // unknown pre-dispatch
    crossServiceChange: /cross.?service|multi.?module|multi.?service|跨服务|跨模块/i.test(combined),
    securityDomain: /security|auth|安全|认证|权限|payment|支付|secret|密钥/i.test(combined),
    dataMigration: /migrat|schema.*change|数据迁移|数据库变更/i.test(combined),
    contextExceeds128K: estimatedTokens > 100000 || wordCount > 5000,
    paymentOrAuthChange: /payment|支付|auth|认证|login|登录/i.test(combined),
    highAmbiguityFix: /可能|也许|不确定|might|maybe|possibly|unclear/i.test(combined),
    executorVerifierSameFamily: false, // set by caller with routing context
  };
}

function countReferences(text: string): number {
  const fileRefs = text.match(/(?:[\w./-]+\.(?:ts|js|py|go|rs|java|rb|php|cs))/g);
  return fileRefs ? new Set(fileRefs).size : 1;
}
