const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_PREFIX = 'CYPH-';

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('密钥格式不正确');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function newSecret() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function newRoomKey() {
  return KEY_PREFIX + newSecret();
}

export function normalizeRoomKey(key) {
  const normalized = key.trim().replace(/\s/g, '');
  if (!normalized.startsWith(KEY_PREFIX)) throw new Error('密钥格式不正确');
  const value = normalized.slice(KEY_PREFIX.length);
  const bytes = fromBase64Url(value);
  if (bytes.length !== 32 || toBase64Url(bytes) !== value) throw new Error('密钥格式不正确');
  return normalized;
}

export async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function roomIdFromKey(key) {
  const normalized = normalizeRoomKey(key);
  return sha256Hex('ciphera-room-v1:' + normalized.slice(KEY_PREFIX.length));
}

async function importRoomKey(key, usage) {
  const normalized = normalizeRoomKey(key);
  return crypto.subtle.importKey('raw', fromBase64Url(normalized.slice(KEY_PREFIX.length)), 'AES-GCM', false, usage);
}

export async function encryptRoomData(key, associatedData, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const roomKey = await importRoomKey(key, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:encoder.encode(associatedData)}, roomKey, encoder.encode(JSON.stringify(data)));
  return {iv:toBase64Url(iv), ciphertext:toBase64Url(new Uint8Array(ciphertext))};
}

export async function decryptRoomData(key, associatedData, envelope) {
  if(!envelope||typeof envelope!=='object'||typeof envelope.iv!=='string'||envelope.iv.length!==16||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>16000)throw new Error('加密消息格式不正确');
  const iv=fromBase64Url(envelope.iv),ciphertext=fromBase64Url(envelope.ciphertext);
  if(iv.length!==12||ciphertext.length<16||toBase64Url(ciphertext)!==envelope.ciphertext)throw new Error('加密消息格式不正确');
  const roomKey = await importRoomKey(key, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({name:'AES-GCM', iv, additionalData:encoder.encode(associatedData)}, roomKey, ciphertext);
  return JSON.parse(decoder.decode(plaintext));
}
