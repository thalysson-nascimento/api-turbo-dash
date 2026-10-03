import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureDatabaseEnv } from '../scripts/database-env.mjs';

test('prioriza a conexão Prisma fornecida pela Vercel', () => {
  const env = { PRISMA_DATABASE_URL: 'postgres://prisma/example', POSTGRES_URL: 'postgres://postgres/example', DATABASE_URL: 'file:./dev.db' };
  assert.equal(configureDatabaseEnv(env), env.PRISMA_DATABASE_URL);
  assert.equal(env.DATABASE_URL, env.PRISMA_DATABASE_URL);
});
test('aceita POSTGRES_URL e preserva SQLite quando não há aliases', () => {
  const env = { POSTGRES_URL: 'postgres://postgres/example' };
  configureDatabaseEnv(env);
  assert.equal(env.DATABASE_URL, env.POSTGRES_URL);
  const local = { DATABASE_URL: 'file:./dev.db' };
  assert.equal(configureDatabaseEnv(local), 'file:./dev.db');
  assert.equal(configureDatabaseEnv({}), undefined);
});
