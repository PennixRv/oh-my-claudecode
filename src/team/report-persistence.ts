/**
 * Report persistence — captures worker task reports on transition
 * and writes them to .omc/reports/auto/ for survival past team shutdown.
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { createHash, randomBytes } from 'crypto';

const REPORTS_DIR = '.omc/reports/auto';
const MAX_AGE_DAYS = 7;

export interface ReportCaptureParams {
  teamName: string;
  taskId: string;
  workerName: string;
  status: string;
  result?: string;
  error?: string;
  cwd: string;
}

/**
 * Capture a task report on transition completion.
 * Writes to .omc/reports/auto/<team>-task<id>-<ISO8601>.md with atomic write.
 */
export async function captureTaskReport(params: ReportCaptureParams): Promise<string | null> {
  const { teamName, taskId, workerName, status, result, error, cwd } = params;
  const reportsDir = join(cwd, REPORTS_DIR);

  // Gather body from: canonical path → worker report file → result → error
  let body = '';
  let source = '';

  // 1. Canonical worker report path (.omc/reports/task-<id>-<worker>.md)
  const canonicalPath = join(cwd, '.omc', 'reports', `task-${taskId}-${workerName}.md`);
  if (existsSync(canonicalPath)) {
    try { body = await readFile(canonicalPath, 'utf-8'); source = 'canonical-report'; } catch { /* fall through */ }
  }
  // 2. Legacy worker-dir path
  if (!body) {
    const workerReportPath = join(cwd, '.omc', 'state', 'team', teamName, 'workers', workerName, `report-task-${taskId}.md`);
    if (existsSync(workerReportPath)) {
      try { body = await readFile(workerReportPath, 'utf-8'); source = 'worker-report-file'; } catch { /* fall through */ }
    }
  }
  // 3. Auto-scan .omc/reports/ for any team-task match
  if (!body) {
    try {
      const reportsDir2 = join(cwd, '.omc', 'reports');
      if (existsSync(reportsDir2)) {
        const { readdir: rd } = await import('fs/promises');
        const files = await rd(reportsDir2);
        const match = files.filter(f => f.startsWith(`task-${taskId}-${workerName}`) || f.startsWith(`${teamName}-task${taskId}-`)).sort().pop();
        if (match) {
          try { body = await readFile(join(reportsDir2, match), 'utf-8'); source = 'scanned-reports-dir'; } catch { /* fall through */ }
        }
      }
    } catch { /* scan failure — fall through */ }
  }
  // 4. result field
  if (!body && result) { body = result; source = 'result'; }
  // 5. error field
  if (!body && error) { body = `error: ${error}`; source = 'error'; }
  if (!body) return null;

  await mkdir(reportsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[T:-]/g, '').slice(0, 17);
  const suffix = randomBytes(3).toString('hex');
  const reportFile = join(reportsDir, `${teamName}-task${taskId}-${workerName}-${ts}-${suffix}.md`);
  const tmpFile = join(reportsDir, `.tmp-${teamName}-task${taskId}-${workerName}-${ts}-${process.pid}`);

  const checksum = createHash('md5').update(`${teamName} ${taskId} ${body}`).digest('hex').slice(0, 8);

  const content = [
    '---',
    `team: ${teamName}`,
    `task_id: ${taskId}`,
    `worker: ${workerName}`,
    `status: ${status}`,
    `source: ${source}`,
    `captured: ${new Date().toISOString()}`,
    '---',
    '',
    body,
    '',
    `<!-- report-end:${checksum} -->`,
  ].join('\n');

  await writeFile(tmpFile, content, 'utf-8');
  await writeFile(reportFile, content, 'utf-8'); // fallback if rename fails
  try {
    const { rename } = await import('fs/promises');
    await rename(tmpFile, reportFile);
  } catch { /* tmp already moved or removed; content written to reportFile directly */ }

  return reportFile;
}

/**
 * Run cleanup of reports older than MAX_AGE_DAYS.
 * Called once per team command invocation.
 */
export async function cleanupOldReports(cwd: string): Promise<void> {
  const reportsDir = join(cwd, REPORTS_DIR);
  if (!existsSync(reportsDir)) return;

  const { readdir, unlink } = await import('fs/promises');
  try {
    const files = await readdir(reportsDir);
    const now = Date.now();
    const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = join(reportsDir, file);
      // Clean aged .md reports AND orphaned .tmp-* files
      if (file.startsWith('.tmp-')) {
        try { await unlink(filePath); } catch { /* skip */ }
        continue;
      }
      if (!file.endsWith('.md')) continue;
      try {
        const { stat } = await import('fs/promises');
        const s = await stat(filePath);
        if (now - s.mtimeMs > maxAge) {
          await unlink(filePath);
        }
      } catch { /* skip files that can't be stat'd or deleted */ }
    }
  } catch { /* directory may not exist yet */ }
}
