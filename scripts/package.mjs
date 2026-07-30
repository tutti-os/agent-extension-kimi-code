import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
const output = new URL('../build/tutti-agent/package/', import.meta.url);
const version = String(process.env.TUTTI_AGENT_EXTENSION_VERSION || '1.0.4').trim();
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid version: ${version}`);
await rm(new URL('../build/', import.meta.url), { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('../extension/', import.meta.url), output, {
  recursive: true,
  filter: (source) => basename(source) !== '.DS_Store'
});
const manifestUrl = new URL('tutti.agent.json', output);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
manifest.version = version;
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
