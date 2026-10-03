const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { homedir } = require('os');
const { join, dirname, delimiter } = require('path');

let executable = process.execPath;
if (Number(process.versions.node.split('.')[0]) < 22) {
  const candidates = [process.env.TURBO_DASH_NODE, join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')];
  executable = candidates.find(candidate => {
    if (!candidate || !existsSync(candidate)) return false;
    const check = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    return check.status === 0 && Number(check.stdout.trim().replace(/^v/, '').split('.')[0]) >= 22;
  });
  if (!executable) {
    console.error('Turbo Dash precisa do Node.js 22 ou superior. Atualize o Node ou configure TURBO_DASH_NODE com o caminho do executável.');
    process.exit(1);
  }
}
const result = spawnSync(executable, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, PATH: dirname(executable) + delimiter + (process.env.PATH || '') },
});
if (result.error) console.error('Não foi possível iniciar o Node.js compatível.');
process.exit(result.status === null ? 1 : result.status);
