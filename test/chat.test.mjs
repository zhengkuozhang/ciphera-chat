import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {copyDatabase} from '../scripts/database.mjs';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createChatServer} from '../server.mjs';
import {newSecret,newRoomKey,roomIdFromKey,sha256Hex,encryptRoomData,decryptRoomData,fromBase64Url,toBase64Url,normalizeRoomKey} from '../dist/crypto.js';

async function fixture(t,databasePath=':memory:'){
  const server=createChatServer({databasePath});server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{if(!server.listening)return;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  async function request(token,path,{method='GET',body,headers={}}={}){
    const response=await fetch(origin+'/api'+path,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),headers:response.headers};
  }
  return {server,origin,request};
}
async function createRoom(request,token,name='测试房间'){
  const key=newRoomKey(),id=await roomIdFromKey(key),invite=newSecret(),device=await sha256Hex(token);
  const metadata=await encryptRoomData(key,`${id}:metadata`,{name});
  const profile=await encryptRoomData(key,`${id}:profile:${device}`,{nickname:'管理员'});
  const inviteBlob=await encryptRoomData(key,`${id}:invite`,{invite});
  const response=await request(token,'/rooms',{method:'POST',body:{id,invite,metadata,profile,inviteBlob}});
  return {key,id,invite,response,requestBody:{id,invite,metadata,profile,inviteBlob}};
}
async function joinRoom(request,token,room,invite=room.invite){
  const profile=await encryptRoomData(room.key,`${room.id}:profile:${await sha256Hex(token)}`,{nickname:'访客'});
  return request(token,`/rooms/${room.id}/join`,{method:'POST',body:{invite,profile}});
}

test('AES-GCM preserves Unicode and rejects wrong keys, contexts and modified ciphertext',async()=>{
  const key=newRoomKey(),payload={text:'你好，世界 👋\n第二行 <script>alert(1)</script>'};
  const envelope=await encryptRoomData(key,'room:message:id',payload);
  assert.deepEqual(await decryptRoomData(key,'room:message:id',envelope),payload);
  assert.notEqual((await encryptRoomData(key,'room:message:id',payload)).iv,envelope.iv);
  assert.ok(!JSON.stringify(envelope).includes('你好'));
  await assert.rejects(decryptRoomData(newRoomKey(),'room:message:id',envelope));
  await assert.rejects(decryptRoomData(key,'other:message:id',envelope));
  const modified=fromBase64Url(envelope.ciphertext);modified[0]^=1;
  await assert.rejects(decryptRoomData(key,'room:message:id',{...envelope,ciphertext:toBase64Url(modified)}));
  assert.throws(()=>normalizeRoomKey('CYPH-AAAA-BBBB-CCCC-DDDD'));
});

test('two independent devices create, join, exchange ciphertext and reconnect without duplicates',async t=>{
  const {request}=await fixture(t),admin=newSecret(),guest=newSecret();
  const room=await createRoom(request,admin);assert.equal(room.response.status,201);
  assert.equal((await joinRoom(request,guest,room)).status,201);
  assert.equal((await joinRoom(request,guest,room)).status,200);
  const id=randomUUID(),text='跨设备秘密消息';
  const envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text,author:'管理员'});
  const sent=await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}});assert.equal(sent.status,201);
  const retried=await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}});assert.equal(retried.status,200);assert.equal(retried.data.seq,sent.data.seq);
  const sync=await request(guest,`/rooms/${room.id}/sync`);assert.equal(sync.status,200);assert.equal(sync.data.members.length,2);assert.equal(sync.data.messages.length,1);
  assert.ok(!JSON.stringify(sync.data).includes(text));
  assert.equal((await decryptRoomData(room.key,`${room.id}:message:${id}`,sync.data.messages[0].envelope)).text,text);
  const delta=await request(guest,`/rooms/${room.id}/sync?after=${sent.data.seq}`);assert.equal(delta.data.messages.length,0);
  assert.equal((await request(guest,`/rooms/${room.id}/sync?after=-1`)).status,400);
  const guestId=randomUUID(),reply=await encryptRoomData(room.key,`${room.id}:message:${guestId}`,{text:'已收到',author:'访客'});
  assert.equal((await request(guest,`/rooms/${room.id}/messages`,{method:'POST',body:{id:guestId,envelope:reply,ttl:0}})).status,201);
  assert.equal((await request(admin,`/rooms/${room.id}/sync?after=${sent.data.seq}`)).data.messages.length,1);
});

test('wrong invitation and unauthorized room access are rejected; rotation preserves existing members',async t=>{
  const {request}=await fixture(t),admin=newSecret(),guest=newSecret(),stranger=newSecret();
  const room=await createRoom(request,admin);
  assert.equal((await joinRoom(request,guest,room,newSecret())).status,404);
  assert.equal((await request(stranger,`/rooms/${room.id}/sync`)).status,403);
  assert.equal((await request('', '/rooms')).status,401);
  assert.equal((await joinRoom(request,guest,room)).status,201);
  const invite=newSecret(),inviteBlob=await encryptRoomData(room.key,`${room.id}:invite`,{invite});
  assert.equal((await request(guest,`/rooms/${room.id}/invite`,{method:'POST',body:{invite,inviteBlob}})).status,403);
  assert.equal((await request(admin,`/rooms/${room.id}/invite`,{method:'POST',body:{invite,inviteBlob}})).status,200);
  assert.equal((await joinRoom(request,stranger,room)).status,404);
  assert.equal((await joinRoom(request,stranger,room,invite)).status,201);
  const sync=await request(guest,`/rooms/${room.id}/sync`);assert.equal(sync.status,200);
  assert.equal((await decryptRoomData(room.key,`${room.id}:invite`,sync.data.inviteBlob)).invite,invite);
});

test('server enforces a combined three-room limit and frees slots after leaving',async t=>{
  const {request}=await fixture(t),admin=newSecret(),other=newSecret();
  const rooms=[];for(let i=0;i<3;i++){rooms.push(await createRoom(request,admin));assert.equal(rooms[i].response.status,201);}
  assert.equal((await createRoom(request,admin)).response.status,409);
  const foreign=await createRoom(request,other);assert.equal((await joinRoom(request,admin,foreign)).status,409);
  assert.equal((await request(admin,`/rooms/${rooms[0].id}/leave`,{method:'POST'})).status,200);
  assert.equal((await joinRoom(request,admin,foreign)).status,201);
  assert.equal((await request(admin,'/rooms')).data.rooms.length,3);
});

test('member removal denies reads and writes; admin departure transfers control and last departure deletes room',async t=>{
  const {request}=await fixture(t),admin=newSecret(),guest=newSecret(),third=newSecret();
  const room=await createRoom(request,admin);await joinRoom(request,guest,room);await joinRoom(request,third,room);
  const guestDevice=await sha256Hex(guest);
  assert.equal((await request(third,`/rooms/${room.id}/members/${guestDevice}`,{method:'DELETE'})).status,403);
  assert.equal((await request(admin,`/rooms/${room.id}/members/${guestDevice}`,{method:'DELETE'})).status,200);
  assert.equal((await request(guest,`/rooms/${room.id}/sync`)).status,403);
  assert.equal((await joinRoom(request,guest,room)).status,403);
  const id=randomUUID(),envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text:'blocked'});
  assert.equal((await request(guest,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}})).status,403);
  assert.equal((await request(admin,`/rooms/${room.id}/leave`,{method:'POST'})).status,200);
  assert.equal((await request(third,`/rooms/${room.id}/sync`)).data.role,'admin');
  assert.equal((await request(third,`/rooms/${room.id}/leave`,{method:'POST'})).status,200);
  assert.equal((await joinRoom(request,newSecret(),room)).status,404);
});

test('message retention expires on server, malformed payloads fail and cross-site requests are blocked',async t=>{
  const {request,origin}=await fixture(t),admin=newSecret(),room=await createRoom(request,admin);
  assert.equal((await request(admin,'/rooms',{headers:{Origin:'https://untrusted.example'}})).status,403);
  assert.equal((await request(admin,'/rooms',{headers:{Origin:'null'}})).status,403);
  for(const payload of ['null','[]','"text"']){
    const response=await fetch(origin+'/api/rooms',{method:'POST',headers:{Authorization:`Bearer ${admin}`,'Content-Type':'application/json'},body:payload});
    assert.equal(response.status,400);
  }
  assert.equal((await request(admin,'/rooms',{headers:{Origin:origin}})).status,200);
  assert.equal((await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id:'bad',envelope:{},ttl:0}})).status,400);
  const id=randomUUID(),envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text:'短期消息'});
  assert.equal((await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:10}})).status,400);
  const result=await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:30}});assert.equal(result.data.expires_at-result.data.created_at,30000);
  const originalNow=Date.now;Date.now=()=>originalNow()+31000;
  try{assert.equal((await request(admin,`/rooms/${room.id}/sync`)).data.messages.length,0);}finally{Date.now=originalNow;}
});

test('database persists ciphertext without message text, room names, nicknames or raw device credentials',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ciphera-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'chat.sqlite'),{request,server}=await fixture(t,path),token=newSecret();
  const room=await createRoom(request,token,'房间保密名称');const id=randomUUID(),text='绝不能出现在数据库的明文';
  const envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{author:'保密昵称',text});
  await request(token,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}});
  const bytes=Buffer.concat(await Promise.all([readFile(path),readFile(path+'-wal')]));
  for(const secret of [text,'房间保密名称','保密昵称',token,room.key,room.invite])assert.ok(!bytes.includes(Buffer.from(secret)),`database leaked ${secret}`);
  const {request:reopened}=await fixture(t,path);assert.equal((await reopened(token,`/rooms/${room.id}/sync`)).data.messages.length,1);
});

test('static app is self-contained and applies security headers',async t=>{
  const {origin}=await fixture(t);const response=await fetch(origin);const html=await response.text();
  assert.equal(response.status,200);assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.ok(!html.includes('unpkg.com'));assert.ok(!html.includes('start-call'));assert.ok(!html.includes('security-dialog'));
  for(const path of ['/app.js','/styles.css','/crypto.js','/icons.js'])assert.equal((await fetch(origin+path)).status,200);
  assert.equal((await fetch(origin+'/server.mjs')).status,404);
});


test('expired messages cannot be resurrected by an idempotent retry',async t=>{
  const {request}=await fixture(t),admin=newSecret(),room=await createRoom(request,admin),id=randomUUID();
  const envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text:'到期后不能复活'});
  const first=await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:30}});assert.equal(first.status,201);
  const now=Date.now;Date.now=()=>now()+31000;
  try{const retry=await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}});assert.equal(retry.status,200);assert.equal(retry.data.seq,first.data.seq);assert.equal(retry.data.expires_at,first.data.expires_at);assert.equal((await request(admin,`/rooms/${room.id}/sync`)).data.messages.length,0);}finally{Date.now=now;}
});

test('paginated synchronization returns 205 ordered messages without gaps or duplicates',async t=>{
  const {request}=await fixture(t),admin=newSecret(),reader=newSecret(),room=await createRoom(request,admin);await joinRoom(request,reader,room);
  for(let i=0;i<205;i++){const id=randomUUID(),envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text:`消息 ${i}`});assert.equal((await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}})).status,201);}
  let after=0,all=[],pages=0,data;
  do{({data}=await request(reader,`/rooms/${room.id}/sync?after=${after}`));pages++;all.push(...data.messages);after=all.at(-1)?.seq||after;}while(data.hasMore);
  assert.equal(pages,3);assert.equal(all.length,205);assert.equal(new Set(all.map(m=>m.id)).size,205);assert.deepEqual(all.map(m=>m.seq),[...all.map(m=>m.seq)].sort((a,b)=>a-b));
  for(const [i,message] of all.entries())assert.equal((await decryptRoomData(room.key,`${room.id}:message:${message.id}`,message.envelope)).text,`消息 ${i}`);
});

test('membership is checked again after receiving a delayed message body',async t=>{
  const {request,origin}=await fixture(t),admin=newSecret(),guest=newSecret(),room=await createRoom(request,admin);await joinRoom(request,guest,room);
  const id=randomUUID(),envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text:'权限撤销期间上传'}),payload=JSON.stringify({id,envelope,ttl:0});
  const pending=http.request(origin+`/api/rooms/${room.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${guest}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}});
  const reply=new Promise((resolve,reject)=>{pending.on('response',response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});pending.on('error',reject);});
  pending.write(payload.slice(0,10));await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await request(admin,`/rooms/${room.id}/members/${await sha256Hex(guest)}`,{method:'DELETE'})).status,200);pending.end(payload.slice(10));assert.equal(await reply,403);assert.equal((await request(admin,`/rooms/${room.id}/sync`)).data.messages.length,0);
});

test('room member capacity is enforced and malformed envelopes are rejected',async t=>{
  const {request}=await fixture(t),admin=newSecret(),room=await createRoom(request,admin);
  for(let i=0;i<31;i++)assert.equal((await joinRoom(request,newSecret(),room)).status,201);
  assert.equal((await joinRoom(request,newSecret(),room)).status,409);
  for(const envelope of [{iv:['AAAAAAAAAAAAAAAA'],ciphertext:'A'.repeat(30)},{iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(16001)},null])assert.equal((await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id:randomUUID(),envelope,ttl:0}})).status,400);
});

test('online backup restores committed WAL data and never overwrites an existing destination',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ciphera-backup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=join(directory,'live.sqlite'),saved=join(directory,'backup.sqlite'),restored=join(directory,'restored.sqlite');const {request}=await fixture(t,source),admin=newSecret(),room=await createRoom(request,admin);
  const id=randomUUID(),envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text:'恢复后可解密'});await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}});
  await copyDatabase(source,saved);await assert.rejects(copyDatabase(source,saved),{code:'EEXIST'});await copyDatabase(saved,restored);
  const {request:recover}=await fixture(t,restored);const sync=await recover(admin,`/rooms/${room.id}/sync`);assert.equal(sync.status,200);assert.equal((await decryptRoomData(room.key,`${room.id}:message:${id}`,sync.data.messages[0].envelope)).text,'恢复后可解密');
});


test('a real service shutdown and restart restores credentials, membership and message sequence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ciphera-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'chat.sqlite');
  const first=await fixture(t,path),admin=newSecret(),guest=newSecret(),room=await createRoom(first.request,admin);await joinRoom(first.request,guest,room);
  const id=randomUUID(),envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text:'重启前消息'});const sent=await first.request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}});
  first.server.closeAllConnections();await new Promise(resolve=>first.server.close(resolve));
  const second=await fixture(t,path);const sync=await second.request(guest,`/rooms/${room.id}/sync`);assert.equal(sync.status,200);assert.equal(sync.data.messages[0].seq,sent.data.seq);assert.equal(sync.data.members.length,2);
  const retry=await second.request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}});assert.equal(retry.status,200);assert.equal(retry.data.seq,sent.data.seq);
});


test('record capacity fails clearly and request rate limits recover in the next window',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ciphera-capacity-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'chat.sqlite'),{request}=await fixture(t,path),admin=newSecret(),room=await createRoom(request,admin);
  const id=randomUUID(),envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,{text:'容量测试'}),db=new DatabaseSync(path);
  try{db.exec('BEGIN');const insert=db.prepare('INSERT INTO messages(room_id,id,sender,envelope,created_at) VALUES(?,?,?,?,?)');for(let i=0;i<5000;i++)insert.run(room.id,randomUUID(),await sha256Hex(admin),JSON.stringify(envelope),Date.now());db.exec('COMMIT');}finally{db.close();}
  const response=await request(admin,`/rooms/${room.id}/messages`,{method:'POST',body:{id,envelope,ttl:0}});assert.equal(response.status,409);assert.match(response.data.error,/容量已满/);
  const other=newSecret();for(let i=0;i<240;i++)assert.equal((await request(other,'/rooms')).status,200);assert.equal((await request(other,'/rooms')).status,429);
  const now=Date.now;Date.now=()=>now()+61000;try{assert.equal((await request(other,'/rooms')).status,200);}finally{Date.now=now;}
});


test('room creation retries are idempotent without letting another device take ownership',async t=>{
  const {request}=await fixture(t),admin=newSecret(),room=await createRoom(request,admin),other=newSecret();
  const retry=await request(admin,'/rooms',{method:'POST',body:room.requestBody});assert.equal(retry.status,200);assert.equal((await request(admin,'/rooms')).data.rooms.length,1);
  assert.equal((await request(other,'/rooms',{method:'POST',body:room.requestBody})).status,409);
  assert.equal((await joinRoom(request,other,room)).status,201);assert.equal((await joinRoom(request,other,room)).status,200);assert.equal((await request(admin,`/rooms/${room.id}/sync`)).data.members.length,2);
});


test('administrator transfer respects join order even when timestamps are identical',async t=>{
  const {request}=await fixture(t),admin=newSecret(),devices=[newSecret(),newSecret()];
  if(await sha256Hex(devices[0])<await sha256Hex(devices[1]))devices.reverse();
  const now=Date.now,frozen=now();Date.now=()=>frozen;
  try{const room=await createRoom(request,admin);await joinRoom(request,devices[0],room);await joinRoom(request,devices[1],room);assert.equal((await request(admin,`/rooms/${room.id}/members/${'f'.repeat(64)}`,{method:'DELETE'})).status,404);await request(admin,`/rooms/${room.id}/leave`,{method:'POST'});assert.equal((await request(devices[0],`/rooms/${room.id}/sync`)).data.role,'admin');assert.equal((await request(devices[1],`/rooms/${room.id}/sync`)).data.role,'member');}finally{Date.now=now;}
});
