import { beforeEach, describe, expect, it, vi } from 'vitest';
const mockedCalls = vi.hoisted(() => ({
    tmuxArgs: [],
    cmuxArgs: [],
    paneCapture: '',
    captureSequence: [],
    paneStatus: '0 zsh\n',
    echoOnLiteralSend: true,
    clearLiteralOnSubmit: false,
    wrapLiteralCapture: false,
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const execFileMock = vi.fn((_cmd, args, cb) => {
        mockedCalls.cmuxArgs.push(args);
        cb(null, '', '');
        return {};
    });
    const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
    execFileMock[promisifyCustom] = async (_cmd, args) => {
        mockedCalls.cmuxArgs.push(args);
        return { stdout: '', stderr: '' };
    };
    return {
        ...actual,
        execFile: execFileMock,
    };
});
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExec: vi.fn((args) => {
            mockedCalls.tmuxArgs.push(args);
            return '';
        }),
        tmuxExecAsync: vi.fn(async (args) => {
            mockedCalls.tmuxArgs.push(args);
            if (args[0] === 'capture-pane') {
                const nextCapture = mockedCalls.captureSequence.length > 0
                    ? mockedCalls.captureSequence.shift() ?? ''
                    : mockedCalls.paneCapture;
                const stdout = args.includes('-J')
                    ? nextCapture.replace(/\n/g, '')
                    : nextCapture;
                return { stdout, stderr: '' };
            }
            if (args[0] === 'send-keys' && args.includes('-l') && mockedCalls.echoOnLiteralSend) {
                const literal = args[args.length - 1] ?? '';
                mockedCalls.paneCapture = mockedCalls.wrapLiteralCapture
                    ? `${literal.slice(0, 80)}\n${literal.slice(80)}`
                    : literal;
            }
            if (args[0] === 'send-keys' &&
                !args.includes('-l') &&
                mockedCalls.clearLiteralOnSubmit &&
                ['C-m', 'Enter'].includes(args.at(-1) ?? '')) {
                mockedCalls.paneCapture = '';
            }
            return { stdout: '', stderr: '' };
        }),
        tmuxCmdAsync: vi.fn(async (args) => {
            mockedCalls.tmuxArgs.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_dead} #{pane_current_command}')) {
                return { stdout: mockedCalls.paneStatus, stderr: '' };
            }
            return { stdout: '', stderr: '' };
        }),
    };
});
import { sendTeamPaneKey, sendToWorker, spawnBridgeInSession, spawnWorkerInPane } from '../tmux-session.js';
describe('spawnWorkerInPane', () => {
    beforeEach(() => {
        mockedCalls.tmuxArgs = [];
        mockedCalls.cmuxArgs = [];
        mockedCalls.paneCapture = '';
        mockedCalls.captureSequence = [];
        mockedCalls.paneStatus = '0 zsh\n';
        mockedCalls.echoOnLiteralSend = true;
        mockedCalls.clearLiteralOnSubmit = false;
        mockedCalls.wrapLiteralCapture = false;
        vi.unstubAllEnvs();
    });
    it('uses argv-style launch with tmux respawn-pane', async () => {
        await spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto', '--model', 'gpt-5;touch /tmp/pwn'],
            cwd: '/tmp',
        });
        const respawnPane = mockedCalls.tmuxArgs.find((args) => args[0] === 'respawn-pane');
        expect(respawnPane).toBeDefined();
        expect(respawnPane).toEqual(expect.arrayContaining(['respawn-pane', '-k', '-t', '%2', '-c', '/tmp']));
        const launchLine = respawnPane?.[respawnPane.length - 1] ?? '';
        expect(launchLine).toContain('exec "$@"');
        expect(launchLine).toContain("'--'");
        expect(launchLine).toContain("'gpt-5;touch /tmp/pwn'");
        expect(launchLine).not.toContain('exec codex --full-auto');
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'send-keys' && args.includes('-l'))).toBe(false);
    });
    it('sends cmux worker command text and submits with send-key', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        await spawnWorkerInPane('cmux:workspace-1', 'cmux-worker-1', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        });
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'respawn-pane')).toBe(false);
        expect(mockedCalls.cmuxArgs).toHaveLength(2);
        expect(mockedCalls.cmuxArgs[0]).toEqual(expect.arrayContaining(['send', '--surface', 'cmux-worker-1']));
        expect(mockedCalls.cmuxArgs[0]?.[0]).toBe('send');
        expect(mockedCalls.cmuxArgs[0]?.at(-1)).toContain('exec "$@"');
        expect(mockedCalls.cmuxArgs[1]).toEqual(['send-key', '--surface', 'cmux-worker-1', 'Enter']);
    });
    it('uses cmux send-key semantics for Enter and control keys', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        await sendTeamPaneKey('cmux-worker-1', 'Enter');
        await sendTeamPaneKey('cmux-worker-1', 'Tab');
        await sendTeamPaneKey('cmux-worker-1', 'C-m');
        await sendTeamPaneKey('cmux-worker-1', 'C-u');
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'send-keys')).toBe(false);
        expect(mockedCalls.cmuxArgs).toEqual([
            ['send-key', '--surface', 'cmux-worker-1', 'Enter'],
            ['send-key', '--surface', 'cmux-worker-1', 'Tab'],
            ['send-key', '--surface', 'cmux-worker-1', 'C-m'],
            ['send-key', '--surface', 'cmux-worker-1', 'C-u'],
        ]);
    });
    it('uses current JS runtime when launching bridge-entry helpers', () => {
        spawnBridgeInSession('session:0', '/tmp/bridge-entry.js', '/tmp/bridge-config.json');
        const sendKeys = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys');
        expect(sendKeys).toBeDefined();
        const launchLine = sendKeys?.[3] ?? '';
        expect(launchLine).toContain(process.execPath);
        expect(launchLine).toContain('/tmp/bridge-entry.js');
        expect(launchLine).toContain('--config');
        expect(launchLine).not.toMatch(/^node\s/);
    });
    it('fails before respawn-pane when the target pane shell never becomes ready', async () => {
        mockedCalls.paneStatus = '1 zsh\n';
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow(/worker_start_shell_not_ready:worker-1:%2:/);
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'respawn-pane')).toBe(false);
    });
    it('rejects invalid team names before command construction', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'Bad-Team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_NAME: 'Bad-Team' },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow('Invalid team name');
    });
    it('rejects invalid environment keys', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: { 'BAD-KEY': 'x' },
            launchBinary: 'codex',
            cwd: '/tmp',
        })).rejects.toThrow('Invalid environment key');
    });
    it('rejects unsafe launchBinary values', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_NAME: 'safe-team' },
            launchBinary: 'codex;touch /tmp/pwn',
            cwd: '/tmp',
        })).rejects.toThrow('Invalid launchBinary');
    });
    it('returns false when an injected message never becomes visible in the pane', async () => {
        mockedCalls.echoOnLiteralSend = false;
        await expect(sendToWorker('session:0', '%2', 'check-inbox')).resolves.toBe(false);
    });
    it('returns true only after a visible injected message is submitted', async () => {
        mockedCalls.clearLiteralOnSubmit = true;
        await expect(sendToWorker('session:0', '%2', 'check-inbox')).resolves.toBe(true);
        expect(mockedCalls.tmuxArgs).toContainEqual(['send-keys', '-t', '%2', '-l', '--', 'check-inbox']);
    });
});
//# sourceMappingURL=tmux-session.spawn.test.js.map