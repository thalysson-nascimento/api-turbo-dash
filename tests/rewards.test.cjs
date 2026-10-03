const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const ts = require('typescript');
const Module = require('node:module');
const { PrismaClient } = require('../integration-staging/daily-client');
const db = new PrismaClient({ datasourceUrl: 'file:' + resolve('integration-staging/daily-test.db').replaceAll('\\','/') });
function load(name, dependencies) {
 const file=resolve('src/lib/'+name+'.ts');
 const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(resolve('src/lib'));
 const original=mod.require.bind(mod);mod.require=id=>Object.hasOwn(dependencies,id)?dependencies[id]:original(id);
 mod._compile(compiled,file);return mod.exports;
}
const api=load('api',{'./db':{db}}), rewards=load('ad-rewards',{'./db':{db},'./api':api});
const sha=s=>createHash('sha256').update(s).digest('hex');
after(()=>db.$disconnect());
test('signed query rejects forged, changed and duplicate parameters',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const query='ad_unit=test&custom_data=abc%2Bdef&timestamp=100&transaction_id=tx1';
 const signature=sign('sha256',Buffer.from(query),privateKey).toString('base64url');
 const raw=query+'&signature='+signature+'&key_id=1';
 assert.equal(rewards.verifyQuery(raw,publicKey),true);
 assert.equal(rewards.verifyQuery(raw.replace('timestamp=100','timestamp=101'),publicKey),false);
 assert.equal(rewards.verifyQuery(raw+'&transaction_id=tx2',publicKey),false);
 const duplicate=query+'&custom_data=other';
 assert.equal(rewards.verifyQuery(duplicate+'&signature='+sign('sha256',Buffer.from(duplicate),privateKey).toString('base64url')+'&key_id=1',publicKey),false);
});
test('Fortaleza day changes at 03:00 UTC',()=>{
 assert.equal(rewards.rewardDay(new Date('2026-10-04T02:59:59Z')),'2026-10-03');
 assert.equal(rewards.rewardDay(new Date('2026-10-04T03:00:00Z')),'2026-10-04');
});
test('five server-verified videos pay once, cancellation and duplicates never overpay',async()=>{
 const user=await db.user.create({data:{email:'daily-'+Date.now()+'@example.com',passwordHash:'fixture',name:'Tester',initials:'TST',avatar:'boy',wallet:{create:{}},stats:{create:{}}}});
 try {
  let state=await rewards.dailyStatus(user.id);assert.equal(state.remaining,5);
  const cancelled=await rewards.startDaily(user.id,{requestId:'cancelled-001'});
  await rewards.cancelDaily(user.id,{token:cancelled.token});
  assert.equal((await rewards.dailyStatus(user.id)).watched,0);
  await assert.rejects(()=>rewards.creditVerified(sha(cancelled.token),'expired-event',Date.now()+11*60*1000),/fora do período/);
  for(let i=0;i<5;i++){
   const requestId='daily-test-'+i;
   const attempt=await rewards.startDaily(user.id,{requestId});
   assert.equal((await rewards.startDaily(user.id,{requestId})).token,attempt.token);
   await assert.rejects(()=>rewards.startDaily(user.id,{requestId:'blocked-'+i}),/Aguarde/);
   await Promise.all([rewards.creditVerified(sha(attempt.token),'verified-tx-'+user.id+'-'+i,Date.now()),rewards.creditVerified(sha(attempt.token),'verified-tx-'+user.id+'-'+i,Date.now())]);
   state=await rewards.dailyStatus(user.id);assert.equal(state.watched,i+1);assert.equal(state.remaining,4-i);
   assert.equal(state.player.balance,i===4?5000:0);
  }
  assert.equal(state.claimed,true);
  await assert.rejects(()=>rewards.startDaily(user.id,{requestId:'sixth-ad-001'}),/já recebeu/);
  // A signed late callback for an earlier cancelled attempt cannot pay a second time.
  await rewards.creditVerified(sha(cancelled.token),'late-'+user.id,Date.now());
  assert.equal((await rewards.dailyStatus(user.id)).player.balance,5000);
  // A previous day's completed record must not disable today's offer.
  await db.adRewardAttempt.deleteMany({where:{userId:user.id}});
  await db.dailyAdReward.update({where:{userId_day:{userId:user.id,day:state.day}},data:{day:'2000-01-01'}});
  const nextDay=await rewards.dailyStatus(user.id);assert.equal(nextDay.remaining,5);assert.equal(nextDay.claimed,false);assert.equal(nextDay.player.balance,5000);
 } finally { await db.user.delete({where:{id:user.id}}); }
});
