import {test,expect} from '@playwright/test';
import http from 'node:http';
import https from 'node:https';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createChatServer} from '../server.mjs';

test('HTTPS reverse proxy supports secure-context encryption and independent clients',async({browser})=>{
  const directory=await mkdtemp(join(tmpdir(),'ciphera-tls-'));let backend,proxy,adminContext,guestContext;
  try{
    const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
    await promisify(execFile)(process.env.OPENSSL_PATH||'openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
    backend=createChatServer({databasePath:':memory:'});backend.listen(0,'127.0.0.1');await once(backend,'listening');
    proxy=https.createServer({key:await readFile(key),cert:await readFile(cert)},(request,response)=>{
      const upstream=http.request({hostname:'127.0.0.1',port:backend.address().port,path:request.url,method:request.method,headers:request.headers},result=>{response.writeHead(result.statusCode,result.headers);result.pipe(response);});
      upstream.on('error',()=>{response.writeHead(502);response.end();});request.pipe(upstream);
    });proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const origin=`https://127.0.0.1:${proxy.address().port}`;
    adminContext=await browser.newContext({ignoreHTTPSErrors:true});guestContext=await browser.newContext({ignoreHTTPSErrors:true});const admin=await adminContext.newPage(),guest=await guestContext.newPage();
    await admin.goto(origin);expect(await admin.evaluate(()=>isSecureContext&&!!crypto.subtle)).toBe(true);
    await admin.locator('#welcome-create').click();await admin.locator('#nickname-input').fill('管理员');await admin.locator('#room-name-input').fill('HTTPS验收');await admin.locator('#room-submit').click();await expect(admin.locator('#room-key-dialog')).toBeVisible();const invitation=await admin.locator('#room-secret').textContent();await admin.locator('#room-key-dialog [data-close-dialog]').click();
    await guest.goto(origin);await guest.locator('#welcome-join').click();await guest.locator('#nickname-input').fill('访客');await guest.locator('#room-key-input').fill(invitation);await guest.locator('#room-submit').click();await expect(guest.locator('#chat-name')).toHaveText('HTTPS验收');
    await admin.locator('#message-input').fill('通过 TLS 代理发送的加密消息');await admin.locator('#send-button').click();await expect(guest.locator('.message-text')).toHaveText('通过 TLS 代理发送的加密消息');
    await guest.locator('#message-input').fill('HTTPS 双向通信成功');await guest.locator('#send-button').click();await expect(admin.locator('#messages')).toContainText('HTTPS 双向通信成功');
  }finally{
    await adminContext?.close();await guestContext?.close();for(const server of [proxy,backend])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(directory,{recursive:true,force:true});
  }
});
