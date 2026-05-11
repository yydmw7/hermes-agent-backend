import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, serviceCommands } from './config-store.js';
import { detectEnvironment, execText, isWritable, pathExists } from './environment.js';

function confidenceLabel(score) {
  if (score >= 85) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

function addCandidate(list, candidate, key = 'value') {
  if (!candidate?.[key]) return;
  const existing = list.find(item => item[key] === candidate[key] && item.scope === candidate.scope);
  if (existing) {
    if (candidate.confidence > existing.confidence) Object.assign(existing, candidate);
    return;
  }
  list.push({
    ...candidate,
    confidenceLabel: confidenceLabel(candidate.confidence || 0),
  });
}

async function listSystemdUnits(scope) {
  const prefix = scope === 'user' ? 'systemctl --user' : 'systemctl';
  const result = await execText(`${prefix} list-units --type=service --all --plain --no-legend`, { timeout: 3500 });
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name] = line.split(/\s+/);
      return { name, scope, raw: line };
    })
    .filter(unit => /hermes/i.test(unit.raw));
}

async function inspectSystemdUnit(unit) {
  const prefix = unit.scope === 'user' ? 'systemctl --user' : 'systemctl';
  const result = await execText(`${prefix} show ${unit.name} --no-pager`, { timeout: 3500 });
  const properties = {};
  if (result.ok) {
    for (const line of result.stdout.split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index < 0) continue;
      properties[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return { ...unit, properties };
}

function serviceConfidence(unit) {
  const name = unit.name.toLowerCase();
  const description = String(unit.properties?.Description || unit.raw || '').toLowerCase();
  if (name === 'hermes.service') return 98;
  if (name.startsWith('hermes') && name.endsWith('.service')) return 90;
  if (name.includes('hermes')) return 82;
  if (description.includes('hermes')) return 68;
  return 45;
}

function rootFromPath(value) {
  if (!value) return '';
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const index = parts.findIndex(part => /^hermes[-_a-z0-9]*$/i.test(part));
  if (index < 0) return '';
  return `/${parts.slice(0, index + 1).join('/')}`;
}

function rootsFromText(text) {
  const matches = String(text || '').match(/\/[^\s;"']*hermes[^\s;"']*/gi) || [];
  return matches.map(rootFromPath).filter(Boolean);
}

async function processCandidates() {
  const result = await execText('ps -eo pid=,args=', { timeout: 2500 });
  if (!result.ok) return [];
  const candidates = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!/hermes/i.test(line) || /hermes-agent/i.test(line)) continue;
    const pid = line.trim().split(/\s+/)[0];
    const args = line.trim().slice(pid.length).trim();
    const roots = rootsFromText(args);
    let cwd = '';
    if (pid) {
      const pwdx = await execText(`pwdx ${pid}`, { timeout: 800 });
      cwd = pwdx.ok ? pwdx.stdout.replace(/^\d+:\s*/, '').trim() : '';
    }
    candidates.push({ pid, args, cwd, roots });
  }
  return candidates;
}

async function commonRootCandidates() {
  const candidates = [];
  const common = ['/opt/hermes', '/srv/hermes', '/mnt/d/Software/hermes', '/mnt/c/Software/hermes'];
  try {
    const users = await fsp.readdir('/home', { withFileTypes: true });
    for (const entry of users) {
      if (!entry.isDirectory()) continue;
      common.push(`/home/${entry.name}/hermes`, `/home/${entry.name}/Hermes`);
    }
  } catch {
    // Non-Linux hosts can safely skip /home probing.
  }
  for (const value of common) {
    if (await pathExists(value)) {
      candidates.push({ path: value, source: 'common-path', confidence: 72 });
    }
  }
  return candidates;
}

async function logCandidatesForRoots(roots, services) {
  const candidates = [];
  for (const root of roots) {
    for (const relative of ['logs/app.log', 'logs/hermes.log', 'hermes.log', 'app.log']) {
      const file = path.join(root.path, relative);
      addCandidate(candidates, {
        path: file,
        source: await pathExists(file) ? 'existing-file' : 'expected-path',
        confidence: await pathExists(file) ? 92 : 58,
      }, 'path');
    }
    try {
      const logsDir = path.join(root.path, 'logs');
      const files = await fsp.readdir(logsDir);
      for (const file of files.filter(item => item.endsWith('.log')).slice(0, 10)) {
        addCandidate(candidates, {
          path: path.join(logsDir, file),
          source: 'logs-directory',
          confidence: 86,
        }, 'path');
      }
    } catch {
      // No logs directory is a normal setup state.
    }
  }

  for (const service of services) {
    if (!service.name) continue;
    const prefix = service.scope === 'system' ? 'journalctl' : 'journalctl --user';
    addCandidate(candidates, {
      path: '',
      command: `${prefix} -u ${service.name} -n 200 --no-pager`,
      source: 'systemd-journal',
      confidence: 62,
    }, 'command');
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

async function healthCandidates() {
  const urls = [
    'http://127.0.0.1:3000/health',
    'http://127.0.0.1:3001/health',
    'http://127.0.0.1:8080/health',
  ];
  const candidates = [];
  for (const url of urls) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetch(url, { signal: controller.signal });
      addCandidate(candidates, {
        url,
        source: 'http-probe',
        status: response.status,
        latencyMs: Date.now() - started,
        confidence: response.ok ? 92 : 50,
      }, 'url');
    } catch {
      addCandidate(candidates, {
        url,
        source: 'default-port',
        status: null,
        latencyMs: Date.now() - started,
        confidence: url.includes(':3000') ? 55 : 35,
      }, 'url');
    } finally {
      clearTimeout(timeout);
    }
  }
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

async function backupCandidates(environment, rootDir) {
  const candidates = [];
  const home = os.homedir();
  const values = [
    '/mnt/d/HermesBackups',
    home ? path.join(home, 'Documents', 'HermesBackups') : '',
    path.join(rootDir, 'backups'),
  ].filter(Boolean);

  for (const value of values) {
    const exists = await pathExists(value);
    const writable = await isWritable(value);
    addCandidate(candidates, {
      path: value,
      source: value.startsWith('/mnt/') ? 'windows-mounted-drive' : 'local-path',
      exists,
      writable,
      confidence: value.startsWith('/mnt/') && !environment.isWsl
        ? 25
        : value === '/mnt/d/HermesBackups' && environment.isWsl
          ? 95
          : writable ? 72 : 45,
    }, 'path');
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

export async function detectLocalHermes(rootDir) {
  const environment = await detectEnvironment(rootDir);
  const serviceUnits = [
    ...(await listSystemdUnits('user')),
    ...(await listSystemdUnits('system')),
  ];
  const services = [];
  for (const unit of serviceUnits) {
    const inspected = await inspectSystemdUnit(unit);
    services.push({
      name: inspected.name,
      scope: inspected.scope,
      description: inspected.properties.Description || '',
      workingDirectory: inspected.properties.WorkingDirectory || '',
      execStart: inspected.properties.ExecStart || '',
      activeState: inspected.properties.ActiveState || '',
      mainPid: inspected.properties.MainPID || '',
      confidence: serviceConfidence(inspected),
      confidenceLabel: confidenceLabel(serviceConfidence(inspected)),
      raw: inspected.raw,
    });
  }
  services.sort((a, b) => b.confidence - a.confidence);

  const roots = [];
  for (const service of services) {
    if (service.workingDirectory && service.workingDirectory !== '/') {
      addCandidate(roots, {
        path: service.workingDirectory,
        source: `${service.scope}:${service.name}:WorkingDirectory`,
        confidence: 96,
      }, 'path');
    }
    for (const root of rootsFromText(service.execStart)) {
      addCandidate(roots, {
        path: root,
        source: `${service.scope}:${service.name}:ExecStart`,
        confidence: 82,
      }, 'path');
    }
  }

  const processes = await processCandidates();
  for (const processInfo of processes) {
    for (const root of processInfo.roots) {
      addCandidate(roots, {
        path: root,
        source: `process:${processInfo.pid}`,
        confidence: 76,
      }, 'path');
    }
    const cwdRoot = rootFromPath(processInfo.cwd);
    if (cwdRoot) {
      addCandidate(roots, {
        path: cwdRoot,
        source: `process-cwd:${processInfo.pid}`,
        confidence: 84,
      }, 'path');
    }
  }

  for (const candidate of await commonRootCandidates()) {
    addCandidate(roots, candidate, 'path');
  }
  roots.sort((a, b) => b.confidence - a.confidence);

  const logs = await logCandidatesForRoots(roots, services);
  const health = await healthCandidates();
  const backups = await backupCandidates(environment, rootDir);
  const bestService = services[0] || null;

  return {
    environment,
    candidates: {
      services,
      roots,
      logs,
      health,
      backups,
    },
    recommended: {
      service: bestService,
      root: roots[0] || null,
      log: logs[0] || null,
      health: health[0] || { url: 'http://127.0.0.1:3000/health', confidence: 55, confidenceLabel: 'medium' },
      backup: backups[0] || { path: './backups', confidence: 40, confidenceLabel: 'low' },
    },
  };
}

export function buildProfileFromSelection(selection, currentConfig) {
  const service = selection.service || {};
  const log = selection.log || {};
  const backup = selection.backup || {};
  return {
    app: currentConfig.app,
    hermes: {
      root: selection.root?.path || currentConfig.hermes.root,
      healthUrl: selection.health?.url || currentConfig.hermes.healthUrl || 'http://127.0.0.1:3000/health',
      logFile: log.path || currentConfig.hermes.logFile || '',
      logCommand: log.command || '',
      service: {
        name: service.name || '',
        scope: service.scope || '',
      },
      commands: serviceCommands(service),
    },
    backup: {
      dir: backup.path || currentConfig.backup.dir || '/mnt/d/HermesBackups',
      keepLast: currentConfig.backup.keepLast || 10,
      include: currentConfig.backup.include?.length ? currentConfig.backup.include : DEFAULT_INCLUDE,
      exclude: currentConfig.backup.exclude?.length ? currentConfig.backup.exclude : DEFAULT_EXCLUDE,
    },
    security: currentConfig.security,
  };
}
