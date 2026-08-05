import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [path.join(root, 'scripts', 'package.mjs')], { stdio: 'inherit' });
const packageDir = path.join(root, 'build', 'tutti-agent', 'package');
const manifest = JSON.parse(await readFile(path.join(packageDir, 'tutti.agent.json'), 'utf8'));
const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.schemaVersion !== 'tutti.agent.manifest.v2' || manifest.agentKey !== 'kimi-code' || manifest.version !== packageMetadata.version) throw new Error('invalid manifest identity');
const expectedInstall = ['install', '--prefix', '${installRoot}', '@moonshot-ai/kimi-code@0.28.0'];
if (manifest.runtime?.kind !== 'standard-acp' || manifest.runtime.install?.runner !== 'npm' || JSON.stringify(manifest.runtime.install.args) !== JSON.stringify(expectedInstall)) throw new Error('Kimi Code runtime must use the pinned, isolated npm contract');
if (manifest.runtime.launch?.executable !== '${installRoot}/node_modules/.bin/kimi' || JSON.stringify(manifest.runtime.launch.args) !== JSON.stringify(['acp']) || JSON.stringify(manifest.runtime.launch.env) !== JSON.stringify({ KIMI_SHELL_PATH: '${env:TUTTI_MANAGED_POSIX_SHELL}' })) throw new Error('Kimi Code managed launch contract changed');
const discovery = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.discovery), 'utf8'));
const candidate = discovery.candidates?.[0];
if (discovery.candidates?.length !== 1 || JSON.stringify(candidate.binaryNames) !== JSON.stringify(['kimi'])) throw new Error('Kimi Code discovery binary changed');
if (JSON.stringify(candidate.searchPaths) !== JSON.stringify([{ scope: 'user', path: '.kimi-code/bin' }])) throw new Error('Kimi Code official install search path changed');
if (JSON.stringify(candidate.version) !== JSON.stringify({ args: ['--version'], constraint: '>=0.28.0 <1.0.0' })) throw new Error('Kimi Code discovery version contract changed');
if (JSON.stringify(candidate.launchArgs) !== JSON.stringify(['acp']) || candidate.probe?.kind !== 'acp-initialize' || candidate.probe.timeoutMs !== 15000) throw new Error('Kimi Code discovery must use the bounded ACP probe');
const capabilities = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.capabilities), 'utf8'));
const expectedCapabilities = { imageInput: true, audioInput: false, embeddedContext: true, browserUse: true, interrupt: true, resume: true, permissionModes: true, modelSelection: true, commands: true, skills: true };
if (JSON.stringify(capabilities.declared) !== JSON.stringify(expectedCapabilities)) throw new Error('Kimi Code capabilities changed without runtime evidence');
const authentication = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.authentication), 'utf8'));
const expectedAuthentication = {
  schemaVersion: 'tutti.agent.authentication.v1',
  methods: [{
    id: 'login',
    name: 'Set up Kimi',
    description: 'Open Kimi Code, then use /login for Coding Plan or /provider for an API key.',
    type: 'terminal',
    command: { strategy: 'runtime', args: [] }
  }]
};
if (JSON.stringify(authentication) !== JSON.stringify(expectedAuthentication)) throw new Error('Kimi Code terminal setup contract changed');
const composer = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.composer), 'utf8'));
const expectedModes = [{ runtimeId: 'plan', semantic: 'read-only' }, { runtimeId: 'default', semantic: 'ask-before-write' }, { runtimeId: 'auto', semantic: 'accept-edits' }, { runtimeId: 'yolo', semantic: 'full-access' }];
if (JSON.stringify(composer.permissionModes) !== JSON.stringify(expectedModes)) throw new Error('Kimi Code permission mappings changed');
const expectedSlashCommands = {
  commandCatalogAuthoritative: true,
  commands: [
    { name: 'compact', effect: 'submitImmediate' },
    { name: 'status', effect: 'showStatus' },
    { name: 'usage', effect: 'submitImmediate' },
    { name: 'mcp', effect: 'submitImmediate' },
    { name: 'tasks', effect: 'submitImmediate' },
    { name: 'help', effect: 'submitImmediate' }
  ]
};
if (JSON.stringify(composer.slashCommands) !== JSON.stringify(expectedSlashCommands)) throw new Error('Kimi Code slash command catalog changed');
const expectedSkills = { invocation: 'textTrigger', triggerPrefix: '/skill:', runtimeCommandProjection: 'unlisted-as-skills', roots: [{ scope: 'workspace', path: '.agents/skills' }] };
if (JSON.stringify(composer.skills) !== JSON.stringify(expectedSkills)) throw new Error('Kimi Code Skill discovery contract changed');
const tools = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.tools), 'utf8'));
if (tools.tools?.length !== 0) throw new Error('Kimi Code tools must remain generic');
await verifyKimiAuthenticationContract();
await verifyKimiSkillDiscovery();
await rejectExecutables(packageDir);

async function verifyKimiAuthenticationContract() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'tutti-kimi-auth-'));
  try {
    const kimiExecutable = path.join(root, 'node_modules', '.bin', 'kimi');
    const output = execFileSync('python3', [
      path.join(root, 'scripts', 'probe_acp_runtime.py'),
      '--cwd', temporaryRoot,
      '--timeout', '20',
      '--initialize-only',
      '--',
      kimiExecutable,
      'acp'
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KIMI_CODE_HOME: temporaryRoot,
        KIMI_DISABLE_TELEMETRY: '1'
      }
    });
    const result = JSON.parse(output);
    const login = result.initialize?.authMethods?.find((method) => method.id === 'login');
    if (login?.type !== 'terminal') {
      throw new Error('Kimi Code ACP must advertise the terminal login method');
    }
    const help = execFileSync(kimiExecutable, ['--help'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        KIMI_CODE_HOME: temporaryRoot,
        KIMI_DISABLE_TELEMETRY: '1'
      }
    });
    if (!help.includes('login') || !help.includes('provider')) {
      throw new Error('Kimi Code runtime no longer exposes both supported setup flows');
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyKimiSkillDiscovery() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'tutti-kimi-skill-'));
  try {
    const workspace = path.join(temporaryRoot, 'workspace');
    const kimiHome = path.join(temporaryRoot, 'kimi-home');
    const skillDirectory = path.join(workspace, '.agents', 'skills', 'tutti-canonical-test');
    const credentialsDirectory = path.join(kimiHome, 'credentials');
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: tutti-canonical-test',
      'description: Verify canonical Tutti skills are discovered by Kimi ACP.',
      '---',
      '',
      '# Tutti canonical test',
      '',
      'This skill exists only for the ACP discovery integration test.',
      ''
    ].join('\n'));
    const credentialFile = path.join(credentialsDirectory, 'kimi-code.json');
    await writeFile(credentialFile, `${JSON.stringify({ access_token: 'skill-discovery-test-token' })}\n`);
    await chmod(credentialFile, 0o600);
    const kimiExecutable = path.join(root, 'node_modules', '.bin', 'kimi');
    const runtimeVersion = execFileSync(kimiExecutable, ['--version'], { encoding: 'utf8' }).trim();
    if (runtimeVersion !== '0.28.0') {
      throw new Error('Kimi Code Skill discovery check did not use the pinned 0.28.0 runtime');
    }
    execFileSync('python3', [
      path.join(root, 'scripts', 'probe_acp_runtime.py'),
      '--cwd', workspace,
      '--timeout', '20',
      '--notification-wait', '5',
      '--expect-command', 'status',
      '--expect-command', 'usage',
      '--expect-command', 'skill:tutti-canonical-test',
      '--summary-only',
      '--',
      kimiExecutable,
      'acp'
    ], {
      env: {
        ...process.env,
        KIMI_CODE_HOME: kimiHome,
        KIMI_DISABLE_TELEMETRY: '1',
        KIMI_MODEL_API_KEY: 'not-used',
        KIMI_MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
        KIMI_MODEL_NAME: 'skill-discovery-test'
      },
      stdio: 'inherit'
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function rejectExecutables(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${item}`);
    if (entry.isDirectory()) { await rejectExecutables(item); continue; }
    if ((await stat(item)).mode & 0o111) throw new Error(`executable is forbidden: ${item}`);
  }
}
