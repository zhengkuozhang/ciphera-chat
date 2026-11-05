import {newRoomKey,newSecret,normalizeRoomKey,roomIdFromKey,encryptRoomData,decryptRoomData,sha256Hex} from './crypto.js';
import {refreshIcons} from './icons.js';

const MAX_ROOMS=3, $=selector=>document.querySelector(selector), $$=selector=>[...document.querySelectorAll(selector)];
const enc=new TextEncoder(),dec=new TextDecoder();
const state={rooms:[],activeId:null,filter:'all',formMode:'create',theme:'light',online:false,deviceHash:null};
let vaultKey,deviceToken,persistQueue=Promise.resolve(),syncBusy=false,lastRenderedRoom=null,lastMessageSignature=null;
const drafts=new Map(),roomSyncs=new Map(),roomSends=new Map(),roomActions=new Set();
let lastRoomListMarkup=null,lastMemberSignature=null;
let draftTimer,pendingAdmission=null,admissionBusy=false;
try{state.theme=localStorage.getItem('ciphera-theme')==='dark'?'dark':'light';}catch{}
let searchIndex=0;
const escapeHTML=(value='')=>String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const icon=(name)=>`<i data-lucide="${name}"></i>`;
const active=()=>state.rooms.find(room=>room.id===state.activeId);
const time=value=>new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const dateLabel=value=>{const date=new Date(value),today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);return date.toDateString()===today.toDateString()?'今天':date.toDateString()===yesterday.toDateString()?'昨天':new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric'}).format(date);};
function updateLatestButton(){const viewport=$('#messages');$('#latest-messages').classList.toggle('hidden',!active()||viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop<80);}
function toast(message){const el=document.createElement('div');el.className='toast';el.innerHTML=`${icon('shield-check')}<span>${escapeHTML(message)}</span>`;$('#toast-region').append(el);refreshIcons();setTimeout(()=>el.remove(),4000);}
function errorText(error){return error.message==='Failed to fetch'?'无法连接聊天服务，请检查网络':error.message;}

async function initVault(){
  let raw=localStorage.getItem('ciphera-device-key');if(!raw&&localStorage.getItem('ciphera-rooms-v2'))throw new Error('本机加密密钥缺失，已停止写入并保留原记录');if(!raw){const bytes=crypto.getRandomValues(new Uint8Array(32));raw=btoa(String.fromCharCode(...bytes));localStorage.setItem('ciphera-device-key',raw);}
  vaultKey=await crypto.subtle.importKey('raw',Uint8Array.from(atob(raw),c=>c.charCodeAt(0)),'AES-GCM',false,['encrypt','decrypt']);
  const stored=localStorage.getItem('ciphera-rooms-v2');if(stored){try{const payload=JSON.parse(stored);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(payload.iv)},vaultKey,new Uint8Array(payload.body));const data=JSON.parse(dec.decode(plain));state.rooms=(data.rooms||[]).map(room=>({...room,legacy:!room.protocol,messages:(room.messages||[]).map(message=>message.pending?{...message,pending:false,failed:true,sending:false}:message),membersList:room.membersList||[]}));pendingAdmission=data.pendingAdmission||null;state.activeId=state.rooms.some(room=>room.id===data.activeId)?data.activeId:state.rooms[0]?.id||null;for(const room of state.rooms)if(room.draft)drafts.set(room.id,room.draft);}catch{throw new Error('本机记录无法读取，已停止写入以保留原数据');}}
  deviceToken=localStorage.getItem('ciphera-device-token');if(!deviceToken&&(state.rooms.length||pendingAdmission))throw new Error('本机身份凭证缺失，已停止写入并保留原记录');if(!deviceToken){deviceToken=newSecret();localStorage.setItem('ciphera-device-token',deviceToken);}if(!/^[A-Za-z0-9_-]{43}$/.test(deviceToken))throw new Error('本机身份凭证无法读取，已保留原数据');state.deviceHash=await sha256Hex(deviceToken);
}
let storageWarningShown=false;
function persist(){const snapshot=JSON.stringify({rooms:state.rooms.map(room=>({...room,draft:drafts.get(room.id)||''})),activeId:state.activeId,pendingAdmission});persistQueue=persistQueue.then(async()=>{const iv=crypto.getRandomValues(new Uint8Array(12));const body=await crypto.subtle.encrypt({name:'AES-GCM',iv},vaultKey,enc.encode(snapshot));localStorage.setItem('ciphera-rooms-v2',JSON.stringify({iv:[...iv],body:[...new Uint8Array(body)]}));storageWarningShown=false;$('#storage-warning').classList.add('hidden');return true;}).catch(()=>{$('#storage-warning').classList.remove('hidden');if(!storageWarningShown)toast('本机保存失败，请保留此窗口并检查浏览器存储空间');storageWarningShown=true;return false;});return persistQueue;}
async function api(path,{method='GET',body}={}){
  let response;try{response=await fetch('/api'+path,{method,headers:{Authorization:`Bearer ${deviceToken}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(12000)});}catch{throw new Error('无法连接聊天服务，请检查网络');}
  const type=response.headers.get('content-type')||'';if(!type.includes('application/json'))throw new Error('此地址尚未接入聊天服务');
  let data;try{data=await response.json();}catch{throw new Error('聊天服务返回了无法读取的数据');}
  if(!response.ok){const error=new Error(data.error||'聊天服务暂时不可用');error.status=response.status;throw error;}return data;
}
function setOnline(online){state.online=online;$('#connection-banner').classList.toggle('hidden',online||!state.rooms.length);$('#vault-status').textContent=online?'聊天服务已连接':'聊天服务未连接';}
function parseInvitation(text){const normalized=text.trim().replace(/\s/g,'');const match=normalized.match(/^(CYPH-[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/);if(!match)throw new Error('密钥格式不正确，请完整粘贴管理员分享的密钥');return {key:normalizeRoomKey(match[1]),invite:match[2]};}
function roomPreview(room){const last=room.messages.filter(m=>!m.expiresAt||m.expiresAt>Date.now()).sort((a,b)=>a.seq&&b.seq?a.seq-b.seq:a.seq?-1:b.seq?1:a.createdAt-b.createdAt).at(-1);return last?.text||last?.error|| (room.legacy?'旧版本机记录':'还没有消息');}
function renderRooms(){
  const q=$('#search-input').value.trim().toLowerCase();const rows=state.rooms.filter(room=>(state.filter==='all'||room.role===state.filter)&&(!q||room.name.toLowerCase().includes(q)||room.messages.some(m=>(!m.expiresAt||m.expiresAt>Date.now())&&m.text?.toLowerCase().includes(q))));
  const markup=rows.map(room=>`<button class="conversation ${room.id===state.activeId?'active':''}" data-id="${escapeHTML(room.id)}"><div class="avatar">${icon('users')}</div><div class="conversation-main"><div class="conversation-line"><strong>${escapeHTML(room.name)} <span class="room-role">${room.legacy?'旧版':room.role==='admin'?'管理员':'成员'}</span></strong><time>${escapeHTML(room.updated||'')}</time></div><p>${escapeHTML(roomPreview(room))}</p></div>${room.unread?`<span class="unread-dot">${room.unread}</span>`:''}</button>`).join('')+(!rows.length?`<p class="room-empty">${q?'没有找到匹配的聊天室或消息':state.filter==='admin'?'还没有你管理的聊天室':state.filter==='member'?'还没有通过密钥加入的聊天室':'创建或加入，开始第一段对话'}</p>`:'')+(state.rooms.length<MAX_ROOMS?`<button class="conversation slot-empty" id="empty-slot"><div class="avatar">${icon('plus')}</div><div class="conversation-main"><strong>创建或加入聊天室</strong><p>还可以加入 ${MAX_ROOMS-state.rooms.length} 个聊天室</p></div></button>`:'');
  $('#room-count').textContent=`已加入 ${state.rooms.length} / ${MAX_ROOMS} 个聊天室`;if(markup!==lastRoomListMarkup){lastRoomListMarkup=markup;$('#conversation-list').innerHTML=markup;$$('.conversation[data-id]').forEach(button=>button.onclick=()=>openRoom(button.dataset.id));$('#empty-slot')?.addEventListener('click',showEntry);refreshIcons();}
}
function renderMembers(room){
  const members=room.membersList||[],signature=JSON.stringify([room.id,room.role,room.removed,members]);if(signature===lastMemberSignature)return;lastMemberSignature=signature;$('#member-list').innerHTML=members.length?members.map(member=>`<div class="member-row"><div class="member-avatar">${icon('users')}</div><div><strong>${escapeHTML(member.nickname||'未命名成员')}</strong><small>${member.role==='admin'?'管理员':'成员'}${member.device===state.deviceHash?' · 我':''}</small></div>${room.role==='admin'&&!room.removed&&member.device!==state.deviceHash?`<button class="remove-member" data-member="${member.device}">移除</button>`:''}</div>`).join(''):'<p class="member-empty">暂无成员信息</p>';
  $$('.remove-member').forEach(button=>button.onclick=()=>removeMember(button.dataset.member));
}
function renderChat(){
  const viewport=$('#messages'),oldScroll=viewport.scrollTop,nearBottom=viewport.scrollHeight-viewport.clientHeight-oldScroll<80;
  const room=active();for(const id of ['chat-search','details-toggle'])$('#'+id).disabled=!room;$('#security-status').disabled=!room||room.legacy||room.removed;
  $('#message-input').disabled=!room||room.legacy||room.removed||roomActions.has(room.id);updateSendButton();$('#timer-button').disabled=!room||room.legacy||room.removed;
  if(!room){$('#latest-messages').classList.add('hidden');$('#connection-banner').classList.add('hidden');$('#expiry-status').textContent='不自动删除';lastMessageSignature=null;lastRenderedRoom=null;$('#app').classList.remove('details-open');$('#message-input').value='';$('#chat-name').textContent='创建或加入聊天室';$('#chat-avatar').innerHTML=icon('users');$('#security-status').innerHTML=`${icon('key-round')} 密钥访问`;$('#messages').innerHTML=`<div class="system-message"><span>${icon('key-round')} 无需账号，创建房间或输入密钥即可开始</span></div>`;refreshIcons();return;}
  if(room.removed&&$('#room-key-dialog').open)$('#room-key-dialog').close();else if($('#room-key-dialog').open){$('#room-secret').textContent=`${room.key}.${room.invite}`;$('#rotate-key').classList.toggle('hidden',room.role!=='admin');}updateExpiryLabel(room);$('#chat-name').textContent=room.name;$('#chat-avatar').innerHTML=icon('users');$('#detail-avatar').innerHTML=icon('users');$('#detail-name').textContent=room.name;
  $('#detail-handle').textContent=room.legacy?'旧版本机记录':`${room.membersList?.length||1} 位成员 · 你是${room.role==='admin'?'管理员':'成员'}`;
  $('#room-role-label').textContent=room.legacy?'旧版密钥不能连接新版服务':room.role==='admin'?'分享或更换邀请密钥':'查看当前加入密钥';
  $('#security-status').innerHTML=`${icon(room.legacy?'wifi-off':'lock-keyhole')} ${room.legacy?'旧版本机记录':room.removed?'已被移出房间':room.role==='admin'?'管理员 · 已加密':'成员 · 已加密'}`;
  $('#manage-room').disabled=room.legacy||room.removed;$('#expiry-setting').disabled=room.legacy||room.removed;renderMembers(room);
  const messages=room.messages.filter(m=>!m.expiresAt||m.expiresAt>Date.now()).sort((a,b)=>a.seq&&b.seq?a.seq-b.seq:a.seq?-1:b.seq?1:a.createdAt-b.createdAt);
  const signature=JSON.stringify([room.id,room.legacy,new Date().toDateString(),messages]);if(signature===lastMessageSignature){refreshIcons();return;}lastMessageSignature=signature;
  let previousDay='';
  $('#messages').innerHTML=(room.legacy?'<div class="system-message">这是旧版记录，创建新房间后可继续聊天。</div>':messages.length?'':'<div class="system-message">还没有消息</div>')+messages.map(message=>{const day=dateLabel(message.createdAt||Date.now()),divider=day!==previousDay?`<div class="day-divider">${escapeHTML(day)}</div>`:'';previousDay=day;return divider+`<div class="message-row ${message.mine?'mine':''}"><div class="message-bubble">${!message.mine&&message.author?`<small class="message-author">${escapeHTML(message.author)}</small>`:''}<span class="message-text">${escapeHTML(message.text||message.error||'无法解密此消息')}</span><div class="message-meta"><time datetime="${new Date(message.createdAt||Date.now()).toISOString()}" title="${escapeHTML(new Date(message.createdAt||Date.now()).toLocaleString('zh-CN'))}">${escapeHTML(time(message.createdAt||Date.now()))}</time><button class="copy-message" data-message="${escapeHTML(message.id)}" aria-label="复制消息">复制</button>${message.pending?' · 待发送':message.failed?` · 发送失败 <button class="retry-message" data-message="${escapeHTML(message.id)}">重试</button>`:message.expiresAt?' · 定时删除':''}</div></div></div>`;}).join('');
  $$('.copy-message').forEach(button=>button.onclick=async()=>{const message=room.messages.find(item=>item.id===button.dataset.message);if(!message)return;try{await navigator.clipboard.writeText(message.text||message.error||'');toast('消息已复制');}catch{toast('无法访问剪贴板，请选择消息文字手动复制');}});
  $$('.retry-message').forEach(button=>button.onclick=()=>{const message=room.messages.find(item=>item.id===button.dataset.message);if(message)deliverMessage(room,message);});
  viewport.scrollTop=lastRenderedRoom!==room.id||nearBottom?viewport.scrollHeight:oldScroll;lastRenderedRoom=room.id;updateLatestButton();updateMessageSearch();refreshIcons();
}
function updateMessageSearch(scroll=false){
  const query=$('#message-search').classList.contains('hidden')?'':$('#message-search-input').value.trim().toLocaleLowerCase();
  const matches=[];
  $$('#messages .message-text').forEach(node=>{const text=node.textContent;node.textContent=text;node.closest('.message-row').classList.remove('search-current');if(!query)return;const lower=text.toLocaleLowerCase();let start=0,index=lower.indexOf(query);if(index<0)return;matches.push(node.closest('.message-row'));node.textContent='';while(index>=0){node.append(document.createTextNode(text.slice(start,index)));const mark=document.createElement('mark');mark.textContent=text.slice(index,index+query.length);node.append(mark);start=index+query.length;index=lower.indexOf(query,start);}node.append(document.createTextNode(text.slice(start)));});
  searchIndex=matches.length?(searchIndex+matches.length)%matches.length:0;
  $('#message-search-count').textContent=!query?'输入关键词':matches.length?`${searchIndex+1} / ${matches.length}`:'没有找到';
  $('#search-previous').disabled=$('#search-next').disabled=!matches.length;
  if(matches.length){matches[searchIndex].classList.add('search-current');if(scroll)matches[searchIndex].scrollIntoView({block:'center'});}
}
function closeMessageSearch(){$('#message-search').classList.add('hidden');$('#message-search-input').value='';searchIndex=0;updateMessageSearch();}
function render(){renderRooms();renderChat();}
function openRoom(id){if(state.activeId)drafts.set(state.activeId,$('#message-input').value);closeMessageSearch();state.activeId=id;$('#message-input').value=drafts.get(id)||'';autoGrow();const room=active();if(room)room.unread=0;render();persist();$('#app').classList.add('mobile-chat');}
function showEntry(){if(pendingAdmission){showAdmissionRecovery();return;}if(state.rooms.length>=MAX_ROOMS){toast('最多同时加入 3 个聊天室，请先退出一个');return;}$('#new-chat-dialog').showModal();refreshIcons();}
function openRoomForm(mode){state.formMode=mode;$('#new-chat-dialog').close();$('#welcome-dialog').close();$('#room-form-kicker').textContent=mode==='create'?'创建聊天室':'通过密钥加入';$('#room-form-title').textContent=mode==='create'?'创建聊天室':'加入聊天室';$('#room-name-field').classList.toggle('hidden',mode!=='create');$('#room-key-field').classList.toggle('hidden',mode!=='join');$('#room-submit').textContent=mode==='create'?'生成密钥并创建':'验证密钥并加入';$('#room-form').reset();$('#room-form-dialog').showModal();$('#nickname-input').focus();}
function showAdmissionRecovery(){if(!$('#admission-recovery-dialog').open)$('#admission-recovery-dialog').showModal();}
async function resumeAdmission(){
  if(!pendingAdmission||admissionBusy)return null;admissionBusy=true;$('#retry-admission').disabled=true;
  const attempt=pendingAdmission;
  try{
    const result=await api(attempt.path,{method:'POST',body:attempt.body});let room=attempt.room;
    if(attempt.mode==='join'){
      const metadata=await decryptRoomData(room.key,`${room.id}:metadata`,result.metadata);
      if(!metadata||typeof metadata.name!=='string')throw new Error('房间资料无法读取，请保留密钥后重试');
      room={...room,name:metadata.name.slice(0,24),role:result.role};
    }
    if(state.activeId)drafts.set(state.activeId,$('#message-input').value);
    if(!state.rooms.some(item=>item.id===room.id))state.rooms.unshift(room);
    state.activeId=room.id;pendingAdmission=null;$('#message-input').value=drafts.get(room.id)||'';autoGrow();await persist();
    $('#admission-recovery-dialog').close();$('#room-form-dialog').close();$('#app').classList.add('mobile-chat');setOnline(true);render();await syncRoom(room);
    if(room.role==='admin')showKeyDialog();else toast('已加入聊天室');return room;
  }catch(error){
    // Network errors leave the encrypted attempt intact for an idempotent retry after reload.
    if(error.status>=400&&error.status<500&&error.status!==429){pendingAdmission=null;await persist();$('#admission-recovery-dialog').close();}
    else showAdmissionRecovery();toast(errorText(error));return null;
  }finally{admissionBusy=false;$('#retry-admission').disabled=false;}
}
async function submitRoom(event){
  event.preventDefault();if(admissionBusy||pendingAdmission){showAdmissionRecovery();return;}if(state.rooms.length>=MAX_ROOMS){toast('聊天室数量已达上限');return;}
  const nickname=$('#nickname-input').value.trim();if(!nickname)return;const button=$('#room-submit');button.disabled=true;
  try{
    const mode=state.formMode;let key,invite,id,name,body,path;
    if(mode==='create'){
      name=$('#room-name-input').value.trim()||'未命名聊天室';key=newRoomKey();invite=newSecret();id=await roomIdFromKey(key);path='/rooms';
      body={id,invite,metadata:await encryptRoomData(key,`${id}:metadata`,{name}),profile:await encryptRoomData(key,`${id}:profile:${state.deviceHash}`,{nickname}),inviteBlob:await encryptRoomData(key,`${id}:invite`,{invite})};
    }else{
      ({key,invite}=parseInvitation($('#room-key-input').value));id=await roomIdFromKey(key);if(state.rooms.some(room=>room.id===id))throw new Error('你已经加入过这个聊天室');path=`/rooms/${id}/join`;
      body={invite,profile:await encryptRoomData(key,`${id}:profile:${state.deviceHash}`,{nickname})};
    }
    pendingAdmission={mode,path,body,room:{protocol:1,id,name:name||'聊天室',key,invite,role:mode==='create'?'admin':'member',nickname,messages:[],membersList:[],cursor:0,clearedThrough:0,updated:'刚刚'}};
    if(!await persist()){pendingAdmission=null;throw new Error('本机保存失败，尚未提交房间请求，请释放存储空间后重试');}
    $('#room-form-dialog').close();const recovered=await resumeAdmission();if(!recovered&&!pendingAdmission)$('#room-form-dialog').showModal();
  }catch(error){toast(errorText(error));}finally{button.disabled=false;}
}
function showKeyDialog(){const room=active();if(!room||room.legacy||room.removed)return;$('#key-dialog-role').textContent=room.role==='admin'?'管理员邀请':'聊天室密钥';$('#key-dialog-title').textContent=room.role==='admin'?'邀请成员':'聊天室密钥';$('#key-dialog-copy').textContent='通过可信渠道分享。任何获得完整密钥的人都可能读取这个房间的消息。';$('#room-secret').textContent=`${room.key}.${room.invite}`;$('#rotate-key').classList.toggle('hidden',room.role!=='admin');$('#room-key-dialog').showModal();refreshIcons();}
async function rotateKey(){const room=active();if(!room||room.role!=='admin'||room.legacy)return;if(!await confirmAction('更换邀请密钥','旧邀请将立即失效，需要向新成员分享更新后的密钥。已加入成员仍可聊天；房间加密密钥不会随之更换。','更换邀请'))return;const button=$('#rotate-key');button.disabled=true;try{const invite=newSecret(),inviteBlob=await encryptRoomData(room.key,`${room.id}:invite`,{invite});await api(`/rooms/${room.id}/invite`,{method:'POST',body:{invite,inviteBlob}});room.invite=invite;$('#room-secret').textContent=`${room.key}.${invite}`;await persist();toast('邀请密钥已更换，旧邀请不能再加入');}catch(error){toast(errorText(error));}finally{button.disabled=false;}}
async function copyKey(){const room=active();if(!room)return;try{await navigator.clipboard.writeText(`${room.key}.${room.invite}`);toast('聊天室密钥已复制');}catch{toast('请手动选择并复制完整密钥');}}
function confirmAction(title,description,label){
  const dialog=$('#confirm-dialog');if(dialog.open)return Promise.resolve(false);
  $('#confirm-title').textContent=title;$('#confirm-description').textContent=description;$('#confirm-submit').textContent=label;
  dialog.returnValue='';return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});dialog.showModal();});
}
async function withRoomAction(room,task){if(roomActions.has(room.id))return;roomActions.add(room.id);render();try{return await task();}finally{roomActions.delete(room.id);render();}}
async function leaveRoom(){const room=active();if(!room)return;if(!await confirmAction('退出聊天室',`退出“${room.name}”后，本机将删除该房间的密钥、草稿和记录。${room.role==='admin'&&!room.legacy?'如有其他成员，管理员身份将转交给最早加入的成员；最后一名成员退出后，房间将被删除。':'重新加入需要有效的邀请密钥。'}`,'退出并删除本机记录'))return;await withRoomAction(room,async()=>{try{await Promise.allSettled([roomSyncs.get(room.id),...(roomSends.get(room.id)||[])]);if(!room.legacy&&!room.removed)await api(`/rooms/${room.id}/leave`,{method:'POST'});closeMessageSearch();state.rooms=state.rooms.filter(r=>r.id!==room.id);drafts.delete(room.id);state.activeId=state.rooms[0]?.id||null;$('#message-input').value=drafts.get(state.activeId)||'';autoGrow();await persist();$('#app').classList.remove('details-open','mobile-chat');render();toast('已退出聊天室');}catch(error){toast(errorText(error));}});}
async function removeMember(device){const room=active(),member=room?.membersList.find(m=>m.device===device);if(!room||!member||!await confirmAction('移除成员',`“${member.nickname}”将无法继续通过服务收发消息。已经获得的房间密钥和自行保存的消息无法远程收回。`,'移除成员'))return;try{await api(`/rooms/${room.id}/members/${device}`,{method:'DELETE'});await syncRoom(room);toast('成员已移除');}catch(error){toast(errorText(error));}}
async function clearHistory(){const room=active();if(!room||!await confirmAction('清空本机记录','将清空当前设备已加载的聊天记录，包括尚未发送成功的消息。草稿、其他成员和服务器上的记录不受影响。此操作无法撤销。','清空记录'))return;await withRoomAction(room,async()=>{await Promise.allSettled([roomSyncs.get(room.id),...(roomSends.get(room.id)||[])]);room.hiddenMessageIds=[...new Set([...(room.hiddenMessageIds||[]),...room.messages.filter(message=>!message.seq).map(message=>message.id)])];room.clearedThrough=Math.max(room.cursor||0,...room.messages.map(message=>message.seq||0));room.messages=[];await persist();render();toast('已清空本机记录');});}
async function sendMessage(text){
  const room=active(),clean=text.trim();if(!room||room.legacy||room.removed||roomActions.has(room.id)||!clean)return;
  const message={id:crypto.randomUUID(),mine:true,author:room.nickname,text:clean,time:time(Date.now()),createdAt:Date.now(),pending:true,ttl:room.expiry||0};room.messages.push(message);room.updated='刚刚';drafts.delete(room.id);$('#message-input').value='';autoGrow();render();await deliverMessage(room,message);
}
function deliverMessage(room,message){
  if(room.removed||room.legacy||roomActions.has(room.id)||message.sending)return;
  const task=(async()=>{message.sending=true;message.pending=true;message.failed=false;render();
    try{await persist();const envelope=await encryptRoomData(room.key,`${room.id}:message:${message.id}`,{author:message.author,text:message.text});const result=await api(`/rooms/${room.id}/messages`,{method:'POST',body:{id:message.id,envelope,ttl:message.ttl||0}});message.pending=false;message.failed=false;message.seq=result.seq;message.createdAt=result.created_at;message.expiresAt=result.expires_at||null;setOnline(true);}
    catch(error){message.pending=false;if(error.status===403)room.removed=true;if(!message.seq){message.failed=true;toast(`发送失败：${errorText(error)}，可点击消息旁的重试`);}}
    finally{delete message.sending;await persist();render();}
  })();
  if(!roomSends.has(room.id))roomSends.set(room.id,new Set());roomSends.get(room.id).add(task);task.finally(()=>roomSends.get(room.id)?.delete(task));return task;
}
function syncRoom(room){
  if(roomSyncs.has(room.id))return roomSyncs.get(room.id);
  const task=performSyncRoom(room).finally(()=>roomSyncs.delete(room.id));roomSyncs.set(room.id,task);return task;
}
async function performSyncRoom(room){
  if(room.legacy||room.removed)return;let data;
  try{do{data=await api(`/rooms/${room.id}/sync?after=${room.cursor||0}`);room.role=data.role;if(data.inviteBlob){try{const current=await decryptRoomData(room.key,`${room.id}:invite`,data.inviteBlob);if(/^[A-Za-z0-9_-]{43}$/.test(current.invite))room.invite=current.invite;}catch{}}const members=[];for(const member of data.members){let nickname='无法解密';try{const profile=await decryptRoomData(room.key,`${room.id}:profile:${member.device}`,member.profile);if(typeof profile.nickname==='string')nickname=profile.nickname.slice(0,18);}catch{}members.push({device:member.device,role:member.role,nickname});}room.membersList=members;
    for(const item of data.messages){room.cursor=Math.max(room.cursor||0,item.seq);if(item.seq<=(room.clearedThrough||0))continue;if(room.hiddenMessageIds?.includes(item.id)){room.hiddenMessageIds=room.hiddenMessageIds.filter(id=>id!==item.id);continue;}const existing=room.messages.find(m=>m.id===item.id);if(existing){existing.pending=false;existing.failed=false;existing.seq=item.seq;existing.createdAt=item.created_at;existing.expiresAt=item.expires_at;continue;}let plain;try{plain=await decryptRoomData(room.key,`${room.id}:message:${item.id}`,item.envelope);if(!plain||typeof plain!=='object'||Array.isArray(plain))plain={text:'消息内容无效'};}catch{plain={text:'消息无法解密或已被篡改'};}
      const message={id:item.id,seq:item.seq,mine:item.sender===state.deviceHash,author:typeof plain.author==='string'?plain.author.slice(0,18):'成员',text:typeof plain.text==='string'?plain.text.slice(0,2000):'消息内容无效',createdAt:item.created_at,time:time(item.created_at),expiresAt:item.expires_at};room.messages.push(message);if(!message.mine&&(state.activeId!==room.id||document.hidden||(matchMedia('(max-width:760px)').matches&&!$('#app').classList.contains('mobile-chat'))))room.unread=(room.unread||0)+1;room.updated=time(item.created_at);
    }}while(data.hasMore);room.messages=room.messages.filter(message=>!message.expiresAt||message.expiresAt>Date.now());setOnline(true);await persist();render();
  }catch(error){if(error.status===403){room.removed=true;await persist();render();}else setOnline(false);}
}
async function syncAll(){if(syncBusy)return;syncBusy=true;try{const remote=await api('/rooms');setOnline(true);const ids=new Set(remote.rooms.map(room=>room.id));for(const room of state.rooms){if(!room.legacy&&!ids.has(room.id)){room.removed=true;continue;}if(!room.legacy)await syncRoom(room);}await persist();render();}catch{setOnline(false);}finally{syncBusy=false;}}
function expireLocalMessages(){let changed=false;for(const room of state.rooms){const remaining=room.messages.filter(message=>!message.expiresAt||message.expiresAt>Date.now());if(remaining.length!==room.messages.length){room.messages=remaining;changed=true;}}if(changed){persist();render();}}
function updateSendButton(){const room=active();$('#send-button').disabled=!room||room.legacy||room.removed||roomActions.has(room.id)||!$('#message-input').value.trim();}
function autoGrow(){updateSendButton();const textarea=$('#message-input');textarea.style.height='auto';textarea.style.height=Math.min(textarea.scrollHeight,120)+'px';}
const expiryLabels={0:'不自动删除',30:'发送后 30 秒删除',300:'发送后 5 分钟删除',3600:'发送后 1 小时删除'};
function updateExpiryLabel(room){const label=expiryLabels[room.expiry||0];$('#expiry-status').textContent=label;$('#detail-expiry').textContent=label;}
let expiryRoomId;
function setExpiry(){const room=active();if(!room||room.legacy||room.removed)return;expiryRoomId=room.id;$('#expiry-form').elements.expiry.value=String(room.expiry||0);$('#expiry-dialog').showModal();}
async function saveExpiry(event){event.preventDefault();const room=state.rooms.find(room=>room.id===expiryRoomId);if(!room){$('#expiry-dialog').close();return;}room.expiry=Number($('#expiry-form').elements.expiry.value);await persist();$('#expiry-dialog').close();if(active()===room)updateExpiryLabel(room);toast('已保存，此房间的新消息将使用该设置');}
function toggleTheme(){state.theme=state.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=state.theme;try{localStorage.setItem('ciphera-theme',state.theme);}catch{toast('主题已切换，但浏览器未能保存偏好');}$('#theme-toggle').innerHTML=icon(state.theme==='dark'?'sun':'moon');refreshIcons();}
async function boot(){
  document.documentElement.dataset.theme=state.theme;$('#theme-toggle').innerHTML=icon(state.theme==='dark'?'sun':'moon');try{await initVault();}catch(error){$('#startup-error-description').textContent=error.message||'无法启动加密功能，请使用 HTTPS 或本机地址';$('#retry-startup').onclick=()=>location.reload();$('#startup-error-dialog').showModal();return;}$('#message-input').value=drafts.get(state.activeId)||'';autoGrow();render();if(!state.rooms.length&&!pendingAdmission)$('#welcome-dialog').showModal();
  $('.brand-mark').onclick=$('[data-view=chats]').onclick=()=>$('#app').classList.remove('mobile-chat','details-open');$('#retry-admission').onclick=resumeAdmission;$('#new-chat').onclick=showEntry;$('#choose-create').onclick=$('#welcome-create').onclick=()=>openRoomForm('create');$('#choose-join').onclick=$('#welcome-join').onclick=()=>openRoomForm('join');$('#room-form').onsubmit=submitRoom;
  $('#room-key-dialog').addEventListener('close',()=>{$('#room-secret').textContent='';});$('#manage-room').onclick=$('#security-status').onclick=showKeyDialog;$('#copy-key').onclick=copyKey;$('#rotate-key').onclick=rotateKey;$('#leave-room').onclick=leaveRoom;$('#clear-history').onclick=clearHistory;
  $('#messages').addEventListener('scroll',updateLatestButton,{passive:true});$('#latest-messages').onclick=()=>{$('#messages').scrollTo({top:$('#messages').scrollHeight,behavior:'smooth'});};$('#message-form').onsubmit=event=>{event.preventDefault();sendMessage($('#message-input').value);};$('#message-input').oninput=()=>{autoGrow();if(state.activeId)drafts.set(state.activeId,$('#message-input').value);clearTimeout(draftTimer);draftTimer=setTimeout(persist,250);};$('#message-input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage(event.currentTarget.value);}};
  $('#search-input').oninput=renderRooms;$$('.tab').forEach(tab=>tab.onclick=()=>{$$('.tab').forEach(item=>{item.classList.remove('active');item.setAttribute('aria-pressed','false');});tab.classList.add('active');tab.setAttribute('aria-pressed','true');state.filter=tab.dataset.filter;renderRooms();});
  $('#details-toggle').onclick=()=>{if(active())$('#app').classList.toggle('details-open');};$('#details-close').onclick=()=>$('#app').classList.remove('details-open');$('#mobile-back').onclick=()=>$('#app').classList.remove('mobile-chat');$('#theme-toggle').onclick=toggleTheme;
  $('#timer-button').onclick=$('#expiry-setting').onclick=setExpiry;$('#expiry-form').onsubmit=saveExpiry;
  $('#chat-search').onclick=()=>{if(!active())return;$('#message-search').classList.remove('hidden');$('#message-search-input').focus();updateMessageSearch();};
  $('#message-search-input').oninput=()=>{searchIndex=0;updateMessageSearch(true);};
  $('#search-previous').onclick=()=>{searchIndex--;updateMessageSearch(true);};$('#search-next').onclick=()=>{searchIndex++;updateMessageSearch(true);};$('#search-close').onclick=closeMessageSearch;
  $('#message-search-input').onkeydown=event=>{if(event.key==='Escape')closeMessageSearch();if(event.key==='Enter'){event.preventDefault();searchIndex+=event.shiftKey?-1:1;updateMessageSearch(true);}};
  $$('[data-close-dialog]').forEach(button=>button.onclick=()=>button.closest('dialog').close());document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('#search-input').focus();}});
  window.addEventListener('online',syncAll);window.addEventListener('offline',()=>setOnline(false));window.addEventListener('pagehide',()=>{clearTimeout(draftTimer);persist();});refreshIcons();if(pendingAdmission){await resumeAdmission();if(!pendingAdmission&&!state.rooms.length&&!$('#welcome-dialog').open)$('#welcome-dialog').showModal();}await syncAll();setInterval(syncAll,4000);setInterval(expireLocalMessages,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){const room=active();if(room&&(!matchMedia('(max-width:760px)').matches||$('#app').classList.contains('mobile-chat'))){room.unread=0;renderRooms();}syncAll();}else persist();});
}
async function start(){
  // Only one writer per browser origin: encrypted snapshots must never overwrite another tab's drafts.
  if(!navigator.locks){await boot();return;}
  await navigator.locks.request('ciphera-workspace',{ifAvailable:true},async lock=>{
    if(!lock){$('#retry-workspace').onclick=()=>location.reload();$('#workspace-busy-dialog').addEventListener('cancel',event=>event.preventDefault());$('#workspace-busy-dialog').showModal();return;}
    await boot();await new Promise(()=>{});
  });
}
start();
