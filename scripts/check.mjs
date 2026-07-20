import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [path.join(root, 'scripts', 'package.mjs')], { stdio: 'inherit' });
const packageDir = path.join(root, 'build', 'tutti-agent', 'package');
const manifest = JSON.parse(await readFile(path.join(packageDir, 'tutti.agent.json'), 'utf8'));
if (manifest.schemaVersion !== 'tutti.agent.manifest.v2' || manifest.agentKey !== 'kimi-code' || manifest.version !== '1.0.0') throw new Error('invalid manifest identity');
const expectedInstall = ['tool', 'install', 'kimi-cli==1.49.0'];
if (manifest.runtime?.kind !== 'standard-acp' || manifest.runtime.install?.runner !== 'uv' || JSON.stringify(manifest.runtime.install.args) !== JSON.stringify(expectedInstall)) throw new Error('Kimi Code runtime must use the pinned, isolated uv tool contract');
if (manifest.runtime.launch?.executable !== '${installRoot}/bin/kimi' || JSON.stringify(manifest.runtime.launch.args) !== JSON.stringify(['acp'])) throw new Error('Kimi Code managed launch contract changed');
const discovery = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.discovery), 'utf8'));
const candidate = discovery.candidates?.[0];
if (discovery.candidates?.length !== 1 || JSON.stringify(candidate.binaryNames) !== JSON.stringify(['kimi'])) throw new Error('Kimi Code discovery binary changed');
if (JSON.stringify(candidate.version) !== JSON.stringify({ args: ['--version'], constraint: '>=1.49.0 <2.0.0' })) throw new Error('Kimi Code discovery version contract changed');
if (JSON.stringify(candidate.launchArgs) !== JSON.stringify(['acp']) || candidate.probe?.kind !== 'acp-initialize' || candidate.probe.timeoutMs !== 15000) throw new Error('Kimi Code discovery must use the bounded ACP probe');
const capabilities = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.capabilities), 'utf8'));
const expectedCapabilities = { imageInput: true, audioInput: false, embeddedContext: false, interrupt: true, resume: true, permissionModes: true, modelSelection: true, commands: true, skills: false };
if (JSON.stringify(capabilities.declared) !== JSON.stringify(expectedCapabilities)) throw new Error('Kimi Code capabilities changed without runtime evidence');
const composer = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.composer), 'utf8'));
const expectedModes = [{ runtimeId: 'plan', semantic: 'read-only' }, { runtimeId: 'default', semantic: 'ask-before-write' }, { runtimeId: 'auto', semantic: 'accept-edits' }, { runtimeId: 'yolo', semantic: 'full-access' }];
if (JSON.stringify(composer.permissionModes) !== JSON.stringify(expectedModes)) throw new Error('Kimi Code permission mappings changed');
if (composer.skills !== undefined) throw new Error('Kimi Code must not declare unverified Skill roots');
const tools = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.tools), 'utf8'));
if (tools.tools?.length !== 0) throw new Error('Kimi Code tools must remain generic');
await rejectExecutables(packageDir);
async function rejectExecutables(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${item}`);
    if (entry.isDirectory()) { await rejectExecutables(item); continue; }
    if ((await stat(item)).mode & 0o111) throw new Error(`executable is forbidden: ${item}`);
  }
}
