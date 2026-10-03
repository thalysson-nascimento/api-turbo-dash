import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { configureDatabaseEnv } from './database-env.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
configureDatabaseEnv();
const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...process.argv.slice(2)], {
  stdio: 'inherit', env: process.env,
});
if (result.error) {
  console.error('Não foi possível executar o Prisma.');
  process.exit(1);
}
process.exit(result.status ?? 1);
