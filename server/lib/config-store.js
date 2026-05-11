import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { detectEnvironment, pathExists, readTextIfExists } from './environment.js';

export const DEFAULT_INCLUDE = ['.env', 'config', 'data', 'uploads', 'logs'];
export const DEFAULT_EXCLUDE = ['node_modules', '.git', 'cache', 'tmp'];

export function createConfigStore(rootDir) {
  const configDir = process.env.HERMES_AGENT_CONFIG_DIR
    ? path.resolve(process.env.HERMES_AGENT_CONFIG_DIR)
    : path.join(rootDir, 'config');
  const hostsDir = path.join(configDir, 'hosts');
  const defaultPath = path.join(configDir, 'default.yaml');
  const packagedDefaultPath = path.join(rootDir, 'config', 'default.yaml');
  const legacyPath = path.join(configDir, 'hermes-agent.yaml');
  const explicitPath = process.env.HERMES_AGENT_CONFIG
    ? path.resolve(process.env.HERMES_AGENT_CONFIG)
    : '';

  async function getPaths() {
    const environment = await detectEnvironment(rootDir);
    const hostPath = path.join(hostsDir, `${environment.hostId}.yaml`);
    return {
      configDir,
      hostsDir,
      defaultPath,
      legacyPath,
      explicitPath,
      hostPath,
      environment,
    };
  }

  async function readYaml(file) {
    if (!file || !(await pathExists(file))) return {};
    return YAML.parse(await readTextIfExists(file)) || {};
  }

  function normalize(parsed) {
    return {
      app: {
        name: parsed.app?.name || 'Hermes Agent',
        host: parsed.app?.host || '127.0.0.1',
        port: Number(parsed.app?.port || process.env.PORT || 8787),
      },
      hermes: {
        root: parsed.hermes?.root || '.',
        healthUrl: parsed.hermes?.healthUrl || '',
        logFile: parsed.hermes?.logFile || '',
        logCommand: parsed.hermes?.logCommand || '',
        service: {
          name: parsed.hermes?.service?.name || '',
          scope: parsed.hermes?.service?.scope || '',
        },
        commands: {
          start: parsed.hermes?.commands?.start || '',
          stop: parsed.hermes?.commands?.stop || '',
          restart: parsed.hermes?.commands?.restart || '',
          status: parsed.hermes?.commands?.status || '',
        },
      },
      backup: {
        dir: parsed.backup?.dir || './backups',
        keepLast: Number(parsed.backup?.keepLast || 10),
        include: Array.isArray(parsed.backup?.include) ? parsed.backup.include : DEFAULT_INCLUDE,
        exclude: Array.isArray(parsed.backup?.exclude) ? parsed.backup.exclude : DEFAULT_EXCLUDE,
      },
      security: {
        adminToken: parsed.security?.adminToken || '',
      },
    };
  }

  function mergeDeep(...objects) {
    const result = {};
    for (const object of objects) {
      for (const [key, value] of Object.entries(object || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          result[key] = mergeDeep(result[key] || {}, value);
        } else if (value !== undefined) {
          result[key] = value;
        }
      }
    }
    return result;
  }

  async function loadConfig() {
    const paths = await getPaths();
    const defaultConfig = mergeDeep(
      await readYaml(packagedDefaultPath),
      await readYaml(defaultPath),
    );
    const legacyConfig = explicitPath ? {} : await readYaml(legacyPath);
    const hostConfig = explicitPath ? {} : await readYaml(paths.hostPath);
    const explicitConfig = explicitPath ? await readYaml(explicitPath) : {};
    const merged = mergeDeep(defaultConfig, legacyConfig, hostConfig, explicitConfig);
    const activePath = explicitPath || (await pathExists(paths.hostPath) ? paths.hostPath : legacyPath);
    const raw = await readTextIfExists(activePath);

    return {
      raw,
      value: normalize(merged),
      meta: {
        ...paths,
        activePath,
        hostProfileExists: await pathExists(paths.hostPath),
        explicit: Boolean(explicitPath),
        sources: [packagedDefaultPath, defaultPath, legacyPath, paths.hostPath, explicitPath].filter(Boolean),
      },
    };
  }

  async function saveActiveConfig(raw) {
    const { meta } = await loadConfig();
    await fsp.mkdir(path.dirname(meta.activePath), { recursive: true });
    YAML.parse(raw);
    await fsp.writeFile(meta.activePath, raw, 'utf8');
    return meta.activePath;
  }

  async function saveHostProfile(profile) {
    const paths = await getPaths();
    await fsp.mkdir(hostsDir, { recursive: true });
    const raw = YAML.stringify(profile);
    await fsp.writeFile(paths.hostPath, raw, 'utf8');
    return {
      path: paths.hostPath,
      raw,
      environment: paths.environment,
    };
  }

  async function getSetupState() {
    const loaded = await loadConfig();
    const config = loaded.value;
    const isDefaultRoot = config.hermes.root === '/home/ubuntu/hermes' || config.hermes.root === '.';
    const commandsEmpty = Object.values(config.hermes.commands).every(value => !value);
    const needsSetup = !loaded.meta.explicit && (!loaded.meta.hostProfileExists || (isDefaultRoot && commandsEmpty));
    return {
      needsSetup,
      hostProfileExists: loaded.meta.hostProfileExists,
      activePath: loaded.meta.activePath,
      hostProfilePath: loaded.meta.hostPath,
      environment: loaded.meta.environment,
      reasons: [
        !loaded.meta.hostProfileExists ? 'No host profile exists for this machine.' : '',
        isDefaultRoot ? 'Hermes root is still a default placeholder.' : '',
        commandsEmpty ? 'System control commands are not configured.' : '',
      ].filter(Boolean),
    };
  }

  return {
    getPaths,
    loadConfig,
    saveActiveConfig,
    saveHostProfile,
    getSetupState,
  };
}

export function serviceCommands(service) {
  if (!service?.name) {
    return { start: '', stop: '', restart: '', status: '' };
  }
  const base = service.scope === 'system' ? 'systemctl' : 'systemctl --user';
  return {
    start: `${base} start ${service.name}`,
    stop: `${base} stop ${service.name}`,
    restart: `${base} restart ${service.name}`,
    status: `${base} status ${service.name} --no-pager`,
  };
}
