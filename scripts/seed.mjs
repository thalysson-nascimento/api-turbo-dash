import { PrismaClient } from '@prisma/client';
import { existsSync } from 'node:fs';
import { configureDatabaseEnv } from './database-env.mjs';
if (existsSync('.env')) process.loadEnvFile('.env');
configureDatabaseEnv();
const db = new PrismaClient();
const items = [
  ['life','Vida Extra','Arme uma nova chance ou use após a batida.',1000,0,0],
  ['turbo','Arrancada Turbo','Velocidade máxima por 8 segundos.',15000,1,8],
  ['shield','Escudo de Aço','Protege contra a próxima colisão.',3500,2,0],
  ['magnet','Ímã de Moedas','Atrai moedas próximas por 15 segundos.',2500,3,15],
  ['double','Moedas em Dobro','Dobra a coleta durante 20 segundos.',6000,4,20],
  ['slow','Tempo Lento','Desacelera a aproximação do trânsito por 6 segundos.',4500,5,6],
  ['ghost','Modo Fantasma','Atravesse o trânsito por 5 segundos.',7000,6,5],
  ['pulse','Pulso Livre','Remove o trânsito próximo do seu carro.',5000,7,0],
];
try {
  for (const [id,name,description,price,art,duration] of items) {
    const data = { id,name,description,price,art,duration };
    await db.product.upsert({ where: { id }, create: data, update: {} });
  }
  console.log('Catálogo: 8 boosters configurados. Preços existentes preservados.');
} finally { await db.$disconnect(); }
