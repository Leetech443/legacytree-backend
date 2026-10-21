// Short fingerprints of the files this server is running, published by /health.
// `node check-deploy.mjs <site> <api>` compares them with your project to show exactly which file is old.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fingerprint = (p) => crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 10);

export const FILES = Object.fromEntries([
  ...fs.readdirSync(here).filter((f) => f.endsWith('.js')).sort().map((f) => [`src/${f}`, fingerprint(path.join(here, f))]),
  ['db/schema.sql', fingerprint(path.join(root, 'db/schema.sql'))],
  ['package.json', fingerprint(path.join(root, 'package.json'))],
]);
