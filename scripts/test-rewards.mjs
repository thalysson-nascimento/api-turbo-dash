import { mkdirSync, readFileSync, writeFileSync, closeSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('integration-staging',{recursive:true});
const schema=readFileSync('prisma/local/schema.prisma','utf8').replace('provider = "prisma-client-js"','provider = "prisma-client-js"\n  output = "./daily-client"');
writeFileSync('integration-staging/daily-schema.prisma',schema);
closeSync(openSync('integration-staging/daily-test.db','a'));
const env={...process.env,DATABASE_URL:'file:./daily-test.db'};
for(const args of [['node_modules/prisma/build/index.js','db','push','--schema','integration-staging/daily-schema.prisma'],['--test','tests/rewards.test.cjs']]){
 const result=spawnSync(process.execPath,args,{stdio:'inherit',env});
 if(result.status!==0)process.exit(result.status??1);
}
