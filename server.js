// ============================================
// COLAB ORCHESTRATOR - Shell Execution Method
// ============================================
const express = require('express');
const { spawn, exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const cors = require('cors');
const multer = require('multer');

const app = express();
const execPromise = util.promisify(exec);

// ============================================
// HARDCODED CONFIGURATION (Testing Only)
// ============================================
const CONFIG = {
    // Auth - Direct from your .env or hardcoded
    COLAB_AUTH_TOKEN: '{"token": "ya29.a0AT3oNZ_JYRY15EBiIMfpxN8IXtFW43Kr3rj18eTv4QRiQr7O9Q-ZKr1Z_mUa2yJH1Aa63lT-DmvxCFqTuSLMMDBfe_mw0xg84cA20w2cAeTJ8DXF_ijdbUg4DUpH2s4XGSdX69ThTtizQNPsc4K60ykHkGnlmt8-W3o1Qb2nVOvP7oryE5gJW5fv4CGudryvYM-MWZQaCgYKAQwSARISFQHGX2Mi6_aFT-RRKHiy45bJg0mKcA0206", "refresh_token": "1//0g4sUFmaXGfvtCgYIARAAGBASNwF-L9IrYGPrhpvZRm7LOnSWxZfdVJGFpzmxEE0vrosqyFaObsZ7eJdDHKbaR1iS2-vhxoCU5Xs", "token_uri": "https://oauth2.googleapis.com/token", "client_id": "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com", "client_secret": "d-FL95Q19q7MQmFpd7hHD0Ty", "scopes": ["openid", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/colaboratory", "https://www.googleapis.com/auth/drive.file"], "universe_domain": "googleapis.com", "account": "", "expiry": "2026-06-15T07:29:05Z"}',

    PORT: 3000,
    SESSIONS_BASE_DIR: '/tmp/colab_sessions',
    UPLOAD_DIR: '/tmp/colab_uploads',
    MAX_SESSIONS: 3,
    SESSION_TIMEOUT: 10800000,
    EXECUTION_TIMEOUT: 7200,
    MAX_CODE_SIZE: 3145728,
    MAX_FILE_SIZE: 100 * 1024 * 1024,
    POLL_INTERVAL: 10000,
    CLEANUP_INTERVAL: 3600000,
    HANGING_PROCESS_CLEANUP_INTERVAL: 900000,
    COMPLETED_EXECUTIONS_TTL: 1200000,
};

// ============================================
// CORS - ALLOW ALL
// ============================================
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// MULTER FOR FILE UPLOADS
// ============================================
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const sessionId = req.body.sessionId || req.query.sessionId;
        if (!sessionId) return cb(new Error('sessionId required'));
        const uploadDir = path.join(CONFIG.UPLOAD_DIR, sessionId);
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const uniqueName = `${timestamp}_${file.originalname}`;
        req.uploadedFileName = uniqueName;
        req.originalFileName = file.originalname;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: CONFIG.MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => cb(null, true)
});

// ============================================
// COLAB BINARY SETUP
// ============================================
let COLAB_BINARY = 'colab';
let USE_PYTHON_MODULE = false;

async function findColabBinary() {
    const { execSync } = require('child_process');
    console.log('🔍 Searching for colab binary...');

    try {
        const whichPath = execSync('which colab 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
        if (whichPath && whichPath !== '') {
            console.log(`✅ Found colab via which: ${whichPath}`);
            return whichPath;
        }
    } catch (e) {}

    try {
        const pipPath = execSync('pip3 show google-colab-cli 2>/dev/null | grep Location | cut -d" " -f2', { encoding: 'utf8', timeout: 5000 }).trim();
        if (pipPath) {
            const possibleBinary = `${pipPath}/colab_cli/__main__.py`;
            if (require('fs').existsSync(possibleBinary)) {
                console.log(`✅ Found colab via pip: ${possibleBinary}`);
                return 'python3';
            }
        }
    } catch (e) {}

    console.warn('⚠️ colab binary not found, falling back to python3 -m colab_cli');
    return 'python3';
}

async function initColabBinary() {
    const binary = await findColabBinary();
    if (binary === 'python3') {
        USE_PYTHON_MODULE = true;
        COLAB_BINARY = 'python3';
        console.log(`🔧 Using Python module: python3 -m colab_cli`);
    } else {
        COLAB_BINARY = binary;
        USE_PYTHON_MODULE = false;
        console.log(`🔧 Using colab binary: ${COLAB_BINARY}`);
    }
}

// ============================================
// COLAB CLI RUNNER (ORIGINAL METHOD)
// ============================================
async function runColabCli(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        let command;
        if (USE_PYTHON_MODULE) {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} -m colab_cli ${escapedArgs}`;
        } else {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} ${escapedArgs}`;
        }
        console.log(`🛠  Running: ${command}`);
        exec(command, { timeout, shell: '/bin/bash', maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && error.code !== 0) {
                reject({ error, stdout, stderr });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

// ============================================
// AUTH SETUP
// ============================================
async function setupColabAuth() {
    const rawToken = CONFIG.COLAB_AUTH_TOKEN.trim();
    try {
        const tokenData = JSON.parse(rawToken);

        if (tokenData.token && !tokenData.access_token) {
            tokenData.access_token = tokenData.token;
            console.log('📝 Converted "token" → "access_token"');
        }

        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(path.join(configDir, 'token.json'), JSON.stringify(tokenData, null, 2));
        await fs.writeFile(path.join(configDir, 'sessions.json'), JSON.stringify({}));

        const verify = JSON.parse(await fs.readFile(path.join(configDir, 'token.json'), 'utf8'));
        if (verify.access_token) {
            console.log('✅ Colab auth token written and verified');
            return true;
        }
        console.warn('⚠️ Token written but no access_token found');
        return false;
    } catch (error) {
        console.error('❌ Auth setup failed:', error.message);
        return false;
    }
}

// ============================================
// HELPERS
// ============================================
function generateId(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

function formatMemory(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function resolveSession(identifier) {
    for (const [id, s] of sessions.entries()) {
        if (id === identifier || id.substring(0, 8) === identifier) {
            return { sessionId: id, session: s };
        }
    }
    return null;
}

// ============================================
// STATE MANAGEMENT
// ============================================
const sessions = new Map();
const completedExecutions = new Map();
const executionQueue = new Set();
const executionProcesses = new Map();
const fileTransfers = new Map();

// Cleanup completed executions
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [execId, data] of completedExecutions.entries()) {
        if (now - data.completedAt > CONFIG.COMPLETED_EXECUTIONS_TTL) {
            completedExecutions.delete(execId);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`🧹 Cleared ${cleaned} stale completed executions`);
}, 60 * 1000);

// Cleanup hanging processes
setInterval(() => {
    for (const [execId, proc] of executionProcesses.entries()) {
        try {
            proc.kill(0);
            const session = Array.from(sessions.values()).find(s => s.currentExecution?.executionId === execId);
            if (session && Date.now() - session.currentExecution.startedAt > 2.5 * 60 * 60 * 1000) {
                console.log(`⚠️ Killing hanging process ${execId}`);
                proc.kill('SIGTERM');
                executionProcesses.delete(execId);
            }
        } catch {
            executionProcesses.delete(execId);
        }
    }
}, CONFIG.HANGING_PROCESS_CLEANUP_INTERVAL);

// Cleanup old file transfers
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [transferId, data] of fileTransfers.entries()) {
        if (now - data.createdAt > 3600000) {
            fileTransfers.delete(transferId);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`🧹 Cleared ${cleaned} stale file transfers`);
}, 60000);

// ============================================
// SESSION FOLDER MANAGEMENT
// ============================================
async function createSessionFolder(sessionId) {
    const folder = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId);
    await fs.mkdir(folder, { recursive: true });
    return folder;
}

async function cleanupSessionFolder(sessionId) {
    try {
        await fs.rm(path.join(CONFIG.SESSIONS_BASE_DIR, sessionId), { recursive: true, force: true });
        await fs.rm(path.join(CONFIG.UPLOAD_DIR, sessionId), { recursive: true, force: true });
        console.log(`✅ Cleaned up folders for session ${sessionId}`);
    } catch (error) {
        console.error(`Failed to cleanup folders for ${sessionId}:`, error.message);
    }
}

// ============================================
// SESSION DATA JSON MANAGEMENT
// ============================================
async function appendSessionData(sessionId, data) {
    const dataFile = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, 'session_data.json');
    try {
        let sessionData = {};
        try {
            sessionData = JSON.parse(await fs.readFile(dataFile, 'utf8'));
        } catch {
            sessionData = {
                sessionId,
                createdAt: new Date().toISOString(),
                cells: [],
                totalCells: 0,
                totalExecutions: 0,
                files: []
            };
        }

        const existingIndex = sessionData.cells.findIndex(c => c.cellNo === data.cellNo && c.type === data.type);
        if (existingIndex !== -1) {
            sessionData.cells[existingIndex] = data;
        } else {
            sessionData.cells.push(data);
        }

        sessionData.totalCells = sessionData.cells.length;
        sessionData.totalExecutions = sessionData.cells.filter(c => c.type === 'execution').length;
        sessionData.lastUpdated = new Date().toISOString();

        await fs.writeFile(dataFile, JSON.stringify(sessionData, null, 2));
        return sessionData;
    } catch (error) {
        console.error(`Failed to append session data for ${sessionId}:`, error.message);
        return null;
    }
}

async function getSessionData(sessionId) {
    try {
        return JSON.parse(await fs.readFile(path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, 'session_data.json'), 'utf8'));
    } catch {
        return null;
    }
}

// ============================================
// CODE EXECUTION ENGINE (ORIGINAL METHOD)
// ============================================
async function executeCodeInColab(sessionId, cellNo, code, executionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const startedAt = Date.now();
    let cellData = {
        type: 'execution',
        cellNo,
        startedAt: new Date(startedAt).toISOString(),
        code,
        status: 'running'
    };

    try {
        if (Buffer.byteLength(code, 'utf8') > CONFIG.MAX_CODE_SIZE) {
            throw new Error(`Code exceeds ${CONFIG.MAX_CODE_SIZE} bytes`);
        }

        const codeFile = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, `code_${cellNo}.py`);
        await fs.writeFile(codeFile, code, 'utf8');

        const escapedCode = code
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$')
            .replace(/"/g, '\\"');

        let command;
        if (USE_PYTHON_MODULE) {
            command = `echo "${escapedCode}" | python3 -m colab_cli exec -s ${session.colabSession} --timeout ${CONFIG.EXECUTION_TIMEOUT}`;
        } else {
            command = `echo "${escapedCode}" | ${COLAB_BINARY} exec -s ${session.colabSession} --timeout ${CONFIG.EXECUTION_TIMEOUT}`;
        }

        const proc = exec(command, {
            timeout: CONFIG.EXECUTION_TIMEOUT * 1000,
            maxBuffer: 50 * 1024 * 1024,
            shell: '/bin/bash'
        });

        executionProcesses.set(executionId, proc);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            const s = sessions.get(sessionId);
            if (s?.currentExecution?.executionId === executionId) {
                s.currentExecution.partialOutput = stdout;
                s.currentExecution.partialError = stderr;
                sessions.set(sessionId, s);
            }
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
            const s = sessions.get(sessionId);
            if (s?.currentExecution?.executionId === executionId) {
                s.currentExecution.partialOutput = stdout;
                s.currentExecution.partialError = stderr;
                sessions.set(sessionId, s);
            }
        });

        const result = await new Promise((resolve, reject) => {
            proc.on('close', (code) => {
                if (code !== 0) reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr });
                else resolve({ stdout, stderr });
            });
            proc.on('error', (err) => reject({ error: err, stdout, stderr }));
        });

        const completedAt = Date.now();
        const executionTime = completedAt - startedAt;

        const output = {
            status: 'completed',
            output: result.stdout || '(No output)',
            error: result.stderr || '',
            startedAt,
            completedAt,
            executionTime
        };

        completedExecutions.set(executionId, output);
        executionProcesses.delete(executionId);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession?.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData = { ...cellData, status: 'completed', completedAt: new Date(completedAt).toISOString(), executionTime, output: result.stdout || '(No output)', error: result.stderr || '' };
        await appendSessionData(sessionId, cellData);

        console.log(`✅ Execution ${executionId} completed in ${executionTime}ms`);
        return output;
    } catch (error) {
        const completedAt = Date.now();
        const failureResult = {
            status: 'failed',
            output: error.stdout || '',
            error: error.stderr || error.message || String(error),
            startedAt,
            completedAt,
            executionTime: completedAt - startedAt
        };

        completedExecutions.set(executionId, failureResult);
        executionProcesses.delete(executionId);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession?.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData = { ...cellData, status: 'failed', completedAt: new Date(completedAt).toISOString(), executionTime: completedAt - startedAt, output: error.stdout || '', error: error.stderr || error.message || String(error) };
        await appendSessionData(sessionId, cellData);

        console.error(`❌ Execution ${executionId} failed:`, error.message || error.error?.message);
        throw error;
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId) {
    const execKey = `${sessionId}_${cellNo}`;
    if (executionQueue.has(execKey)) return;
    executionQueue.add(execKey);
    console.log(`📋 Queued execution ${executionId}`);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId);
    } catch (error) {
        console.error(`💥 Background error for ${executionId}:`, error.message || error.error?.message);
    } finally {
        executionQueue.delete(execKey);
    }
}

// ============================================
// HEALTH ENDPOINTS
// ============================================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'healthy',
        activeSessions: sessions.size,
        maxSessions: CONFIG.MAX_SESSIONS,
        uptime: process.uptime(),
        memoryUsage: {
            rss: formatMemory(mem.rss),
            heapTotal: formatMemory(mem.heapTotal),
            heapUsed: formatMemory(mem.heapUsed),
        },
        timestamp: new Date().toISOString(),
        colabBinary: COLAB_BINARY,
        usePythonModule: USE_PYTHON_MODULE,
    });
});

app.get('/health/simple', (req, res) => {
    res.json({ status: 'up', timestamp: new Date().toISOString(), sessions: sessions.size });
});

// ============================================
// SESSION ENDPOINTS
// ============================================

// GET /sessions - List all sessions
app.get('/sessions', async (req, res) => {
    const mem = process.memoryUsage();
    const sessionData = [];
    let totalCells = 0;
    let totalExecutions = 0;

    for (const [id, session] of sessions.entries()) {
        const data = await getSessionData(id);
        const cellsCount = data?.cells?.length || 0;
        const executionsCount = data?.totalExecutions || 0;
        totalCells += cellsCount;
        totalExecutions += executionsCount;

        sessionData.push({
            sub: id.substring(0, 8),
            sessionId: id,
            colabSession: session.colabSession,
            status: session.status,
            gpu: session.gpu || null,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: parseFloat(((Date.now() - session.createdAt) / 1000 / 60).toFixed(2)),
            cellsExecuted: cellsCount,
            executions: executionsCount,
            hasCurrentExecution: !!session.currentExecution,
            folder: session.folder,
            dataFileExists: data !== null
        });
    }

    res.json({
        totalSessions: sessions.size,
        maxSessions: CONFIG.MAX_SESSIONS,
        sessions: sessionData,
        memoryUsage: {
            rss: formatMemory(mem.rss),
            heapTotal: formatMemory(mem.heapTotal),
            heapUsed: formatMemory(mem.heapUsed)
        },
        totalCellsExecuted: totalCells,
        totalExecutions,
        queuedExecutions: executionQueue.size,
        completedExecutions: completedExecutions.size,
        fileTransfers: fileTransfers.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// GET /sessions/:identifier - Get session details
app.get('/sessions/:identifier', async (req, res) => {
    const cleanId = req.params.identifier.replace(/\/$/, '');
    const found = resolveSession(cleanId);

    if (!found) {
        return res.status(404).json({ error: 'Session not found', message: `No session found with identifier: ${cleanId}` });
    }

    const { sessionId, session } = found;
    const sessionData = await getSessionData(sessionId);
    const mem = process.memoryUsage();

    res.json({
        session: {
            sub: sessionId.substring(0, 8),
            sessionId,
            colabSession: session.colabSession,
            gpu: session.gpu || null,
            status: session.status,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: parseFloat(((Date.now() - session.createdAt) / 1000 / 60).toFixed(2)),
            hasCurrentExecution: !!session.currentExecution,
            folder: session.folder
        },
        sessionData,
        currentExecution: session.currentExecution || null,
        memoryUsage: {
            rss: formatMemory(mem.rss),
            heapTotal: formatMemory(mem.heapTotal),
            heapUsed: formatMemory(mem.heapUsed)
        },
        timestamp: new Date().toISOString()
    });
});

// POST /new - Create a new session
app.post('/new', async (req, res) => {
    // Evict oldest if at max
    if (sessions.size >= CONFIG.MAX_SESSIONS) {
        console.log(`🧹 Max sessions reached, evicting oldest`);
        let oldestId = null;
        let oldestTime = Infinity;
        for (const [id, s] of sessions.entries()) {
            if (s.lastActivity < oldestTime) { oldestTime = s.lastActivity; oldestId = id; }
        }
        if (oldestId) {
            const s = sessions.get(oldestId);
            try { await runColabCli(['stop', '-s', s.colabSession], 10000); } catch {}
            await cleanupSessionFolder(oldestId);
            sessions.delete(oldestId);
            console.log(`🗑️ Evicted session ${oldestId.substring(0, 12)}`);
        }
    }

    const sessionId = req.body?.sessionId || generateId(32);
    const gpu = req.body?.gpu || null;
    const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

    // Build CLI args - CORRECT ORDER: -s first, then --gpu
    const args = ['new'];
    args.push('-s', colabSessionName);
    if (gpu) args.push('--gpu', gpu);

    console.log(`📝 Creating session ${sessionId.substring(0, 12)} [gpu=${gpu || 'none'}]`);

    try {
        await createSessionFolder(sessionId);

        await fs.writeFile(
            path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, 'session_data.json'),
            JSON.stringify({ sessionId, createdAt: new Date().toISOString(), cells: [], totalCells: 0, totalExecutions: 0, files: [], lastUpdated: new Date().toISOString() }, null, 2)
        );

        await runColabCli(args, 60000);

        sessions.set(sessionId, {
            colabSession: colabSessionName,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: 'ready',
            gpu: gpu,
            currentExecution: null,
            folder: path.join(CONFIG.SESSIONS_BASE_DIR, sessionId)
        });

        console.log(`✅ Session ${sessionId.substring(0, 12)} created`);
        return res.json({
            success: true,
            sessionId,
            colabSession: colabSessionName,
            gpu: gpu || null,
            expiresIn: CONFIG.SESSION_TIMEOUT,
            activeSessions: sessions.size,
            maxSessions: CONFIG.MAX_SESSIONS,
            message: 'Session created successfully'
        });
    } catch (error) {
        console.error('❌ Session creation failed:', error.message || error.error?.message);
        await cleanupSessionFolder(sessionId);

        // Spawn fallback to catch OAuth URL
        const spawnArgs = USE_PYTHON_MODULE
            ? ['-m', 'colab_cli', ...args]
            : args;

        const child = spawn(COLAB_BINARY, spawnArgs);
        let authUrl = null;
        let outputBuffer = '';

        const timeout = setTimeout(() => {
            if (!authUrl) {
                child.kill();
                return res.status(500).json({
                    success: false,
                    sessionId,
                    error: 'Failed to create session',
                    details: 'Authentication required or token expired'
                });
            }
        }, 10000);

        const handleOutput = (data) => {
            outputBuffer += data.toString();
            const match = outputBuffer.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"']+/);
            if (match && !authUrl) {
                authUrl = match[0];
                clearTimeout(timeout);
                child.kill();

                sessions.set(sessionId, {
                    colabSession: colabSessionName,
                    createdAt: Date.now(),
                    lastActivity: Date.now(),
                    status: 'auth_required',
                    gpu,
                    currentExecution: null,
                    folder: path.join(CONFIG.SESSIONS_BASE_DIR, sessionId),
                    authUrl
                });

                return res.json({
                    success: false,
                    needsAuth: true,
                    authUrl,
                    sessionId,
                    colabSession: colabSessionName,
                    message: 'Please authenticate with Google'
                });
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);
        child.on('error', (err) => {
            clearTimeout(timeout);
            if (!authUrl) {
                return res.status(500).json({ success: false, sessionId, error: 'Spawn error', details: err.message });
            }
        });
    }
});

// POST /stop - Stop a session
app.post('/stop', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;
    console.log(`🛑 Stopping session ${resolvedId.substring(0, 12)}`);

    try {
        await runColabCli(['stop', '-s', session.colabSession], 30000);
        await cleanupSessionFolder(resolvedId);
        sessions.delete(resolvedId);
        res.json({ success: true, sessionId: resolvedId, message: 'Session stopped' });
    } catch (error) {
        await cleanupSessionFolder(resolvedId);
        sessions.delete(resolvedId);
        res.json({ success: true, sessionId: resolvedId, warning: 'Session removed locally, may still exist remotely' });
    }
});

// DELETE /session/:sessionId - Delete session
app.delete('/session/:sessionId', async (req, res) => {
    const found = resolveSession(req.params.sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId: req.params.sessionId });

    const { sessionId, session } = found;
    console.log(`🗑️ Deleting session ${sessionId.substring(0, 12)}`);

    try {
        await runColabCli(['stop', '-s', session.colabSession], 30000);
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        return res.json({ success: true, sessionId, message: 'Session terminated' });
    } catch (error) {
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        return res.json({ success: true, sessionId, warning: 'Session removed locally, may still exist remotely' });
    }
});

// POST /keepalive - Keep session alive
app.post('/keepalive', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    try {
        await runColabCli(['sessions'], 10000);
        found.session.lastActivity = Date.now();
        sessions.set(found.sessionId, found.session);
        console.log(`💓 Keepalive: ${found.sessionId.substring(0, 12)}`);
        res.json({ success: true, sessionId: found.sessionId, message: 'Session kept alive' });
    } catch (error) {
        console.error(`❌ Keepalive failed:`, error.message);
        res.status(500).json({ error: 'Keepalive failed', sessionId: found.sessionId, details: error.message });
    }
});

// ============================================
// CODE EXECUTION
// ============================================

// POST /exec - Execute code
app.post('/exec', async (req, res) => {
    const { sessionId, code, cellNo } = req.body;
    if (!sessionId || !code || cellNo === undefined) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
    }

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        return res.status(409).json({
            error: 'Session busy',
            sessionId: resolvedId,
            currentExecution: session.currentExecution
        });
    }

    const executionId = generateId(16);
    const validCellNo = parseInt(cellNo, 10);

    console.log(`▶️ Execution ${executionId} | session ${resolvedId.substring(0, 12)} | cell ${validCellNo}`);

    session.status = 'busy';
    session.lastActivity = Date.now();
    session.currentExecution = {
        executionId,
        cellNo: validCellNo,
        startedAt: Date.now(),
        status: 'running',
        partialOutput: '',
        partialError: ''
    };
    sessions.set(resolvedId, session);

    await appendSessionData(resolvedId, {
        type: 'execution_start',
        cellNo: validCellNo,
        startedAt: new Date().toISOString(),
        code,
        status: 'started'
    });

    backgroundExecution(resolvedId, validCellNo, code, executionId);

    res.json({
        status: 'processing',
        sessionId: resolvedId,
        executionId,
        pollInterval: CONFIG.POLL_INTERVAL,
        message: 'Code execution started. Poll /exec-status for results.'
    });
});

// POST /exec-status - Check execution status
app.post('/exec-status', async (req, res) => {
    const { sessionId, executionId } = req.body;
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    if (completedExecutions.has(executionId)) {
        const record = completedExecutions.get(executionId);
        return res.json({
            status: record.status,
            sessionId,
            executionId,
            output: record.output,
            error: record.error,
            executionTime: record.executionTime
        });
    }

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { session, sessionId: resolvedId } = found;
    const execution = session.currentExecution;

    if (execution?.executionId === executionId) {
        return res.json({
            status: 'running',
            sessionId: resolvedId,
            executionId,
            elapsed: Date.now() - execution.startedAt,
            partialOutput: execution.partialOutput || '',
            partialError: execution.partialError || ''
        });
    }

    res.json({ status: 'not_found', sessionId, executionId, message: 'Execution not found or already completed' });
});

// POST /exec-ack - Acknowledge completion
app.post('/exec-ack', async (req, res) => {
    const { executionId } = req.body;
    if (executionId && completedExecutions.has(executionId)) {
        completedExecutions.delete(executionId);
        console.log(`✅ Acknowledged execution ${executionId}`);
        return res.json({ success: true, executionId, message: 'Acknowledged' });
    }
    res.json({ success: false, executionId, message: 'Execution not found' });
});

// ============================================
// FILE OPERATIONS
// ============================================

// POST /download - Download file (with polling)
app.post('/download', async (req, res) => {
    const { sessionId, remotePath, localPath } = req.body;
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, remotePath' });
    }

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    const transferId = generateId(16);
    const destPath = localPath || path.join(CONFIG.SESSIONS_BASE_DIR, resolvedId, path.basename(remotePath));
    const uploadDir = path.join(CONFIG.UPLOAD_DIR, resolvedId);
    await fs.mkdir(uploadDir, { recursive: true });

    fileTransfers.set(transferId, {
        type: 'download',
        sessionId: resolvedId,
        remotePath,
        localPath: destPath,
        status: 'pending',
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        error: null,
        output: '',
        progress: 0
    });

    console.log(`⬇️ Downloading ${remotePath} → ${destPath} [transfer: ${transferId}]`);

    setImmediate(async () => {
        try {
            const transfer = fileTransfers.get(transferId);
            if (!transfer) return;
            
            transfer.status = 'running';
            transfer.startedAt = Date.now();
            fileTransfers.set(transferId, transfer);

            const result = await runColabCli(['download', remotePath, destPath, '-s', session.colabSession], 60000);
            
            transfer.status = 'completed';
            transfer.completedAt = Date.now();
            transfer.output = result.stdout || '';
            transfer.progress = 100;
            fileTransfers.set(transferId, transfer);
            
            session.lastActivity = Date.now();
            sessions.set(resolvedId, session);
            console.log(`✅ Download completed: ${transferId}`);
        } catch (error) {
            const transfer = fileTransfers.get(transferId);
            if (transfer) {
                transfer.status = 'failed';
                transfer.completedAt = Date.now();
                transfer.error = error.stderr || error.message || String(error);
                fileTransfers.set(transferId, transfer);
            }
            console.error(`❌ Download failed: ${transferId}`, error.message);
        }
    });

    res.json({
        success: true,
        transferId,
        sessionId: resolvedId,
        remotePath,
        localPath: destPath,
        status: 'pending',
        message: 'Download started. Poll /download-status for progress.',
        pollInterval: CONFIG.POLL_INTERVAL
    });
});

// GET /download-status - Check download status
app.get('/download-status', async (req, res) => {
    const { transferId } = req.query;
    if (!transferId) {
        return res.status(400).json({ error: 'transferId query param required' });
    }

    const transfer = fileTransfers.get(transferId);
    if (!transfer) {
        return res.status(404).json({ error: 'Transfer not found', transferId });
    }

    const response = {
        transferId,
        type: transfer.type,
        sessionId: transfer.sessionId,
        remotePath: transfer.remotePath,
        localPath: transfer.localPath,
        status: transfer.status,
        progress: transfer.progress || 0,
        createdAt: new Date(transfer.createdAt).toISOString(),
        startedAt: transfer.startedAt ? new Date(transfer.startedAt).toISOString() : null,
        completedAt: transfer.completedAt ? new Date(transfer.completedAt).toISOString() : null,
        output: transfer.output || '',
        error: transfer.error || null
    };

    if (transfer.status === 'completed') {
        try {
            const stats = await fs.stat(transfer.localPath);
            response.fileSize = stats.size;
            response.fileSizeFormatted = formatMemory(stats.size);
        } catch {
            response.fileSize = 0;
        }
    }

    res.json(response);
});

// POST /upload - Upload file (with polling)
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const { sessionId, remotePath } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'File not uploaded. Use multipart/form-data with field name "file"' });
        }

        const found = resolveSession(sessionId);
        if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

        const { sessionId: resolvedId, session } = found;

        const remoteFilePath = remotePath || `/content/${req.originalFileName}`;
        const localFilePath = req.file.path;

        const transferId = generateId(16);

        fileTransfers.set(transferId, {
            type: 'upload',
            sessionId: resolvedId,
            localPath: localFilePath,
            remotePath: remoteFilePath,
            originalName: req.originalFileName,
            fileSize: req.file.size,
            status: 'pending',
            createdAt: Date.now(),
            startedAt: null,
            completedAt: null,
            error: null,
            output: '',
            progress: 0
        });

        console.log(`⬆️ Uploading ${localFilePath} → ${remoteFilePath} [transfer: ${transferId}]`);

        setImmediate(async () => {
            try {
                const transfer = fileTransfers.get(transferId);
                if (!transfer) return;
                
                transfer.status = 'running';
                transfer.startedAt = Date.now();
                fileTransfers.set(transferId, transfer);

                const result = await runColabCli(['upload', localFilePath, remoteFilePath, '-s', session.colabSession], 60000);
                
                transfer.status = 'completed';
                transfer.completedAt = Date.now();
                transfer.output = result.stdout || '';
                transfer.progress = 100;
                fileTransfers.set(transferId, transfer);
                
                session.lastActivity = Date.now();
                sessions.set(resolvedId, session);
                console.log(`✅ Upload completed: ${transferId}`);
            } catch (error) {
                const transfer = fileTransfers.get(transferId);
                if (transfer) {
                    transfer.status = 'failed';
                    transfer.completedAt = Date.now();
                    transfer.error = error.stderr || error.message || String(error);
                    fileTransfers.set(transferId, transfer);
                }
                console.error(`❌ Upload failed: ${transferId}`, error.message);
            }
        });

        res.json({
            success: true,
            transferId,
            sessionId: resolvedId,
            localPath: localFilePath,
            remotePath: remoteFilePath,
            originalName: req.originalFileName,
            fileSize: req.file.size,
            fileSizeFormatted: formatMemory(req.file.size),
            status: 'pending',
            message: 'Upload started. Poll /upload-status for progress.',
            pollInterval: CONFIG.POLL_INTERVAL
        });
    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({
            success: false,
            error: 'Upload failed',
            details: error.message || String(error)
        });
    }
});

// GET /upload-status - Check upload status
app.get('/upload-status', async (req, res) => {
    const { transferId } = req.query;
    if (!transferId) {
        return res.status(400).json({ error: 'transferId query param required' });
    }

    const transfer = fileTransfers.get(transferId);
    if (!transfer) {
        return res.status(404).json({ error: 'Transfer not found', transferId });
    }

    res.json({
        transferId,
        type: transfer.type,
        sessionId: transfer.sessionId,
        localPath: transfer.localPath,
        remotePath: transfer.remotePath,
        originalName: transfer.originalName || null,
        fileSize: transfer.fileSize || 0,
        fileSizeFormatted: transfer.fileSize ? formatMemory(transfer.fileSize) : '0 MB',
        status: transfer.status,
        progress: transfer.progress || 0,
        createdAt: new Date(transfer.createdAt).toISOString(),
        startedAt: transfer.startedAt ? new Date(transfer.startedAt).toISOString() : null,
        completedAt: transfer.completedAt ? new Date(transfer.completedAt).toISOString() : null,
        output: transfer.output || '',
        error: transfer.error || null
    });
});

// ============================================
// OTHER COMMANDS
// ============================================

// GET /status - Show session status
app.get('/status', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId query param required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['status', '-s', session.colabSession], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'status failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /sessions-list - List sessions via CLI
app.get('/sessions-list', async (req, res) => {
    console.log('📋 Fetching CLI session list');
    try {
        const result = await runColabCli(['sessions'], 15000);
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
            trackedSessions: sessions.size
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'sessions list failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /install - Install packages
app.post('/install', async (req, res) => {
    const { sessionId, packages, requirement } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    if (!packages && !requirement) {
        return res.status(400).json({ error: 'Either packages or requirement file required' });
    }

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        return res.status(409).json({ error: 'Session busy', sessionId: resolvedId });
    }

    const args = ['install', '-s', session.colabSession];
    if (requirement) {
        args.push('-r', requirement);
    } else if (packages) {
        const pkgList = Array.isArray(packages) ? packages : [packages];
        args.push(...pkgList);
    }

    console.log(`📦 Installing packages: ${args.join(' ')}`);

    try {
        const result = await runColabCli(args, 60000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Packages installed successfully'
        });
    } catch (error) {
        console.error(`❌ Install failed:`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'Install failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /ls - List files
app.get('/ls', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId query param required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;
    const pathArg = req.query.path || 'content';

    try {
        const result = await runColabCli(['ls', pathArg, '-s', session.colabSession], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            path: pathArg,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'ls failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /rm - Remove a remote file
app.post('/rm', async (req, res) => {
    const { sessionId, path: remotePath } = req.body;
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, path' });
    }

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['rm', remotePath, '-s', session.colabSession], 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            path: remotePath,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'File removed successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'rm failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /restart-kernel - Restart session kernel
app.post('/restart-kernel', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        return res.status(409).json({ error: 'Session busy, cannot restart', sessionId: resolvedId });
    }

    console.log(`🔄 Restarting kernel for session ${resolvedId.substring(0, 12)}`);
    try {
        const result = await runColabCli(['restart-kernel', '-s', session.colabSession], 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            message: 'Kernel restarted'
        });
    } catch (error) {
        console.error(`❌ Restart failed:`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'Restart failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /drivemount - Mount Google Drive
app.post('/drivemount', async (req, res) => {
    const { sessionId, path: mountPath } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;
    const mountPoint = mountPath || '/content/drive';

    try {
        const args = ['drivemount', mountPoint, '-s', session.colabSession];
        const result = await runColabCli(args, 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            mountPath: mountPoint,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Drive mounted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'drivemount failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /auth - Authenticate VM
app.post('/auth', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['auth', '-s', session.colabSession], 60000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'VM authenticated'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'auth failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /url - Get browser URL for session
app.get('/url', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId query param required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;
    const host = req.query.host || 'https://colab.research.google.com';

    try {
        const result = await runColabCli(['url', '-s', session.colabSession, '--host', host], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            url: result.stdout.trim(),
            host: host,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'url failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /version - Get CLI version
app.get('/version', async (req, res) => {
    try {
        const result = await runColabCli(['version'], 10000);
        res.json({
            success: true,
            version: result.stdout.trim(),
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'version failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /update - Check for updates
app.get('/update', async (req, res) => {
    const install = req.query.install === 'true';
    
    try {
        const args = ['update'];
        if (install) args.push('--install');
        const result = await runColabCli(args, 30000);
        res.json({
            success: true,
            install: install,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'update failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /log - Get session log
app.get('/log', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId query param required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;
    const lines = req.query.lines ? parseInt(req.query.lines) : null;
    const type = req.query.type || null;
    const output = req.query.output || null;

    try {
        const args = ['log', '-s', session.colabSession];
        if (lines) args.push('-n', lines.toString());
        if (type) args.push('-t', type);
        if (output) args.push('-o', output);
        
        const result = await runColabCli(args, 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'log failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /pay - Open Colab signup page
app.get('/pay', async (req, res) => {
    try {
        const result = await runColabCli(['pay'], 10000);
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Colab signup page opened'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'pay failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /readme - Print README
app.get('/readme', async (req, res) => {
    try {
        const result = await runColabCli(['readme'], 10000);
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'readme failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /skill - Print SKILL.md
app.get('/skill', async (req, res) => {
    try {
        const result = await runColabCli(['skill'], 10000);
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'skill failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /console - Connect to TTY console
app.post('/console', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['console', '-s', session.colabSession], 10000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Console connection attempted'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'console failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /repl - Start REPL
app.post('/repl', async (req, res) => {
    const { sessionId, code } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    try {
        let command;
        if (code) {
            const escapedCode = code
                .replace(/\\/g, '\\\\')
                .replace(/`/g, '\\`')
                .replace(/\$/g, '\\$')
                .replace(/"/g, '\\"');
            
            if (USE_PYTHON_MODULE) {
                command = `echo "${escapedCode}" | python3 -m colab_cli repl -s ${session.colabSession}`;
            } else {
                command = `echo "${escapedCode}" | ${COLAB_BINARY} repl -s ${session.colabSession}`;
            }
        } else {
            if (USE_PYTHON_MODULE) {
                command = `echo "print('REPL ready')" | python3 -m colab_cli repl -s ${session.colabSession}`;
            } else {
                command = `echo "print('REPL ready')" | ${COLAB_BINARY} repl -s ${session.colabSession}`;
            }
        }

        const result = await new Promise((resolve, reject) => {
            exec(command, { timeout: 30000, maxBuffer: 50 * 1024 * 1024, shell: '/bin/bash' }, (error, stdout, stderr) => {
                if (error && error.code !== 0) {
                    reject({ error, stdout, stderr });
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });

        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'REPL command executed'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'repl failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /run - Run Python script on fresh VM
app.post('/run', async (req, res) => {
    const { script, gpu, keep, timeout, sessionName } = req.body;
    if (!script) {
        return res.status(400).json({ error: 'script path required' });
    }

    try {
        await fs.access(script);
    } catch {
        return res.status(400).json({ error: 'Script file not found', script });
    }

    const args = ['run', script];
    if (gpu) args.push('--gpu', gpu);
    if (keep) args.push('--keep');
    if (timeout) args.push('--timeout', timeout.toString());
    if (sessionName) args.push('--session', sessionName);

    console.log(`📜 Running script: ${script} [gpu=${gpu || 'none'}]`);

    try {
        const result = await runColabCli(args, 60000);
        res.json({
            success: true,
            script: script,
            gpu: gpu || null,
            keep: keep || false,
            timeout: timeout || 30,
            sessionName: sessionName || null,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Script executed on fresh VM'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            script: script,
            error: 'Script execution failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /edit - Edit a file
app.post('/edit', async (req, res) => {
    const { sessionId, remotePath } = req.body;
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, remotePath' });
    }

    const found = resolveSession(sessionId);
    if (!found) return res.status(404).json({ error: 'Session not found', sessionId });

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['edit', remotePath, '-s', session.colabSession], 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            remotePath: remotePath,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Edit command sent'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'edit failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// IDLE SESSION CLEANUP
// ============================================
async function cleanupIdleSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > CONFIG.SESSION_TIMEOUT && session.status !== 'busy') {
            console.log(`🧹 Evicting idle session ${sessionId.substring(0, 12)}`);
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                cleaned++;
            } catch {}
            sessions.delete(sessionId);
        }
    }
    if (cleaned > 0) console.log(`🧹 Evicted ${cleaned} idle sessions`);
    setTimeout(cleanupIdleSessions, CONFIG.CLEANUP_INTERVAL);
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
let shuttingDown = false;

async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 ${signal} received — shutting down (${sessions.size} sessions)`);
    for (const [sessionId, session] of sessions.entries()) {
        try {
            await runColabCli(['stop', '-s', session.colabSession], 10000);
            await cleanupSessionFolder(sessionId);
        } catch {}
        sessions.delete(sessionId);
    }
    console.log('✅ Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => { console.error('💥 Uncaught:', err.message); gracefulShutdown('UNCAUGHT'); });
process.on('unhandledRejection', (r) => { console.error('💥 Unhandled rejection:', r); });

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: 'Available endpoints (matching colab CLI commands):',
        endpoints: [
            'GET  /health, /health/simple',
            'GET  /sessions, /sessions/:identifier',
            'GET  /sessions-list',
            'POST /new              { sessionId?, gpu? }',
            'POST /stop             { sessionId }',
            'DELETE /session/:sessionId',
            'POST /keepalive        { sessionId }',
            'POST /exec             { sessionId, code, cellNo }',
            'POST /exec-status      { sessionId, executionId }',
            'POST /exec-ack         { executionId }',
            'POST /restart-kernel   { sessionId }',
            'POST /install          { sessionId, packages?, requirement? }',
            'GET  /ls?sessionId=<id>&path=<path>',
            'POST /download         { sessionId, remotePath, localPath? }',
            'GET  /download-status?transferId=<id>',
            'POST /upload           (multipart/form-data with "file" field)',
            'GET  /upload-status?transferId=<id>',
            'POST /rm               { sessionId, path }',
            'POST /edit             { sessionId, remotePath }',
            'POST /drivemount       { sessionId, path? }',
            'POST /auth             { sessionId }',
            'POST /console          { sessionId }',
            'POST /repl             { sessionId, code? }',
            'POST /run              { script, gpu?, keep?, timeout?, sessionName? }',
            'GET  /status?sessionId=<id>',
            'GET  /url?sessionId=<id>&host=<host>',
            'GET  /log?sessionId=<id>&lines=<n>&type=<type>&output=<file>',
            'GET  /pay',
            'GET  /readme',
            'GET  /skill',
            'GET  /version',
            'GET  /update?install=<true/false>',
        ],
        timestamp: new Date().toISOString()
    });
});

// ============================================
// INIT
// ============================================
async function init() {
    console.log('🚀 Initializing Colab Orchestrator v3.0 (Shell Execution)...');

    await initColabBinary();
    await fs.mkdir(CONFIG.SESSIONS_BASE_DIR, { recursive: true });
    await fs.mkdir(CONFIG.UPLOAD_DIR, { recursive: true });
    await setupColabAuth();

    setTimeout(cleanupIdleSessions, CONFIG.CLEANUP_INTERVAL);

    const PORT = process.env.PORT || CONFIG.PORT;
    app.listen(PORT, () => {
        console.log(`\n🚀 Colab Orchestrator v3.0 running on port ${PORT}`);
        console.log(`📁 Sessions: ${CONFIG.SESSIONS_BASE_DIR}`);
        console.log(`📁 Uploads: ${CONFIG.UPLOAD_DIR}`);
        console.log(`📊 Max sessions: ${CONFIG.MAX_SESSIONS}`);
        console.log(`⏰ Session TTL: ${CONFIG.SESSION_TIMEOUT / 3600000}h`);
        console.log(`🔧 Colab binary: ${COLAB_BINARY}${USE_PYTHON_MODULE ? ' (-m colab_cli)' : ''}`);
        console.log(`🌐 CORS: All origins allowed`);
        console.log(`🔑 Auth: DISABLED (testing mode)`);
        console.log(`\n📡 Health: http://localhost:${PORT}/health`);
        console.log(`📖 Help: http://localhost:${PORT}/`);
        console.log('\n🚀 Ready!');
    });
}

init();
