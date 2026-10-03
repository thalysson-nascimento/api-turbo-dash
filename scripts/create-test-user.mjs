import { existsSync } from 'node:fs';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { configureDatabaseEnv } from './database-env.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
configureDatabaseEnv();
const email = process.env.TEST_ACCOUNT_EMAIL?.trim().toLowerCase();
const password = process.env.TEST_ACCOUNT_PASSWORD;
if (!email || !password) throw new Error('Configure TEST_ACCOUNT_EMAIL e TEST_ACCOUNT_PASSWORD.');
const salt = randomBytes(16).toString('hex');
const hash = await promisify(scryptCallback)(password, salt, 64);
const passwordHash = `${salt}:${hash.toString('hex')}`;
const db = new PrismaClient();
try {
  await db.user.upsert({
    where: { email },
    create: { email, passwordHash, name: 'Piloto Teste', initials: 'TST', avatar: 'boy', wallet: { create: {} }, stats: { create: {} } },
    update: { passwordHash },
  });
  console.log('Conta de teste configurada; progresso existente preservado.');
} finally { await db.$disconnect(); }
