import {test,expect} from '@playwright/test';

async function createRoom(page,name='端到端测试房间'){
  await page.goto('/');
  await page.getByRole('button',{name:'创建聊天室',exact:true}).click();
  await page.locator('#nickname-input').fill('管理员甲');
  await page.locator('#room-name-input').fill(name);
  await page.locator('#room-submit').click();
  await expect(page.locator('#room-key-dialog')).toBeVisible();
  const invitation=await page.locator('#room-secret').textContent();
  await page.locator('#room-key-dialog [data-close-dialog]').click();
  return invitation;
}
async function joinRoom(page,invitation){
  await page.goto('/');
  await page.getByRole('button',{name:'使用密钥加入',exact:true}).click();
  await page.locator('#nickname-input').fill('成员乙');
  await page.locator('#room-key-input').fill(invitation);
  await page.locator('#room-submit').click();
  await expect(page.locator('#room-form-dialog')).not.toBeVisible();
}

test('independent browser sessions exchange messages, survive reload and display safe text',async({browser,page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const invitation=await createRoom(page);
  const guestContext=await browser.newContext();const guest=await guestContext.newPage();guest.on('pageerror',error=>errors.push(error.message));
  try{
    await joinRoom(guest,invitation);
    await expect(guest.locator('#chat-name')).toHaveText('端到端测试房间');
    await page.locator('#message-input').fill('你好，跨浏览器测试 👋');await page.locator('#send-button').click();
    await expect(guest.locator('#messages')).toContainText('你好，跨浏览器测试 👋');
    await guest.locator('#message-input').fill('<img src=x onerror=alert(1)>');await guest.locator('#send-button').click();
    await expect(page.locator('#messages')).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.locator('#messages img')).toHaveCount(0);
    await page.reload();await expect(page.locator('#messages')).toContainText('你好，跨浏览器测试 👋');
    await expect(page.locator('#vault-status')).toHaveText('聊天服务已连接');
    await page.locator('#details-toggle').click();await expect(page.locator('#member-list')).toContainText('成员乙');
    await expect(page.locator('#detail-handle')).toContainText('2 位成员');
    await page.locator('#details-toggle').click();await page.locator('#chat-search').click();
    await page.locator('#message-search-input').fill('跨浏览器');await expect(page.locator('#message-search-count')).toHaveText('1 / 1');
    await expect(page.locator('#messages mark')).toHaveText('跨浏览器');await page.locator('#search-close').click();
    expect(errors).toEqual([]);
  }finally{await guestContext.close();}
});

test('wrong invitations show an error and do not create a room',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'使用密钥加入',exact:true}).click();
  await page.locator('#nickname-input').fill('测试者');await page.locator('#room-key-input').fill('CYPH-AAAA-BBBB-CCCC-DDDD');await page.locator('#room-submit').click();
  await expect(page.locator('#toast-region')).toContainText('密钥格式不正确');
  await expect(page.locator('#room-count')).toContainText('0 / 3');
});

test('layout fills desktop and mobile viewports without horizontal overflow',async({page},testInfo)=>{
  await createRoom(page,'布局测试');
  await page.locator('#message-input').fill('这是新版页面的实际消息。文字、输入框和操作按钮更清晰，也支持多行消息。');await page.locator('#send-button').click();
  await expect(page.locator('.message-bubble')).toHaveCSS('font-size','18px');
  await page.screenshot({path:testInfo.outputPath('desktop.png')});
  const dimensions=await page.evaluate(()=>{const app=document.querySelector('#app').getBoundingClientRect();const composer=document.querySelector('.composer').getBoundingClientRect();return {appBottom:app.bottom,height:innerHeight,composerBottom:composer.bottom,scroll:document.documentElement.scrollWidth,width:innerWidth};});
  expect(dimensions.appBottom).toBe(dimensions.height);expect(dimensions.composerBottom).toBeLessThan(dimensions.height);expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  await page.setViewportSize({width:390,height:844});await expect(page.locator('#mobile-back')).toBeVisible();
  const mobile=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,composer:document.querySelector('.composer').getBoundingClientRect().bottom,height:innerHeight}));
  expect(mobile.scroll).toBeLessThanOrEqual(mobile.width);expect(mobile.composer).toBeLessThan(mobile.height);
  await page.screenshot({path:testInfo.outputPath('mobile.png')});
  await page.setViewportSize({width:320,height:568});await page.locator('#details-toggle').click();await expect(page.locator('#details-close')).toBeInViewport();await page.locator('#details-close').click();
  await page.locator('#chat-search').click();await expect(page.locator('#message-search-input')).toBeInViewport();await page.locator('#search-close').click();
  await page.locator('#mobile-back').click();await expect(page.locator('#new-chat')).toBeVisible();
});

test('send failures can retry the same message without duplication',async({page})=>{
  await createRoom(page);
  await page.route('**/api/rooms/*/messages',route=>route.abort());
  await page.locator('#message-input').fill('请保留这条未发送消息');await page.locator('#send-button').click();
  await expect(page.locator('#messages')).toContainText('发送失败');await expect(page.locator('.retry-message')).toBeVisible();
  await page.unroute('**/api/rooms/*/messages');await page.locator('.retry-message').click();
  await expect(page.locator('.retry-message')).toHaveCount(0);await expect(page.locator('.message-text')).toHaveCount(1);
});

 test('drafts survive reload and clearing history survives synchronization',async({page})=>{
  await createRoom(page);await page.locator('#message-input').fill('尚未发送的草稿');
  await expect.poll(()=>page.evaluate(async()=>{const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(localStorage.getItem('ciphera-device-key')),c=>c.charCodeAt(0)),'AES-GCM',false,['decrypt']);const data=JSON.parse(localStorage.getItem('ciphera-rooms-v2'));return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(data.iv)},key,new Uint8Array(data.body)));})).toContain('尚未发送的草稿');
  await page.reload();await expect(page.locator('#message-input')).toHaveValue('尚未发送的草稿');
  await page.locator('#send-button').click();await expect(page.locator('#messages')).toContainText('尚未发送的草稿');
  await page.locator('#details-toggle').click();await page.locator('#clear-history').click();await page.locator('#confirm-submit').click();
  await expect(page.locator('.message-text')).toHaveCount(0);await page.reload();await expect(page.locator('#vault-status')).toHaveText('聊天服务已连接');await expect(page.locator('.message-text')).toHaveCount(0);
 });

test('retry after a lost acknowledgement keeps one server message',async({page,browser})=>{
  const invitation=await createRoom(page);const context=await browser.newContext();const guest=await context.newPage();
  try{
    await joinRoom(guest,invitation);
    await page.route('**/api/rooms/*/messages',async route=>{await route.fetch();await route.abort();});
    await page.locator('#message-input').fill('回执丢失测试');await page.locator('#send-button').click();
    await expect(page.locator('.retry-message')).toBeVisible();await page.unroute('**/api/rooms/*/messages');await page.locator('.retry-message').click();
    await expect(page.locator('.retry-message')).toHaveCount(0);await expect(guest.locator('.message-text')).toHaveText(['回执丢失测试']);
    await page.reload();await expect(page.locator('#vault-status')).toHaveText('聊天服务已连接');await expect(page.locator('.message-text')).toHaveText(['回执丢失测试']);
  }finally{await context.close();}
});

test('retention is explicit, persists per room and applies to outgoing messages',async({page},testInfo)=>{
  await createRoom(page,'定时消息');await page.locator('#timer-button').click();
  await page.getByLabel('5 分钟',{exact:true}).check();await page.screenshot({path:testInfo.outputPath('retention.png')});await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await expect(page.locator('#expiry-status')).toHaveText('发送后 5 分钟删除');await page.reload();
  await expect(page.locator('#expiry-status')).toHaveText('发送后 5 分钟删除');
  const sent=page.waitForRequest(request=>request.url().endsWith('/messages')&&request.method()==='POST');
  await page.locator('#message-input').fill('定时消息测试');await page.locator('#send-button').click();expect((await sent).postDataJSON().ttl).toBe(300);
  await expect(page.locator('.message-meta')).toContainText('定时删除');
  await page.locator('#new-chat').click();await page.locator('#choose-create').click();await page.locator('#nickname-input').fill('甲');await page.locator('#room-name-input').fill('另一房间');await page.locator('#room-submit').click();await expect(page.locator('#room-key-dialog')).toBeVisible();await page.locator('#room-key-dialog [data-close-dialog]').click();
  await expect(page.locator('#expiry-status')).toHaveText('不自动删除');await page.locator('.conversation[data-id]').filter({hasText:'定时消息'}).click();await expect(page.locator('#expiry-status')).toHaveText('发送后 5 分钟删除');
});

test('idle synchronization preserves message nodes and disconnected state is visible',async({page})=>{
  await createRoom(page);await page.locator('#message-input').fill('可选择并复制的文字');await page.locator('#send-button').click();await expect(page.locator('.message-meta')).not.toContainText('待发送');
  await page.locator('.message-text').evaluate(node=>node.dataset.preserved='yes');await page.locator('.conversation[data-id]').evaluate(node=>node.dataset.preserved='yes');
  await page.waitForResponse(response=>response.url().includes('/sync?after='));
  await expect(page.locator('.message-text')).toHaveAttribute('data-preserved','yes');await expect(page.locator('.conversation[data-id]')).toHaveAttribute('data-preserved','yes');
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await expect(page.locator('#connection-banner')).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('#connection-banner')).toBeHidden();
});

test('destructive confirmation cancels safely and leaving the last room resets the interface',async({page},testInfo)=>{
  await createRoom(page,'退出测试');await page.locator('#message-input').fill('保留的消息');await page.locator('#send-button').click();await expect(page.locator('.message-meta')).not.toContainText('待发送');
  await page.locator('#details-toggle').click();await page.locator('#clear-history').click();await expect(page.locator('#confirm-dialog')).toBeVisible();await expect(page.getByRole('button',{name:'取消',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.locator('.message-text')).toHaveText('保留的消息');
  await page.locator('#leave-room').click();await expect(page.locator('#confirm-description')).toContainText('最后一名成员');await page.setViewportSize({width:320,height:568});await expect(page.locator('#confirm-submit')).toBeInViewport();await page.screenshot({path:testInfo.outputPath('confirm-mobile.png')});
  await page.locator('#confirm-submit').click();await expect(page.locator('#room-count')).toContainText('0 / 3');await expect(page.locator('#message-input')).toBeDisabled();await expect(page.locator('#chat-search')).toBeDisabled();await expect(page.locator('#details-toggle')).toBeDisabled();
  await page.reload();await expect(page.locator('#welcome-dialog')).toBeVisible();await expect(page.locator('#room-count')).toContainText('0 / 3');
});

test('administrator departure transfers control and removal blocks the former member',async({page,browser})=>{
  const invitation=await createRoom(page,'权限交接');const context=await browser.newContext();const guest=await context.newPage();
  try{
    await joinRoom(guest,invitation);await page.locator('#details-toggle').click();await expect(page.locator('#member-list')).toContainText('成员乙');
    await page.locator('#leave-room').click();await page.locator('#confirm-submit').click();await expect(guest.locator('#security-status')).toContainText('管理员');
    await page.getByRole('button',{name:'新建会话',exact:true}).click();await page.locator('#choose-join').click();await page.locator('#nickname-input').fill('再次加入的甲');await page.locator('#room-key-input').fill(invitation);await page.locator('#room-submit').click();await expect(page.locator('#room-form-dialog')).not.toBeVisible();
    await guest.locator('#details-toggle').click();await expect(guest.locator('#member-list')).toContainText('再次加入的甲');await guest.locator('.remove-member').click();await guest.locator('#confirm-submit').click();
    await expect(page.locator('#security-status')).toContainText('已被移出房间');await expect(page.locator('#message-input')).toBeDisabled();await page.locator('#details-toggle').click();await expect(page.locator('#manage-room')).toBeDisabled();
  }finally{await context.close();}
});

test('invitation rotation requires confirmation and closing the dialog clears its text',async({page})=>{
  const original=await createRoom(page);await expect(page.locator('#room-secret')).toHaveText('');
  await page.locator('#security-status').click();await page.locator('#rotate-key').click();await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('#room-secret')).toHaveText(original);
  await page.locator('#rotate-key').click();await page.locator('#confirm-submit').click();await expect(page.locator('#room-secret')).not.toHaveText(original);await expect(page.locator('#room-secret')).toHaveText(/^CYPH-.*\..+$/);
  await page.locator('#room-key-dialog [data-close-dialog]').click();await expect(page.locator('#room-secret')).toHaveText('');
});

test('a second tab cannot overwrite drafts and can resume after the first closes',async({page,context})=>{
  await createRoom(page);await page.locator('#message-input').fill('原窗口的草稿');
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('ciphera-rooms-v2'))).not.toBeNull();
  const second=await context.newPage();await second.goto('/');await expect(second.locator('#workspace-busy-dialog')).toBeVisible();
  await second.keyboard.press('Escape');await expect(second.locator('#workspace-busy-dialog')).toBeVisible();
  await expect.poll(()=>page.evaluate(async()=>{const raw=localStorage.getItem('ciphera-device-key');const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(raw),c=>c.charCodeAt(0)),'AES-GCM',false,['decrypt']);const saved=JSON.parse(localStorage.getItem('ciphera-rooms-v2'));return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(saved.iv)},key,new Uint8Array(saved.body)));})).toContain('原窗口的草稿');
  await page.close();await second.locator('#retry-workspace').click();await expect(second.locator('#message-input')).toHaveValue('原窗口的草稿');await expect(second.locator('#vault-status')).toHaveText('聊天服务已连接');
});

test('unreadable local storage stops startup without replacing the original record',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('ciphera-rooms-v2','broken-record'));await page.goto('/');
  await expect(page.locator('#startup-error-dialog')).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('ciphera-rooms-v2'))).toBe('broken-record');
});

 test('messages are grouped by date, copy exactly and keep the reading position',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);await createRoom(page);const content='第一行\n第二行 <安全文字>';
  await page.locator('#message-input').fill(content);await page.locator('#send-button').click();await expect(page.locator('.message-meta')).not.toContainText('待发送');await expect(page.locator('.day-divider')).toHaveText('今天');await page.locator('.copy-message').click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(content);
  // Fill the scroll area using real sends so the navigation is tested against actual message rendering.
  for(let i=0;i<12;i++){await page.locator('#message-input').fill(`第 ${i+1} 条\n多行记录\n用于阅读测试`);await page.locator('#send-button').click();}
  await expect(page.locator('.message-text')).toHaveCount(13);await expect(page.locator('#messages')).not.toContainText('待发送');await page.locator('#messages').evaluate(node=>node.scrollTop=0);await expect(page.locator('#latest-messages')).toBeVisible();
  const position=await page.locator('#messages').evaluate(node=>node.scrollTop);await page.waitForResponse(response=>response.url().includes('/sync?after='));expect(await page.locator('#messages').evaluate(node=>node.scrollTop)).toBe(position);
  await page.locator('#latest-messages').click();await expect(page.locator('#latest-messages')).toBeHidden();await expect(page.locator('.day-divider')).toHaveCount(1);
 });

 test('composer handles whitespace and multiline input and dark theme restores',async({page},testInfo)=>{
  await createRoom(page,'深色界面验证');await expect(page.locator('#send-button')).toBeDisabled();await page.locator('#message-input').fill('   ');await expect(page.locator('#send-button')).toBeDisabled();
  await page.locator('#message-input').fill('第一行');await page.locator('#message-input').press('Shift+Enter');await page.locator('#message-input').pressSequentially('第二行');await expect(page.locator('.message-text')).toHaveCount(0);await page.locator('#message-input').press('Enter');await expect(page.locator('.message-text')).toHaveText('第一行\n第二行');
  await page.locator('#theme-toggle').click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.screenshot({path:testInfo.outputPath('dark-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('.conversation[data-id]').click();await expect(page.locator('#theme-toggle')).toBeVisible();await expect.poll(()=>page.locator('.chat-panel').evaluate(node=>Math.round(node.getBoundingClientRect().left))).toBe(0);await page.screenshot({path:testInfo.outputPath('dark-mobile.png')});
 });


test('storage quota errors remain visible and recover without deleting the previous snapshot',async({page})=>{
  await createRoom(page);const saved=await page.evaluate(()=>localStorage.getItem('ciphera-rooms-v2'));
  await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='ciphera-rooms-v2')throw new DOMException('full','QuotaExceededError');return window.originalSetItem.call(this,key,value);};});
  await page.locator('#message-input').fill('空间不足时的草稿');await expect(page.locator('#storage-warning')).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('ciphera-rooms-v2'))).toBe(saved);
  await page.evaluate(()=>Storage.prototype.setItem=window.originalSetItem);await page.locator('#message-input').fill('空间恢复后的草稿');await expect(page.locator('#storage-warning')).toBeHidden();await page.reload();await expect(page.locator('#message-input')).toHaveValue('空间恢复后的草稿');
});

test('delayed acknowledgements preserve the server order and maximum-length Unicode messages',async({page})=>{
  await createRoom(page);let first=true;
  await page.route('**/api/rooms/*/messages',async route=>{const response=await route.fetch();if(first){first=false;await new Promise(resolve=>setTimeout(resolve,700));}await route.fulfill({response});});
  await page.locator('#message-input').fill('先发送的消息');await page.locator('#send-button').click();await page.locator('#message-input').fill('后发送的消息');await page.locator('#send-button').click();
  await expect(page.locator('#messages')).not.toContainText('待发送');await expect(page.locator('.message-text')).toHaveText(['先发送的消息','后发送的消息']);
  await page.unroute('**/api/rooms/*/messages');const content='汉'.repeat(2000);await page.locator('#message-input').fill(content);await page.locator('#send-button').click();await expect(page.locator('#messages')).not.toContainText('待发送');await expect(page.locator('.message-text').last()).toHaveText(content);
  await page.reload();await expect(page.locator('.message-text')).toHaveText(['先发送的消息','后发送的消息',content]);
});


test('lost room creation acknowledgement restores the original room after reload',async({page})=>{
  await page.goto('/');await page.route('**/api/rooms',async route=>{if(route.request().method()==='POST'){await route.fetch();await route.abort();}else await route.continue();});
  await page.locator('#welcome-create').click();await page.locator('#nickname-input').fill('甲');await page.locator('#room-name-input').fill('回执恢复房间');await page.locator('#room-submit').click();await expect(page.locator('#admission-recovery-dialog')).toBeVisible();
  await page.unroute('**/api/rooms');await page.reload();await expect(page.locator('#room-key-dialog')).toBeVisible();await page.locator('#room-key-dialog [data-close-dialog]').click();await expect(page.locator('#chat-name')).toHaveText('回执恢复房间');await expect(page.locator('#welcome-dialog')).toBeHidden();await expect(page.locator('#room-count')).toContainText('1 / 3');
  const count=await page.evaluate(async()=>{const response=await fetch('/api/rooms',{headers:{Authorization:'Bearer '+localStorage.getItem('ciphera-device-token')}});return (await response.json()).rooms.length;});expect(count).toBe(1);
});

test('lost join acknowledgement can be retried without duplicate memberships',async({page,browser})=>{
  const invitation=await createRoom(page),context=await browser.newContext(),guest=await context.newPage();
  try{await guest.route('**/api/rooms/*/join',async route=>{await route.fetch();await route.abort();});await joinRoom(guest,invitation);await expect(guest.locator('#admission-recovery-dialog')).toBeVisible();await guest.unroute('**/api/rooms/*/join');await guest.reload();await expect(guest.locator('#chat-name')).toHaveText('端到端测试房间');await expect(guest.locator('#room-count')).toContainText('1 / 3');await guest.locator('#details-toggle').click();await expect(guest.locator('#detail-handle')).toContainText('2 位成员');}finally{await context.close();}
});

test('room requests are not sent when the browser cannot save their recovery keys',async({page})=>{
  await page.goto('/');await expect(page.locator('#welcome-dialog')).toBeVisible();let requests=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/rooms'))requests++;});
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='ciphera-rooms-v2')throw new DOMException('full','QuotaExceededError');return original.call(this,key,value);};});
  await page.locator('#welcome-create').click();await page.locator('#nickname-input').fill('甲');await page.locator('#room-submit').click();await expect(page.locator('#toast-region')).toContainText('尚未提交房间请求');expect(requests).toBe(0);await expect(page.locator('#room-form-dialog')).toBeVisible();
});

test('local expiry still removes messages when synchronization is unavailable',async({page})=>{
  await createRoom(page);await page.locator('#timer-button').click();await page.getByLabel('30 秒',{exact:true}).check();await page.locator('#expiry-form button[type=submit]').click();await page.locator('#message-input').fill('离线也应消失');await page.locator('#send-button').click();await expect(page.locator('.message-meta')).toContainText('定时删除');
  await page.route('**/api/**',route=>route.abort());await page.clock.install();await page.clock.fastForward(31000);await expect(page.locator('.message-text')).toHaveCount(0);await expect(page.locator('.conversation[data-id]')).not.toContainText('离线也应消失');
});

test('clearing a message with a lost acknowledgement does not resurrect it on sync',async({page})=>{
  await createRoom(page);await page.route('**/api/rooms/*/sync?*',route=>route.abort());await page.route('**/api/rooms/*/messages',async route=>{await route.fetch();await route.abort();});
  await page.locator('#message-input').fill('清空后的未知回执消息');await page.locator('#send-button').click();await expect(page.locator('.retry-message')).toBeVisible();await page.locator('#details-toggle').click();await page.locator('#clear-history').click();await page.locator('#confirm-submit').click();await expect(page.locator('.message-text')).toHaveCount(0);
  await page.unroute('**/api/rooms/*/sync?*');await page.unroute('**/api/rooms/*/messages');await page.reload();await expect(page.locator('#vault-status')).toHaveText('聊天服务已连接');await expect(page.locator('.message-text')).toHaveCount(0);
});

test('encrypted null payload does not stop synchronization of the next message',async({page})=>{
  await createRoom(page);
  await page.evaluate(async()=>{const {encryptRoomData}=await import('/crypto.js'),raw=localStorage.getItem('ciphera-device-key'),key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(raw),c=>c.charCodeAt(0)),'AES-GCM',false,['decrypt']);const saved=JSON.parse(localStorage.getItem('ciphera-rooms-v2')),data=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(saved.iv)},key,new Uint8Array(saved.body)))),room=data.rooms[0];
    for(const value of [null,{text:'异常消息之后仍应同步',author:'甲'}]){const id=crypto.randomUUID(),envelope=await encryptRoomData(room.key,`${room.id}:message:${id}`,value);await fetch(`/api/rooms/${room.id}/messages`,{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('ciphera-device-token'),'Content-Type':'application/json'},body:JSON.stringify({id,envelope,ttl:0})});}
  });await expect(page.locator('.message-text')).toHaveText(['消息内容无效','异常消息之后仍应同步']);await expect(page.locator('#vault-status')).toHaveText('聊天服务已连接');
});


test('denied browser storage produces a recoverable startup screen instead of a blank app',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>{Storage.prototype.getItem=function(){throw new DOMException('denied','SecurityError');};});await page.goto('/');await expect(page.locator('#startup-error-dialog')).toBeVisible();await expect(page.locator('#retry-startup')).toBeVisible();expect(errors).toEqual([]);
});


test('missing local keys or credentials never silently replace an existing identity',async({page})=>{
  await createRoom(page);
  await page.addInitScript(()=>{window.expectedSnapshot=localStorage.getItem('ciphera-rooms-v2');localStorage.removeItem('ciphera-device-token');});await page.reload();await expect(page.locator('#startup-error-description')).toContainText('身份凭证缺失');expect(await page.evaluate(()=>localStorage.getItem('ciphera-device-token'))).toBeNull();expect(await page.evaluate(()=>localStorage.getItem('ciphera-rooms-v2')===window.expectedSnapshot)).toBe(true);
  await page.addInitScript(()=>localStorage.removeItem('ciphera-device-key'));await page.reload();await expect(page.locator('#startup-error-description')).toContainText('加密密钥缺失');expect(await page.evaluate(()=>localStorage.getItem('ciphera-device-key'))).toBeNull();expect(await page.evaluate(()=>localStorage.getItem('ciphera-rooms-v2')===window.expectedSnapshot)).toBe(true);
});

test('clearing while a send is in flight waits for it and temporarily disables the composer',async({page})=>{
  await createRoom(page);let release;const gate=new Promise(resolve=>release=resolve);let received;const uploaded=new Promise(resolve=>received=resolve);
  await page.route('**/api/rooms/*/messages',async route=>{const response=await route.fetch();received();await gate;await route.fulfill({response});});
  await page.locator('#message-input').fill('清空期间尚在发送');await page.locator('#send-button').click();await uploaded;await page.locator('#details-toggle').click();await page.locator('#clear-history').click();await page.locator('#confirm-submit').click();await expect(page.locator('#message-input')).toBeDisabled();release();await expect(page.locator('.message-text')).toHaveCount(0);await expect(page.locator('#message-input')).toBeEnabled();await page.reload();await expect(page.locator('#vault-status')).toHaveText('聊天服务已连接');await expect(page.locator('.message-text')).toHaveCount(0);
});
