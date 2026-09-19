import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
const root=path.resolve(import.meta.dirname,'..'),dir=mkdtempSync(path.join(tmpdir(),'pg-capture-'));
let db;
try {
 cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
 Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(dir,'db'),PAYGATE_DATA_DIR:dir,ENCRYPTION_KEY:'ab'.repeat(32),COOKIE_SECRET:'cd'.repeat(32),LAB_UNOFFICIAL:'0',GOPAY_ACCESS_TOKEN:'',SHOPEEPAY_TOKEN:''});
 const load=f=>import(pathToFileURL(path.join(dir,'src',f)));({db}=await load('db/index.js'));
 const m=await load('middleware/console-audit.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
 assert.equal(typeof m.auditAction,'function','route audit middleware must exist');
 const now=Date.now();db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,?,?,?,?)').run('test','fake',now,now);
 const {listEvents}=await load('services/console-log.js');
 function invoke(event,status,data){const req={user:{id:1},id:'123456abcdef',body:{password:'NEVER_LOG'},headers:{authorization:'NEVER_LOG'}};const res=new EventEmitter();Object.assign(res,{statusCode:status,locals:{},json:body=>body});let next=0;m.auditAction(event)(req,res,()=>next++);m.auditAction(event)(req,res,()=>next++);assert.equal(next,2);assert.equal(res.json(data),data);res.emit('finish');res.emit('finish');return listEvents(1).entries;}
 let rows=invoke('GOPAY_LOGIN_START',503,{code:'PHONE_REJECTED',error:'NEVER_LOG',diagnostic:{id:'00112233-4455-4677-8899-aabbccddeeff',stage:'otp_request',provider_status:401},token:'NEVER_LOG'});
 assert.equal(rows.length,1);assert.equal(rows[0].code,'PHONE_REJECTED');assert.equal(rows[0].level,'warn');assert.equal(rows[0].provider_status,401);assert.equal(rows[0].request_id,'00112233-4455-4677-8899-aabbccddeeff');assert.ok(!JSON.stringify(rows).includes('NEVER_LOG'));
 rows=invoke('ORDER_CREATE',422,{error:'NEVER_LOG'});assert.equal(rows[0].code,'VALIDATION_ERROR');
 rows=invoke('ORDER_CREATE',201,{key:'NEVER_LOG'});assert.equal(rows[0].code,'OK');assert.equal(rows[0].level,'info');
 const n=rows.length;invoke(null,200,{token:'NEVER_LOG'});assert.equal(listEvents(1).entries.length,n,'unmapped reads never recorded');
 console.log('PASS real SQLite request capture: one event, safe metadata, unchanged response, precise rejection level, no unmapped read noise');
} finally {db?.close();rmSync(dir,{recursive:true,force:true});}
