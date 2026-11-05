import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtemp,chmod,link,rm,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// SQLite's backup API includes committed WAL content. Publish without overwriting any existing file.
export async function copyDatabase(source,destination){
  source=resolve(source);destination=resolve(destination);
  if(source===destination)throw new Error('源文件和目标文件不能相同');
  if(!(await stat(source)).isFile())throw new Error('源文件必须是数据库文件');
  const db=new DatabaseSync(source,{readOnly:true});let temporary;
  try{
    const result=db.prepare('PRAGMA integrity_check').all();
    if(result.length!==1||result[0].integrity_check!=='ok')throw new Error('数据库完整性检查失败');
    for(const table of ['rooms','memberships','messages'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('这不是聊天室数据库');
    temporary=await mkdtemp(join(dirname(destination),'.ciphera-backup-'));
    const path=join(temporary,'snapshot.sqlite');await backup(db,path);await chmod(path,0o600);await link(path,destination);
  }finally{db.close();if(temporary)await rm(temporary,{recursive:true,force:true});}
  return destination;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,source,destination]=process.argv.slice(2);
  if(!['backup','restore'].includes(command)||!source||!destination){console.error('用法：node scripts/database.mjs backup|restore 源数据库 新目标文件');process.exitCode=1;}
  else try{console.log(`数据库已检查并复制到：${await copyDatabase(source,destination)}`);}catch(error){console.error(`操作失败：${error.code==='EEXIST'?'目标已存在，未覆盖任何文件':error.message}`);process.exitCode=1;}
}
