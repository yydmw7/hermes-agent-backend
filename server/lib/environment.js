import { exec } from 'node:child_process';
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function execText(command, options = {}) {
  return new Promise(resolve => {
    exec(command, {
      cwd: options.cwd,
      timeout: options.timeout || 3000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      shell: options.shell,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        error: error?.message || '',
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

export async function readTextIfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

export async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isWritable(target) {
  try {
    await fsp.access(target, constants.W_OK);
    return true;
  } catch {
    try {
      const parent = path.dirname(target);
      await fsp.access(parent, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function parseOsRelease(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    result[match[1].toLowerCase()] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}

function slug(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

export async function detectEnvironment(rootDir) {
  const platform = process.platform;
  const hostname = os.hostname();
  const procVersion = platform === 'linux' ? await readTextIfExists('/proc/version') : '';
  const osRelease = platform === 'linux' ? parseOsRelease(await readTextIfExists('/etc/os-release')) : {};
  const machineId = platform === 'linux'
    ? (await readTextIfExists('/etc/machine-id')).trim()
    : '';
  const isWsl = platform === 'linux' && (
    Boolean(process.env.WSL_DISTRO_NAME)
    || Boolean(process.env.WSL_INTEROP)
    || /microsoft|wsl/i.test(procVersion)
  );
  const distro = process.env.WSL_DISTRO_NAME || osRelease.name || '';
  const systemdCheck = await execText('systemctl --version', { timeout: 1500 });
  const mounts = [];

  for (const mount of ['/mnt/c', '/mnt/d']) {
    mounts.push({
      path: mount,
      exists: await pathExists(mount),
      writable: await isWritable(mount),
    });
  }

  const kind = isWsl ? 'wsl' : platform === 'win32' ? 'windows' : platform;
  const hostIdParts = [
    kind,
    distro || platform,
    hostname,
    machineId ? machineId.slice(0, 8) : '',
  ].filter(Boolean);

  return {
    kind,
    platform,
    hostname,
    distro,
    isWsl,
    isWindows: platform === 'win32',
    machineId,
    hostId: slug(hostIdParts.join('-')),
    systemd: {
      available: systemdCheck.ok,
      version: systemdCheck.stdout.split(/\r?\n/)[0] || '',
      error: systemdCheck.ok ? '' : systemdCheck.error || systemdCheck.stderr,
    },
    mounts,
    rootDir,
  };
}
