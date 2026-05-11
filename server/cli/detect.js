import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLocalHermes } from '../lib/hermes-detect.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const detection = await detectLocalHermes(rootDir);
const json = process.argv.includes('--json');

if (json) {
  console.log(JSON.stringify(detection, null, 2));
} else {
  console.log(`Environment: ${detection.environment.kind} ${detection.environment.distro || detection.environment.platform}`);
  console.log(`Host profile id: ${detection.environment.hostId}`);
  console.log('');
  console.log(`Service: ${detection.recommended.service?.name || 'not found'} ${detection.recommended.service?.scope ? `(${detection.recommended.service.scope})` : ''}`);
  console.log(`Root: ${detection.recommended.root?.path || 'not found'}`);
  console.log(`Log: ${detection.recommended.log?.path || detection.recommended.log?.command || 'not found'}`);
  console.log(`Health: ${detection.recommended.health?.url || 'not found'}`);
  console.log(`Backup: ${detection.recommended.backup?.path || 'not found'}`);
}
