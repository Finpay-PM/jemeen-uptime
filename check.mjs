#!/usr/bin/env node
// Host-independent uptime check for Jemeen (N62). Runs on GitHub Actions, i.e. not
// on Render, ChatGPT Sites or Supabase. One GitHub issue per down target is the
// alert (GitHub emails the repository owner); closing it with a comment is the
// recovery notice, including the measured downtime. No dependencies (Node >= 20).
// Logs print target names and short codes only, never URLs, headers or bodies.
//
// Env: MONITOR_TARGETS  JSON array of targets (see targets.example.json)
//      GITHUB_REPOSITORY owner/name, GITHUB_TOKEN (workflow token, issues: write)
//      MONITOR_MENTION   optional "@username" added to alert issues
//      MONITOR_DRY_RUN   "true" = probe and print only, no issue changes
import {fileURLToPath} from 'node:url';

const LABEL='uptime';
const NAME=/^[a-z0-9][a-z0-9-]{0,39}$/;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export function parseTargets(raw){
  let list;try{list=JSON.parse(raw||'');}catch{throw new Error('MONITOR_TARGETS is not valid JSON');}
  if(!Array.isArray(list)||list.length<1||list.length>20)throw new Error('MONITOR_TARGETS must be an array of 1-20 targets');
  const seen=new Set();
  return list.map((t,i)=>{
    if(!t||typeof t!=='object')throw new Error(`target ${i} is not an object`);
    if(!NAME.test(t.name||'')||seen.has(t.name))throw new Error(`target ${i} needs a unique lower-case name`);
    seen.add(t.name);
    let url;try{url=new URL(t.url);}catch{throw new Error(`target ${t.name} has an invalid url`);}
    if(url.protocol!=='https:'&&!(t.allowHttp===true&&url.protocol==='http:'))throw new Error(`target ${t.name} must use https`);
    const expectStatus=t.expectStatus===undefined?[200]:[].concat(t.expectStatus);
    if(!expectStatus.every(s=>Number.isInteger(s)&&s>=100&&s<=599))throw new Error(`target ${t.name} has an invalid expectStatus`);
    for(const k of ['expectText','expectBody','expectHeader'])if(t[k]!==undefined&&(typeof t[k]!=='string'||!t[k]||t[k].length>200))throw new Error(`target ${t.name} has an invalid ${k}`);
    const timeoutMs=t.timeoutMs===undefined?10000:t.timeoutMs;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)throw new Error(`target ${t.name} has an invalid timeoutMs`);
    return {name:t.name,url:url.href,method:t.method==='HEAD'?'HEAD':'GET',expectStatus,expectText:t.expectText,expectBody:t.expectBody,expectHeader:t.expectHeader?.toLowerCase(),timeoutMs};
  });
}

// One attempt: returns null when healthy, otherwise a short failure code.
export async function attempt(target,fetchImpl=fetch){
  let response;
  try{
    response=await fetchImpl(target.url,{method:target.method,redirect:'manual',headers:{'user-agent':'jemeen-uptime/1','cache-control':'no-cache'},signal:AbortSignal.timeout(target.timeoutMs)});
  }catch(error){return error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'network';}
  try{
    if(!target.expectStatus.includes(response.status))return 'status_'+response.status;
    if(target.expectHeader&&!response.headers.has(target.expectHeader))return 'header_missing';
    if(target.expectText!==undefined||target.expectBody!==undefined){
      const text=(await response.text()).slice(0,200000);
      if(target.expectBody!==undefined&&text.trim()!==target.expectBody)return 'body_mismatch';
      if(target.expectText!==undefined&&!text.includes(target.expectText))return 'text_missing';
    }
    return null;
  }finally{try{await response.body?.cancel();}catch{}}
}

// Retries absorb a single blip: a target is down only if every attempt fails.
export async function probe(target,{fetchImpl=fetch,attempts=3,delayMs=15000,wait=sleep}={}){
  let code=null;
  for(let i=0;i<attempts;i++){
    code=await attempt(target,fetchImpl);
    if(code===null)return {name:target.name,ok:true};
    if(i<attempts-1)await wait(delayMs);
  }
  return {name:target.name,ok:false,code};
}

function github({repo,token,fetchImpl}){
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo||''))throw new Error('GITHUB_REPOSITORY missing');
  if(!token)throw new Error('GITHUB_TOKEN missing');
  return async(method,path,body)=>{
    const r=await fetchImpl('https://api.github.com/repos/'+repo+path,{method,headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'jemeen-uptime/1',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error(`github_${method}_${r.status}`);
    return r.status===204?null:r.json();
  };
}
const titleFor=name=>`DOWN: ${name}`;
const minutes=ms=>Math.max(0,Math.round(ms/60000));

// Opens one issue per newly-down target and closes the issue of each recovered one.
export async function reconcile(results,{repo,token,fetchImpl=fetch,mention='',now=()=>new Date()}){
  const api=github({repo,token,fetchImpl});
  const open=(await api('GET',`/issues?state=open&labels=${LABEL}&per_page=100`)).filter(i=>!i.pull_request);
  const actions=[];
  for(const r of results){
    const issue=open.find(i=>i.title===titleFor(r.name));
    if(!r.ok&&!issue){
      const at=now().toISOString();
      await api('POST','/issues',{title:titleFor(r.name),labels:[LABEL],body:`${mention?mention+' ':''}Jemeen uptime check: **${r.name}** is failing (\`${r.code}\`) from GitHub Actions, outside Render/Sites/Supabase.\n\nFirst failed check: ${at} (3 attempts over ~30 s).\n\nThis issue closes automatically with the downtime when the target recovers.`});
      actions.push({name:r.name,action:'opened',code:r.code});
    }else if(r.ok&&issue){
      const down=minutes(now().getTime()-Date.parse(issue.created_at));
      await api('POST',`/issues/${issue.number}/comments`,{body:`Recovered at ${now().toISOString()} after about ${down} minute(s) down.`});
      await api('PATCH',`/issues/${issue.number}`,{state:'closed',state_reason:'completed'});
      actions.push({name:r.name,action:'closed',downMinutes:down});
    }
  }
  return actions;
}

export async function main(env=process.env,{fetchImpl=fetch,log=console.log,wait=sleep}={}){
  const targets=parseTargets(env.MONITOR_TARGETS);
  const results=await Promise.all(targets.map(t=>probe(t,{fetchImpl,wait})));
  for(const r of results)log(`${r.name}: ${r.ok?'ok':'DOWN '+r.code}`);
  if(env.MONITOR_DRY_RUN==='true'){log('dry run: no issue changes');return {results,actions:[]};}
  const actions=await reconcile(results,{repo:env.GITHUB_REPOSITORY,token:env.GITHUB_TOKEN,fetchImpl,mention:/^@[A-Za-z0-9-]{1,39}$/.test(env.MONITOR_MENTION||'')?env.MONITOR_MENTION:''});
  for(const a of actions)log(`${a.name}: issue ${a.action}`);
  return {results,actions};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  // Exit 1 only when the monitor itself is broken (config/GitHub API), so a
  // monitor failure surfaces as a failed-workflow email, not an outage email.
  main().catch(error=>{console.error('monitor error: '+String(error?.message||error).slice(0,200));process.exitCode=1;});
}
