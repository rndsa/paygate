import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { renderPage } from '../src/lib/render.js';

const app=express();
app.set('view engine','ejs');
app.set('views',path.resolve(import.meta.dirname,'../views'));
app.locals.config={labUnofficialEnabled:false,labUserId:1};
app.get('/tos',(req,res,next)=>{
  res.locals.csrfToken='test';
  renderPage(res,'tos',{title:'Syarat Penggunaan',active:'tos',user:{id:1,username:'owner',role:'admin'}}).catch(next);
});
const server=app.listen(0,'127.0.0.1');
await once(server,'listening');
try{
 const response=await fetch(`http://127.0.0.1:${server.address().port}/tos`);
 const text=await response.text();
 assert.equal(response.status,200);
 assert.doesNotMatch(text,/\[object Promise\]/,'Nested partial must render actual ToS, not Promise');
 assert.match(text,/Ketentuan dan tanggung jawab/);
 assert.match(text,/Persyaratan merchant ShopeePay/);
 assert.equal((text.match(/<details class="terms-faq-item">/g)||[]).length,8);
 assert.doesNotMatch(text,/<table\b|terms-table/);
 assert.match(text,/<summary>Apa batas penggunaan ShopeePay\?<\/summary>/);
 console.log('PASS real Express renderPage + eight native FAQ items; no table or Promise text');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
