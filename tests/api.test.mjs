import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const base = process.env.TEST_API_URL ?? 'http://localhost:3000/api/v1';
const suffix = `${Date.now()}${Math.floor(Math.random()*10000)}`;
const email = `api-test-${suffix}@example.com`;
const password = 'TurboDash-test-123!';
let token, userId;
async function call(path, body, auth=token) {
  const response = await fetch(`${base}/${path}`, {
    method: body===undefined?'GET':'POST',
    headers: { ...(body!==undefined?{'Content-Type':'application/json'}:{}), ...(auth?{Authorization:`Bearer ${auth}`}:{}) },
    ...(body!==undefined?{body:JSON.stringify(body)}:{})
  });
  return { status:response.status, data:await response.json() };
}
after(async()=>{
  await db.user.deleteMany({where:{email:{startsWith:`api-test-${suffix}`}}});
  await db.$disconnect();
});
test('cadastro, autenticação, corridas, loja e logout', async t=>{
  await t.test('banco responde e catálogo coincide com o jogo',async()=>{
    assert.equal((await call('health',undefined,null)).status,200);
    const catalog=await call('store',undefined,null);
    assert.equal(catalog.data.items.length,8);
    assert.equal(catalog.data.items.find(i=>i.id==='life').price,1000);
    assert.deepEqual(catalog.data.coinPacks,[5000,10000,25000,50000]);
  });
  await t.test('valida cadastro e autentica automaticamente',async()=>{
    assert.equal((await call('auth/register',{name:'',initials:'1',avatar:'x',email,password},null)).status,400);
    const registered=await call('auth/register',{name:'Teste API',initials:'abc',avatar:'boy',email,password},null);
    assert.equal(registered.status,201);token=registered.data.token;userId=registered.data.player.id;
    assert.equal(registered.data.player.initials,'ABC');assert.equal(registered.data.player.balance,0);
    assert.ok(!('passwordHash' in registered.data.player));assert.match(token,/^[a-f0-9]{64}$/);
    const stored=await db.user.findUnique({where:{id:userId},include:{sessions:true}});
    assert.notEqual(stored.passwordHash,password);assert.notEqual(stored.sessions[0].tokenHash,token);
    assert.equal((await call('auth/register',{name:'Teste API',initials:'ABC',avatar:'boy',email:email.toUpperCase(),password},null)).status,409);
    assert.equal((await call('me')).data.player.id,userId);
    assert.equal((await call('me',undefined,null)).status,401);
  });
  await t.test('login rejeita senha incorreta e retorna perfil',async()=>{
    assert.equal((await call('auth/login',{email,password:'incorrect-123'},null)).status,401);
    const signed=await call('auth/login',{email:email.toUpperCase(),password},null);
    assert.equal(signed.status,200);token=signed.data.token;assert.equal(signed.data.player.id,userId);
  });
  let runId;
  await t.test('corridas são vinculadas ao usuário e checkpoint é idempotente',async()=>{
    const started=await call('runs/start',{requestId:`run-${suffix}`});assert.equal(started.status,200);runId=started.data.runId;
    assert.equal((await call('runs/start',{requestId:`run-${suffix}`})).data.runId,runId);
    const report={runId,score:150,coins:20};
    const first=await call('runs/checkpoint',report);assert.equal(first.status,200);assert.equal(first.data.player.balance,20);
    const second=await call('runs/checkpoint',report);assert.equal(second.data.player.balance,20);assert.equal(second.data.player.totalRuns,1);
    assert.equal((await call('runs/checkpoint',{runId,score:100,coins:10})).status,409);
    assert.equal((await call('runs/checkpoint',{runId,score:1000000,coins:100000})).status,422);
    const rank=await call('ranking',undefined,null);assert.ok(rank.data.entries.some(e=>e.playerId===userId&&e.score===150));
  });
  await t.test('compras sem saldo e inventário vazio são recusados',async()=>{
    assert.equal((await call('store/purchases',{itemId:'life',requestId:`empty-${suffix}`})).status,409);
    assert.equal((await call('inventory/consume',{runId,itemId:'life',requestId:`emptyuse-${suffix}`})).status,409);
  });
  await t.test('compra concorrente não duplica débito e consumo não duplica item',async()=>{
    // Fixture directly in the test database; the API has no arbitrary credit endpoint.
    await db.wallet.update({where:{userId},data:{balance:2000}});
    const body={itemId:'life',requestId:`buy-${suffix}`,price:0};
    const receipts=await Promise.all([call('store/purchases',body),call('store/purchases',body)]);
    for(const receipt of receipts){assert.equal(receipt.status,200);assert.equal(receipt.data.balance,1000);assert.equal(receipt.data.quantity,1);}
    assert.equal((await call('me')).data.player.balance,1000);
    assert.equal((await call('store/purchases',{...body,itemId:'shield'})).status,409);
    const use={runId,itemId:'life',requestId:`use-${suffix}`};
    assert.equal((await call('inventory/consume',use)).status,200);
    assert.equal((await call('inventory/consume',use)).status,200);
    assert.equal((await call('me')).data.player.inventory.find(i=>i.itemId==='life').quantity,0);
    assert.equal((await call('inventory/consume',{...use,requestId:`use-new-${suffix}`})).status,409);
  });
  await t.test('isolamento entre contas e encerramento da corrida',async()=>{
    const other=await call('auth/register',{name:'Outro piloto',initials:'DEF',avatar:'girl',email:`api-test-${suffix}-other@example.com`,password},null);
    assert.equal(other.status,201);
    assert.equal((await call('runs/checkpoint',{runId,score:150,coins:20},other.data.token)).status,404);
    assert.equal((await call('inventory/consume',{runId,itemId:'life',requestId:`foreign-${suffix}`},other.data.token)).status,404);
    assert.equal((await call('runs/checkpoint',{runId,score:150,coins:20,finished:true})).status,200);
    assert.equal((await call('runs/checkpoint',{runId,score:151,coins:20})).status,409);
    assert.equal((await call('runs/start',{requestId:`run-${suffix}`})).status,409);
  });
  await t.test('compras distintas simultâneas nunca deixam saldo negativo',async()=>{
    await db.wallet.update({where:{userId},data:{balance:1000}});
    const results=await Promise.all([
      call('store/purchases',{itemId:'life',requestId:`parallel-a-${suffix}`}),
      call('store/purchases',{itemId:'life',requestId:`parallel-b-${suffix}`})
    ]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    assert.equal((await call('me')).data.player.balance,0);
  });
  await t.test('logout revoga token e sessão expirada é recusada',async()=>{
    assert.equal((await call('auth/logout',{})).status,200);
    assert.equal((await call('me')).status,401);
    const signed=await call('auth/login',{email,password},null);token=signed.data.token;
    await db.session.updateMany({where:{userId},data:{expiresAt:new Date(0)}});
    assert.equal((await call('me')).status,401);
  });
});
