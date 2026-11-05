import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, chmodSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const tokenOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const idOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (status, message) => {throw Object.assign(new Error(message), {status});};
function envelopeOK(value) {
  return value && typeof value==='object' && !Array.isArray(value) && typeof value.iv==='string' && /^[A-Za-z0-9_-]{16}$/.test(value.iv) && typeof value.ciphertext === 'string' && value.ciphertext.length >= 22 && value.ciphertext.length <= 16000 && /^[A-Za-z0-9_-]+$/.test(value.ciphertext);
}

export function createChatServer({databasePath = join(root, 'data/chat.sqlite')} = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), {recursive:true, mode:0o700});
  const db = new DatabaseSync(databasePath);
  if(databasePath!==':memory:')chmodSync(databasePath,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, invite_hash TEXT NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL, invite_blob TEXT);
    CREATE TABLE IF NOT EXISTS memberships(room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, device TEXT NOT NULL, role TEXT NOT NULL, profile TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY(room_id, device));
    CREATE TABLE IF NOT EXISTS removed_members(room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, device TEXT NOT NULL, PRIMARY KEY(room_id,device));
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL, sender TEXT NOT NULL, envelope TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, UNIQUE(room_id,id));
    CREATE TABLE IF NOT EXISTS message_receipts(room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL, sender TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY(room_id,id));
    INSERT OR IGNORE INTO message_receipts SELECT room_id,id,sender,seq,created_at,expires_at FROM messages;
    CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id,seq);`);
  if(!db.prepare('PRAGMA table_info(rooms)').all().some(column=>column.name==='invite_blob'))db.exec('ALTER TABLE rooms ADD COLUMN invite_blob TEXT');
  const limits = new Map();
  const json = (res, status, value) => {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}); res.end(JSON.stringify(value));};
  const transaction = callback => {db.exec('BEGIN IMMEDIATE'); try {const result=callback();db.exec('COMMIT');return result;} catch(error){db.exec('ROLLBACK');throw error;}};
  const roomFor = (id, device) => {const member=db.prepare('SELECT * FROM memberships WHERE room_id=? AND device=?').get(id,device);if(!member)fail(403,'你不是此房间的成员，或已被移除');return member;};
  const adminFor = (id,device) => {const member=roomFor(id,device);if(member.role!=='admin')fail(403,'只有管理员可以执行此操作');return member;};
  const membershipCount = device => Number(db.prepare('SELECT COUNT(*) count FROM memberships WHERE device=?').get(device).count);
  const body = async req => {let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32768)fail(413,'内容超过大小限制');chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString());if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'请求格式不正确');return value;}catch{fail(400,'请求格式不正确');}};
  const purgeExpired = () => db.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at<=?').run(Date.now());
  const expiryTimer = setInterval(purgeExpired,10000);expiryTimer.unref();
  const rate = (key,max) => {const time=Date.now();let entry=limits.get(key);if(!entry||time-entry.time>60000){entry={time,count:0};limits.set(key,entry);}if(++entry.count>max)fail(429,'操作过于频繁，请稍后重试');if(limits.size>10000)for(const [k,v] of limits)if(time-v.time>60000)limits.delete(k);};
  const securityHeaders = {
    'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
  };
  const server=http.createServer(async(req,res)=>{
    for(const [key,value] of Object.entries(securityHeaders))res.setHeader(key,value);
    try {
      const url=new URL(req.url,'http://localhost');
      if(!url.pathname.startsWith('/api/')) {
        if(req.method!=='GET'&&req.method!=='HEAD')fail(405,'请求方法不支持');
        const assets={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/crypto.js':['crypto.js','text/javascript; charset=utf-8'],'/icons.js':['icons.js','text/javascript; charset=utf-8']};
        const asset=assets[url.pathname];if(!asset)fail(404,'页面不存在');
        const data=readFileSync(join(root,'dist',asset[0]));res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:data);return;
      }
      if(url.pathname==='/api/health'&&req.method==='GET'){json(res,200,{ok:true,protocol:1});return;}
      const origin=req.headers.origin;if(origin){let originHost;try{originHost=new URL(origin).host;}catch{fail(403,'不允许跨站请求');}if(originHost!==req.headers.host)fail(403,'不允许跨站请求');}
      if(req.headers['sec-fetch-site']==='cross-site')fail(403,'不允许跨站请求');
      const token=req.headers.authorization?.replace(/^Bearer /,'');if(!tokenOK(token))fail(401,'设备凭证无效');
      const device=hash(token);rate('device:'+device,240);
      purgeExpired();
      if(url.pathname==='/api/rooms'&&req.method==='GET'){
        const rooms=db.prepare('SELECT r.id,r.metadata,m.role FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE m.device=? ORDER BY m.joined_at').all(device);json(res,200,{rooms,device});return;
      }
      if(url.pathname==='/api/rooms'&&req.method==='POST'){
        rate('admission:'+device,20);const input=await body(req);
        if(!idOK(input.id)||!tokenOK(input.invite)||!envelopeOK(input.metadata)||!envelopeOK(input.profile)||!envelopeOK(input.inviteBlob))fail(400,'房间资料不正确');
        const existing=db.prepare('SELECT r.metadata,r.invite_hash,m.role FROM rooms r LEFT JOIN memberships m ON m.room_id=r.id AND m.device=? WHERE r.id=?').get(device,input.id);if(existing){if(existing.role==='admin'&&existing.metadata===JSON.stringify(input.metadata)&&existing.invite_hash===hash(input.invite)){json(res,200,{id:input.id,role:existing.role,device});return;}fail(409,'房间已存在');}
        transaction(()=>{if(membershipCount(device)>=3)fail(409,'最多同时加入 3 个聊天室，请先退出一个');db.prepare('INSERT INTO rooms(id,invite_hash,metadata,created_at,invite_blob) VALUES(?,?,?,?,?)').run(input.id,hash(input.invite),JSON.stringify(input.metadata),Date.now(),JSON.stringify(input.inviteBlob));db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?)').run(input.id,device,'admin',JSON.stringify(input.profile),Date.now());});
        json(res,201,{id:input.id,role:'admin',device});return;
      }
      const match=url.pathname.match(new RegExp('^/api/rooms/([a-f0-9]{64})(?:/(join|sync|messages|invite|leave|members)(?:/([a-f0-9]{64}))?)?$'));
      if(!match)fail(404,'接口不存在');const [,id,action,target]=match;
      if(action==='join'&&req.method==='POST'){
        rate('admission:'+device,20);const input=await body(req);if(!tokenOK(input.invite)||!envelopeOK(input.profile))fail(400,'加入资料不正确');
        const room=db.prepare('SELECT * FROM rooms WHERE id=?').get(id);if(!room)fail(404,'密钥无效、已失效或房间不存在');
        const existing=db.prepare('SELECT role FROM memberships WHERE room_id=? AND device=?').get(id,device);if(existing){json(res,200,{id,role:existing.role,metadata:JSON.parse(room.metadata),device});return;}
        if(!timingSafeEqual(Buffer.from(room.invite_hash),Buffer.from(hash(input.invite))))fail(404,'密钥无效、已失效或房间不存在');
        if(db.prepare('SELECT 1 FROM removed_members WHERE room_id=? AND device=?').get(id,device))fail(403,'此设备已被管理员移出房间');
        transaction(()=>{if(db.prepare('SELECT 1 FROM memberships WHERE room_id=? AND device=?').get(id,device))fail(409,'这台设备已经加入此聊天室');if(membershipCount(device)>=3)fail(409,'最多同时加入 3 个聊天室，请先退出一个');if(Number(db.prepare('SELECT COUNT(*) count FROM memberships WHERE room_id=?').get(id).count)>=32)fail(409,'聊天室最多支持 32 位成员');db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?)').run(id,device,'member',JSON.stringify(input.profile),Date.now());});
        json(res,201,{id,role:'member',metadata:JSON.parse(room.metadata),device});return;
      }
      const member=roomFor(id,device);
      if(action==='sync'&&req.method==='GET'){
        const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)fail(400,'同步位置无效');
        const messages=db.prepare('SELECT seq,id,sender,envelope,created_at,expires_at FROM messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT 100').all(id,after).map(m=>({...m,envelope:JSON.parse(m.envelope)}));
        const members=db.prepare('SELECT device,role,profile FROM memberships WHERE room_id=? ORDER BY joined_at,rowid').all(id).map(m=>({...m,profile:JSON.parse(m.profile)}));
        const inviteBlob=db.prepare('SELECT invite_blob FROM rooms WHERE id=?').get(id).invite_blob;
        json(res,200,{messages,members,hasMore:messages.length===100,role:member.role,inviteBlob:inviteBlob?JSON.parse(inviteBlob):null});return;
      }
      if(action==='messages'&&req.method==='POST'){
        const input=await body(req);roomFor(id,device);if(typeof input.id!=='string'||!/^[a-f0-9-]{36}$/.test(input.id)||!envelopeOK(input.envelope)||![0,30,300,3600].includes(input.ttl))fail(400,'消息格式不正确');
        const existing=db.prepare('SELECT seq,sender,created_at,expires_at FROM message_receipts WHERE room_id=? AND id=?').get(id,input.id);if(existing){if(existing.sender!==device)fail(409,'消息标识冲突');json(res,200,existing);return;}
        if(Number(db.prepare('SELECT COUNT(*) count FROM message_receipts WHERE room_id=?').get(id).count)>=50000)fail(409,'房间累计消息已达上限，请创建新的聊天室');
        const usage=db.prepare('SELECT COUNT(*) count,COALESCE(SUM(LENGTH(envelope)),0) bytes FROM messages WHERE room_id=?').get(id);if(usage.count>=5000||usage.bytes+JSON.stringify(input.envelope).length>64000000)fail(409,'房间记录容量已满，请创建新的聊天室');
        const created=Date.now(),expires=input.ttl?created+input.ttl*1000:null;const result=transaction(()=>{const inserted=db.prepare('INSERT INTO messages(room_id,id,sender,envelope,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(id,input.id,device,JSON.stringify(input.envelope),created,expires);db.prepare('INSERT INTO message_receipts VALUES(?,?,?,?,?,?)').run(id,input.id,device,Number(inserted.lastInsertRowid),created,expires);return inserted;});
        json(res,201,{seq:Number(result.lastInsertRowid),created_at:created,expires_at:expires});return;
      }
      if(action==='invite'&&req.method==='POST'){adminFor(id,device);const input=await body(req);adminFor(id,device);if(!tokenOK(input.invite)||!envelopeOK(input.inviteBlob))fail(400,'邀请密钥格式不正确');db.prepare('UPDATE rooms SET invite_hash=?,invite_blob=? WHERE id=?').run(hash(input.invite),JSON.stringify(input.inviteBlob),id);json(res,200,{ok:true});return;}
      if(action==='members'&&target&&req.method==='DELETE'){adminFor(id,device);if(target===device)fail(400,'请使用退出房间操作');if(!db.prepare('SELECT 1 FROM memberships WHERE room_id=? AND device=?').get(id,target)&&!db.prepare('SELECT 1 FROM removed_members WHERE room_id=? AND device=?').get(id,target))fail(404,'该成员已不在房间中');transaction(()=>{db.prepare('DELETE FROM memberships WHERE room_id=? AND device=?').run(id,target);db.prepare('INSERT OR IGNORE INTO removed_members VALUES(?,?)').run(id,target);});json(res,200,{ok:true});return;}
      if(action==='leave'&&req.method==='POST'){
        transaction(()=>{db.prepare('DELETE FROM memberships WHERE room_id=? AND device=?').run(id,device);const next=db.prepare('SELECT device FROM memberships WHERE room_id=? ORDER BY joined_at,rowid LIMIT 1').get(id);if(!next)db.prepare('DELETE FROM rooms WHERE id=?').run(id);else if(member.role==='admin')db.prepare("UPDATE memberships SET role='admin' WHERE room_id=? AND device=?").run(id,next.device);});
        json(res,200,{ok:true});return;
      }
      fail(405,'请求方法不支持');
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'服务暂时无法处理请求'});else res.end();}
  });
  server.maxRequestsPerSocket=1000;server.keepAliveTimeout=5000;server.requestTimeout=15000;server.headersTimeout=10000;
  server.on('close',()=>{clearInterval(expiryTimer);db.close();});return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=createChatServer({databasePath:process.env.DATABASE_PATH||join(root,'data/chat.sqlite')});const port=Number(process.env.PORT||4173);const host=process.env.HOST||'127.0.0.1';
  server.listen(port,host,()=>console.log(`隐语已启动：http://${host}:${server.address().port}`));
  const shutdown=()=>{server.close(()=>process.exit(0));setTimeout(()=>{server.closeAllConnections();},5000).unref();};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
