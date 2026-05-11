import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { createConfigStore } from './lib/config-store.js';
import { detectEnvironment } from './lib/environment.js';
import { buildProfileFromSelection, detectLocalHermes } from './lib/hermes-detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const configStore = createConfigStore(rootDir);

const server = Fastify({ logger: true });

await server.register(cors, { origin: true });
await server.register(websocket);

if (fs.existsSync(distDir)) {
  await server.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
  });
}

function resolveFromRoot(value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

async function readText(file) {
  return fsp.readFile(file, 'utf8');
}

function redactConfig(config) {
  return {
    ...config,
    security: {
      adminToken: config.security.adminToken ? 'configured' : '',
    },
  };
}

function requireWriteAccess(request, reply, config) {
  const token = config.security.adminToken;
  if (!token) return true;
  if (request.headers['x-admin-token'] === token) return true;
  reply.code(401).send({ error: 'Admin token required.' });
  return false;
}

function execConfigured(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject({ message: error.message, stdout, stderr, code: error.code });
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function fetchHealth(url) {
  if (!url) return { configured: false, online: false, status: null, latencyMs: null, body: '' };
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    return {
      configured: true,
      online: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      body: body.slice(0, 500),
    };
  } catch (error) {
    return {
      configured: true,
      online: false,
      status: null,
      latencyMs: Date.now() - started,
      body: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function normalizeTarPath(value) {
  return value.split(path.sep).join('/');
}

async function listBackups(config) {
  const backupDir = resolveFromRoot(config.backup.dir);
  await fsp.mkdir(backupDir, { recursive: true });
  const files = await fsp.readdir(backupDir, { withFileTypes: true });
  const backups = [];

  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith('.tar.gz')) continue;
    const filePath = path.join(backupDir, entry.name);
    const stat = await fsp.stat(filePath);
    const manifestPath = `${filePath}.manifest.json`;
    let manifest = null;
    if (await pathExists(manifestPath)) {
      try {
        manifest = JSON.parse(await readText(manifestPath));
      } catch {
        manifest = null;
      }
    }
    backups.push({
      id: entry.name,
      name: entry.name,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      manifest,
    });
  }

  return backups.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

async function createBackup(config, selectedInclude) {
  const hermesRoot = resolveFromRoot(config.hermes.root);
  const backupDir = resolveFromRoot(config.backup.dir);
  await fsp.mkdir(backupDir, { recursive: true });

  const requested = Array.isArray(selectedInclude) && selectedInclude.length > 0
    ? selectedInclude
    : config.backup.include;

  const existing = [];
  for (const item of requested) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    const relative = normalizeTarPath(item.trim());
    const absolute = path.resolve(hermesRoot, relative);
    const relativeFromRoot = path.relative(hermesRoot, absolute);
    if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) continue;
    if (await pathExists(absolute)) existing.push(relative);
  }

  if (existing.length === 0) {
    throw new Error('No configured backup include paths exist under hermes.root.');
  }

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const name = `hermes-backup-${timestamp}.tar.gz`;
  const archivePath = path.join(backupDir, name);
  const manifestName = '.hermes-agent-backup-manifest.json';
  const manifestPath = path.join(hermesRoot, manifestName);
  const manifest = {
    app: 'hermes',
    createdAt: new Date().toISOString(),
    hermesRoot,
    include: existing,
    excluded: config.backup.exclude,
    platform: {
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
    },
  };

  let includeManifest = false;
  try {
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    includeManifest = true;
  } catch {
    includeManifest = false;
  }

  const tarEntries = includeManifest ? [manifestName, ...existing] : existing;
  const excludes = config.backup.exclude.map(item => normalizeTarPath(String(item)));

  try {
    await tar.c({
      gzip: true,
      file: archivePath,
      cwd: hermesRoot,
      portable: true,
      filter: entryPath => {
        const normalized = normalizeTarPath(entryPath);
        return !excludes.some(excluded => normalized === excluded || normalized.startsWith(`${excluded}/`));
      },
    }, tarEntries);
  } finally {
    if (includeManifest) {
      await fsp.rm(manifestPath, { force: true });
    }
  }

  const checksum = await sha256File(archivePath);
  const stat = await fsp.stat(archivePath);
  const finalManifest = { ...manifest, archive: name, size: stat.size, checksum };
  await fsp.writeFile(`${archivePath}.manifest.json`, JSON.stringify(finalManifest, null, 2), 'utf8');

  await pruneBackups(config);

  return {
    id: name,
    name,
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    manifest: finalManifest,
  };
}

async function pruneBackups(config) {
  const keepLast = Number(config.backup.keepLast || 0);
  if (!keepLast || keepLast < 1) return;
  const backups = await listBackups(config);
  const backupDir = resolveFromRoot(config.backup.dir);
  for (const backup of backups.slice(keepLast)) {
    const file = path.join(backupDir, backup.name);
    await fsp.rm(file, { force: true });
    await fsp.rm(`${file}.manifest.json`, { force: true });
  }
}

async function readLastLines(file, lineCount) {
  if (!file || !(await pathExists(file))) return [];
  const text = await readText(file);
  return text.split(/\r?\n/).slice(-lineCount);
}

async function readLogSnapshot(config, lineCount) {
  const logFile = resolveFromRoot(config.hermes.logFile);
  if (logFile && await pathExists(logFile)) {
    return { file: logFile, command: '', lines: await readLastLines(logFile, lineCount) };
  }
  if (config.hermes.logCommand) {
    try {
      const result = await execConfigured(config.hermes.logCommand, resolveFromRoot(config.hermes.root));
      return {
        file: logFile,
        command: config.hermes.logCommand,
        lines: String(result.stdout || result.stderr || '').split(/\r?\n/).slice(-lineCount),
      };
    } catch (error) {
      return {
        file: logFile,
        command: config.hermes.logCommand,
        lines: [error.message || 'Log command failed.'],
      };
    }
  }
  return { file: logFile, command: '', lines: [] };
}

server.get('/api/status', async () => {
  const { value: config, meta } = await configStore.loadConfig();
  const hermesRoot = resolveFromRoot(config.hermes.root);
  const [health, rootExists, logExists] = await Promise.all([
    fetchHealth(config.hermes.healthUrl),
    pathExists(hermesRoot),
    pathExists(resolveFromRoot(config.hermes.logFile)),
  ]);

  return {
    app: {
      name: config.app.name,
      uptimeSeconds: Math.round(process.uptime()),
      platform: process.platform,
      node: process.version,
      configPath: meta.activePath,
      hostProfile: meta.hostProfileExists,
    },
    hermes: {
      root: hermesRoot,
      rootExists,
      health,
      logFile: resolveFromRoot(config.hermes.logFile),
      logCommand: config.hermes.logCommand,
      logExists,
      service: config.hermes.service,
      commandsConfigured: Object.fromEntries(
        Object.entries(config.hermes.commands).map(([key, value]) => [key, Boolean(value)]),
      ),
    },
    system: {
      hostname: os.hostname(),
      cpus: os.cpus().length,
      loadAverage: os.loadavg(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
    backup: {
      dir: resolveFromRoot(config.backup.dir),
      include: config.backup.include,
      keepLast: config.backup.keepLast,
    },
    security: {
      tokenRequired: Boolean(config.security.adminToken),
    },
  };
});

server.get('/api/config', async () => {
  const { raw, value, meta } = await configStore.loadConfig();
  return { path: meta.activePath, raw, parsed: redactConfig(value), meta: { hostId: meta.environment.hostId, explicit: meta.explicit } };
});

server.put('/api/config', async (request, reply) => {
  const { value: config } = await configStore.loadConfig();
  if (!requireWriteAccess(request, reply, config)) return;
  const body = request.body || {};
  if (typeof body.raw !== 'string') {
    reply.code(400).send({ error: 'raw YAML content is required.' });
    return;
  }
  const path = await configStore.saveActiveConfig(body.raw);
  return { ok: true, path };
});

server.post('/api/control/:action', async (request, reply) => {
  const { value: config } = await configStore.loadConfig();
  if (!requireWriteAccess(request, reply, config)) return;
  const action = request.params.action;
  const command = config.hermes.commands[action];
  if (!command) {
    reply.code(400).send({ error: `No configured command for ${action}.` });
    return;
  }
  try {
    const result = await execConfigured(command, resolveFromRoot(config.hermes.root));
    return { ok: true, action, ...result };
  } catch (error) {
    reply.code(500).send({ ok: false, action, ...error });
  }
});

server.get('/api/logs', async request => {
  const { value: config } = await configStore.loadConfig();
  const lines = Math.max(20, Math.min(Number(request.query.lines || 200), 2000));
  return readLogSnapshot(config, lines);
});

server.get('/ws/logs', { websocket: true }, async connection => {
  const { value: config } = await configStore.loadConfig();
  const logFile = resolveFromRoot(config.hermes.logFile);
  let position = 0;
  let watcher = null;

  const sendNewContent = async initial => {
    if (!(await pathExists(logFile))) {
      if (initial && config.hermes.logCommand) {
        const snapshot = await readLogSnapshot(config, 200);
        connection.send(JSON.stringify({ type: 'snapshot', file: logFile, command: snapshot.command, lines: snapshot.lines }));
        connection.send(JSON.stringify({ type: 'append', file: logFile, text: '\nLive tail is unavailable for journal snapshots. Refresh to reload.\n' }));
        return;
      }
      connection.send(JSON.stringify({ type: 'missing', file: logFile }));
      return;
    }
    const stat = await fsp.stat(logFile);
    if (initial) {
      const lines = await readLastLines(logFile, 200);
      connection.send(JSON.stringify({ type: 'snapshot', file: logFile, lines }));
      position = stat.size;
      return;
    }
    if (stat.size < position) position = 0;
    if (stat.size === position) return;
    const stream = fs.createReadStream(logFile, { start: position, end: stat.size });
    let chunk = '';
    for await (const part of stream) chunk += part;
    position = stat.size;
    connection.send(JSON.stringify({ type: 'append', file: logFile, text: chunk }));
  };

  await sendNewContent(true);
  if (await pathExists(logFile)) {
    watcher = fs.watch(logFile, () => {
      sendNewContent(false).catch(error => connection.send(JSON.stringify({ type: 'error', message: error.message })));
    });
  }
  connection.socket.on('close', () => watcher?.close());
});

server.get('/api/backups', async () => {
  const { value: config } = await configStore.loadConfig();
  return { backups: await listBackups(config), dir: resolveFromRoot(config.backup.dir) };
});

server.post('/api/backups', async (request, reply) => {
  const { value: config } = await configStore.loadConfig();
  if (!requireWriteAccess(request, reply, config)) return;
  try {
    const backup = await createBackup(config, request.body?.include);
    return { ok: true, backup };
  } catch (error) {
    reply.code(500).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.get('/api/backups/:id/download', async (request, reply) => {
  const { value: config } = await configStore.loadConfig();
  const backups = await listBackups(config);
  const backup = backups.find(item => item.id === request.params.id);
  if (!backup) {
    reply.code(404).send({ error: 'Backup not found.' });
    return;
  }
  const file = path.join(resolveFromRoot(config.backup.dir), backup.name);
  return reply.header('Content-Disposition', `attachment; filename="${backup.name}"`).send(fs.createReadStream(file));
});

server.post('/api/backups/:id/verify', async (request, reply) => {
  const { value: config } = await configStore.loadConfig();
  if (!requireWriteAccess(request, reply, config)) return;
  const backups = await listBackups(config);
  const backup = backups.find(item => item.id === request.params.id);
  if (!backup) {
    reply.code(404).send({ error: 'Backup not found.' });
    return;
  }
  const file = path.join(resolveFromRoot(config.backup.dir), backup.name);
  const checksum = await sha256File(file);
  return { ok: true, checksum, matchesManifest: backup.manifest?.checksum ? backup.manifest.checksum === checksum : null };
});

server.delete('/api/backups/:id', async (request, reply) => {
  const { value: config } = await configStore.loadConfig();
  if (!requireWriteAccess(request, reply, config)) return;
  const backups = await listBackups(config);
  const backup = backups.find(item => item.id === request.params.id);
  if (!backup) {
    reply.code(404).send({ error: 'Backup not found.' });
    return;
  }
  const file = path.join(resolveFromRoot(config.backup.dir), backup.name);
  await fsp.rm(file, { force: true });
  await fsp.rm(`${file}.manifest.json`, { force: true });
  return { ok: true };
});

server.get('/api/environment', async () => detectEnvironment(rootDir));

server.get('/api/setup/state', async () => configStore.getSetupState());

server.get('/api/setup/detect', async () => detectLocalHermes(rootDir));
server.post('/api/setup/detect', async () => detectLocalHermes(rootDir));

server.post('/api/setup/apply', async (request, reply) => {
  const { value: config } = await configStore.loadConfig();
  if (!requireWriteAccess(request, reply, config)) return;
  const body = request.body || {};
  const detection = body.selection ? null : await detectLocalHermes(rootDir);
  const selection = body.selection || detection?.recommended || {};
  const profile = buildProfileFromSelection(selection, config);
  const saved = await configStore.saveHostProfile(profile);
  return {
    ok: true,
    path: saved.path,
    profile,
    setup: await configStore.getSetupState(),
  };
});

server.setNotFoundHandler((request, reply) => {
  if (request.raw.url?.startsWith('/api') || request.raw.url?.startsWith('/ws')) {
    reply.code(404).send({ error: 'Not found.' });
    return;
  }
  const indexPath = path.join(distDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    reply.type('text/html').send(fs.createReadStream(indexPath));
    return;
  }
  reply.code(404).send({ error: 'Frontend build not found. Run npm run build first.' });
});

export async function startServer(overrides = {}) {
  const { value: config } = await configStore.loadConfig();
  const host = overrides.host || process.env.HERMES_AGENT_HOST || config.app.host;
  const port = Number(overrides.port ?? process.env.PORT ?? config.app.port);
  await server.listen({ host, port });
  const address = server.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, host, port: actualPort };
}

if (process.env.HERMES_AGENT_EMBEDDED !== '1') {
  await startServer();
}
