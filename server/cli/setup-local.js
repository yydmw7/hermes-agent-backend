import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from '../lib/config-store.js';
import { buildProfileFromSelection, detectLocalHermes } from '../lib/hermes-detect.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configStore = createConfigStore(rootDir);
const detection = await detectLocalHermes(rootDir);
const { value: currentConfig } = await configStore.loadConfig();
const profile = buildProfileFromSelection(detection.recommended, currentConfig);
const saved = await configStore.saveHostProfile(profile);

console.log(`Wrote host profile: ${saved.path}`);
console.log(`Environment: ${detection.environment.kind} ${detection.environment.distro || detection.environment.platform}`);
console.log(`Service: ${profile.hermes.service.name || 'not found'} ${profile.hermes.service.scope ? `(${profile.hermes.service.scope})` : ''}`);
console.log(`Root: ${profile.hermes.root}`);
console.log(`Log: ${profile.hermes.logFile || profile.hermes.logCommand || 'not configured'}`);
console.log(`Health: ${profile.hermes.healthUrl}`);
console.log(`Backup: ${profile.backup.dir}`);
