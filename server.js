const express = require('express');
const { spawn, exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const cors = require('cors');
require('dotenv').config();

const app = express();
const execPromise = util.promisify(exec);

// ============================================
// CORS CONFIGURATION
// ============================================
const allowedOrigins = [
    'https://thereaper987.github.io',
    'https://kushalkumarj2006.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://colabbridge-53hx.onrender.com'
];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        console.warn(`❌ CORS blocked: ${origin}`);
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'api-secret', 'x-api-secret', 'Authorization'],
    exposedHeaders: ['Content-Type', 'api-secret'],
    credentials: true,
    maxAge: 86400
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// ============================================
// CONFIGURATION
// ============================================
const API_SECRET = process.env.API_SECRET;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 3;
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 3 * 60 * 60 * 1000;
const EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT) || 7200;
const MAX_CODE_SIZE = parseInt(process.env.MAX_CODE_SIZE) || 3 * 1024 * 1024;
const MAX_CODE_LENGTH = parseInt(process.env.MAX_CODE_LENGTH) || 100000;
const COMPLETED_EXECUTIONS_TTL = parseInt(process.env.COMPLETED_EXECUTIONS_TTL) || 10 * 60 * 1000;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 15000;
const SESSIONS_BASE_DIR = process.env.SESSIONS_BASE_DIR || path.join(os.tmpdir(), 'colab_sessions');
const HANGING_PROCESS_CLEANUP_INTERVAL = parseInt(process.env.HANGING_PROCESS_CLEANUP_INTERVAL) || 300000;
const DEFAULT_GPU = process.env.DEFAULT_GPU || 'T4';
const ENABLE_GPU_FLEXIBILITY = process.env.ENABLE_GPU_FLEXIBILITY === 'true';
const ENABLE_FILE_OPS = process.env.ENABLE_FILE_OPS === 'true';
const ENABLE_AUTOMATION = process.env.ENABLE_AUTOMATION === 'true';
const ENABLE_EPHEMERAL_RUN = process.env.ENABLE_EPHEMERAL_RUN === 'true';
const ENABLE_HISTORY_EXPORT = process.env.ENABLE_HISTORY_EXPORT === 'true';
const ENABLE_SESSION_PERSISTENCE = process.env.ENABLE_SESSION_PERSISTENCE === 'true';
const HISTORY_MAX_EVENTS = parseInt(process.env.HISTORY_MAX_EVENTS) || 1000;
const HISTORY_EXPORT_FORMATS = process.env.HISTORY_EXPORT_FORMATS ? process.env.HISTORY_EXPORT_FORMATS.split(',') : ['ipynb', 'md', 'txt', 'jsonl'];
const HISTORY_AUTO_CLEANUP = process.env.HISTORY_AUTO_CLEANUP === 'true';
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED === 'true';
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW) || 60000;
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000;
const API_SECRET_ROTATION_INTERVAL = parseInt(process.env.API_SECRET_ROTATION_INTERVAL) || 2592000000;
const ENABLE_CORS = process.env.ENABLE_CORS === 'true';
const MAX_CONCURRENT_EXECUTIONS = parseInt(process.env.MAX_CONCURRENT_EXECUTIONS) || 3;
const EXECUTION_QUEUE_TIMEOUT = parseInt(process.env.EXECUTION_QUEUE_TIMEOUT) || 300000;
const CLEANUP_BATCH_SIZE = parseInt(process.env.CLEANUP_BATCH_SIZE) || 10;
const LOG_MAX_SIZE = parseInt(process.env.LOG_MAX_SIZE) || 10485760;
const LOG_MAX_FILES = parseInt(process.env.LOG_MAX_FILES) || 5;
const ENABLE_REQUEST_LOGGING = process.env.ENABLE_REQUEST_LOGGING === 'true';
const ENABLE_ERROR_LOGGING = process.env.ENABLE_ERROR_LOGGING === 'true';
const CLEANUP_INTERVAL = parseInt(process.env.CLEANUP_INTERVAL) || 3600000;

// Colab binary configuration
let COLAB_BINARY = 'colab';
let USE_PYTHON_MODULE = false;

// ============================================
// COLAB BINARY SETUP
// ============================================

async function findColabBinaryRecursive() {
    const { execSync } = require('child_process');
    console.log('🔍 Searching for colab binary...');
    
    try {
        const whichPath = execSync('which colab 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
        if (whichPath && whichPath !== '') {
            console.log(`✅ Found colab via which: ${whichPath}`);
            return whichPath;
        }
    } catch(e) {}

    try {
        const pipPath = execSync('pip3 show google-colab-cli 2>/dev/null | grep Location | cut -d" " -f2', { encoding: 'utf8', timeout: 5000 }).trim();
        if (pipPath) {
            console.log(`📦 pip location: ${pipPath}`);
            const possibleBinary = `${pipPath}/colab_cli/__main__.py`;
            if (require('fs').existsSync(possibleBinary)) {
                console.log(`✅ Found colab via pip: ${possibleBinary}`);
                return 'python3';
            }
        }
    } catch(e) {}

    console.warn('⚠️ colab binary not found, will use python3 -m colab_cli');
    return 'python3';
}

async function initColabBinary() {
    const binary = await findColabBinaryRecursive();
    if (binary === 'python3') {
        USE_PYTHON_MODULE = true;
        COLAB_BINARY = 'python3';
        console.log(`🔧 Using Python module: ${COLAB_BINARY} -m colab_cli`);
    } else {
        COLAB_BINARY = binary;
        USE_PYTHON_MODULE = false;
        console.log(`🔧 Using colab binary: ${COLAB_BINARY}`);
    }
}

// ============================================
// COLAB CLI RUNNER (Enhanced - Fixed)
// ============================================

async function runColabCli(args, options = {}) {
    const { 
        sessionId = null,
        timeout = 30000, 
        env = {},
        cwd = null,
        maxBuffer = 50 * 1024 * 1024
    } = options;

    return new Promise((resolve, reject) => {
        let command;
        
        // Build command properly - handle args with spaces by quoting only those
        const formattedArgs = args.map(arg => {
            // If arg contains spaces or special characters, quote it
            if (arg.includes(' ') || arg.includes('"') || arg.includes("'") || arg.includes('\\')) {
                return `"${arg.replace(/"/g, '\\"')}"`;
            }
            return arg;
        }).join(' ');
        
        if (USE_PYTHON_MODULE) {
            command = `${COLAB_BINARY} -m colab_cli ${formattedArgs}`;
        } else {
            command = `${COLAB_BINARY} ${formattedArgs}`;
        }
        
        console.log(`Running: ${command}`);
        
        const envVars = { ...process.env, ...env };
        if (sessionId) {
            const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
            envVars.COLAB_CONFIG_DIR = path.join(sessionFolder, '.config');
        }
        
        const execOptions = {
            timeout: timeout,
            shell: '/bin/bash',
            maxBuffer: maxBuffer,
            env: envVars
        };
        
        if (cwd) execOptions.cwd = cwd;
        
        exec(command, execOptions, (error, stdout, stderr) => {
            if (error && error.code !== 0) {
                console.error(`Command failed: ${error.message}`);
                console.error(`Stdout: ${stdout}`);
                console.error(`Stderr: ${stderr}`);
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
    if (!process.env.COLAB_AUTH_TOKEN) {
        console.warn('⚠️ COLAB_AUTH_TOKEN not found in environment');
        return false;
    }

    try {
        let rawToken = process.env.COLAB_AUTH_TOKEN.trim();
        if ((rawToken.startsWith("'") && rawToken.endsWith("'")) || 
            (rawToken.startsWith('"') && rawToken.endsWith('"'))) {
            rawToken = rawToken.slice(1, -1);
            console.log('📝 Stripped surrounding quotes from token');
        }

        const tokenData = JSON.parse(rawToken);
        
        if (tokenData.token && !tokenData.access_token) {
            tokenData.access_token = tokenData.token;
            console.log('📝 Converted "token" field to "access_token"');
        }
        
        console.log('✅ Parsed COLAB_AUTH_TOKEN successfully');
        
        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
            path.join(configDir, 'token.json'), 
            JSON.stringify(tokenData, null, 2)
        );
        console.log('✅ Written token.json');

        await fs.writeFile(
            path.join(configDir, 'sessions.json'), 
            JSON.stringify({})
        );
        console.log('✅ Written sessions.json');
        
        const verifyToken = await fs.readFile(path.join(configDir, 'token.json'), 'utf8');
        const parsed = JSON.parse(verifyToken);
        if (parsed.access_token) {
            console.log('✅ Token verification passed');
            return true;
        } else {
            console.warn('⚠️ Token verification failed - no access_token found');
            return false;
        }
    } catch (error) {
        console.error('❌ Auth setup failed:', error.message);
        return false;
    }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

async function createSessionFolder(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    await fs.mkdir(sessionFolder, { recursive: true });
    return sessionFolder;
}

async function cleanupSessionFolder(sessionId) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    try {
        await fs.rm(sessionFolder, { recursive: true, force: true });
        console.log(`✅ Cleaned up folder for session ${sessionId}`);
    } catch (error) {
        console.error(`Failed to cleanup folder for ${sessionId}:`, error.message);
    }
}

// ============================================
// SESSION DATA JSON MANAGEMENT
// ============================================

async function appendSessionData(sessionId, data) {
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    const dataFile = path.join(sessionFolder, 'session_data.json');
    
    try {
        let sessionData = {};
        try {
            const content = await fs.readFile(dataFile, 'utf8');
            sessionData = JSON.parse(content);
        } catch (e) {
            sessionData = {
                sessionId: sessionId,
                createdAt: new Date().toISOString(),
                cells: [],
                totalCells: 0,
                totalExecutions: 0
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
    const sessionFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    const dataFile = path.join(sessionFolder, 'session_data.json');
    
    try {
        const content = await fs.readFile(dataFile, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        return null;
    }
}

// ============================================
// API HELPERS
// ============================================

function validateApiSecret(input) {
    if (!input) return false;
    return input === API_SECRET;
}

function extractApiSecret(req) {
    return req.body?.api_secret || 
           req.headers['api-secret'] || 
           req.headers['x-api-secret'];
}

function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

function generateExecutionId() {
    return crypto.randomBytes(16).toString('hex');
}

function formatMemory(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function resolveHardware(gpu, tpu) {
    if (tpu) {
        const validTpus = ['v5e1', 'v6e1'];
        const normalized = tpu.toLowerCase();
        if (!validTpus.includes(normalized)) {
            throw new Error(`Invalid TPU: ${tpu}. Supported: ${validTpus.join(', ')}`);
        }
        return { variant: 'TPU', accelerator: normalized.toUpperCase() };
    }
    
    if (gpu) {
        const mapping = {
            'a100': 'A100',
            'h100': 'H100', 
            'l4': 'L4',
            't4': 'T4',
            'g4': 'G4'
        };
        const normalized = gpu.toLowerCase();
        if (!mapping[normalized]) {
            throw new Error(`Invalid GPU: ${gpu}. Supported: ${Object.keys(mapping).join(', ')}`);
        }
        return { variant: 'GPU', accelerator: mapping[normalized] };
    }
    
    return { variant: 'DEFAULT', accelerator: 'NONE' };
}

function resolveSessionName(customName) {
    if (customName) return customName;
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function validateSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status === 'busy') throw new Error('Session is busy');
    return session;
}

function formatSuccess(data, message = 'Success') {
    return {
        success: true,
        data: data,
        message: message,
        timestamp: new Date().toISOString()
    };
}

function formatError(message, code = 500, details = null) {
    return {
        success: false,
        error: message,
        code: code,
        details: details,
        timestamp: new Date().toISOString()
    };
}

// ============================================
// STATE MANAGEMENT
// ============================================

const sessions = new Map();
const executionQueue = new Set();
const completedExecutions = new Map();
const executionProcesses = new Map();

// Cleanup completed executions periodically
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [execId, data] of completedExecutions.entries()) {
        if (now - data.completedAt > COMPLETED_EXECUTIONS_TTL) {
            completedExecutions.delete(execId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} completed executions from memory`);
    }
}, 60 * 1000);

// Cleanup hanging processes (safety net)
setInterval(() => {
    const now = Date.now();
    for (const [execId, process] of executionProcesses.entries()) {
        try {
            process.kill(0);
            const session = Array.from(sessions.values()).find(s => 
                s.currentExecution?.executionId === execId
            );
            if (session && Date.now() - session.currentExecution.startedAt > 2.5 * 60 * 60 * 1000) {
                console.log(`⚠️ Killing hanging process ${execId}`);
                process.kill('SIGTERM');
                executionProcesses.delete(execId);
            }
        } catch {
            executionProcesses.delete(execId);
        }
    }
}, HANGING_PROCESS_CLEANUP_INTERVAL);

// Cleanup idle sessions
async function cleanupIdleSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > SESSION_TIMEOUT && session.status !== 'busy') {
            console.log(`🧹 Cleaning idle session ${sessionId}`);
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                cleaned++;
            } catch (error) {
                console.error(`❌ Failed to clean session ${sessionId}:`, error.message);
            }
            sessions.delete(sessionId);
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} idle sessions`);
    }
    setTimeout(cleanupIdleSessions, 60 * 60 * 1000);
}

// ============================================
// CODE EXECUTION (Enhanced with spawn() for safety)
// ============================================

async function executeCodeInColab(sessionId, cellNo, code, executionId, timeout = null) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const startedAt = Date.now();
    let childProcess = null;
    let cellData = {
        type: 'execution',
        cellNo: cellNo,
        startedAt: new Date(startedAt).toISOString(),
        code: code,
        status: 'running'
    };
    
    try {
        if (Buffer.byteLength(code, 'utf8') > MAX_CODE_SIZE) {
            throw new Error(`Code exceeds ${MAX_CODE_SIZE} bytes`);
        }

        const execTimeout = timeout || EXECUTION_TIMEOUT;
        
        // Build spawn command and arguments (no shell, no escaping needed!)
        let spawnCmd;
        let spawnArgs = [];
        
        if (USE_PYTHON_MODULE) {
            spawnCmd = 'python3';
            spawnArgs = ['-m', 'colab_cli', 'exec', '-s', session.colabSession, '--timeout', String(execTimeout)];
        } else {
            spawnCmd = COLAB_BINARY;
            spawnArgs = ['exec', '-s', session.colabSession, '--timeout', String(execTimeout)];
        }

        console.log(`▶️ Spawning: ${spawnCmd} ${spawnArgs.join(' ')}`);
        console.log(`📝 Code length: ${code.length} chars`);

        // Spawn the process - NO SHELL, just raw binary + args array
        childProcess = spawn(spawnCmd, spawnArgs, {
            timeout: execTimeout * 1000,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'] // stdin, stdout, stderr all piped
        });

        executionProcesses.set(executionId, childProcess);

        let stdout = '';
        let stderr = '';

        // Capture stdout for polling
        childProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.currentExecution?.executionId === executionId) {
                currentSession.currentExecution.partialOutput = stdout;
                currentSession.currentExecution.partialError = stderr;
                sessions.set(sessionId, currentSession);
            }
        });

        // Capture stderr for polling
        childProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.currentExecution?.executionId === executionId) {
                currentSession.currentExecution.partialOutput = stdout;
                currentSession.currentExecution.partialError = stderr;
                sessions.set(sessionId, currentSession);
            }
        });

        // WRITE CODE DIRECTLY TO STDIN - Safe, no escaping needed!
        childProcess.stdin.write(code);
        childProcess.stdin.end();

        // Wait for process to complete
        const result = await new Promise((resolve, reject) => {
            childProcess.on('close', (code) => {
                if (code !== 0) {
                    reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr });
                } else {
                    resolve({ stdout, stderr });
                }
            });
            
            childProcess.on('error', (err) => {
                reject({ error: err, stdout, stderr });
            });
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
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData.status = 'completed';
        cellData.completedAt = new Date(completedAt).toISOString();
        cellData.executionTime = executionTime;
        cellData.output = result.stdout || '(No output)';
        cellData.error = result.stderr || '';
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
        if (updatedSession && updatedSession.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData.status = 'failed';
        cellData.completedAt = new Date(completedAt).toISOString();
        cellData.executionTime = completedAt - startedAt;
        cellData.output = error.stdout || '';
        cellData.error = error.stderr || error.message || String(error);
        await appendSessionData(sessionId, cellData);

        console.error(`❌ Execution ${executionId} failed:`, error.message);
        throw error;
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId, timeout = null) {
    const execKey = `${sessionId}_${cellNo}`;
    if (executionQueue.has(execKey)) return;
    
    executionQueue.add(execKey);
    console.log(`📋 Queued execution ${executionId} for session ${sessionId}, cell ${cellNo}`);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId, timeout);
    } catch (error) {
        console.error(`💥 Background error for ${executionId}:`, error.message);
    } finally {
        executionQueue.delete(execKey);
        console.log(`📋 Removed execution ${executionId} from queue`);
    }
}

// ============================================
// PUBLIC ENDPOINTS (No Auth Required)
// ============================================

// Health check - Full
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const now = new Date().toISOString();
    res.json({
        status: 'healthy',
        activeSessions: sessions.size,
        maxSessions: MAX_SESSIONS,
        sessionDetails: Array.from(sessions.entries()).map(([id, s]) => ({
            id: id.slice(0, 12) + '...',
            colabSession: s.colabSession,
            createdAt: new Date(s.createdAt).toISOString(),
            lastActivity: new Date(s.lastActivity).toISOString(),
            status: s.status,
            hardware: s.hardware || 'CPU',
            hasCurrentExecution: !!s.currentExecution
        })),
        completedExecutions: completedExecutions.size,
        queuedExecutions: executionQueue.size,
        uptime: process.uptime(),
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed),
            external: formatMemory(memUsage.external),
            arrayBuffers: formatMemory(memUsage.arrayBuffers)
        },
        timestamp: now,
        colabBinary: COLAB_BINARY,
        usePythonModule: USE_PYTHON_MODULE,
        hasAuthToken: !!process.env.COLAB_AUTH_TOKEN
    });
});

// Health check - Simple
app.get('/health/simple', (req, res) => {
    res.json({
        status: 'up',
        timestamp: new Date().toISOString(),
        sessions: sessions.size
    });
});

// List all sessions (public)
app.get('/sessions', async (req, res) => {
    const memUsage = process.memoryUsage();
    const sessionData = [];
    let totalCells = 0;
    let totalExecutions = 0;

    for (const [id, session] of sessions.entries()) {
        const dataFile = await getSessionData(id);
        const cellsCount = dataFile?.cells?.length || 0;
        const executionsCount = dataFile?.totalExecutions || 0;
        totalCells += cellsCount;
        totalExecutions += executionsCount;

        const activeMinutes = ((Date.now() - session.createdAt) / 1000 / 60).toFixed(2);
        
        sessionData.push({
            sub: id.substring(0, 8),
            sessionId: id,
            colabSession: session.colabSession,
            status: session.status,
            hardware: session.hardware || 'CPU',
            variant: session.variant || 'DEFAULT',
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: parseFloat(activeMinutes),
            cellsExecuted: cellsCount,
            executions: executionsCount,
            hasCurrentExecution: !!session.currentExecution,
            folder: session.folder,
            dataFileExists: dataFile !== null
        });
    }

    res.json({
        totalSessions: sessions.size,
        maxSessions: MAX_SESSIONS,
        sessions: sessionData,
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed),
            external: formatMemory(memUsage.external),
            arrayBuffers: formatMemory(memUsage.arrayBuffers)
        },
        totalCellsExecuted: totalCells,
        totalExecutions: totalExecutions,
        queuedExecutions: executionQueue.size,
        completedExecutions: completedExecutions.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Get session details by sub or full sessionId (public)
app.get('/sessions/:identifier', async (req, res) => {
    const { identifier } = req.params;
    const cleanIdentifier = identifier.replace(/\/$/, '');
    
    let session = null;
    let sessionId = null;
    
    for (const [id, s] of sessions.entries()) {
        const sub = id.substring(0, 8);
        if (id === cleanIdentifier || sub === cleanIdentifier) {
            session = s;
            sessionId = id;
            break;
        }
    }
    
    if (!session) {
        return res.status(404).json({ 
            error: 'Session not found',
            message: `No session found with identifier: ${cleanIdentifier}`
        });
    }

    const sessionData = await getSessionData(sessionId);
    const memUsage = process.memoryUsage();

    res.json({
        session: {
            sub: sessionId.substring(0, 8),
            sessionId: sessionId,
            colabSession: session.colabSession,
            status: session.status,
            hardware: session.hardware || 'CPU',
            variant: session.variant || 'DEFAULT',
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: ((Date.now() - session.createdAt) / 1000 / 60).toFixed(2),
            hasCurrentExecution: !!session.currentExecution,
            folder: session.folder
        },
        sessionData: sessionData,
        currentExecution: session.currentExecution || null,
        memoryUsage: {
            rss: formatMemory(memUsage.rss),
            heapTotal: formatMemory(memUsage.heapTotal),
            heapUsed: formatMemory(memUsage.heapUsed),
            external: formatMemory(memUsage.external),
            arrayBuffers: formatMemory(memUsage.arrayBuffers)
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// HELP ENDPOINT (Public - No Auth Required)
// ============================================

/**
 * GET /help
 * Returns comprehensive API documentation for AI agents and developers.
 * This endpoint explains every available endpoint, their purpose, request/response formats,
 * authentication requirements, and provides usage examples.
 */
app.get('/help', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    res.json({
        server: {
            name: "ColabBridge API",
            version: "2.1.0",
            description: "A REST API wrapper around Google Colab CLI that enables remote execution of Python code on Colab VMs",
            baseUrl: baseUrl,
            documentation: "This help endpoint provides complete API documentation for AI agents and developers",
            lastUpdated: new Date().toISOString()
        },
        authentication: {
            description: "Most endpoints require an API secret for authentication. The secret can be sent in multiple ways:",
            methods: [
                {
                    method: "Request Body",
                    description: "Include 'api_secret' in the JSON body of POST requests",
                    example: '{"api_secret": "your-secret", ...otherFields}'
                },
                {
                    method: "HTTP Header",
                    description: "Send 'api-secret' header with the secret value",
                    example: "api-secret: your-secret"
                },
                {
                    method: "HTTP Header (Alternative)",
                    description: "Send 'x-api-secret' header with the secret value",
                    example: "x-api-secret: your-secret"
                }
            ],
            publicEndpoints: [
                "GET /health",
                "GET /health/simple",
                "GET /help",
                "GET /sessions",
                "GET /sessions/:identifier"
            ],
            note: "The API secret is configured via the API_SECRET environment variable."
        },
        environmentVariables: {
            API_SECRET: "Your API secret for authentication (required)",
            COLAB_AUTH_TOKEN: "Google Colab authentication token in JSON format (required)",
            COLAB_REFRESH_DATA: "Refresh data extracted from token.json (optional)",
            PORT: "Server port (default: 3000)",
            NODE_ENV: "Environment mode: development/production (default: development)",
            LOG_LEVEL: "Logging verbosity: info/debug/error (default: info)",
            DEBUG_ENABLED: "Enable debug mode (default: true)",
            MAX_SESSIONS: "Maximum concurrent sessions (default: 3)",
            SESSION_TIMEOUT: "Session idle timeout in milliseconds (default: 10800000 = 3 hours)",
            SESSIONS_BASE_DIR: "Session storage directory (default: /tmp/colab_sessions)",
            PERSIST_SESSION_DATA: "Persist session data to disk (default: true)",
            CLEANUP_INTERVAL: "Idle session cleanup interval in milliseconds (default: 3600000 = 1 hour)",
            EXECUTION_TIMEOUT: "Default execution timeout in seconds (default: 7200 = 2 hours)",
            MAX_CODE_SIZE: "Maximum code size in bytes (default: 3145728 = 3 MB)",
            MAX_CODE_LENGTH: "Maximum code length in characters (default: 100000)",
            MAX_RETRY_ATTEMPTS: "Retry attempts for failed executions (default: 3)",
            STREAMING_ENABLED: "Enable streaming output (default: true)",
            COMPLETED_EXECUTIONS_TTL: "Keep completed executions in memory in milliseconds (default: 1200000 = 20 minutes)",
            POLL_INTERVAL: "Recommended polling interval in milliseconds (default: 10000 = 10 seconds)",
            HANGING_PROCESS_CLEANUP_INTERVAL: "Hanging process cleanup interval in milliseconds (default: 900000 = 15 minutes)",
            DEFAULT_GPU: "Default GPU if none specified (default: T4)",
            ENABLE_GPU_FLEXIBILITY: "Allow GPU/TPU selection per session (default: true)",
            ENABLE_FILE_OPS: "Enable file operation endpoints (default: true)",
            ENABLE_AUTOMATION: "Enable automation endpoints (default: true)",
            ENABLE_EPHEMERAL_RUN: "Enable colab run command (default: true)",
            ENABLE_HISTORY_EXPORT: "Enable history export (default: true)",
            ENABLE_SESSION_PERSISTENCE: "Persist session data to disk (default: true)",
            HISTORY_MAX_EVENTS: "Max events to keep in history (default: 1000)",
            HISTORY_EXPORT_FORMATS: "Allowed export formats (default: ipynb,md,txt,jsonl)",
            HISTORY_AUTO_CLEANUP: "Auto-cleanup old history (default: true)",
            RATE_LIMIT_ENABLED: "Enable rate limiting (default: false)",
            RATE_LIMIT_WINDOW: "Rate limit window in milliseconds (default: 60000)",
            RATE_LIMIT_MAX_REQUESTS: "Max requests per window (default: 1000)",
            API_SECRET_ROTATION_INTERVAL: "Secret rotation interval in milliseconds (default: 2592000000 = 30 days)",
            ENABLE_CORS: "Enable CORS (default: true)",
            CORS_ALLOWED_ORIGINS: "Comma-separated list of allowed origins",
            MAX_CONCURRENT_EXECUTIONS: "Max concurrent executions (default: 3)",
            EXECUTION_QUEUE_TIMEOUT: "Queue timeout in milliseconds (default: 300000 = 5 minutes)",
            CLEANUP_BATCH_SIZE: "Batch size for cleanup (default: 10)",
            LOG_MAX_SIZE: "Max log file size in bytes (default: 10485760 = 10 MB)",
            LOG_MAX_FILES: "Max log files to keep (default: 5)",
            ENABLE_REQUEST_LOGGING: "Log all requests (default: true)",
            ENABLE_ERROR_LOGGING: "Log all errors (default: true)"
        },
        endpoints: {
            // ============================================
            // PUBLIC ENDPOINTS
            // ============================================
            health: {
                method: "GET",
                path: "/health",
                authRequired: false,
                purpose: "Full health check - Returns detailed server status, memory usage, active sessions, and Colab CLI configuration",
                request: {
                    format: "No request body required",
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    fields: {
                        status: "Always 'healthy' if server is running",
                        activeSessions: "Number of active Colab sessions",
                        maxSessions: "Maximum sessions allowed (configurable via MAX_SESSIONS)",
                        sessionDetails: "Array of session objects with truncated IDs",
                        sessionDetails_id: "Truncated session ID (first 12 chars + '...')",
                        sessionDetails_colabSession: "Internal Colab session name",
                        sessionDetails_createdAt: "Session creation timestamp",
                        sessionDetails_lastActivity: "Last activity timestamp",
                        sessionDetails_status: "Session status: 'ready', 'busy', or 'auth_required'",
                        sessionDetails_hardware: "Hardware type: 'CPU', 'T4', 'A100', etc.",
                        sessionDetails_hasCurrentExecution: "Whether a code execution is running",
                        completedExecutions: "Number of completed executions in memory",
                        queuedExecutions: "Number of executions waiting to run",
                        uptime: "Server uptime in seconds",
                        memoryUsage: "Memory usage breakdown",
                        memoryUsage_rss: "Resident Set Size",
                        memoryUsage_heapTotal: "Total heap size",
                        memoryUsage_heapUsed: "Used heap size",
                        memoryUsage_external: "External memory",
                        memoryUsage_arrayBuffers: "Array buffers memory",
                        timestamp: "Current server time in ISO format",
                        colabBinary: "Path to Colab CLI binary being used",
                        usePythonModule: "Whether Python module is being used instead of binary",
                        hasAuthToken: "Whether COLAB_AUTH_TOKEN is configured"
                    }
                },
                usage: {
                    curl: `curl ${baseUrl}/health`,
                    javascript: `fetch('${baseUrl}/health').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/health').json())`
                },
                exampleResponse: {
                    status: "healthy",
                    activeSessions: 2,
                    maxSessions: 3,
                    sessionDetails: [
                        {
                            id: "a1b2c3d4e5f6...",
                            colabSession: "colab_a1b2c3d4e5f6",
                            createdAt: "2026-06-17T10:00:00.000Z",
                            lastActivity: "2026-06-17T10:05:00.000Z",
                            status: "ready",
                            hardware: "T4",
                            hasCurrentExecution: false
                        }
                    ],
                    completedExecutions: 5,
                    queuedExecutions: 0,
                    uptime: 3600,
                    memoryUsage: {
                        rss: "71.21 MB",
                        heapTotal: "13.21 MB",
                        heapUsed: "11.28 MB",
                        external: "2.5 MB",
                        arrayBuffers: "1.2 MB"
                    },
                    timestamp: "2026-06-17T10:05:00.000Z",
                    colabBinary: "/usr/local/bin/colab",
                    usePythonModule: false,
                    hasAuthToken: true
                }
            },
            healthSimple: {
                method: "GET",
                path: "/health/simple",
                authRequired: false,
                purpose: "Simple health check - Quick ping to verify server is alive",
                request: {
                    format: "No request body required",
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    fields: {
                        status: "Always 'up' if server is running",
                        timestamp: "Current server time in ISO format",
                        sessions: "Number of active sessions"
                    }
                },
                usage: {
                    curl: `curl ${baseUrl}/health/simple`,
                    javascript: `fetch('${baseUrl}/health/simple').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/health/simple').json())`
                },
                exampleResponse: {
                    status: "up",
                    timestamp: "2026-06-17T10:05:00.000Z",
                    sessions: 2
                }
            },
            sessions: {
                method: "GET",
                path: "/sessions",
                authRequired: false,
                purpose: "List all active sessions with their details and execution history",
                request: {
                    format: "No request body required",
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    fields: {
                        totalSessions: "Total number of active sessions",
                        maxSessions: "Maximum sessions allowed",
                        sessions: "Array of session objects",
                        sessions_sub: "Short identifier (first 8 chars of sessionId)",
                        sessions_sessionId: "Full 64-character hex session ID",
                        sessions_colabSession: "Internal Colab session name",
                        sessions_status: "Session status: 'ready', 'busy', or 'auth_required'",
                        sessions_hardware: "Hardware type: 'CPU', 'T4', 'A100', etc.",
                        sessions_variant: "Hardware variant: 'DEFAULT', 'GPU', 'TPU'",
                        sessions_createdAt: "Session creation timestamp",
                        sessions_lastActivity: "Last activity timestamp",
                        sessions_activeMinutes: "Session age in minutes",
                        sessions_cellsExecuted: "Number of cells executed",
                        sessions_executions: "Number of executions",
                        sessions_hasCurrentExecution: "Whether a code execution is running",
                        sessions_folder: "Session folder path on server",
                        sessions_dataFileExists: "Whether session data file exists",
                        memoryUsage: "Current memory usage breakdown",
                        totalCellsExecuted: "Total cells executed across all sessions",
                        totalExecutions: "Total executions across all sessions",
                        queuedExecutions: "Number of queued executions",
                        completedExecutions: "Number of completed executions in memory",
                        uptime: "Server uptime in seconds",
                        timestamp: "Current server time"
                    }
                },
                usage: {
                    curl: `curl ${baseUrl}/sessions`,
                    javascript: `fetch('${baseUrl}/sessions').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/sessions').json())`
                },
                exampleResponse: {
                    totalSessions: 2,
                    maxSessions: 3,
                    sessions: [
                        {
                            sub: "a1b2c3d4",
                            sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
                            colabSession: "colab_a1b2c3d4e5f6",
                            status: "ready",
                            hardware: "T4",
                            variant: "GPU",
                            createdAt: "2026-06-17T10:00:00.000Z",
                            lastActivity: "2026-06-17T10:05:00.000Z",
                            activeMinutes: 5.0,
                            cellsExecuted: 3,
                            executions: 3,
                            hasCurrentExecution: false,
                            folder: "/tmp/colab_sessions/a1b2c3d4...",
                            dataFileExists: true
                        }
                    ],
                    memoryUsage: {
                        rss: "71.21 MB",
                        heapTotal: "13.21 MB",
                        heapUsed: "11.28 MB",
                        external: "2.5 MB",
                        arrayBuffers: "1.2 MB"
                    },
                    totalCellsExecuted: 3,
                    totalExecutions: 3,
                    queuedExecutions: 0,
                    completedExecutions: 5,
                    uptime: 3600,
                    timestamp: "2026-06-17T10:05:00.000Z"
                }
            },
            sessionDetails: {
                method: "GET",
                path: "/sessions/:identifier",
                authRequired: false,
                purpose: "Get detailed information about a specific session",
                request: {
                    format: "URL parameter",
                    parameters: {
                        identifier: "Session ID (full 64-char hex) OR sub (first 8 chars). E.g., /sessions/a1b2c3d4 or /sessions/a1b2c3d4e5f6..."
                    },
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    fields: {
                        session: "Session metadata object",
                        session_sub: "Short identifier (first 8 chars)",
                        session_sessionId: "Full 64-character hex session ID",
                        session_colabSession: "Colab session name",
                        session_status: "Current status ('ready', 'busy', 'auth_required')",
                        session_hardware: "Hardware type",
                        session_variant: "Hardware variant",
                        session_createdAt: "Creation timestamp",
                        session_lastActivity: "Last activity timestamp",
                        session_activeMinutes: "Session age in minutes",
                        session_hasCurrentExecution: "Whether execution is running",
                        session_folder: "Session folder path",
                        sessionData: "Detailed execution history with all cells",
                        sessionData_cells: "Array of executed cells with code, outputs, and status",
                        sessionData_totalCells: "Total cells count",
                        sessionData_totalExecutions: "Total executions count",
                        sessionData_lastUpdated: "Last update timestamp",
                        currentExecution: "Currently running execution info (or null)",
                        currentExecution_executionId: "Execution ID",
                        currentExecution_cellNo: "Cell number being executed",
                        currentExecution_startedAt: "Start timestamp (milliseconds)",
                        currentExecution_status: "Execution status ('running')",
                        currentExecution_partialOutput: "Partial stdout output so far",
                        currentExecution_partialError: "Partial stderr output so far",
                        memoryUsage: "Memory usage breakdown",
                        timestamp: "Current server time"
                    },
                    error: {
                        status: 404,
                        body: { error: "Session not found", message: "No session found with identifier: ..." }
                    }
                },
                usage: {
                    curl: `curl ${baseUrl}/sessions/a1b2c3d4`,
                    javascript: `fetch('${baseUrl}/sessions/a1b2c3d4').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/sessions/a1b2c3d4').json())`
                },
                exampleResponse: {
                    session: {
                        sub: "a1b2c3d4",
                        sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
                        colabSession: "colab_a1b2c3d4e5f6",
                        status: "ready",
                        hardware: "T4",
                        variant: "GPU",
                        createdAt: "2026-06-17T10:00:00.000Z",
                        lastActivity: "2026-06-17T10:05:00.000Z",
                        activeMinutes: "5.00",
                        hasCurrentExecution: false,
                        folder: "/tmp/colab_sessions/a1b2c3d4..."
                    },
                    sessionData: {
                        sessionId: "a1b2c3d4...",
                        createdAt: "2026-06-17T10:00:00.000Z",
                        cells: [
                            {
                                type: "execution",
                                cellNo: 1,
                                startedAt: "2026-06-17T10:01:00.000Z",
                                code: "print('Hello')",
                                status: "completed",
                                completedAt: "2026-06-17T10:01:01.000Z",
                                executionTime: 1234,
                                output: "Hello\n",
                                error: ""
                            }
                        ],
                        totalCells: 1,
                        totalExecutions: 1,
                        lastUpdated: "2026-06-17T10:01:01.000Z"
                    },
                    currentExecution: null,
                    memoryUsage: {
                        rss: "71.21 MB",
                        heapTotal: "13.21 MB",
                        heapUsed: "11.28 MB",
                        external: "2.5 MB",
                        arrayBuffers: "1.2 MB"
                    },
                    timestamp: "2026-06-17T10:05:00.000Z"
                }
            },
            help: {
                method: "GET",
                path: "/help",
                authRequired: false,
                purpose: "Returns this complete API documentation for AI agents and developers",
                request: {
                    format: "No request body required",
                    headers: "None required"
                },
                response: {
                    format: "JSON",
                    description: "This entire documentation structure"
                },
                usage: {
                    curl: `curl ${baseUrl}/help`,
                    javascript: `fetch('${baseUrl}/help').then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.get('${baseUrl}/help').json())`
                }
            },
            // ============================================
            // SESSION MANAGEMENT (Auth Required)
            // ============================================
            createSession: {
                method: "POST",
                path: "/session/new",
                authRequired: true,
                purpose: "Create a new Colab session with flexible hardware selection (GPU/TPU/CPU)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        session_name: "Optional custom session name (auto-generated if omitted)",
                        gpu: "GPU type: T4, L4, G4, H100, A100 (optional)",
                        tpu: "TPU type: v5e1, v6e1 (optional)",
                        timeout: "Custom session timeout in milliseconds (optional)"
                    },
                    examples: {
                        cpu: {
                            api_secret: "your-api-key",
                            session_name: "cpu-session"
                        },
                        gpu: {
                            api_secret: "your-api-key",
                            session_name: "gpu-training",
                            gpu: "A100"
                        },
                        tpu: {
                            api_secret: "your-api-key",
                            session_name: "tpu-inference",
                            tpu: "v5e1"
                        }
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        sessionId: "64-character hex session ID",
                        hardware: "Hardware type (CPU, T4, A100, etc.)",
                        variant: "Hardware variant (DEFAULT, GPU, TPU)",
                        authUrl: "null (no auth needed)",
                        expiresIn: "Session timeout in milliseconds",
                        activeSessions: "Current session count",
                        maxSessions: "Maximum allowed sessions",
                        message: "Session created with hardware"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    rateLimit: {
                        status: 429,
                        body: { error: "Max sessions reached" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/session/new -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","gpu":"T4"}'`,
                    javascript: `fetch('${baseUrl}/session/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', gpu: 'T4' }) }).then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.post('${baseUrl}/session/new', json={'api_secret':'your-api-key','gpu':'T4'}).json())`
                },
                exampleResponse: {
                    success: true,
                    sessionId: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
                    hardware: "T4",
                    variant: "GPU",
                    authUrl: null,
                    expiresIn: 10800000,
                    activeSessions: 2,
                    maxSessions: 3,
                    message: "Session created with T4"
                }
            },
            deleteSession: {
                method: "DELETE",
                path: "/session/:sessionId",
                authRequired: true,
                purpose: "Terminate a session and release the Colab VM",
                request: {
                    format: "URL parameter + headers",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    },
                    parameters: {
                        sessionId: "Session ID to delete (in URL path)"
                    },
                    example: `DELETE ${baseUrl}/session/a1b2c3d4e5f6...`
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Session terminated"
                    },
                    warning: {
                        success: true,
                        warning: "Session removed from tracking, but may still exist remotely"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X DELETE ${baseUrl}/session/a1b2c3d4e5f6... -H "api-secret: your-api-key"`,
                    javascript: `fetch('${baseUrl}/session/a1b2c3d4e5f6...', { method: 'DELETE', headers: { 'api-secret': 'your-api-key' } }).then(r => r.json()).then(console.log);`,
                    python: `import requests; print(requests.delete('${baseUrl}/session/a1b2c3d4e5f6...', headers={'api-secret':'your-api-key'}).json())`
                }
            },
            keepAlive: {
                method: "POST",
                path: "/keepalive",
                authRequired: true,
                purpose: "Keep a session alive to prevent idle timeout (default 3 hours)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID to keep alive (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6..."
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Session kept alive"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/keepalive -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4..."}'`,
                    javascript: `fetch('${baseUrl}/keepalive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...' }) }).then(r => r.json()).then(console.log);`
                },
                recommendedInterval: "Call every 30-60 minutes to prevent session expiration",
                exampleResponse: {
                    success: true,
                    message: "Session kept alive"
                }
            },
            restartKernel: {
                method: "POST",
                path: "/session/restart-kernel",
                authRequired: true,
                purpose: "Restart the Jupyter kernel of a running session (keeps VM alive)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6..."
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Kernel restarted successfully"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/session/restart-kernel -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4..."}'`,
                    javascript: `fetch('${baseUrl}/session/restart-kernel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...' }) }).then(r => r.json()).then(console.log);`
                }
            },
            sessionStatus: {
                method: "POST",
                path: "/session/status",
                authRequired: true,
                purpose: "Get detailed status of a session including current execution info",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6..."
                    }
                },
                response: {
                    format: "JSON",
                    fields: {
                        success: "Always true if successful",
                        sessionId: "Session ID",
                        status: "Session status: 'BUSY' or 'IDLE'",
                        running: "What's currently running (or null)",
                        hardware: "Hardware type",
                        variant: "Hardware variant",
                        lastExecution: "Last execution info (or null)",
                        lastExecution_file: "Executed file name",
                        lastExecution_cell: "Cell number or identifier",
                        lastExecution_time: "Execution timestamp",
                        rawOutput: "Raw CLI output from status command"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/session/status -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4..."}'`,
                    javascript: `fetch('${baseUrl}/session/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...' }) }).then(r => r.json()).then(console.log);`
                }
            },
            // ============================================
            // CODE EXECUTION (Auth Required)
            // ============================================
            executeCode: {
                method: "POST",
                path: "/exec",
                authRequired: true,
                purpose: "Execute Python code on a Colab session with async polling support",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID to execute on (required)",
                        code: "Python code to execute (required)",
                        cellNo: "Cell number for tracking (required, integer)",
                        timeout: "Custom timeout in seconds (optional, defaults to EXECUTION_TIMEOUT)"
                    },
                    limits: {
                        maxCodeSize: "3 MB (configurable via MAX_CODE_SIZE)",
                        maxExecutionTime: "2 hours (configurable via EXECUTION_TIMEOUT)",
                        maxCodeLength: "100,000 characters (configurable via MAX_CODE_LENGTH)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        code: "print('Hello World')",
                        cellNo: 1,
                        timeout: 3600
                    }
                },
                response: {
                    format: "JSON",
                    processing: {
                        status: "processing",
                        sessionId: "Session ID",
                        executionId: "Execution ID for polling",
                        pollInterval: "Polling interval in milliseconds (configurable via POLL_INTERVAL)",
                        message: "Code execution started. Poll /status for results."
                    },
                    busy: {
                        status: 409,
                        body: {
                            error: "Session busy",
                            currentExecution: {
                                executionId: "Current execution ID",
                                cellNo: "Current cell number",
                                startedAt: "Start timestamp",
                                status: "running",
                                partialOutput: "Partial output so far",
                                partialError: "Partial error output"
                            }
                        }
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/exec -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","code":"print(\\"Hello World\\")","cellNo":1}'`,
                    javascript: `fetch('${baseUrl}/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...', code: 'print("Hello World")', cellNo: 1 }) }).then(r => r.json()).then(console.log);`
                },
                exampleResponse: {
                    status: "processing",
                    sessionId: "a1b2c3d4e5f6...",
                    executionId: "f1e2d3c4b5a6",
                    pollInterval: 10000,
                    message: "Code execution started. Poll /status for results."
                }
            },
            executeFile: {
                method: "POST",
                path: "/exec/file",
                authRequired: true,
                purpose: "Execute a Python file on a Colab session",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        fileContent: "Base64 encoded file content (required)",
                        fileName: "Name of the file (required)",
                        timeout: "Custom timeout in seconds (optional)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        fileContent: "cHJpbnQoJ0hlbGxvIFdvcmxkJyk=",
                        fileName: "script.py",
                        timeout: 3600
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        executionId: "Execution ID",
                        stdout: "Standard output from execution",
                        stderr: "Standard error from execution",
                        exitCode: "Exit code (0 for success)"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/exec/file -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","fileContent":"cHJpbnQoJ0hlbGxvJyk=","fileName":"script.py"}'`,
                    javascript: `fetch('${baseUrl}/exec/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...', fileContent: btoa('print("Hello")'), fileName: 'script.py' }) }).then(r => r.json()).then(console.log);`
                }
            },
            executeNotebook: {
                method: "POST",
                path: "/exec/notebook",
                authRequired: true,
                purpose: "Execute a Jupyter notebook (.ipynb) on a Colab session",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        notebookContent: "Base64 encoded notebook content (required)",
                        timeout: "Custom timeout in seconds (optional)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        notebookContent: "base64_encoded_notebook_content",
                        timeout: 3600
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        executionId: "Execution ID",
                        outputNotebook: "Base64 encoded output notebook (or null)",
                        cellResults: "Array of per-cell results",
                        cellResults_cellNo: "Cell number",
                        cellResults_output: "Cell output",
                        cellResults_error: "Cell error (or null)",
                        stdout: "Standard output",
                        stderr: "Standard error"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/exec/notebook -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","notebookContent":"base64..."}'`,
                    javascript: `fetch('${baseUrl}/exec/notebook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...', notebookContent: btoa(notebookJson) }) }).then(r => r.json()).then(console.log);`
                }
            },
            executionStatus: {
                method: "POST",
                path: "/status",
                authRequired: true,
                purpose: "Check the status of a running execution (polling)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        executionId: "Execution ID from /exec response (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        executionId: "f1e2d3c4b5a6"
                    }
                },
                response: {
                    format: "JSON",
                    running: {
                        status: "running",
                        elapsed: "Time elapsed in milliseconds",
                        partialOutput: "Partial stdout output",
                        partialError: "Partial stderr output"
                    },
                    completed: {
                        status: "completed",
                        output: "Full stdout output",
                        error: "Full stderr output or empty",
                        executionTime: "Total execution time in milliseconds"
                    },
                    failed: {
                        status: "failed",
                        output: "Partial stdout output",
                        error: "Error message",
                        executionTime: "Total execution time in milliseconds"
                    },
                    notFound: {
                        status: "not_found",
                        message: "Execution not found or already completed"
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/status -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","executionId":"f1e2d3c4b5a6"}'`,
                    javascript: `fetch('${baseUrl}/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', sessionId: 'a1b2c3d4...', executionId: 'f1e2d3c4b5a6' }) }).then(r => r.json()).then(console.log);`
                },
                polling: {
                    description: "Poll this endpoint every 10-15 seconds (or use the pollInterval from /exec response) until status is 'completed' or 'failed'",
                    example: "while (status.status === 'running') { await sleep(pollInterval); status = await fetchStatus(); }"
                }
            },
            acknowledgeExecution: {
                method: "POST",
                path: "/status/ack",
                authRequired: true,
                purpose: "Acknowledge execution completion to free memory on server",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        executionId: "Execution ID to acknowledge (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        executionId: "f1e2d3c4b5a6"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Acknowledged"
                    },
                    notFound: {
                        success: false,
                        message: "Execution not found"
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/status/ack -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","executionId":"f1e2d3c4b5a6"}'`,
                    javascript: `fetch('${baseUrl}/status/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_secret: 'your-api-key', executionId: 'f1e2d3c4b5a6' }) }).then(r => r.json()).then(console.log);`
                },
                note: "Always call this after receiving a 'completed' or 'failed' status to clean up memory"
            },
            repl: {
                method: "POST",
                path: "/repl",
                authRequired: true,
                purpose: "Execute Python code in REPL mode (one-shot execution)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        code: "Python code to execute (required)",
                        outputImagePath: "Optional path to save generated images"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        code: "import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.show()"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        output: "Standard output",
                        error: "Standard error",
                        executionTime: "Execution time in milliseconds"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/repl -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","code":"print(\\"Hello\\")"}'`
                }
            },
            console: {
                method: "POST",
                path: "/console",
                authRequired: true,
                purpose: "Execute shell commands on the Colab VM",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        command: "Shell command to execute (required)",
                        isPiped: "Whether to pipe input (default: true)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        command: "ls -la /content"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        output: "Command output",
                        error: "Command error"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/console -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","command":"df -h"}'`
                }
            },
            ephemeralRun: {
                method: "POST",
                path: "/run",
                authRequired: true,
                purpose: "Provision a fresh VM, execute a script, and auto-cleanup (one-shot)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        scriptContent: "Base64 encoded script content (required)",
                        scriptArgs: "Array of arguments to pass to script (optional)",
                        gpu: "GPU type (optional)",
                        tpu: "TPU type (optional)",
                        keepAlive: "Keep VM alive after execution (default: false)",
                        sessionName: "Name for the session (optional)",
                        timeout: "Custom timeout in seconds (optional)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        scriptContent: "cHJpbnQoJ1Rlc3QnKQ==",
                        scriptArgs: ["--epochs", "10"],
                        gpu: "T4",
                        keepAlive: false
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        stdout: "Script output",
                        stderr: "Script error",
                        exitCode: "Exit code (0 for success)",
                        sessionId: "Session ID (if keepAlive=true)",
                        keptAlive: "Whether session was kept alive",
                        message: "Status message"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/run -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","scriptContent":"cHJpbnQoJ0hlbGxvJyk=","gpu":"T4"}'`
                }
            },
            // ============================================
            // FILE OPERATIONS (Auth Required)
            // ============================================
            listFiles: {
                method: "POST",
                path: "/file/ls",
                authRequired: true,
                purpose: "List files and directories on the Colab VM",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        path: "Directory path to list (default: /content)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        path: "/content/data"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        path: "Listed path",
                        files: "Array of file objects",
                        files_name: "File/directory name",
                        files_type: "File type: 'file' or 'directory'",
                        rawOutput: "Raw CLI output"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/file/ls -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","path":"/content"}'`
                }
            },
            deleteFile: {
                method: "POST",
                path: "/file/rm",
                authRequired: true,
                purpose: "Delete a file on the Colab VM",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        path: "File path to delete (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        path: "/content/temp.txt"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Deleted path"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/file/rm -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","path":"/content/temp.txt"}'`
                }
            },
            uploadFile: {
                method: "POST",
                path: "/file/upload",
                authRequired: true,
                purpose: "Upload a file to the Colab VM",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        remotePath: "Remote file path (required)",
                        fileContent: "Base64 encoded file content (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        remotePath: "/content/data.csv",
                        fileContent: "base64_encoded_content"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        remotePath: "Uploaded path",
                        size: "File size in bytes",
                        message: "Upload status"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/file/upload -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","remotePath":"/content/data.csv","fileContent":"base64..."}'`
                }
            },
            downloadFile: {
                method: "POST",
                path: "/file/download",
                authRequired: true,
                purpose: "Download a file from the Colab VM",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        remotePath: "Remote file path (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        remotePath: "/content/results.csv"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        fileContent: "Base64 encoded file content",
                        fileName: "File name",
                        fileSize: "File size in bytes"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/file/download -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","remotePath":"/content/results.csv"}'`
                }
            },
            editFile: {
                method: "POST",
                path: "/file/edit",
                authRequired: true,
                purpose: "Edit a file on the Colab VM (in-place update)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        remotePath: "Remote file path (required)",
                        newContent: "Base64 encoded new content (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        remotePath: "/content/config.json",
                        newContent: "base64_encoded_new_content"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Updated remotePath",
                        size: "New file size in bytes"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/file/edit -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","remotePath":"/content/config.json","newContent":"base64..."}'`
                }
            },
            // ============================================
            // AUTOMATION (Auth Required)
            // ============================================
            vmAuth: {
                method: "POST",
                path: "/automation/auth",
                authRequired: true,
                purpose: "Authenticate the Colab VM for Google Cloud services (GCS, BigQuery, etc.)",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6..."
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Authentication completed"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/automation/auth -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4..."}'`
                }
            },
            mountDrive: {
                method: "POST",
                path: "/automation/drivemount",
                authRequired: true,
                purpose: "Mount Google Drive on the Colab VM",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        mountPath: "Mount path (default: /content/drive)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        mountPath: "/content/drive"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        message: "Drive mounted at mountPath"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/automation/drivemount -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4..."}'`
                }
            },
            installPackages: {
                method: "POST",
                path: "/automation/install",
                authRequired: true,
                purpose: "Install Python packages on the Colab VM",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: {
                        api_secret: "Your API secret (required)",
                        sessionId: "Session ID (required)",
                        packages: "Array of package names (optional)",
                        requirementsFile: "Base64 encoded requirements.txt content (optional)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        packages: ["numpy", "pandas", "torch"]
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        installed: "Array of installed packages",
                        output: "Installation output",
                        message: "Installation complete"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/automation/install -H "Content-Type: application/json" -d '{"api_secret":"your-api-key","sessionId":"a1b2c3d4...","packages":["numpy","pandas"]}'`
                }
            },
            // ============================================
            // UTILITIES (Auth Required)
            // ============================================
            getUrl: {
                method: "GET",
                path: "/url/:sessionId",
                authRequired: true,
                purpose: "Generate a browser URL to connect to the session",
                request: {
                    format: "URL parameter + query",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    },
                    parameters: {
                        sessionId: "Session ID (in URL path)"
                    },
                    query: {
                        host: "Colab host (default: https://colab.research.google.com)"
                    },
                    example: `GET ${baseUrl}/url/a1b2c3d4?host=https://colab.research.google.com`
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        url: "Full browser URL",
                        sessionId: "Session ID",
                        host: "Host used"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X GET "${baseUrl}/url/a1b2c3d4" -H "api-secret: your-api-key"`,
                    javascript: `fetch('${baseUrl}/url/a1b2c3d4', { headers: { 'api-secret': 'your-api-key' } }).then(r => r.json()).then(console.log);`
                }
            },
            getVersion: {
                method: "GET",
                path: "/version",
                authRequired: true,
                purpose: "Get the Colab CLI version",
                request: {
                    format: "No request body",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        version: "CLI version string"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    }
                },
                usage: {
                    curl: `curl -X GET ${baseUrl}/version -H "api-secret: your-api-key"`
                }
            },
            checkUpdate: {
                method: "GET",
                path: "/update",
                authRequired: true,
                purpose: "Check for updates to the Colab CLI",
                request: {
                    format: "No request body",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        output: "Update check output",
                        stderr: "Error output"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    }
                },
                usage: {
                    curl: `curl -X GET ${baseUrl}/update -H "api-secret: your-api-key"`
                }
            },
            whoami: {
                method: "GET",
                path: "/whoami",
                authRequired: true,
                purpose: "Debug endpoint - get current authentication identity and scopes",
                request: {
                    format: "No request body",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        output: "Whoami output",
                        stderr: "Error output"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    }
                },
                usage: {
                    curl: `curl -X GET ${baseUrl}/whoami -H "api-secret: your-api-key"`
                }
            },
            // ============================================
            // HISTORY ENDPOINTS (Auth Required)
            // ============================================
            getHistory: {
                method: "GET",
                path: "/log/:sessionId",
                authRequired: true,
                purpose: "Get the execution history for a session",
                request: {
                    format: "URL parameter + query",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    },
                    parameters: {
                        sessionId: "Session ID (in URL path)"
                    },
                    query: {
                        lines: "Number of lines to show (optional)",
                        type: "Filter by event type: execution, file_operation, automation, etc. (optional)",
                        format: "Output format: jsonl, ipynb, md, txt (default: jsonl)"
                    },
                    example: `GET ${baseUrl}/log/a1b2c3d4?lines=20&type=execution`
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        sessionId: "Session ID",
                        history: "History data (format varies)",
                        format: "Output format",
                        rawOutput: "Raw CLI output",
                        stderr: "Error output"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X GET "${baseUrl}/log/a1b2c3d4?lines=20" -H "api-secret: your-api-key"`
                }
            },
            exportHistory: {
                method: "POST",
                path: "/log/export",
                authRequired: true,
                purpose: "Export session history to various formats",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json",
                        "api-secret": "Your API secret (required)"
                    },
                    body: {
                        sessionId: "Session ID (required)",
                        format: "Export format: ipynb, md, txt, jsonl (required)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        format: "ipynb"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        content: "Base64 encoded file content",
                        format: "Export format",
                        fileName: "Download filename",
                        sessionId: "Session ID",
                        rawOutput: "Raw CLI output",
                        stderr: "Error output"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/log/export -H "Content-Type: application/json" -H "api-secret: your-api-key" -d '{"sessionId":"a1b2c3d4...","format":"ipynb"}'`
                }
            },
            filterHistory: {
                method: "GET",
                path: "/log/:sessionId/filter",
                authRequired: true,
                purpose: "Filter session history by event type",
                request: {
                    format: "URL parameter + query",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    },
                    parameters: {
                        sessionId: "Session ID (in URL path)"
                    },
                    query: {
                        eventType: "Event type to filter (required): execution, file_operation, automation, keep_alive_started, keep_alive_error, keep_alive_stopped, session_created, session_terminated",
                        limit: "Number of results (default: 50)",
                        offset: "Offset for pagination (default: 0)"
                    },
                    example: `GET ${baseUrl}/log/a1b2c3d4/filter?eventType=execution&limit=10`
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        sessionId: "Session ID",
                        eventType: "Filtered event type",
                        totalEvents: "Total events matching filter",
                        events: "Array of matching events",
                        limit: "Limit used",
                        offset: "Offset used"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X GET "${baseUrl}/log/a1b2c3d4/filter?eventType=execution" -H "api-secret: your-api-key"`
                }
            },
            searchHistory: {
                method: "POST",
                path: "/log/search",
                authRequired: true,
                purpose: "Search session history for specific content",
                request: {
                    format: "JSON",
                    headers: {
                        "Content-Type": "application/json",
                        "api-secret": "Your API secret (required)"
                    },
                    body: {
                        sessionId: "Session ID (required)",
                        query: "Search query (required)",
                        limit: "Max results (default: 20)",
                        searchIn: "Search target: code, output, all (default: code)"
                    },
                    example: {
                        api_secret: "your-api-key",
                        sessionId: "a1b2c3d4e5f6...",
                        query: "import torch",
                        searchIn: "code"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        sessionId: "Session ID",
                        query: "Search query",
                        searchIn: "Search target",
                        totalFound: "Number of matches",
                        results: "Array of matching events",
                        limit: "Limit used"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found" }
                    }
                },
                usage: {
                    curl: `curl -X POST ${baseUrl}/log/search -H "Content-Type: application/json" -H "api-secret: your-api-key" -d '{"sessionId":"a1b2c3d4...","query":"import torch"}'`
                }
            },
            executionDetails: {
                method: "GET",
                path: "/log/:sessionId/execution/:executionId",
                authRequired: true,
                purpose: "Get details of a specific execution by its ID",
                request: {
                    format: "URL parameter",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    },
                    parameters: {
                        sessionId: "Session ID (in URL path)",
                        executionId: "Execution ID (in URL path)"
                    },
                    example: `GET ${baseUrl}/log/a1b2c3d4/execution/f1e2d3c4b5a6`
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        sessionId: "Session ID",
                        executionId: "Execution ID",
                        execution: "Complete execution event",
                        rawOutput: "Raw CLI output"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    },
                    notFound: {
                        status: 404,
                        body: { error: "Session not found or execution not found" }
                    }
                },
                usage: {
                    curl: `curl -X GET "${baseUrl}/log/a1b2c3d4/execution/f1e2d3c4b5a6" -H "api-secret: your-api-key"`
                }
            },
            listHistorySessions: {
                method: "GET",
                path: "/log/sessions/list",
                authRequired: true,
                purpose: "List all sessions that have history logs",
                request: {
                    format: "No request body",
                    headers: {
                        "api-secret": "Your API secret (required)"
                    }
                },
                response: {
                    format: "JSON",
                    success: {
                        success: true,
                        sessionsWithHistory: "Array of session names with history",
                        rawOutput: "Raw CLI output"
                    },
                    error: {
                        status: 401,
                        body: { error: "Invalid API secret" }
                    }
                },
                usage: {
                    curl: `curl -X GET ${baseUrl}/log/sessions/list -H "api-secret: your-api-key"`
                }
            }
        },
        workflow: {
            title: "Typical API Workflow",
            steps: [
                {
                    step: 1,
                    action: "Create a session",
                    endpoint: "POST /session/new",
                    description: "Allocate a Colab VM with optional GPU/TPU",
                    next: "Get sessionId from response"
                },
                {
                    step: 2,
                    action: "Keep session alive (optional but recommended)",
                    endpoint: "POST /keepalive",
                    description: "Prevent idle timeout (call every 30-60 minutes)",
                    next: "Continue until ready to execute"
                },
                {
                    step: 3,
                    action: "Execute code",
                    endpoint: "POST /exec",
                    description: "Run Python code on the session",
                    next: "Get executionId from response"
                },
                {
                    step: 4,
                    action: "Poll for status",
                    endpoint: "POST /status",
                    description: "Check execution progress (every 10-15 seconds)",
                    next: "Wait for 'completed' or 'failed' status"
                },
                {
                    step: 5,
                    action: "Acknowledge completion",
                    endpoint: "POST /status/ack",
                    description: "Free memory on server",
                    next: "Continue or delete session"
                },
                {
                    step: 6,
                    action: "Delete session",
                    endpoint: "DELETE /session/:sessionId",
                    description: "Terminate VM and free resources",
                    next: "Done"
                }
            ],
            alternativeWorkflows: [
                {
                    title: "One-shot execution (Ephemeral)",
                    description: "Provision, execute, and cleanup in one call",
                    endpoint: "POST /run",
                    useCase: "Training jobs, data processing, CI/CD"
                },
                {
                    title: "File operations",
                    description: "Upload, download, list, and edit files on the VM",
                    endpoints: ["POST /file/upload", "POST /file/download", "POST /file/ls", "POST /file/rm", "POST /file/edit"],
                    useCase: "Data transfer, model checkpoint management"
                },
                {
                    title: "Automation",
                    description: "Authenticate VM, mount Drive, install packages",
                    endpoints: ["POST /automation/auth", "POST /automation/drivemount", "POST /automation/install"],
                    useCase: "Environment setup, GCP integration"
                },
                {
                    title: "History & Logging",
                    description: "View, filter, search, and export session history",
                    endpoints: ["GET /log/:sessionId", "POST /log/export", "GET /log/:sessionId/filter", "POST /log/search", "GET /log/:sessionId/execution/:executionId", "GET /log/sessions/list"],
                    useCase: "Debugging, auditing, reproducibility"
                }
            ]
        },
        errors: {
            commonErrors: [
                {
                    code: 401,
                    description: "Invalid API secret",
                    solution: "Check that you're sending the correct API secret in the request body or headers"
                },
                {
                    code: 404,
                    description: "Session not found",
                    solution: "The session ID may be expired or invalid. Create a new session with POST /session/new"
                },
                {
                    code: 409,
                    description: "Session busy",
                    solution: "Wait for the current execution to complete, or use a different session"
                },
                {
                    code: 400,
                    description: "Missing required fields",
                    solution: "Check that all required fields are included in the request body"
                },
                {
                    code: 500,
                    description: "Internal server error",
                    solution: "Check server logs for details. The Colab CLI may have failed."
                },
                {
                    code: 429,
                    description: "Rate limit exceeded",
                    solution: "Slow down your requests (rate limiting may be disabled via RATE_LIMIT_ENABLED=false)"
                },
                {
                    code: 413,
                    description: "Request too large",
                    solution: "Reduce code size (max 3MB configurable via MAX_CODE_SIZE)"
                }
            ]
        },
        limits: {
            maxSessions: `${MAX_SESSIONS}`,
            sessionTimeout: `${SESSION_TIMEOUT / 1000 / 60 / 60} hours`,
            executionTimeout: `${EXECUTION_TIMEOUT / 60} minutes`,
            maxCodeSize: `${MAX_CODE_SIZE / 1024 / 1024} MB`,
            maxCodeLength: `${MAX_CODE_LENGTH} characters`,
            pollingInterval: `${POLL_INTERVAL / 1000} seconds`,
            concurrentExecutions: "3 (configurable via MAX_CONCURRENT_EXECUTIONS)",
            historyEvents: "1000 (configurable via HISTORY_MAX_EVENTS)"
        },
        architecture: {
            codeExecution: "Uses spawn() for safe stdin piping (no shell escaping issues)",
            sessionManagement: "In-memory Map with periodic cleanup",
            persistence: "Session data stored in JSON files at SESSIONS_BASE_DIR",
            polling: "Async execution with status polling via /status endpoint",
            logging: "Structured logging with configurable log levels",
            cleanup: "Automatic cleanup of idle sessions, hanging processes, and completed executions"
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// AUTH PROTECTED ENDPOINTS
// ============================================

// 1. Create new session (flexible) - WITH AUTO CLEANUP & FIXED GPU HANDLING
app.post('/session/new', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /session/new`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { session_name, gpu, tpu, timeout } = req.body;
    const name = resolveSessionName(session_name);
    
    // Max retry attempts for session creation
    const MAX_RETRIES = 3;
    let retryCount = 0;
    
    while (retryCount < MAX_RETRIES) {
        try {
            const { variant, accelerator } = resolveHardware(gpu, tpu);
            
            // Check session limit - if we're at max, kill the oldest
            if (sessions.size >= MAX_SESSIONS) {
                console.log(`🧹 ${sessions.size} sessions active, max ${MAX_SESSIONS}`);
                let oldestSessionId = null;
                let oldestTime = Infinity;
                
                for (const [sessionId, session] of sessions.entries()) {
                    if (session.lastActivity < oldestTime) {
                        oldestTime = session.lastActivity;
                        oldestSessionId = sessionId;
                    }
                }
                
                if (oldestSessionId) {
                    console.log(`🗑️ Killing oldest session: ${oldestSessionId}`);
                    const session = sessions.get(oldestSessionId);
                    try {
                        await runColabCli(['stop', '-s', session.colabSession], 10000);
                    } catch (error) {
                        console.log(`⚠️ Could not stop session remotely: ${error.message}`);
                    }
                    await cleanupSessionFolder(oldestSessionId);
                    sessions.delete(oldestSessionId);
                    console.log(`✅ Removed session ${oldestSessionId}`);
                }
            }

            const hardwareDisplay = accelerator === 'NONE' ? 'CPU' : accelerator;
            console.log(`📝 New session request received with ${hardwareDisplay}`);
            const sessionId = generateSessionId();
            const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

            await createSessionFolder(sessionId);
            
            const initialData = {
                sessionId: sessionId,
                createdAt: new Date().toISOString(),
                cells: [],
                totalCells: 0,
                totalExecutions: 0,
                lastUpdated: new Date().toISOString()
            };
            const dataFile = path.join(path.join(SESSIONS_BASE_DIR, sessionId), 'session_data.json');
            await fs.writeFile(dataFile, JSON.stringify(initialData, null, 2));
            
            console.log(`⏳ Creating Colab session: ${colabSessionName} with ${hardwareDisplay}`);
            
            // ============================================
            // FIX: Build command properly - only add --gpu/--tpu if needed
            // ============================================
            const cliArgs = ['new', '-s', colabSessionName];
            
            // Only add --gpu if accelerator is not NONE
            if (accelerator !== 'NONE') {
                cliArgs.push('--gpu', accelerator);
            }
            // If tpu was specified, use --tpu instead
            if (tpu) {
                // Remove any --gpu that might have been added
                const gpuIndex = cliArgs.indexOf('--gpu');
                if (gpuIndex !== -1) {
                    cliArgs.splice(gpuIndex, 2);
                }
                cliArgs.push('--tpu', tpu.toUpperCase());
            }
            
            try {
                await runColabCli(cliArgs, 60000);
            } catch (error) {
                // Check if it's a TooManyAssignmentsError or Precondition Failed
                const errorMessage = error.message || '';
                const stderr = error.stderr || '';
                const combinedError = errorMessage + stderr;
                
                if (combinedError.includes('TooManyAssignmentsError') || 
                    combinedError.includes('Precondition Failed') ||
                    combinedError.includes('412')) {
                    
                    console.warn(`⚠️ Session limit reached, cleaning up oldest session...`);
                    
                    // Find and kill the oldest session
                    let oldestSessionId = null;
                    let oldestTime = Infinity;
                    
                    for (const [sessionId, session] of sessions.entries()) {
                        if (session.lastActivity < oldestTime) {
                            oldestTime = session.lastActivity;
                            oldestSessionId = sessionId;
                        }
                    }
                    
                    if (oldestSessionId) {
                        console.log(`🗑️ Killing oldest session: ${oldestSessionId}`);
                        const session = sessions.get(oldestSessionId);
                        try {
                            await runColabCli(['stop', '-s', session.colabSession], 10000);
                        } catch (e) {
                            console.log(`⚠️ Could not stop session remotely: ${e.message}`);
                        }
                        await cleanupSessionFolder(oldestSessionId);
                        sessions.delete(oldestSessionId);
                        console.log(`✅ Removed session ${oldestSessionId}`);
                        
                        // Retry session creation
                        retryCount++;
                        if (retryCount < MAX_RETRIES) {
                            console.log(`🔄 Retrying session creation (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                            continue;
                        }
                    }
                }
                
                // If not a limit error or retries exhausted, rethrow
                throw error;
            }
            
            sessions.set(sessionId, {
                colabSession: colabSessionName,
                createdAt: Date.now(),
                lastActivity: Date.now(),
                status: 'ready',
                currentExecution: null,
                folder: path.join(SESSIONS_BASE_DIR, sessionId),
                hardware: hardwareDisplay,
                variant: variant,
                gpu: gpu || null,
                tpu: tpu || null
            });

            console.log(`✅ Session ${sessionId} created successfully`);
            return res.json({
                success: true,
                sessionId: sessionId,
                hardware: hardwareDisplay,
                variant: variant,
                authUrl: null,
                expiresIn: SESSION_TIMEOUT,
                activeSessions: sessions.size,
                maxSessions: MAX_SESSIONS,
                message: `Session created with ${hardwareDisplay}`
            });
            
        } catch (error) {
            console.error(`❌ Session creation attempt ${retryCount + 1} failed:`, error.message);
            
            // If this is a TooManyAssignmentsError and we haven't exceeded retries
            const errorMessage = error.message || '';
            const stderr = error.stderr || '';
            const combinedError = errorMessage + stderr;
            
            if ((combinedError.includes('TooManyAssignmentsError') || 
                 combinedError.includes('Precondition Failed') ||
                 combinedError.includes('412')) && retryCount < MAX_RETRIES - 1) {
                
                // Clean up any partially created session folder
                try {
                    const sessionId = generateSessionId(); // Placeholder
                    await cleanupSessionFolder(sessionId);
                } catch (e) {
                    // Ignore cleanup errors
                }
                
                retryCount++;
                console.log(`🔄 Retrying session creation (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                continue;
            }
            
            // If we've exhausted retries or it's a different error, return failure
            return res.status(500).json({ 
                error: 'Failed to create session', 
                details: error.message,
                retries: retryCount
            });
        }
    }
});

// 2. Delete session (existing functionality)
app.delete('/session/:sessionId', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for DELETE /session`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`⚠️ Delete failed: session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    console.log(`🗑️ Deleting session ${sessionId}`);
    try {
        await runColabCli(['stop', '-s', session.colabSession], 30000);
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        console.log(`✅ Session ${sessionId} terminated`);
        res.json({ success: true, message: 'Session terminated' });
    } catch (error) {
        console.error(`❌ Delete error for ${sessionId}:`, error.message);
        await cleanupSessionFolder(sessionId);
        sessions.delete(sessionId);
        res.json({ 
            success: true, 
            warning: 'Session removed from tracking, but may still exist remotely' 
        });
    }
});

// 3. Keep session alive
app.post('/keepalive', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /keepalive`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`⚠️ Keepalive failed: session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await runColabCli(['sessions'], 10000);
        session.lastActivity = Date.now();
        sessions.set(sessionId, session);
        console.log(`💓 Keepalive success for session ${sessionId.substring(0, 12)}...`);
        res.json({ success: true, message: 'Session kept alive' });
    } catch (error) {
        console.error(`❌ Keepalive failed for ${sessionId}:`, error.message);
        res.status(500).json({ error: 'Keepalive failed', details: error.message });
    }
});

// 4. Restart kernel
app.post('/session/restart-kernel', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await runColabCli(['restart-kernel', '-s', session.colabSession], 30000);
        session.lastActivity = Date.now();
        sessions.set(sessionId, session);
        
        res.json({
            success: true,
            message: 'Kernel restarted successfully'
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to restart kernel', 
            details: error.message 
        });
    }
});

// 5. Get session status
app.post('/session/status', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const result = await runColabCli(['status', '-s', session.colabSession], 10000);
        res.json({
            success: true,
            sessionId: sessionId,
            status: session.status === 'busy' ? 'BUSY' : 'IDLE',
            running: session.running || null,
            hardware: session.hardware || 'CPU',
            variant: session.variant || 'DEFAULT',
            lastExecution: session.lastExecution || null,
            rawOutput: result.stdout
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to get status', 
            details: error.message 
        });
    }
});

// 6. Execute code (enhanced /run)
app.post('/exec', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /exec`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, code, cellNo, timeout } = req.body;
    if (!sessionId || !code || cellNo === undefined) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`⚠️ Exec failed: session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'busy') {
        console.warn(`⚠️ Session ${sessionId} is busy with execution ${session.currentExecution?.executionId}`);
        return res.status(409).json({ 
            error: 'Session busy',
            currentExecution: session.currentExecution
        });
    }

    const executionId = generateExecutionId();
    const validCellNo = parseInt(cellNo, 10);
    const execTimeout = timeout || EXECUTION_TIMEOUT;

    console.log(`▶️ Starting execution ${executionId} on session ${sessionId}, cell ${validCellNo}`);
    console.log(`📝 Code length: ${code.length} chars, timeout: ${execTimeout}s`);

    session.status = 'busy';
    session.lastActivity = Date.now();
    session.currentExecution = {
        executionId: executionId,
        cellNo: validCellNo,
        startedAt: Date.now(),
        status: 'running',
        partialOutput: '',
        partialError: ''
    };
    sessions.set(sessionId, session);

    const cellStartData = {
        type: 'execution_start',
        cellNo: validCellNo,
        startedAt: new Date().toISOString(),
        code: code,
        status: 'started'
    };
    await appendSessionData(sessionId, cellStartData);

    backgroundExecution(sessionId, validCellNo, code, executionId, execTimeout);

    res.json({
        status: 'processing',
        sessionId: sessionId,
        executionId: executionId,
        pollInterval: POLL_INTERVAL,
        message: 'Code execution started. Poll /status for results.'
    });
});

// 7. Execute file
app.post('/exec/file', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, fileContent, fileName, timeout } = req.body;
    if (!sessionId || !fileContent || !fileName) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, fileContent, fileName' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'busy') {
        return res.status(409).json({ 
            error: 'Session busy',
            currentExecution: session.currentExecution
        });
    }

    try {
        const fileBuffer = Buffer.from(fileContent, 'base64');
        const tempPath = path.join(os.tmpdir(), `file_${Date.now()}_${path.basename(fileName)}`);
        await fs.writeFile(tempPath, fileBuffer);

        const executionId = generateExecutionId();
        const execTimeout = timeout || EXECUTION_TIMEOUT;

        console.log(`▶️ Starting file execution ${executionId} on session ${sessionId}`);
        console.log(`📝 File: ${fileName}, size: ${fileBuffer.length} bytes, timeout: ${execTimeout}s`);

        session.status = 'busy';
        session.lastActivity = Date.now();
        session.currentExecution = {
            executionId: executionId,
            cellNo: 0,
            startedAt: Date.now(),
            status: 'running',
            partialOutput: '',
            partialError: ''
        };
        sessions.set(sessionId, session);

        let command;
        if (USE_PYTHON_MODULE) {
            command = `python3 -m colab_cli exec -s ${session.colabSession} -f ${tempPath} --timeout ${execTimeout}`;
        } else {
            command = `${COLAB_BINARY} exec -s ${session.colabSession} -f ${tempPath} --timeout ${execTimeout}`;
        }

        const result = await runColabCli(command.split(' '), { 
            sessionId, 
            timeout: execTimeout * 1000 
        });

        await fs.unlink(tempPath);

        session.status = 'ready';
        session.currentExecution = null;
        sessions.set(sessionId, session);

        res.json({
            success: true,
            executionId: executionId,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'File execution failed', 
            details: error.message,
            stdout: error.stdout || '',
            stderr: error.stderr || ''
        });
    }
});

// 8. Execute notebook
app.post('/exec/notebook', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, notebookContent, timeout } = req.body;
    if (!sessionId || !notebookContent) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, notebookContent' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'busy') {
        return res.status(409).json({ 
            error: 'Session busy',
            currentExecution: session.currentExecution
        });
    }

    try {
        const notebookBuffer = Buffer.from(notebookContent, 'base64');
        const tempPath = path.join(os.tmpdir(), `notebook_${Date.now()}.ipynb`);
        await fs.writeFile(tempPath, notebookBuffer);

        const executionId = generateExecutionId();
        const execTimeout = timeout || EXECUTION_TIMEOUT;

        console.log(`▶️ Starting notebook execution ${executionId} on session ${sessionId}`);
        console.log(`📝 Notebook size: ${notebookBuffer.length} bytes, timeout: ${execTimeout}s`);

        session.status = 'busy';
        session.lastActivity = Date.now();
        session.currentExecution = {
            executionId: executionId,
            cellNo: 0,
            startedAt: Date.now(),
            status: 'running',
            partialOutput: '',
            partialError: ''
        };
        sessions.set(sessionId, session);

        let command;
        if (USE_PYTHON_MODULE) {
            command = `python3 -m colab_cli exec -s ${session.colabSession} -f ${tempPath} --timeout ${execTimeout}`;
        } else {
            command = `${COLAB_BINARY} exec -s ${session.colabSession} -f ${tempPath} --timeout ${execTimeout}`;
        }

        const result = await runColabCli(command.split(' '), { 
            sessionId, 
            timeout: execTimeout * 1000 
        });

        // Read output notebook if exists
        const outputPath = tempPath.replace('.ipynb', '_output.ipynb');
        let outputNotebook = null;
        let cellResults = [];
        
        try {
            const outputBuffer = await fs.readFile(outputPath);
            outputNotebook = outputBuffer.toString('base64');
            
            const nb = JSON.parse(outputBuffer.toString('utf-8'));
            cellResults = nb.cells
                .filter(cell => cell.cell_type === 'code')
                .map((cell, index) => ({
                    cellNo: index + 1,
                    output: cell.outputs?.map(o => o.text || '').join('') || '',
                    error: cell.outputs?.some(o => o.output_type === 'error') ? 'Error in cell' : null
                }));
            
            await fs.unlink(outputPath).catch(() => {});
        } catch (e) {
            console.log('No output notebook generated');
        }

        await fs.unlink(tempPath);

        session.status = 'ready';
        session.currentExecution = null;
        sessions.set(sessionId, session);

        res.json({
            success: true,
            executionId: executionId,
            outputNotebook: outputNotebook,
            cellResults: cellResults,
            stdout: result.stdout,
            stderr: result.stderr
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Notebook execution failed', 
            details: error.message 
        });
    }
});

// 9. Check execution status (existing)
app.post('/status', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /status`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, executionId } = req.body;
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    if (completedExecutions.has(executionId)) {
        const record = completedExecutions.get(executionId);
        return res.json({
            status: record.status,
            output: record.output,
            error: record.error,
            executionTime: record.executionTime
        });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`⚠️ Status check: session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }

    const execution = session.currentExecution;
    if (execution && execution.executionId === executionId) {
        return res.json({
            status: 'running',
            elapsed: Date.now() - execution.startedAt,
            partialOutput: execution.partialOutput || '',
            partialError: execution.partialError || ''
        });
    }

    res.json({ 
        status: 'not_found',
        message: 'Execution not found or already completed'
    });
});

// 10. Acknowledge execution (existing)
app.post('/status/ack', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        console.warn(`🔒 Auth failed for /status/ack`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { executionId } = req.body;
    if (executionId && completedExecutions.has(executionId)) {
        completedExecutions.delete(executionId);
        console.log(`✅ Acknowledged execution ${executionId}`);
        res.json({ success: true, message: 'Acknowledged' });
    } else {
        res.json({ success: false, message: 'Execution not found' });
    }
});

// 11. One-shot REPL execution
app.post('/repl', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, code, outputImagePath } = req.body;
    if (!sessionId || !code) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, code' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const escapedCode = code
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$')
            .replace(/"/g, '\\"');

        let command;
        if (USE_PYTHON_MODULE) {
            command = `echo "${escapedCode}" | python3 -m colab_cli repl -s ${session.colabSession}`;
        } else {
            command = `echo "${escapedCode}" | ${COLAB_BINARY} repl -s ${session.colabSession}`;
        }

        if (outputImagePath) {
            command += ` --output-image ${outputImagePath}`;
        }

        const result = await runColabCli(command.split(' '), { 
            sessionId, 
            timeout: EXECUTION_TIMEOUT * 1000 
        });

        res.json({
            success: true,
            output: result.stdout,
            error: result.stderr,
            executionTime: 0
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'REPL execution failed', 
            details: error.message 
        });
    }
});

// 12. Shell command execution
app.post('/console', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, command, isPiped = true } = req.body;
    if (!sessionId || !command) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, command' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        let cmd;
        if (isPiped) {
            const escapedCommand = command
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/`/g, '\\`')
                .replace(/\$/g, '\\$');
            
            if (USE_PYTHON_MODULE) {
                cmd = `echo "${escapedCommand}" | python3 -m colab_cli console -s ${session.colabSession}`;
            } else {
                cmd = `echo "${escapedCommand}" | ${COLAB_BINARY} console -s ${session.colabSession}`;
            }
        } else {
            if (USE_PYTHON_MODULE) {
                cmd = `python3 -m colab_cli console -s ${session.colabSession}`;
            } else {
                cmd = `${COLAB_BINARY} console -s ${session.colabSession}`;
            }
        }

        const result = await runColabCli(cmd.split(' '), { 
            sessionId, 
            timeout: EXECUTION_TIMEOUT * 1000 
        });

        res.json({
            success: true,
            output: result.stdout,
            error: result.stderr
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Console command failed', 
            details: error.message 
        });
    }
});

// 13. Ephemeral run (colab run)
app.post('/run', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { scriptContent, scriptArgs, gpu, tpu, keepAlive = false, sessionName, timeout } = req.body;
    if (!scriptContent) {
        return res.status(400).json({ error: 'Missing required fields: scriptContent' });
    }

    try {
        const scriptBuffer = Buffer.from(scriptContent, 'base64');
        const tempPath = path.join(os.tmpdir(), `run_${Date.now()}.py`);
        await fs.writeFile(tempPath, scriptBuffer);

        let cmd = `colab run`;
        if (gpu) cmd += ` --gpu ${gpu}`;
        if (tpu) cmd += ` --tpu ${tpu}`;
        if (keepAlive) cmd += ` --keep`;
        if (sessionName) cmd += ` -s ${sessionName}`;
        if (timeout) cmd += ` --timeout ${timeout}`;
        cmd += ` ${tempPath}`;
        if (scriptArgs && scriptArgs.length > 0) {
            cmd += ` ${scriptArgs.map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(' ')}`;
        }

        console.log(`▶️ Running ephemeral: ${cmd}`);
        const result = await runColabCli(cmd.split(' '), { 
            timeout: (timeout || EXECUTION_TIMEOUT) * 1000 
        });

        await fs.unlink(tempPath);

        // Check if session was kept alive
        let sessionId = null;
        if (keepAlive && sessionName) {
            for (const [id, s] of sessions.entries()) {
                if (s.colabSession === `colab_${sessionName.substring(0, 12)}`) {
                    sessionId = id;
                    break;
                }
            }
        }

        res.json({
            success: true,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
            sessionId: sessionId,
            keptAlive: keepAlive && !!sessionId,
            message: keepAlive ? 'Session kept alive' : 'Session terminated'
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Run failed', 
            details: error.message,
            stdout: error.stdout || '',
            stderr: error.stderr || ''
        });
    }
});

// 14. List directory
app.post('/file/ls', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, path: remotePath = '/content' } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const result = await runColabCli(['ls', '-s', session.colabSession, remotePath], { sessionId });
        
        const files = result.stdout
            .split('\n')
            .filter(line => line.trim())
            .map(line => ({
                name: line.replace('/', '').trim(),
                type: line.endsWith('/') ? 'directory' : 'file'
            }));

        res.json({
            success: true,
            path: remotePath,
            files: files,
            rawOutput: result.stdout
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'List failed', 
            details: error.message 
        });
    }
});

// 15. Delete file
app.post('/file/rm', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, path: remotePath } = req.body;
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'sessionId and path required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await runColabCli(['rm', '-s', session.colabSession, remotePath], { sessionId });
        res.json({
            success: true,
            message: `Deleted ${remotePath}`
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Delete failed', 
            details: error.message 
        });
    }
});

// 16. Upload file
app.post('/file/upload', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, remotePath, fileContent } = req.body;
    if (!sessionId || !remotePath || !fileContent) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const fileBuffer = Buffer.from(fileContent, 'base64');
        const tempPath = path.join(os.tmpdir(), `upload_${Date.now()}_${path.basename(remotePath)}`);
        await fs.writeFile(tempPath, fileBuffer);

        await runColabCli(['upload', '-s', session.colabSession, tempPath, remotePath], { sessionId });
        await fs.unlink(tempPath);

        res.json({
            success: true,
            remotePath: remotePath,
            size: fileBuffer.length,
            message: `Uploaded ${fileBuffer.length} bytes to ${remotePath}`
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Upload failed', 
            details: error.message 
        });
    }
});

// 17. Download file
app.post('/file/download', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, remotePath } = req.body;
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'sessionId and remotePath required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const tempPath = path.join(os.tmpdir(), `download_${Date.now()}_${path.basename(remotePath)}`);
        
        await runColabCli(['download', '-s', session.colabSession, remotePath, tempPath], { sessionId });
        
        const fileBuffer = await fs.readFile(tempPath);
        const fileContent = fileBuffer.toString('base64');
        
        await fs.unlink(tempPath);

        res.json({
            success: true,
            fileContent: fileContent,
            fileName: path.basename(remotePath),
            fileSize: fileBuffer.length
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Download failed', 
            details: error.message 
        });
    }
});

// 18. Edit file
app.post('/file/edit', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, remotePath, newContent } = req.body;
    if (!sessionId || !remotePath || !newContent) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const fileBuffer = Buffer.from(newContent, 'base64');
        const tempPath = path.join(os.tmpdir(), `edit_${Date.now()}_${path.basename(remotePath)}`);
        await fs.writeFile(tempPath, fileBuffer);

        await runColabCli(['upload', '-s', session.colabSession, tempPath, remotePath], { sessionId });
        await fs.unlink(tempPath);

        res.json({
            success: true,
            message: `Updated ${remotePath}`,
            size: fileBuffer.length
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Edit failed', 
            details: error.message 
        });
    }
});

// 19. VM-side GCP authentication
app.post('/automation/auth', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const code = `import os\nos.environ['USE_AUTH_EPHEM'] = '0'\nfrom google.colab import auth\nauth.authenticate_user()`;
        
        // Use spawn() for auth too since it's code execution
        let spawnCmd, spawnArgs;
        if (USE_PYTHON_MODULE) {
            spawnCmd = 'python3';
            spawnArgs = ['-m', 'colab_cli', 'exec', '-s', session.colabSession];
        } else {
            spawnCmd = COLAB_BINARY;
            spawnArgs = ['exec', '-s', session.colabSession];
        }

        const child = spawn(spawnCmd, spawnArgs, {
            timeout: 600000,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        child.stdin.write(code);
        child.stdin.end();

        await new Promise((resolve, reject) => {
            child.on('close', (code) => {
                if (code !== 0) reject(new Error(`Process exited with code ${code}`));
                else resolve();
            });
            child.on('error', reject);
        });
        
        res.json({
            success: true,
            message: 'Authentication completed'
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Authentication failed', 
            details: error.message 
        });
    }
});

// 20. Mount Google Drive
app.post('/automation/drivemount', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, mountPath = '/content/drive' } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const code = `from google.colab import drive\ndrive.mount('${mountPath}')`;
        
        // Use spawn() for drivemount too
        let spawnCmd, spawnArgs;
        if (USE_PYTHON_MODULE) {
            spawnCmd = 'python3';
            spawnArgs = ['-m', 'colab_cli', 'exec', '-s', session.colabSession];
        } else {
            spawnCmd = COLAB_BINARY;
            spawnArgs = ['exec', '-s', session.colabSession];
        }

        const child = spawn(spawnCmd, spawnArgs, {
            timeout: 600000,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        child.stdin.write(code);
        child.stdin.end();

        await new Promise((resolve, reject) => {
            child.on('close', (code) => {
                if (code !== 0) reject(new Error(`Process exited with code ${code}`));
                else resolve();
            });
            child.on('error', reject);
        });
        
        res.json({
            success: true,
            message: `Drive mounted at ${mountPath}`
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Drive mount failed', 
            details: error.message 
        });
    }
});

// 21. Install packages
app.post('/automation/install', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, packages, requirementsFile } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    if (!packages && !requirementsFile) {
        return res.status(400).json({ error: 'packages or requirementsFile required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        let reqPath = null;
        
        if (requirementsFile) {
            const reqBuffer = Buffer.from(requirementsFile, 'base64');
            reqPath = path.join(os.tmpdir(), `requirements_${Date.now()}.txt`);
            await fs.writeFile(reqPath, reqBuffer);
            await runColabCli(['upload', '-s', session.colabSession, reqPath, '/content/requirements.txt'], { sessionId });
        }

        let cmd = `colab install -s ${session.colabSession}`;
        if (reqPath) {
            cmd += ` -r /content/requirements.txt`;
        }
        if (packages && packages.length > 0) {
            cmd += ` ${packages.join(' ')}`;
        }

        const result = await runColabCli(cmd.split(' '), { sessionId, timeout: 300000 });
        
        if (reqPath) {
            await fs.unlink(reqPath).catch(() => {});
        }

        res.json({
            success: true,
            installed: packages || ['requirements.txt'],
            output: result.stdout,
            message: 'Installation complete'
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Installation failed', 
            details: error.message 
        });
    }
});

// 22. Get browser URL for session
app.get('/url/:sessionId', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.params;
    const { host = 'https://colab.research.google.com' } = req.query;
    
    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const result = await runColabCli(['url', '-s', session.colabSession, '--host', host], { sessionId });
        const url = result.stdout.trim();
        
        res.json({
            success: true,
            url: url,
            sessionId: sessionId,
            host: host
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to generate URL', 
            details: error.message 
        });
    }
});

// 23. Get CLI version
app.get('/version', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    try {
        const result = await runColabCli(['version'], 10000);
        const versionMatch = result.stdout.match(/Version:\s*(.+)/);
        const version = versionMatch ? versionMatch[1].trim() : 'unknown';
        
        res.json({
            success: true,
            version: version
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to get version', 
            details: error.message 
        });
    }
});

// 24. Check for updates
app.get('/update', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    try {
        const result = await runColabCli(['update'], 10000);
        res.json({
            success: true,
            output: result.stdout,
            stderr: result.stderr
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Update check failed', 
            details: error.message 
        });
    }
});

// 25. Debug whoami
app.get('/whoami', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    try {
        const result = await runColabCli(['whoami'], 10000);
        res.json({
            success: true,
            output: result.stdout,
            stderr: result.stderr
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Whoami failed', 
            details: error.message 
        });
    }
});

// ============================================
// ENHANCED HISTORY ENDPOINTS
// ============================================

// 26. Get session history (basic)
app.get('/log/:sessionId', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.params;
    const { lines, type, format = 'jsonl' } = req.query;
    
    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        let cmd = `colab log -s ${session.colabSession}`;
        if (lines) cmd += ` -n ${lines}`;
        if (type) cmd += ` -t ${type}`;
        if (format && format !== 'jsonl') cmd += ` -o ${format}`;
        
        const result = await runColabCli(cmd.split(' '), { sessionId });
        
        // Parse history if format is jsonl
        let parsedHistory = null;
        if (format === 'jsonl') {
            parsedHistory = result.stdout
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                })
                .filter(item => item !== null);
        }
        
        res.json({
            success: true,
            sessionId: sessionId,
            history: parsedHistory || result.stdout,
            format: format,
            rawOutput: result.stdout,
            stderr: result.stderr
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to get log', 
            details: error.message 
        });
    }
});

// 27. Export history
app.post('/log/export', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, format = 'ipynb' } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const outputFile = `/tmp/${sessionId}_history.${format}`;
        const result = await runColabCli(['log', '-s', session.colabSession, '-o', outputFile], { sessionId });
        
        let fileContent = null;
        let fileName = `${sessionId}_history.${format}`;
        
        try {
            const fileBuffer = await fs.readFile(outputFile);
            fileContent = fileBuffer.toString('base64');
            await fs.unlink(outputFile).catch(() => {});
        } catch (e) {
            console.log('No output file generated');
        }

        res.json({
            success: true,
            content: fileContent,
            format: format,
            fileName: fileName,
            sessionId: sessionId,
            rawOutput: result.stdout,
            stderr: result.stderr
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Export failed', 
            details: error.message 
        });
    }
});

// 28. Get history by event type (enhanced filtering)
app.get('/log/:sessionId/filter', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId } = req.params;
    const { eventType, limit = 50, offset = 0 } = req.query;
    
    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (!eventType) {
        return res.status(400).json({ error: 'eventType query parameter required' });
    }

    try {
        // Get full history in JSONL format
        const result = await runColabCli(['log', '-s', session.colabSession, '-o', 'jsonl'], { sessionId });
        
        // Parse and filter
        const allEvents = result.stdout
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(item => item !== null);
        
        const filteredEvents = allEvents
            .filter(event => event.event_type === eventType)
            .slice(parseInt(offset), parseInt(offset) + parseInt(limit));
        
        res.json({
            success: true,
            sessionId: sessionId,
            eventType: eventType,
            totalEvents: allEvents.filter(e => e.event_type === eventType).length,
            events: filteredEvents,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to filter history', 
            details: error.message 
        });
    }
});

// 29. Search history
app.post('/log/search', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, query, limit = 20, searchIn = 'code' } = req.body;
    if (!sessionId || !query) {
        return res.status(400).json({ error: 'sessionId and query required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        // Get full history
        const result = await runColabCli(['log', '-s', session.colabSession], { sessionId });
        
        // Parse history
        const allEvents = result.stdout
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(item => item !== null);
        
        // Search
        const searchResults = allEvents
            .filter(event => {
                if (searchIn === 'code' && event.code) {
                    return event.code.toLowerCase().includes(query.toLowerCase());
                }
                if (searchIn === 'output' && event.outputs) {
                    return JSON.stringify(event.outputs).toLowerCase().includes(query.toLowerCase());
                }
                if (searchIn === 'all') {
                    return JSON.stringify(event).toLowerCase().includes(query.toLowerCase());
                }
                return false;
            })
            .slice(0, parseInt(limit));
        
        res.json({
            success: true,
            sessionId: sessionId,
            query: query,
            searchIn: searchIn,
            totalFound: searchResults.length,
            results: searchResults,
            limit: parseInt(limit)
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Search failed', 
            details: error.message 
        });
    }
});

// 30. Get specific execution details by execution ID
app.get('/log/:sessionId/execution/:executionId', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    const { sessionId, executionId } = req.params;
    
    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        // Get full history
        const result = await runColabCli(['log', '-s', session.colabSession], { sessionId });
        
        // Parse history
        const allEvents = result.stdout
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(item => item !== null);
        
        // Find execution by ID
        const executionEvent = allEvents.find(event => 
            (event.executionId && event.executionId === executionId) ||
            (event.data && event.data.executionId && event.data.executionId === executionId) ||
            (event.event_type === 'execution' && event.code && event.timestamp)
        );
        
        if (!executionEvent) {
            return res.status(404).json({ error: 'Execution not found in history' });
        }
        
        res.json({
            success: true,
            sessionId: sessionId,
            executionId: executionId,
            execution: executionEvent,
            rawOutput: result.stdout
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to get execution details', 
            details: error.message 
        });
    }
});

// 31. List all sessions with history
app.get('/log/sessions/list', async (req, res) => {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        return res.status(401).json({ error: 'Invalid API secret' });
    }

    try {
        const result = await runColabCli(['log'], 10000);
        
        // Parse the list of sessions with history
        const sessionsWithHistory = result.stdout
            .split('\n')
            .filter(line => line.includes('Sessions with history logs:'))
            .flatMap(line => {
                const nextLines = result.stdout.split('\n');
                const index = nextLines.indexOf(line);
                if (index !== -1) {
                    return nextLines.slice(index + 1)
                        .filter(l => l.trim())
                        .map(l => l.trim().replace(/^[•\-\s]+/, ''));
                }
                return [];
            });
        
        res.json({
            success: true,
            sessionsWithHistory: sessionsWithHistory,
            rawOutput: result.stdout
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to list sessions with history', 
            details: error.message 
        });
    }
});

// ============================================
// BACKWARD COMPATIBILITY ENDPOINTS
// ============================================

// Keep /start for backward compatibility
app.post('/start', async (req, res) => {
    // Forward to /session/new with default GPU
    req.body.gpu = req.body.gpu || DEFAULT_GPU;
    // Call the /session/new handler
    const handler = app._router.stack
        .filter(layer => layer.route && layer.route.path === '/session/new')
        .map(layer => layer.route.stack[0].handle)[0];
    
    if (handler) {
        return handler(req, res);
    } else {
        // Fallback to original behavior
        const apiSecret = extractApiSecret(req);
        if (!validateApiSecret(apiSecret)) {
            return res.status(401).json({ error: 'Invalid API secret' });
        }

        const { session_name } = req.body;
        const name = resolveSessionName(session_name);
        
        try {
            const { variant, accelerator } = resolveHardware(DEFAULT_GPU, null);
            const hardwareDisplay = accelerator === 'NONE' ? 'CPU' : accelerator;
            
            if (sessions.size >= MAX_SESSIONS) {
                let oldestSessionId = null;
                let oldestTime = Infinity;
                for (const [sessionId, session] of sessions.entries()) {
                    if (session.lastActivity < oldestTime) {
                        oldestTime = session.lastActivity;
                        oldestSessionId = sessionId;
                    }
                }
                if (oldestSessionId) {
                    const session = sessions.get(oldestSessionId);
                    try {
                        await runColabCli(['stop', '-s', session.colabSession], 10000);
                    } catch (error) {
                        console.log(`⚠️ Could not stop session remotely: ${error.message}`);
                    }
                    await cleanupSessionFolder(oldestSessionId);
                    sessions.delete(oldestSessionId);
                }
            }

            const sessionId = generateSessionId();
            const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

            await createSessionFolder(sessionId);
            
            const initialData = {
                sessionId: sessionId,
                createdAt: new Date().toISOString(),
                cells: [],
                totalCells: 0,
                totalExecutions: 0,
                lastUpdated: new Date().toISOString()
            };
            const dataFile = path.join(path.join(SESSIONS_BASE_DIR, sessionId), 'session_data.json');
            await fs.writeFile(dataFile, JSON.stringify(initialData, null, 2));
            
            // ============================================
            // FIX: Build command properly - only add --gpu if not NONE
            // ============================================
            const cliArgs = ['new', '-s', colabSessionName];
            if (accelerator !== 'NONE') {
                cliArgs.push('--gpu', accelerator);
            }
            await runColabCli(cliArgs, 60000);
            
            sessions.set(sessionId, {
                colabSession: colabSessionName,
                createdAt: Date.now(),
                lastActivity: Date.now(),
                status: 'ready',
                currentExecution: null,
                folder: path.join(SESSIONS_BASE_DIR, sessionId),
                hardware: hardwareDisplay,
                variant: variant,
                gpu: DEFAULT_GPU,
                tpu: null
            });

            res.json({
                success: true,
                sessionId: sessionId,
                hardware: hardwareDisplay,
                variant: variant,
                authUrl: null,
                expiresIn: SESSION_TIMEOUT,
                activeSessions: sessions.size,
                maxSessions: MAX_SESSIONS,
                message: `Session created with ${hardwareDisplay}`
            });
        } catch (error) {
            console.error('❌ Session creation failed:', error.message);
            res.status(500).json({ 
                error: 'Failed to create session', 
                details: error.message 
            });
        }
    }
});

// ============================================
// 404 HANDLER
// ============================================

app.use((req, res) => {
    console.log(`❓ 404: ${req.method} ${req.path}`);
    res.status(404).json({
        error: 'Not Found',
        message: 'This is an API-only server. Available endpoints:',
        endpoints: {
            public: {
                health: 'GET /health',
                simpleHealth: 'GET /health/simple',
                sessions: 'GET /sessions',
                sessionDetails: 'GET /sessions/:identifier'
            },
            protected: {
                createSession: 'POST /session/new',
                deleteSession: 'DELETE /session/:sessionId',
                keepalive: 'POST /keepalive',
                restartKernel: 'POST /session/restart-kernel',
                sessionStatus: 'POST /session/status',
                execute: 'POST /exec',
                executeFile: 'POST /exec/file',
                executeNotebook: 'POST /exec/notebook',
                executionStatus: 'POST /status',
                acknowledge: 'POST /status/ack',
                repl: 'POST /repl',
                console: 'POST /console',
                run: 'POST /run',
                listFiles: 'POST /file/ls',
                deleteFile: 'POST /file/rm',
                uploadFile: 'POST /file/upload',
                downloadFile: 'POST /file/download',
                editFile: 'POST /file/edit',
                auth: 'POST /automation/auth',
                drivemount: 'POST /automation/drivemount',
                install: 'POST /automation/install',
                url: 'GET /url/:sessionId',
                version: 'GET /version',
                update: 'GET /update',
                whoami: 'GET /whoami',
                log: 'GET /log/:sessionId',
                export: 'POST /log/export',
                filterHistory: 'GET /log/:sessionId/filter',
                searchHistory: 'POST /log/search',
                executionDetails: 'GET /log/:sessionId/execution/:executionId',
                listHistorySessions: 'GET /log/sessions/list'
            }
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

let shutdownInProgress = false;

async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    
    console.log(`🛑 Received ${signal}, starting graceful shutdown...`);
    console.log(`📊 Active sessions: ${sessions.size}, active executions: ${executionProcesses.size}`);
    
    for (const sessionId of sessions.keys()) {
        try {
            const session = sessions.get(sessionId);
            if (session) {
                console.log(`🧹 Cleaning up session ${sessionId}`);
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                sessions.delete(sessionId);
            }
        } catch (error) {
            console.error(`❌ Failed to clean up session ${sessionId}:`, error.message);
        }
    }
    
    console.log('✅ Graceful shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught exception:', error.message);
    console.error(error.stack);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled rejection:', reason);
});

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    console.log('🚀 Initializing Colab Orchestrator v2.1...');
    
    await initColabBinary();
    await fs.mkdir(SESSIONS_BASE_DIR, { recursive: true });
    await setupColabAuth();
    
    console.log('✅ Token auto-refresh handled by Colab CLI');
    console.log(`✅ Colab binary: ${COLAB_BINARY} ${USE_PYTHON_MODULE ? '(-m colab_cli)' : ''}`);
    
    // Start cleanup after 1 hour
    setTimeout(cleanupIdleSessions, 60 * 60 * 1000);

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🚀 Colab Orchestrator v2.1 running on port ${PORT}`);
        console.log(`📁 Sessions folder: ${SESSIONS_BASE_DIR}`);
        console.log(`🔧 Colab binary: ${COLAB_BINARY} ${USE_PYTHON_MODULE ? '(-m colab_cli)' : ''}`);
        console.log(`📊 Max sessions: ${MAX_SESSIONS}`);
        console.log(`🔐 API Secret: ${API_SECRET ? '✅ Configured' : '⚠️ Not set'}`);
        console.log(`🔑 Colab Auth: ${process.env.COLAB_AUTH_TOKEN ? '✅ Token configured' : '⚠️ No token'}`);
        console.log(`⏰ Session timeout: ${SESSION_TIMEOUT / 1000 / 60 / 60} hours`);
        console.log(`⏱️  Execution timeout: ${EXECUTION_TIMEOUT / 60} minutes`);
        console.log(`🔒 CORS: ${allowedOrigins.length} allowed origins`);
        console.log(`📦 API-Only: No static files served`);
        console.log(`\n🌐 API server running on http://localhost:${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/health`);
        console.log(`📋 Public endpoints:`);
        console.log(`   GET /health`);
        console.log(`   GET /health/simple`);
        console.log(`   GET /sessions`);
        console.log(`   GET /sessions/:identifier`);
        console.log(`\n🔒 Protected endpoints (API Secret required):`);
        console.log(`   POST /session/new`);
        console.log(`   DELETE /session/:sessionId`);
        console.log(`   POST /keepalive`);
        console.log(`   POST /session/restart-kernel`);
        console.log(`   POST /session/status`);
        console.log(`   POST /exec`);
        console.log(`   POST /exec/file`);
        console.log(`   POST /exec/notebook`);
        console.log(`   POST /status`);
        console.log(`   POST /status/ack`);
        console.log(`   POST /repl`);
        console.log(`   POST /console`);
        console.log(`   POST /run`);
        console.log(`   POST /file/ls`);
        console.log(`   POST /file/rm`);
        console.log(`   POST /file/upload`);
        console.log(`   POST /file/download`);
        console.log(`   POST /file/edit`);
        console.log(`   POST /automation/auth`);
        console.log(`   POST /automation/drivemount`);
        console.log(`   POST /automation/install`);
        console.log(`   GET /url/:sessionId`);
        console.log(`   GET /version`);
        console.log(`   GET /update`);
        console.log(`   GET /whoami`);
        console.log(`   GET /log/:sessionId`);
        console.log(`   POST /log/export`);
        console.log(`   GET /log/:sessionId/filter`);
        console.log(`   POST /log/search`);
        console.log(`   GET /log/:sessionId/execution/:executionId`);
        console.log(`   GET /log/sessions/list`);
        console.log(`\n📝 History features: View, filter, search, and export session history`);
        console.log(`🔒 Code execution now uses spawn() for safe stdin piping (no shell escaping issues!)\n`);
    });
}

init();
