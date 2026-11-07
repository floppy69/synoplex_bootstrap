const fs=require('fs'),path=require('path');
const cfg=JSON.parse(fs.readFileSync((process.env.SYNOPLEX_STACK_JSON||'/data/PlexMediaServer/stack.json'),'utf8'));

const QB=String(cfg.qbittorrent?.url||'').replace(/\/$/,'');
const QU=String(cfg.qbittorrent?.username||'').trim();
const QP=String(cfg.qbittorrent?.password||'');
const RB=String(cfg.radarr?.url||'').replace(/\/$/,'');
const RK=String(cfg.radarr?.api_key||'').trim();
const SB=String(cfg.sonarr?.url||'').replace(/\/$/,'');
const SK=String(cfg.sonarr?.api_key||'').trim();

const SEEDER_THRESHOLD=10;
const RADARR_ROOT=String(cfg.paths?.movies||'').replace(/\/$/,'');
const RADARR_PROFILE=Number(cfg.radarr?.quality_profile_id||1);
const RADARR_STAGING=String(cfg.paths?.radarr_staging||(cfg.paths?.media_root?String(cfg.paths.media_root).replace(/\/$/,'')+'/downloads/radarr':''));
const RADARR_DOWNLOAD_ROOTS=[
RADARR_STAGING,
String(cfg.qbittorrent?.download_folder||''),
...(Array.isArray(cfg.paths?.radarr_download_roots)?cfg.paths.radarr_download_roots:[])
].filter(Boolean);
const qh={'Accept':'application/json'};
const rh={'X-Api-Key':RK,'Accept':'application/json','Content-Type':'application/json'};
const sh={'X-Api-Key':SK,'Accept':'application/json','Content-Type':'application/json'};
const videoExt=new Set(['.mkv','.mp4','.avi','.m4v','.mov','.ts','.m2ts','.webm','.wmv']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function api(base,headers,p,opts={}){
const method=String(opts.method||'GET').toUpperCase();
const readOnly=method==='GET'||method==='HEAD';
const maxAttempts=(base===SB&&readOnly)?2:1;
const timeoutMs=base===SB?45000:20000;
for(let attempt=0;attempt<maxAttempts;attempt++){
try{
  const r=await fetch(base+p,{
    ...opts,
    headers:{...headers,...(opts.headers||{})},
    signal:AbortSignal.timeout(timeoutMs)
  });
  const txt=await r.text();
  let data=null;
  try{data=txt?JSON.parse(txt):null}catch{data=txt}
  if(!r.ok) throw new Error(r.status+' '+p+' :: '+String(txt).slice(0,500));
  return data;
}catch(e){
  if(attempt+1>=maxAttempts) throw e;
  await sleep(1200*(attempt+1));
}
}
}

function pathMappings(){
return [
[String(cfg.paths?.config_root||''),String(cfg.paths?.n8n_config_root||'')],
[String(cfg.paths?.media_root||''),String(cfg.paths?.n8n_media_root||'')]
].filter(([nasRoot,localRoot])=>nasRoot&&localRoot)
 .sort((a,b)=>b[0].length-a[0].length);
}
function canMapNas(nasPath){
const p=String(nasPath||'');
return pathMappings().some(([nasRoot])=>p===nasRoot||p.startsWith(nasRoot+'/'));
}
function localPath(nasPath){
const p=String(nasPath||'');
for(const [nasRoot,localRoot] of pathMappings()){
if(p===nasRoot||p.startsWith(nasRoot+'/')) return localRoot+p.slice(nasRoot.length);
}
throw new Error('No n8n path mapping for NAS path: '+p);
}
function localToNas(local){
const p=String(local||'');
for(const [nasRoot,localRoot] of pathMappings()){
if(p===localRoot||p.startsWith(localRoot+'/')) return nasRoot+p.slice(localRoot.length);
}
throw new Error('No NAS path mapping for n8n path: '+p);
}

function existsNas(nasPath){
try{return fs.existsSync(localPath(nasPath));}catch{return false;}
}

function hasVideoNas(nasPath){
try{return walk(localPath(nasPath)).length>0;}catch{return false;}
}

function normTitle(s){
return String(s||'')
.normalize('NFKD')
.replace(/[\u0300-\u036f]/g,'')
.toLowerCase()
.replace(/[^a-z0-9]+/g,' ')
.trim()
.replace(/\s+/g,' ');
}

function yearFromText(s){
const m=String(s||'').match(/\b(19\d{2}|20\d{2})\b/);
return m?Number(m[1]):null;
}

function linkOrCopy(src,dst){
if(fs.existsSync(dst)) return 'EXISTS';
try{
fs.linkSync(src,dst);
return 'HARDLINK';
}catch{
copyForSeeding(src,dst);
return 'COPY';
}
}

function isAllowedRadarrPath(p){
const s=String(p||'');
return RADARR_DOWNLOAD_ROOTS.some(root=>s===root||s.startsWith(root+'/'));
}

function walk(dir,out=[]){
if(!fs.existsSync(dir)) return out;
const st=fs.statSync(dir);
if(st.isFile()){
if(videoExt.has(path.extname(dir).toLowerCase())) out.push(dir);
return out;
}
for(const name of fs.readdirSync(dir)){
const p=path.join(dir,name);
const s=fs.statSync(p);
if(s.isDirectory()) walk(p,out);
else if(s.isFile()&&videoExt.has(path.extname(name).toLowerCase())) out.push(p);
}
return out;
}

function sourceVideo(localContentPath){
const files=walk(localContentPath);
if(!files.length) throw new Error('No video file found in '+localContentPath);
files.sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size);
return files[0];
}

function seederInfo(t){
const total=Number(t.num_complete);
if(Number.isFinite(total)&&total>=0) return {count:total,source:'num_complete',known:true};
const connected=Number(t.num_seeds);
if(Number.isFinite(connected)&&connected>=0) return {count:connected,source:'num_seeds',known:true};
return {count:null,source:'unknown',known:false};
}

async function qbitLogin(){
const body=new URLSearchParams({username:QU,password:QP});
const r=await fetch(QB+'/api/v2/auth/login',{
method:'POST',
headers:{'Content-Type':'application/x-www-form-urlencoded','Referer':QB+'/'},
body,
signal:AbortSignal.timeout(15000)
});
const txt=(await r.text()).trim();
const setCookie=r.headers.get('set-cookie')||'';
const sessionCookie=setCookie?setCookie.split(';',1)[0]:'';
if(!r.ok||txt==='Fails.') throw new Error('qBittorrent authentication failed');
if(sessionCookie) qh.Cookie=sessionCookie;
qh.Referer=QB+'/';
const verify=await fetch(QB+'/api/v2/app/version',{headers:qh,signal:AbortSignal.timeout(15000)});
if(!verify.ok) throw new Error('qBittorrent authenticated session verification failed: HTTP '+verify.status);
}

async function qbitForm(endpoint,data){
const body=new URLSearchParams(data);
const r=await fetch(QB+endpoint,{
method:'POST',
headers:{
  ...qh,
  'Content-Type':'application/x-www-form-urlencoded'
},
body,
signal:AbortSignal.timeout(15000)
});
if(!r.ok) throw new Error('qBittorrent '+endpoint+' failed: HTTP '+r.status);
}

async function removeTorrent(t){
throw new Error('AUTO_DELETE_DISABLED_MOVE_ONLY_POLICY');
}
async function pauseTorrent(t){
await qbitForm('/api/v2/torrents/pause',{hashes:String(t.hash||'')});
}

function hasQbitTag(t,tag){
return String(t.tags||'').split(',').map(x=>x.trim()).filter(Boolean).includes(tag);
}

async function parkTorrent(t,tag){
const hash=String(t.hash||'');
const before=await api(QB,qh,'/api/v2/torrents/info?hashes='+encodeURIComponent(hash));
const current=Array.isArray(before)?before[0]:null;
if(!current||!hash)throw Error('PARK_NO_TORRENT');
if(current.auto_tmm){
await qbitForm('/api/v2/torrents/setAutoManagement',{hashes:hash,enable:'false'});
}
await qbitForm('/api/v2/torrents/addTags',{hashes:hash,tags:tag});
await qbitForm('/api/v2/torrents/setCategory',{hashes:hash,category:''});
const after=await api(QB,qh,'/api/v2/torrents/info?hashes='+encodeURIComponent(hash));
if(!Array.isArray(after)||!after.length||
String(after[0].save_path||'')!==String(current.save_path||''))
throw Error('PARK_UNEXPECTED_SAVE_PATH_CHANGE');
}
async function moveTorrentToRadarrStaging(t){
const current=String(t.content_path||'');
if(current===RADARR_STAGING||current.startsWith(RADARR_STAGING+'/')) return current;
if(!isAllowedRadarrPath(current)) throw new Error('UNEXPECTED_SOURCE '+current);

await qbitForm('/api/v2/torrents/setLocation',{
hashes:String(t.hash||''),
location:RADARR_STAGING
});

const hash=encodeURIComponent(String(t.hash||''));
const stagedCandidate=path.posix.join(RADARR_STAGING,path.posix.basename(current));
for(let i=0;i<300;i++){
const rows=await api(QB,qh,'/api/v2/torrents/info?hashes='+hash);
const cur=Array.isArray(rows)?rows[0]:null;
const cp=String(cur?.content_path||'');
const sp=String(cur?.save_path||'');
const state=String(cur?.state||'');
const contentMoved=(cp===RADARR_STAGING||cp.startsWith(RADARR_STAGING+'/'));
const saveMoved=(sp===RADARR_STAGING||sp.startsWith(RADARR_STAGING+'/'));
if(state!=='moving'){
  if(contentMoved) return cp;
  if(saveMoved&&existsNas(stagedCandidate)) return stagedCandidate;
}
await sleep(1000);
}
throw new Error('STAGING_MOVE_TIMEOUT '+current);
}

function copyForSeeding(src,dst){
const tmp=dst+'.copying';
try{if(fs.existsSync(tmp)) fs.unlinkSync(tmp)}catch{}
fs.copyFileSync(src,tmp,fs.constants.COPYFILE_FICLONE);
fs.renameSync(tmp,dst);
}

function moveWithoutSeeding(src,dst){
try{
fs.renameSync(src,dst);
}catch(e){
if(e?.code!=='EXDEV') throw e;
const tmp=dst+'.moving';
try{if(fs.existsSync(tmp)) fs.unlinkSync(tmp)}catch{}
fs.copyFileSync(src,tmp,fs.constants.COPYFILE_FICLONE);
fs.renameSync(tmp,dst);
fs.unlinkSync(src);
}
}

async function waitRadarrCommand(id){
if(!id) return null;
for(let i=0;i<20;i++){
const c=await api(RB,rh,'/api/v3/command/'+id);
const s=String(c?.status||'').toLowerCase();
if(['completed','failed','aborted'].includes(s)) return c;
await sleep(500);
}
return null;
}

async function waitSonarrCommand(id){
if(!id) return null;
for(let i=0;i<60;i++){
const c=await api(SB,sh,'/api/v3/command/'+id);
const s=String(c?.status||'').toLowerCase();
if(['completed','failed','aborted'].includes(s)) return c;
await sleep(1000);
}
return null;
}

async function finishRecoveredTorrent(t,keepSeeding,tag){
if(keepSeeding){
await parkTorrent(t,tag);
return {parked:true,qbitRemoved:false};
}
await removeTorrent(t);
return {parked:false,qbitRemoved:true};
}

function historyDownloadId(x){
return String(x?.downloadId||x?.data?.downloadId||'').toLowerCase();
}
function isC411HistoryRecord(x,arrIndexerId){
if(String(x?.eventType||'').toLowerCase()!=='grabbed') return false;
const d=x?.data||{};
return Number(d.indexerId)===Number(arrIndexerId) || /\bC411\b/i.test(String(d.indexer||''));
}
function isC411Torrent(t,historyRecords,arrIndexerId){
const hash=String(t?.hash||'').toLowerCase();
return (Array.isArray(historyRecords)?historyRecords:[]).some(x=>historyDownloadId(x)===hash&&isC411HistoryRecord(x,arrIndexerId));
}
async function ensureC411Tag(t){
if(hasQbitTag(t,'seed-c411')) return;
await qbitForm('/api/v2/torrents/addTags',{
hashes:String(t.hash||''),
tags:'seed-c411'
});
}

function importedPathFromHistory(x){
const d=x?.data||{};
return String(d.importedPath||d.destinationPath||d.path||'').trim();
}

function looksImportedEvent(x){
const type=String(x?.eventType||'').toLowerCase();
const importedPath=importedPathFromHistory(x);
return type.includes('import')||Boolean(importedPath);
}

function sonarrImportEvidence(t,historyRecords){
const hash=String(t.hash||'').toLowerCase();
const matching=historyRecords.filter(x=>historyDownloadId(x)===hash&&looksImportedEvent(x));
const importedPaths=[...new Set(matching.map(importedPathFromHistory).filter(Boolean))];
const existingImportedPaths=importedPaths.filter(existsNas);

let sourceFiles=[];
const contentPath=String(t.content_path||'');
if(canMapNas(contentPath)){
try{sourceFiles=walk(localPath(contentPath));}catch{}
}

const sourceVideoCount=sourceFiles.length;
const importedCount=existingImportedPaths.length;
const fullyImported=
sourceVideoCount>0
  ? importedCount>=sourceVideoCount
  : importedCount>0;

return {
fullyImported,
sourceVideoCount,
importedCount,
historyMatches:matching.length,
sourceFiles,
matchingRecords:matching
};
}

function explicitExtraFile(file){
const b=path.basename(String(file||''));
return /(?:^|[._\-\s])(special|ova|oad|bonus|extra|ncop|nced|creditless|trailer|preview|promo)(?:[._\-\s]|$)/i.test(b);
}

function episodeRefFromFile(file){
const b=path.basename(String(file||''));
const m=b.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
if(!m) return null;
return {seasonNumber:Number(m[1]),episodeNumber:Number(m[2]),file};
}

async function recoverSonarrCompletedPack(t,ctx,evidence,seeds,keepSeeding){
if(VERIFIED_OP_C411_PACKS[String(t?.hash||'').toLowerCase()])return null; // Mapping must stay absolute, never guessed from Sonarr grab history.
if(Number(evidence.sourceVideoCount)<=1) return null;

const importedRecords=Array.isArray(evidence.matchingRecords)?evidence.matchingRecords:[];
const seriesIds=[...new Set(importedRecords.map(x=>Number(x.seriesId)).filter(x=>Number.isFinite(x)&&x>0))];
if(seriesIds.length!==1) return null;

const seriesId=seriesIds[0];
const sourceFiles=Array.isArray(evidence.sourceFiles)?evidence.sourceFiles:[];
const extras=sourceFiles.filter(explicitExtraFile);
const regular=sourceFiles.filter(f=>!explicitExtraFile(f));

if(!extras.length||!regular.length) return null;

const refs=regular.map(episodeRefFromFile);
if(refs.some(x=>!x)) return null;

const missingCount=Math.max(0,Number(evidence.sourceVideoCount)-Number(evidence.importedCount));
if(extras.length!==missingCount) return null;
if(Number(evidence.importedCount)<regular.length) return null;

const episodes=await api(SB,sh,'/api/v3/episode?seriesId='+seriesId+'&includeImages=false');
const episodeRows=Array.isArray(episodes)?episodes:[];

const missingRegular=[];
for(const ref of refs){
const ep=episodeRows.find(e=>
  Number(e.seasonNumber)===ref.seasonNumber &&
  Number(e.episodeNumber)===ref.episodeNumber
);
if(!ep?.hasFile){
  missingRegular.push({
    seasonNumber:ref.seasonNumber,
    episodeNumber:ref.episodeNumber,
    file:path.basename(ref.file)
  });
}
}

if(missingRegular.length) return null;

const series=await api(SB,sh,'/api/v3/series/'+seriesId);
if(!series?.path) return null;

const destDir=path.join(localPath(series.path),'Specials','Unmatched');
fs.mkdirSync(destDir,{recursive:true});

const savedExtras=[];
for(const src of extras){
const dst=path.join(destDir,path.basename(src));
const transfer=linkOrCopy(src,dst);
if(!fs.existsSync(dst)) throw new Error('Extra file was not saved: '+dst);
savedExtras.push({
  source:localToNas(src),
  destination:localToNas(dst),
  transfer
});
}

const finish=await finishRecoveredTorrent(t,keepSeeding,'seed-sonarr');

return {
category:'sonarr',
torrent:t.name,
status:keepSeeding
  ? 'SONARR_PACK_COMPLETE_EXTRAS_SAVED_PARKED_SEEDING'
  : 'SONARR_PACK_COMPLETE_EXTRAS_SAVED_TORRENT_REMOVED',
seriesId,
seriesTitle:series.title||null,
sourceVideoCount:evidence.sourceVideoCount,
importedCount:evidence.importedCount,
regularEpisodeCount:regular.length,
unmatchedExtraCount:extras.length,
unmatchedExtras:savedExtras,
destination:localToNas(destDir),
seeders:seeds.count,
seedersSource:seeds.source,
threshold:SEEDER_THRESHOLD,
keepSeeding,
...finish
};
}

async function ensureRadarrStandaloneMovie(episode,t,ctx){
const year=yearFromText(t.name);
const term=[episode?.title||t.name,year||''].join(' ').trim();
const lookup=await api(RB,rh,'/api/v3/movie/lookup?term='+encodeURIComponent(term));
const rows=Array.isArray(lookup)?lookup:[];
const target=normTitle(episode?.title||'');

let hit=rows.find(x=>{
const titles=[
  x?.title,
  x?.originalTitle,
  ...(Array.isArray(x?.alternateTitles)?x.alternateTitles.map(a=>a?.title):[])
];
return titles.some(t=>normTitle(t)===target) &&
  (!year||Number(x.year)===Number(year));
})||null;

if(!hit?.tmdbId){
return {movie:null,hit:null,reason:'RADARR_LOOKUP_NOT_FOUND'};
}

let movie=(ctx.radarrMovies||[]).find(x=>Number(x.tmdbId)===Number(hit.tmdbId))||null;
if(!movie){
const existing=await api(RB,rh,'/api/v3/movie?tmdbId='+encodeURIComponent(hit.tmdbId));
if(Array.isArray(existing)&&existing.length) movie=existing[0];
}

if(!movie){
const profile=await api(RB,rh,'/api/v3/qualityprofile/'+RADARR_PROFILE);
if(!profile||Number(profile.id)!==RADARR_PROFILE){
  throw new Error('Radarr quality profile ID '+RADARR_PROFILE+' not found');
}

const roots=await api(RB,rh,'/api/v3/rootfolder');
let root=(Array.isArray(roots)?roots:[]).find(x=>String(x.path||'').replace(/\/$/,'')===RADARR_ROOT);
if(!root){
  root=await api(RB,rh,'/api/v3/rootfolder',{
    method:'POST',
    body:JSON.stringify({path:RADARR_ROOT})
  });
}
if(!root?.id) throw new Error('Radarr root folder unavailable: '+RADARR_ROOT);

movie=await api(RB,rh,'/api/v3/movie',{
  method:'POST',
  body:JSON.stringify({
    ...hit,
    qualityProfileId:RADARR_PROFILE,
    rootFolderPath:RADARR_ROOT,
    monitored:true,
    tags:[],
    addOptions:{searchForMovie:false}
  })
});

if(movie?.id) ctx.radarrMovies.push(movie);
}

return {movie,hit,reason:null};
}

async function routeSonarrStandaloneMovie(t,ctx,qItem,episode,seeds,keepSeeding){
const resolved=await ensureRadarrStandaloneMovie(episode,t,ctx);
let movie=resolved.movie;

if(!movie?.id){
return {
  category:'sonarr',
  originCategory:'sonarr',
  torrent:t.name,
  status:'STANDALONE_MOVIE_RADARR_NOT_FOUND',
  episodeId:qItem.episodeId,
  episodeTitle:episode?.title||null,
  seeders:seeds.count,
  seedersSource:seeds.source,
  keepSeeding,
  reason:resolved.reason
};
}

if(!movie.hasFile&&hasVideoNas(movie.path)){
const cmd=await api(RB,rh,'/api/v3/command',{
  method:'POST',
  body:JSON.stringify({name:'RescanMovie',movieId:movie.id})
});
await waitRadarrCommand(cmd?.id);
movie=await api(RB,rh,'/api/v3/movie/'+movie.id);
}

let transfer='EXISTS';
let destination=movie.path;

if(!movie.hasFile){
const sourceNas=String(t.content_path||'');
if(!canMapNas(sourceNas)){
  return {
    category:'sonarr',
    originCategory:'sonarr',
    torrent:t.name,
    status:'STANDALONE_MOVIE_UNEXPECTED_SOURCE',
    source:sourceNas,
    radarrId:movie.id,
    tmdbId:movie.tmdbId||resolved.hit?.tmdbId||null,
    seeders:seeds.count,
    seedersSource:seeds.source,
    keepSeeding
  };
}

const src=sourceVideo(localPath(sourceNas));
const dstDir=localPath(movie.path);
fs.mkdirSync(dstDir,{recursive:true});
const dst=path.join(dstDir,path.basename(src));
transfer=linkOrCopy(src,dst);
destination=localToNas(dst);

const cmd=await api(RB,rh,'/api/v3/command',{
  method:'POST',
  body:JSON.stringify({name:'RescanMovie',movieId:movie.id})
});
const done=await waitRadarrCommand(cmd?.id);
movie=await api(RB,rh,'/api/v3/movie/'+movie.id);

if(!movie.hasFile){
  return {
    category:'sonarr',
    originCategory:'sonarr',
    torrent:t.name,
    status:'STANDALONE_MOVIE_RADARR_RESCAN_NO_FILE',
    radarrId:movie.id,
    tmdbId:movie.tmdbId||resolved.hit?.tmdbId||null,
    transfer,
    destination,
    commandId:cmd?.id??null,
    commandStatus:done?.status??null,
    seeders:seeds.count,
    seedersSource:seeds.source,
    keepSeeding
  };
}
}

const finish=await finishRecoveredTorrent(t,keepSeeding,'seed-radarr');
return {
category:'radarr',
originCategory:'sonarr',
torrent:t.name,
status:keepSeeding
  ? 'SONARR_MOVIE_ROUTED_RADARR_PARKED_SEEDING'
  : 'SONARR_MOVIE_ROUTED_RADARR_TORRENT_REMOVED',
radarrId:movie.id,
title:movie.title,
tmdbId:movie.tmdbId||resolved.hit?.tmdbId||null,
episodeId:qItem.episodeId,
episodeTitle:episode?.title||null,
transfer,
destination,
hasFile:Boolean(movie.hasFile),
seeders:seeds.count,
seedersSource:seeds.source,
threshold:SEEDER_THRESHOLD,
keepSeeding,
...finish
};
}

async function recoverSonarrSingleFile(t,ctx,evidence,seeds,keepSeeding){
if(Number(evidence.sourceVideoCount)!==1) return null;

const hash=String(t.hash||'').toLowerCase();
const qItem=(ctx.sonarrQueue?.records||[]).find(
x=>String(x.downloadId||'').toLowerCase()===hash
);

if(!qItem?.seriesId||!qItem?.episodeId) return null;
if(String(qItem.status||'').toLowerCase()!=='completed') return null;

const state=String(qItem.trackedDownloadState||'').toLowerCase();
const trackedStatus=String(qItem.trackedDownloadStatus||'').toLowerCase();
if(state!=='importpending'&&trackedStatus!=='warning') return null;

let episode=await api(SB,sh,'/api/v3/episode/'+qItem.episodeId);

if(episode?.hasFile){
const finish=await finishRecoveredTorrent(t,keepSeeding,'seed-sonarr');
return {
  category:'sonarr',
  torrent:t.name,
  status:keepSeeding
    ? 'SONARR_SINGLE_FILE_ALREADY_IMPORTED_PARKED_SEEDING'
    : 'SONARR_SINGLE_FILE_ALREADY_IMPORTED_TORRENT_REMOVED',
  seriesId:qItem.seriesId,
  episodeId:qItem.episodeId,
  seasonNumber:episode.seasonNumber,
  episodeNumber:episode.episodeNumber,
  episodeTitle:episode.title,
  seeders:seeds.count,
  seedersSource:seeds.source,
  threshold:SEEDER_THRESHOLD,
  keepSeeding,
  ...finish
};
}

const movieLike=
Number(episode?.seasonNumber)===0 &&
/\bmovie\b/i.test(String(episode?.title||''));

if(movieLike){
return routeSonarrStandaloneMovie(t,ctx,qItem,episode,seeds,keepSeeding);
}

const src=sourceVideo(localPath(String(t.content_path||'')));
const srcNas=localToNas(src);
const grabbed=(ctx.sonarrHistory?.records||[]).find(
x=>historyDownloadId(x)===hash&&String(x.eventType||'').toLowerCase()==='grabbed'
);

if(!qItem.quality){
return {
  category:'sonarr',
  torrent:t.name,
  status:'SONARR_MANUAL_IMPORT_MISSING_QUALITY',
  seriesId:qItem.seriesId,
  episodeId:qItem.episodeId,
  source:srcNas,
  seeders:seeds.count,
  seedersSource:seeds.source,
  keepSeeding
};
}

const file={
path:srcNas,
seriesId:Number(qItem.seriesId),
episodeIds:[Number(qItem.episodeId)],
quality:qItem.quality,
languages:Array.isArray(qItem.languages)?qItem.languages:[]
};

const releaseGroup=String(grabbed?.data?.releaseGroup||'').trim();
if(releaseGroup) file.releaseGroup=releaseGroup;

const cmd=await api(SB,sh,'/api/v3/command',{
method:'POST',
body:JSON.stringify({
  name:'ManualImport',
  importMode:'copy',
  files:[file]
})
});

const done=await waitSonarrCommand(cmd?.id);
episode=await api(SB,sh,'/api/v3/episode/'+qItem.episodeId);

if(!episode?.hasFile){
return {
  category:'sonarr',
  torrent:t.name,
  status:'SONARR_MANUAL_IMPORT_NO_FILE',
  seriesId:qItem.seriesId,
  episodeId:qItem.episodeId,
  seasonNumber:episode?.seasonNumber??null,
  episodeNumber:episode?.episodeNumber??null,
  episodeTitle:episode?.title??null,
  source:srcNas,
  commandId:cmd?.id??null,
  commandStatus:done?.status??null,
  commandMessage:done?.message??null,
  seeders:seeds.count,
  seedersSource:seeds.source,
  keepSeeding
};
}

const finish=await finishRecoveredTorrent(t,keepSeeding,'seed-sonarr');
return {
category:'sonarr',
torrent:t.name,
status:keepSeeding
  ? 'SONARR_MANUAL_IMPORTED_PARKED_SEEDING'
  : 'SONARR_MANUAL_IMPORTED_TORRENT_REMOVED',
seriesId:qItem.seriesId,
episodeId:qItem.episodeId,
seasonNumber:episode.seasonNumber,
episodeNumber:episode.episodeNumber,
episodeTitle:episode.title,
source:srcNas,
commandId:cmd?.id??null,
commandStatus:done?.status??null,
commandMessage:done?.message??null,
hasFile:Boolean(episode.hasFile),
seeders:seeds.count,
seedersSource:seeds.source,
threshold:SEEDER_THRESHOLD,
keepSeeding,
...finish
};
}

async function processRadarr(t,ctx){
const {radarrHistory,radarrMovies,radarrQueue}=ctx;
const hash=String(t.hash||'').toLowerCase();
const qItem=(radarrQueue?.records||[]).find(x=>String(x.downloadId||'').toLowerCase()===hash);
const linkedHistory=(radarrHistory?.records||[]).filter(x=>historyDownloadId(x)===hash);
const grabbed=linkedHistory.find(x=>String(x.eventType||'').toLowerCase()==='grabbed');
const movieId=Number(qItem?.movieId||grabbed?.movieId||linkedHistory.find(x=>Number(x.movieId)>0)?.movieId||0);
const seeds=seederInfo(t);
const c411=isC411Torrent(t,radarrHistory?.records||[],21)||hasQbitTag(t,'seed-c411');
if(c411) await ensureC411Tag(t);
const keepSeeding=c411||!seeds.known||seeds.count<SEEDER_THRESHOLD;

if(!movieId) return {category:'radarr',torrent:t.name,status:'SKIP_NO_MOVIE_MATCH',seeders:seeds.count,seedersSource:seeds.source};

let movie=radarrMovies.find(m=>Number(m.id)===movieId);
if(!movie) return {category:'radarr',torrent:t.name,movieId,status:'SKIP_MOVIE_NOT_FOUND',seeders:seeds.count,seedersSource:seeds.source};

try{
if(movie.hasFile){
  const sameReleaseInLibrary=Boolean(movie.movieFile?.path)&&
    path.posix.basename(String(movie.movieFile.path))===path.posix.basename(String(t.content_path||''));
  if(keepSeeding||sameReleaseInLibrary){
    await parkTorrent(t,'seed-radarr');
    return {category:'radarr',torrent:t.name,movieId,title:movie.title,status:'ALREADY_IMPORTED_PARKED_SEEDING',seeders:seeds.count,seedersSource:seeds.source,threshold:SEEDER_THRESHOLD,keepSeeding:true,parked:true};
  }
  await removeTorrent(t);
  return {category:'radarr',torrent:t.name,movieId,title:movie.title,status:'ALREADY_IMPORTED_TORRENT_REMOVED',seeders:seeds.count,seedersSource:seeds.source,threshold:SEEDER_THRESHOLD,keepSeeding:false,qbitRemoved:true};
}

const originalSource=String(t.content_path||'');
if(!isAllowedRadarrPath(originalSource)){
  return {category:'radarr',torrent:t.name,movieId,title:movie.title,status:'SKIP_UNEXPECTED_SOURCE',source:originalSource,seeders:seeds.count,seedersSource:seeds.source};
}

const sourceNas=originalSource;
const src=sourceVideo(localPath(sourceNas));
const dstDir=localPath(movie.path);
fs.mkdirSync(dstDir,{recursive:true});
const dst=path.join(dstDir,path.basename(src));

let transfer='EXISTS';
if(!fs.existsSync(dst)){
  if(keepSeeding){
    transfer=linkOrCopy(src,dst);
    if(transfer==='COPY') transfer='COPY_KEEP_SEEDING';
    else if(transfer==='HARDLINK') transfer='HARDLINK_KEEP_SEEDING';
  }else{
    moveWithoutSeeding(src,dst);
    transfer='MOVE_NO_SEED';
  }
}

const radCmd=await api(RB,rh,'/api/v3/command',{method:'POST',body:JSON.stringify({name:'RescanMovie',movieId})});
const command=await waitRadarrCommand(radCmd?.id);
movie=await api(RB,rh,'/api/v3/movie/'+movieId);

let qbitRemoved=false;
let parked=false;
if(movie.hasFile&&!keepSeeding){
  await removeTorrent(t);
  qbitRemoved=true;
}else if(movie.hasFile&&keepSeeding){
  await parkTorrent(t,'seed-radarr');
  parked=true;
}

return {
  category:'radarr',torrent:t.name,movieId,title:movie.title,
  status:movie.hasFile?(keepSeeding?'IMPORTED_PARKED_SEEDING':'IMPORTED_TORRENT_REMOVED'):'RESCAN_NO_FILE',
  originalSource,source:sourceNas,transfer,destination:movie.path,
  commandId:radCmd?.id??null,commandStatus:command?.status??null,hasFile:Boolean(movie.hasFile),
  seeders:seeds.count,seedersSource:seeds.source,threshold:SEEDER_THRESHOLD,keepSeeding,qbitRemoved,parked
};
}catch(e){
return {category:'radarr',torrent:t.name,movieId,title:movie.title,status:'ERROR',seeders:seeds.count,seedersSource:seeds.source,error:e.message};
}
}


const C411_RECOVERY_BATCH_SIZE=8;
function c411SeriesTitleMatches(torrentTitle,series){
const torrent=normTitle(torrentTitle);
const aliases=[String(series?.title||''),
...(Array.isArray(series?.alternateTitles)?series.alternateTitles.map(a=>String(a?.title||'')):[])];
if(/^Buffy the Vampire Slayer$/i.test(String(series?.title||''))) aliases.push('Buffy Contre Les Vampires');
if(/^City Hunter$/i.test(String(series?.title||''))) aliases.push('Nicky Larson');
if(/^The Pretender$/i.test(String(series?.title||''))) aliases.push('Le Cameleon');
const matches=aliases.map(normTitle).filter(s=>s.length>=5);
const titleOK=matches.some(s=>torrent===s||torrent.startsWith(s+' '));
const expectedYear=Number(series?.year||0);
const releaseYear=yearFromText(torrentTitle);
return titleOK && (!releaseYear||!expectedYear||Math.abs(expectedYear-releaseYear)<=1);
}
async function previewC411Import(t,qItem){
const folder=String(t.content_path||'');
const hash=String(qItem?.downloadId||'').trim();
if(!folder||!hash) return [];
const url='/api/v3/manualimport?folder='+encodeURIComponent(folder)+
'&downloadId='+encodeURIComponent(hash)+'&filterExistingFiles=false';
const r=await fetch(SB+url,{
headers:sh,
signal:AbortSignal.timeout(90000)
});
const txt=await r.text();
if(!r.ok) throw new Error('C411_MANUAL_PREVIEW_HTTP_'+r.status+' '+txt.slice(0,280));
const rows=JSON.parse(txt);
return Array.isArray(rows)?rows:[];
}
async function recoverSonarrC411Integral(t,ctx,evidence,seeds,keepSeeding){
if(!hasQbitTag(t,'seed-c411')||Number(t.progress)!==1) return null;
if(ctx.c411ManualImportBusy) return null;
const hash=String(t.hash||'').toLowerCase();
if(VERIFIED_OP_C411_PACKS[hash])return null; // Use verified absolute-number recovery instead of Sonarr's wrong season preview.
if(!ctx.c411RecoveryHashes?.has(hash)) return null;
const qItem=(ctx.sonarrQueue?.records||[]).find(
x=>String(x.downloadId||'').toLowerCase()===hash
);
if(!qItem||!['importblocked','importpending'].includes(
String(qItem.trackedDownloadState||'').toLowerCase()
)) return null;
const folder=String(t.content_path||'');
if(!canMapNas(folder)||!existsNas(folder)) return {
category:'sonarr',torrent:t.name,status:'C411_IMPORT_SOURCE_UNAVAILABLE',
source:folder,keepSeeding,seeders:seeds.count
};
const rows=await previewC411Import(t,qItem);
if(!rows.length) return {
category:'sonarr',torrent:t.name,status:'C411_IMPORT_PREVIEW_EMPTY',
source:folder,keepSeeding,seeders:seeds.count
};
const candidates=rows.filter(x=>x?.series?.id&&Array.isArray(x.episodes)&&x.episodes.length);
const distinctSeries=[...new Set(candidates.map(x=>Number(x.series.id)))];
if(distinctSeries.length!==1) return {
category:'sonarr',torrent:t.name,status:'C411_IMPORT_AMBIGUOUS_SERIES',
source:folder,matchedSeries:distinctSeries,previewCount:rows.length,
keepSeeding,seeders:seeds.count
};
const seriesId=distinctSeries[0];
const series=(ctx.sonarrSeries||[]).find(s=>Number(s.id)===seriesId);
const titleTokens=series?[
String(series.title||''),
...(Array.isArray(series.alternateTitles)?series.alternateTitles.map(a=>String(a.title||'')):[])
].map(normTitle).filter(a=>a.length>=5):[];
const everyFileNamesSameSeries=Boolean(series)&&rows.length>=5&&candidates.length===rows.length
&& rows.every(x=>{
  const fileTitle=normTitle(path.posix.basename(String(x.path||'')));
  const matches=titleTokens.some(a=>fileTitle===a||fileTitle.startsWith(a+' '));
  const date=yearFromText(path.posix.basename(String(x.path||'')));
  return matches&&(!date||Math.abs(date-Number(series.year||0))<=1);
});
if(!series||(!c411SeriesTitleMatches(t.name,series)&&!everyFileNamesSameSeries)) return {
category:'sonarr',torrent:t.name,status:'C411_IMPORT_TITLE_MISMATCH',
candidateSeries:series?.title||null,seriesId,
previewCount:rows.length,keepSeeding,seeders:seeds.count
};
const episodeRows=await api(SB,sh,'/api/v3/episode?seriesId='+seriesId);
const episodeMap=new Map((Array.isArray(episodeRows)?episodeRows:[])
.map(e=>[Number(e.id),e]));
const ready=[];
const seen=new Set();
let physicallyPresentButUnindexed=0;
for(const x of candidates){
const p=String(x.path||'');
if(!p.startsWith(folder+'/')||!canMapNas(p)||!existsNas(p)) continue;
if(!x.quality?.quality?.id||!Array.isArray(x.languages)||!x.languages.length) continue;
if((x.rejections||[]).length) continue;
const ids=x.episodes.map(e=>Number(e.id));
if(!ids.length||ids.some(id=>!episodeMap.has(id))) continue;
if(ids.some(id=>Number(episodeMap.get(id).seasonNumber)===0)) continue;
if(ids.some(id=>episodeMap.get(id).hasFile||seen.has(id))) continue;
const firstEp=episodeMap.get(ids[0]);
const expectedFolder=path.posix.join(String(series.path||''),'Season '+String(firstEp.seasonNumber));
const expectedFile=path.posix.join(expectedFolder,path.posix.basename(p));
if(series.path&&existsNas(expectedFile)){
  physicallyPresentButUnindexed++;
  continue;
}
if(x.episodes.some(e=>Number(e.seriesId||seriesId)!==seriesId)) continue;
for(const id of ids) seen.add(id);
ready.push({
  path:p,seriesId,episodeIds:ids,
  quality:x.quality,languages:x.languages,
  releaseGroup:String(x.releaseGroup||''),
  folderName:String(t.name||''),
  indexerFlags:Number(x.indexerFlags||0),
  releaseType:x.releaseType||'singleEpisode'
});
if(ready.length>=C411_RECOVERY_BATCH_SIZE) break;
}
if(!ready.length){
const allAccountedFor=rows.length===Number(evidence.sourceVideoCount)
  && rows.every(x=>Number(x.series?.id)===seriesId&&Array.isArray(x.episodes)
    && x.episodes.length>0&&x.episodes.every(e=>episodeMap.get(Number(e.id))?.hasFile));
if(allAccountedFor){
  const finish=await finishRecoveredTorrent(t,keepSeeding,'seed-sonarr');
  return {
    category:'sonarr',torrent:t.name,status:'C411_PACK_IMPORTED_PARKED_SEEDING',
    seriesId,seriesTitle:series.title,previewCount:rows.length,
    keepSeeding,seeders:seeds.count,sourceVideoCount:evidence.sourceVideoCount,
    ...finish
  };
}
if(physicallyPresentButUnindexed>0){
  const stateFile='/home/node/.n8n/.sonarr-c411-rescan-state.json';
  let last={};
  try{last=JSON.parse(fs.readFileSync(stateFile,'utf8'))||{}}catch{}
  const previous=Number(last[String(seriesId)]||0);
  const now=Date.now();
  if(now-previous>=30*60*1000){
    const rescan=await api(SB,sh,'/api/v3/command',{
      method:'POST',body:JSON.stringify({name:'RescanSeries',seriesId})
    });
    last[String(seriesId)]=now;
    try{fs.writeFileSync(stateFile,JSON.stringify(last))}catch{}
    return {
      category:'sonarr',torrent:t.name,status:'C411_RESCAN_SUBMITTED',
      seriesId,seriesTitle:series.title,commandId:rescan?.id??null,
      physicallyPresentButUnindexed,keepSeeding:true,seeders:seeds.count
    };
  }
  return {
    category:'sonarr',torrent:t.name,status:'C411_AWAITING_RESCAN',
    seriesId,seriesTitle:series.title,physicallyPresentButUnindexed,
    keepSeeding:true,seeders:seeds.count
  };
}
return {
  category:'sonarr',torrent:t.name,status:'C411_NO_SAFE_MISSING_EPISODES',
  seriesId,seriesTitle:series.title,previewCount:rows.length,
  keepSeeding,seeders:seeds.count,sourceVideoCount:evidence.sourceVideoCount
};
}
const command=await api(SB,sh,'/api/v3/command',{
method:'POST',
body:JSON.stringify({name:'ManualImport',importMode:'copy',files:ready})
});
return {
category:'sonarr',torrent:t.name,status:'C411_MANUAL_IMPORT_SUBMITTED',
seriesId,seriesTitle:series.title,previewCount:rows.length,
submitted:ready.length,episodeIds:ready.flatMap(x=>x.episodeIds),
commandId:command?.id??null,keepSeeding:true,
seeders:seeds.count,sourceVideoCount:evidence.sourceVideoCount,
message:'Sonarr import en cours, verification au prochain cycle'
};
}


/* SynoPlex: conservative recovery of completed, unparsed Sonarr season packs.
 * Files must be mapped to a uniquely identified Sonarr series AND episode.
 * Never infer a season from a release year, never import specials or duplicates.
 */
const SAFE_PACK_RECOVERY_DRY_RUN=false;
const SAFE_PACK_BATCH_SIZE=16;
const SAFE_PACK_STATE_FILE='/home/node/.n8n/.synoplex-sonarr-pack-jobs.json';
function readSafePackState(){
try{const v=JSON.parse(fs.readFileSync(SAFE_PACK_STATE_FILE,'utf8'));return v&&typeof v==='object'?v:{}}catch{return {};}
}
function saveSafePackState(state){
const temp=SAFE_PACK_STATE_FILE+'.tmp';
fs.writeFileSync(temp,JSON.stringify(state));
fs.renameSync(temp,SAFE_PACK_STATE_FILE);
}


function safePackSeriesAliases(s){
const result=[String(s.title||''),...(Array.isArray(s.alternateTitles)?s.alternateTitles.map(x=>String(x.title||'')):[])];
if(/^The Pretender$/i.test(String(s.title||''))) result.push('Le Caméléon','Le Cameleon');
if(/^City Hunter$/i.test(String(s.title||''))) result.push('Nicky Larson');
return [...new Set(result.map(normTitle).filter(x=>x.length>=5))];
}
function safePackSeriesMatches(t,s){
const title=normTitle(t.name);
const releaseYear=yearFromText(t.name),seriesYear=Number(s.year||0);
if(releaseYear&&seriesYear&&Math.abs(releaseYear-seriesYear)>1)return false;
return safePackSeriesAliases(s).some(a=>title===a||title.startsWith(a+' '));
}
function safePackEpisodeNumber(base){
const m=base.match(/(?:^|[^a-z0-9])(?:e(?:p(?:isode)?)?)[ ._-]?(\d{1,3})(?!\d)/i);
return m?Number(m[1]):null;
}
// Five C411 One Piece packs explicitly verified against torrent metadata and Sonarr TVDB 81797.
// Release season numbering differs from Sonarr season numbering. NEVER use SxxEyy directly
// for these hashes: resolve only by anime absolute episode numbers.
const VERIFIED_OP_C411_PACKS=Object.freeze({
'fc854452fe679f1768593ffb4a7ccc439019de25':{s:12,start:408,end:421,count:14},
'121ba4a952e65c494924ae2e0db1aff26b59cdce':{s:13,start:422,end:456,count:35},
'02eb237545b11b940bf125e4fd12d9ff2684d842':{s:14,start:457,end:516,count:59},
'cd86b56e8a06ae017befc04892d248260fa45499':{s:15,start:517,end:574,count:57},
'5f78edcdef348863af47d137b9e92b540ee86f7f':{s:16,start:575,end:628,count:53}
});
function verifiedOnePieceC411Episode(t,basename,episodes,series){
 const spec=VERIFIED_OP_C411_PACKS[String(t?.hash||'').toLowerCase()];
 if(!spec||Number(series?.tvdbId)!==81797||Number(series?.year)!==1999||
    String(series?.title||'')!=='One Piece')return null;
 let absolute=0;
 if(spec.s===16){
   const m=String(basename).match(/^One[.]Piece[.]E(\d{3})(?=[.]|$)/i);
   absolute=m?Number(m[1]):0;
 }else{
   const m=String(basename).match(/^One[.]Piece[.]S(\d{2})E(\d{2,3})(?=[.]|$)/i);
   if(!m||Number(m[1])!==spec.s)return null;
   absolute=spec.start+Number(m[2])-1;
 }
 if(absolute<spec.start||absolute>spec.end)return null;
 const hits=episodes.filter(e=>Number(e.seasonNumber)>0&&Number(e.absoluteEpisodeNumber)===absolute);
 return hits.length===1?hits[0]:null;
}

function safePackEpisodeMatch(base,episodes,series){
let m=base.match(/(?:^|[^a-z0-9])S(\d{1,2})[ ._-]*E(\d{1,3})(?!\d)/i);
if(!m)m=base.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?!\d)/i);
if(m){
if(/E\d{1,3}[\s._-]*(?:E|&|\+)\d{1,3}/i.test(base))return null;
const season=Number(m[1]),number=Number(m[2]);
if(season===0)return null;
return episodes.find(e=>Number(e.seasonNumber)===season&&Number(e.episodeNumber)===number)||null;
}
const absolute=safePackEpisodeNumber(base);
if(!absolute)return null;
const regular=episodes.filter(e=>Number(e.seasonNumber)>0);
const seasons=[...new Set(regular.map(e=>Number(e.seasonNumber)))];
if(seasons.length===1){
return regular.find(e=>Number(e.episodeNumber)===absolute)||null;
}
if(normTitle(series.title)==='slam dunk'&&Number(series.year)===1993){
const hits=regular.filter(e=>Number(e.absoluteEpisodeNumber)===absolute);
return hits.length===1?hits[0]:null;
}
return null;
}
async function safePackPreview(t,qItem){
let rows=[];
try{
if(qItem?.downloadId) rows=await previewC411Import(t,qItem);
if(!rows.length){
  const url='/api/v3/manualimport?folder='+encodeURIComponent(String(t.content_path||''))+'&filterExistingFiles=false';
  const fetched=await api(SB,sh,url);
  rows=Array.isArray(fetched)?fetched:[];
}
}catch(e){return {rows:[],error:String(e.message)};}
return {rows,error:null};
}
function safePackQualityFromFilename(filename,definitions){
const base=String(filename||'');
const resolution=base.match(/(?:^|[.\s_-])(480|720|1080|2160)p(?:[.\s_-]|$)/i)?.[1];
if(!resolution)return null;
const name=String(base).toLowerCase();
let sources=[];
if(/\b(?:webdl|web-dl)\b/i.test(base)) sources=['webdl'];
else if(/\bwebrip\b/i.test(base)) sources=['webrip'];
else if(/(?:^|[.\s_-])web(?:[.\s_-]|$)/i.test(base)) sources=['webrip','webdl'];
else if(/\bbluray\b/i.test(base)) sources=['bluray'];
else if(/\bhdtv\b/i.test(base)) sources=['hdtv'];
else if(/\bdvdrip\b|\bdvd\b/i.test(base)) sources=['dvd'];
if(!sources.length)return null;
const defs=Array.isArray(definitions)?definitions:[];
for(const source of sources){
const found=defs.find(x=>{
  const q=x?.quality;
  if(!q?.id)return false;
  const label=String(q.name||'').toLowerCase().replace(/[\s._-]/g,'');
  return label.includes(source)&&label.includes(resolution+'p');
});
if(found){
  return {quality:found.quality,revision:{version:1,real:0}};
}
}
return null;
}

async function recoverSonarrUnparsedIntegral(t,ctx,evidence,seeds,keepSeeding){
if(Number(evidence.sourceVideoCount)<2||Number(t.progress)!==1)return null;
const hash=String(t.hash||'').toLowerCase();
if(!ctx.safePackRecoveryHashes?.has(hash))return null;
if(ctx.c411ManualImportBusy||ctx.safePackSubmitted)return {
category:'sonarr',torrent:t.name,status:'PACK_IMPORT_DEFERRED',
reason:ctx.c411ManualImportBusy?'SONARR_IMPORT_BUSY':'BATCH_ALREADY_SUBMITTED',
sourceVideoCount:evidence.sourceVideoCount,keepSeeding:true
};
if(!canMapNas(String(t.content_path||''))||!existsNas(String(t.content_path||''))){
return {category:'sonarr',torrent:t.name,status:'PACK_SOURCE_UNAVAILABLE',source:t.content_path};
}
const matched=(ctx.sonarrSeries||[]).filter(s=>safePackSeriesMatches(t,s));
if(!matched.length)return {category:'sonarr',torrent:t.name,status:'PACK_SERIES_NOT_FOUND',sourceVideoCount:evidence.sourceVideoCount};
if(matched.length!==1)return {category:'sonarr',torrent:t.name,status:'PACK_MULTIPLE_SERIES_MATCH',seriesIds:matched.map(s=>s.id)};
const series=matched[0];
const verifiedPack=VERIFIED_OP_C411_PACKS[hash]||null;
if(verifiedPack&&(Number(series.tvdbId)!==81797||Number(series.year)!==1999||Number(evidence.sourceVideoCount)!==verifiedPack.count))return {
category:'sonarr',torrent:t.name,status:'ONE_PIECE_VERIFIED_PACK_GUARD_FAILED',
seriesId:series.id,sourceVideoCount:evidence.sourceVideoCount,expectedCount:verifiedPack.count,keepSeeding:true
};
const aclReadyNas=path.posix.join(path.posix.dirname(String(series.path||'')),'.synoplex-sonarr-acl-ready');
if(!ctx.sonarrAclCache)ctx.sonarrAclCache=new Map();
if(!ctx.sonarrAclCache.has(aclReadyNas)){
let markerVerified=existsNas(aclReadyNas);
let checkedVia=markerVerified?'n8n':'sonarr';
let probeError=null;
if(!markerVerified){
  try{
    const directory=path.posix.dirname(aclReadyNas)+'/';
    const listing=await api(SB,sh,'/api/v3/filesystem?path='+encodeURIComponent(directory)+'&includeFiles=true');
    markerVerified=Array.isArray(listing?.files)&&listing.files.some(
      f=>String(f?.name||'')===path.posix.basename(aclReadyNas)
    );
  }catch(e){probeError=e.message;}
}
ctx.sonarrAclCache.set(aclReadyNas,{markerVerified,checkedVia,probeError});
}
const aclState=ctx.sonarrAclCache.get(aclReadyNas);
if(!aclState.markerVerified)return {
category:'sonarr',torrent:t.name,status:'PACK_NAS_ACL_NOT_VERIFIED',
seriesId:series.id,seriesTitle:series.title,sourceVideoCount:evidence.sourceVideoCount,
expectedMarker:aclReadyNas,verificationMethod:aclState.checkedVia,
verificationError:aclState.probeError||undefined,keepSeeding:true
};
const eps=await api(SB,sh,'/api/v3/episode?seriesId='+Number(series.id)+'&includeImages=false');
const episodes=Array.isArray(eps)?eps:[];
const files=Array.isArray(evidence.sourceFiles)?evidence.sourceFiles:[];
const mapping=[],unmatched=[],seenIds=new Set();
for(const local of files){
const filename=path.basename(local);
const nas=localToNas(local);
const root=String(t.content_path||'').replace(/\/$/,'');
if(nas!==root&&!nas.startsWith(root+'/')){unmatched.push(filename);continue;}
if(explicitExtraFile(filename)){unmatched.push(filename);continue;}
const ep=verifiedPack?verifiedOnePieceC411Episode(t,filename,episodes,series):safePackEpisodeMatch(filename,episodes,series);
if(!ep||!ep.id){unmatched.push(filename);continue;}
if(seenIds.has(Number(ep.id))){unmatched.push(filename);continue;}
seenIds.add(Number(ep.id));
mapping.push({path:nas,filename,episode:ep});
}
if(verifiedPack&&(unmatched.length||mapping.length!==verifiedPack.count))return {
category:'sonarr',torrent:t.name,status:'ONE_PIECE_ABSOLUTE_MAPPING_INCOMPLETE',
mappedCount:mapping.length,unmatchedCount:unmatched.length,expectedCount:verifiedPack.count,
sampleUnmatched:unmatched.slice(0,5),keepSeeding:true
};
if(!mapping.length)return {
category:'sonarr',torrent:t.name,status:'PACK_EPISODE_NUMBERS_UNRECOGNIZED',
seriesId:series.id,seriesTitle:series.title,sourceVideoCount:evidence.sourceVideoCount,
sampleUnmatched:unmatched.slice(0,5),keepSeeding:true
};
const readyCandidates=mapping.filter(x=>!x.episode.hasFile);
const previousJobs=readSafePackState();
const previous=previousJobs[hash];
if(previous&&Array.isArray(previous.episodeIds)&&previous.episodeIds.length){
const verified=previous.episodeIds.filter(id=>episodes.some(e=>Number(e.id)===Number(id)&&e.hasFile)).length;
if(verified<previous.episodeIds.length)return {
  category:'sonarr',torrent:t.name,status:'PACK_IMPORT_UNCONFIRMED',
  seriesId:series.id,seriesTitle:series.title,commandId:previous.commandId??null,
  requested:previous.episodeIds.length,verified,submittedAt:previous.submittedAt,
  message:'Sonarr did not confirm all files from the previous import command; retry suppressed',
  keepSeeding:true
};
delete previousJobs[hash];
saveSafePackState(previousJobs);
}
if(!readyCandidates.length){
if(unmatched.length)return {
  category:'sonarr',torrent:t.name,status:'PACK_EPISODES_PRESENT_EXTRAS_PENDING',
  seriesId:series.id,seriesTitle:series.title,matchedCount:mapping.length,unmatchedCount:unmatched.length,
  keepSeeding:true,sampleUnmatched:unmatched.slice(0,5)
};
if(SAFE_PACK_RECOVERY_DRY_RUN)return {
  category:'sonarr',torrent:t.name,status:'PACK_ALL_EPISODES_PRESENT_DRY_RUN',
  seriesId:series.id,seriesTitle:series.title,matchedCount:mapping.length,keepSeeding
};
const finish=await finishRecoveredTorrent(t,keepSeeding,'seed-sonarr');
return {category:'sonarr',torrent:t.name,status:'PACK_ALL_EPISODES_PRESENT',
  seriesId:series.id,seriesTitle:series.title,matchedCount:mapping.length,keepSeeding,...finish};
}
const qItem=(ctx.sonarrQueue?.records||[]).find(x=>String(x.downloadId||'').toLowerCase()===hash);
const preview=await safePackPreview(t,qItem);
const byPath=new Map(preview.rows.map(x=>[String(x.path||''),x]));
const batch=readyCandidates.slice(0,SAFE_PACK_BATCH_SIZE);
const filesToImport=[],missingQuality=[],blocked=[];
if(!ctx.safePackQualityDefinitions){
const defs=await api(SB,sh,'/api/v3/qualitydefinition').catch(()=>[]);
ctx.safePackQualityDefinitions=Array.isArray(defs)?defs:[];
}
for(const item of batch){
const row=byPath.get(item.path);
// For the five verified One Piece hashes, Sonarr's preview can reject valid
// files because its season numbering differs. Explicit hash+filename+TVDB
// mapping above is authoritative; quality is taken from the file definition.
if(verifiedPack){
  const quality=(row?.quality?.quality?.id?row.quality:safePackQualityFromFilename(item.filename,ctx.safePackQualityDefinitions));
  if(!quality){missingQuality.push(item.filename);continue;}
  if(!existsNas(item.path)){blocked.push(item.filename);continue;}
  filesToImport.push({path:item.path,seriesId:Number(series.id),episodeIds:[Number(item.episode.id)],
    quality,languages:Array.isArray(row?.languages)?row.languages:[],
    releaseGroup:verifiedPack.s===16?'AMB3R':'HANAMi',folderName:String(t.name||''),
    indexerFlags:0,releaseType:'singleEpisode'});
  continue;
}
if(!row){blocked.push(item.filename);continue;}
const quality=row.quality?.quality?.id?row.quality:(qItem?.quality?.quality?.id?qItem.quality:safePackQualityFromFilename(item.filename,ctx.safePackQualityDefinitions));
if(!quality){missingQuality.push(item.filename);continue;}
if(!existsNas(item.path)){blocked.push(item.filename);continue;}
const hard=(row.rejections||[]).filter(r=>
  !/unable to parse|unknown series|series not found|episode not found|no matching episode|no episodes found|unable to identify|not found in the grabbed release/i.test(String(r.reason||r.message||r)));
if(hard.length){blocked.push(item.filename);continue;}
filesToImport.push({
  path:item.path,seriesId:Number(series.id),episodeIds:[Number(item.episode.id)],
  quality,languages:Array.isArray(row.languages)?row.languages:[],
  releaseGroup:String(row.releaseGroup||''),folderName:String(t.name||''),
  indexerFlags:Number(row.indexerFlags||0),releaseType:row.releaseType||'singleEpisode'
});
}
const base={
category:'sonarr',torrent:t.name,seriesId:series.id,seriesTitle:series.title,
sourceVideoCount:evidence.sourceVideoCount,mappedCount:mapping.length,
alreadyInSonarr:mapping.length-readyCandidates.length,remaining:readyCandidates.length,
unmatchedCount:unmatched.length,previewCount:preview.rows.length,
batchReady:filesToImport.length,missingQuality:missingQuality.length,blocked:blocked.length,
keepSeeding:true,previewError:preview.error||undefined,
sampleUnmatched:unmatched.slice(0,4),
sampleReady:filesToImport.slice(0,4).map(x=>({name:path.basename(x.path),episodeId:x.episodeIds[0],quality:x.quality?.quality?.name}))
};
if(SAFE_PACK_RECOVERY_DRY_RUN)return {...base,status:'PACK_RECOVERY_DRY_RUN'};
if(!filesToImport.length)return {...base,status:'PACK_MANUAL_PREVIEW_NEEDS_REVIEW',
sampleBlocked:blocked.slice(0,4),sampleMissingQuality:missingQuality.slice(0,4)};
const command=await api(SB,sh,'/api/v3/command',{
method:'POST',body:JSON.stringify({name:'ManualImport',importMode:'copy',files:filesToImport})
});
ctx.safePackSubmitted=true;
const saved=readSafePackState();
saved[hash]={commandId:command?.id??null,episodeIds:filesToImport.flatMap(x=>x.episodeIds),
submittedAt:new Date().toISOString(),seriesId:Number(series.id)};
saveSafePackState(saved);
return {...base,status:'PACK_MANUAL_IMPORT_SUBMITTED',submitted:filesToImport.length,commandId:command?.id??null};
}

async function processSonarr(t,ctx){
const seeds=seederInfo(t);
const c411=isC411Torrent(t,ctx.sonarrHistory?.records||[],0)||hasQbitTag(t,'seed-c411');
if(c411) await ensureC411Tag(t);
const keepSeeding=c411||!seeds.known||seeds.count<SEEDER_THRESHOLD;
const evidence=sonarrImportEvidence(t,ctx.sonarrHistory?.records||[]);

try{
if(!evidence.fullyImported){
  const singleRecovered=await recoverSonarrSingleFile(t,ctx,evidence,seeds,keepSeeding);
  if(singleRecovered) return singleRecovered;

  const safeIntegral=await recoverSonarrUnparsedIntegral(t,ctx,evidence,seeds,keepSeeding);
  if(safeIntegral) return safeIntegral;

  const packRecovered=await recoverSonarrCompletedPack(t,ctx,evidence,seeds,keepSeeding);
  if(packRecovered) return packRecovered;

  const c411Recovered=await recoverSonarrC411Integral(t,ctx,evidence,seeds,keepSeeding);
  if(c411Recovered) return c411Recovered;

  return {
    category:'sonarr',torrent:t.name,status:'WAITING_OR_INCOMPLETE_IMPORT',
    seeders:seeds.count,seedersSource:seeds.source,threshold:SEEDER_THRESHOLD,keepSeeding,
    source:String(t.content_path||''),sourceVideoCount:evidence.sourceVideoCount,
    importedCount:evidence.importedCount,historyMatches:evidence.historyMatches,
  };
}

if(keepSeeding){
  await parkTorrent(t,'seed-sonarr');
  return {
    category:'sonarr',torrent:t.name,status:'IMPORTED_PARKED_SEEDING',
    seeders:seeds.count,seedersSource:seeds.source,threshold:SEEDER_THRESHOLD,keepSeeding:true,parked:true,
    source:String(t.content_path||''),sourceVideoCount:evidence.sourceVideoCount,
    importedCount:evidence.importedCount
  };
}

await removeTorrent(t);
return {
  category:'sonarr',torrent:t.name,status:'IMPORTED_TORRENT_REMOVED',
  seeders:seeds.count,seedersSource:seeds.source,threshold:SEEDER_THRESHOLD,keepSeeding:false,
  source:String(t.content_path||''),sourceVideoCount:evidence.sourceVideoCount,
  importedCount:evidence.importedCount,qbitRemoved:true
};
}catch(e){
return {
  category:'sonarr',torrent:t.name,status:'ERROR',
  seeders:seeds.count,seedersSource:seeds.source,source:String(t.content_path||''),error:e.message
};
}
}


(async()=>{
if(!QB||!QU||!QP||!RB||!RK||!SB||!SK){
console.log(JSON.stringify({service:'media-smart-importer',ok:false,status:'CONFIG_MISSING'}));
return;
}

await qbitLogin();

const [torrents,radarrHistory,radarrMovies,radarrQueue,sonarrHistory,sonarrQueue,sonarrSeries,sonarrCommands]=await Promise.all([
api(QB,qh,'/api/v2/torrents/info'),
api(RB,rh,'/api/v3/history?page=1&pageSize=500&sortKey=date&sortDirection=descending'),
api(RB,rh,'/api/v3/movie'),
api(RB,rh,'/api/v3/queue?page=1&pageSize=200&includeUnknownMovieItems=true'),
api(SB,sh,'/api/v3/history?page=1&pageSize=1000&sortKey=date&sortDirection=descending'),
api(SB,sh,'/api/v3/queue?page=1&pageSize=500&includeUnknownSeriesItems=true'),
api(SB,sh,'/api/v3/series'),
api(SB,sh,'/api/v3/command').catch(()=>[{name:'ManualImport',status:'started'}])
]);

const hasTag=(t,tag)=>String(t.tags||'').split(',').some(x=>x.trim().toLowerCase()===tag);
const excluded=(t)=>hasTag(t,'xyzsubz');
const done=(Array.isArray(torrents)?torrents:[]).filter(t=>{
if(Number(t.progress)<1||excluded(t)) return false;
const category=String(t.category||'').toLowerCase();
return category==='radarr'||category==='sonarr';
});
const ctx={
radarrHistory,
radarrMovies:Array.isArray(radarrMovies)?radarrMovies:[],
radarrQueue,
sonarrHistory,
sonarrQueue,
sonarrSeries:Array.isArray(sonarrSeries)?sonarrSeries:[],
c411RecoveryHashes:new Set(),
c411ManualImportBusy:(Array.isArray(sonarrCommands)?sonarrCommands:[]).some(c=>
  /(manualimport|rescanseries)/i.test(String(c.name||''))&&
  ['started','queued'].includes(String(c.status||'').toLowerCase()))
};
const blocked=done.filter(t=>String(t.category)==='sonarr'&&hasQbitTag(t,'seed-c411')&&
!hasQbitTag(t,'seed-sonarr')&&
(sonarrQueue?.records||[]).some(q=>String(q.downloadId||'').toLowerCase()===String(t.hash||'').toLowerCase()&&
['importblocked','importpending'].includes(String(q.trackedDownloadState||'').toLowerCase())));
if(blocked.length&&!ctx.c411ManualImportBusy){
const offset=Math.floor(Date.now()/300000)%blocked.length;
for(let i=0;i<Math.min(2,blocked.length);i++){
  ctx.c411RecoveryHashes.add(String(blocked[(offset+i)%blocked.length].hash||'').toLowerCase());
}
}

const packCandidates=done.filter(t=>String(t.category)==='sonarr' &&
!hasQbitTag(t,'seed-sonarr')&&!hasQbitTag(t,'seed-radarr'));
const ROTATION_FILE='/home/node/.n8n/.synoplex-sonarr-pack-rotation.json';
let rotationState={};
try{rotationState=JSON.parse(fs.readFileSync(ROTATION_FILE,'utf8'))||{}}catch{}
const orderedPacks=[...packCandidates].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
const prev=orderedPacks.findIndex(x=>String(x.hash||'').toLowerCase()===String(rotationState.lastHash||'').toLowerCase());
const rotatedPacks=orderedPacks.slice(prev+1).concat(orderedPacks.slice(0,prev+1));
const packPriority=new Map(rotatedPacks.map((x,i)=>[String(x.hash||'').toLowerCase(),i]));
ctx.safePackRecoveryHashes=new Set(orderedPacks.map(x=>String(x.hash||'').toLowerCase()));
ctx.safePackSubmitted=false;

const results=[];
let relocationRequests=0;
const MAX_RELOCATIONS_PER_RUN=1;
const processingOrder=[...done].sort((a,b)=>{
const ia=packPriority.get(String(a.hash||'').toLowerCase());
const ib=packPriority.get(String(b.hash||'').toLowerCase());
return (ia??Number.MAX_SAFE_INTEGER)-(ib??Number.MAX_SAFE_INTEGER);
});
for(const t of processingOrder){
const state=String(t.state||'').toLowerCase();
const category=String(t.category||'') || (hasQbitTag(t,'seed-radarr')?'radarr':hasQbitTag(t,'seed-sonarr')?'sonarr':'unknown');
const seeds=seederInfo(t);
const isC411=hasQbitTag(t,'seed-c411') ||
  (category==='radarr'&&isC411Torrent(t,radarrHistory?.records||[],21));
const inMotion=state==='moving'||state.startsWith('checking');
if(inMotion){
  results.push({category,torrent:t.name,status:'MOVE_IN_PROGRESS_WAIT',state:t.state,keepSeeding:true,c411:isC411});
  continue;
}
const hash=String(t.hash||'').toLowerCase();
const record=(radarrHistory?.records||[]).filter(x=>historyDownloadId(x)===hash);
const qr=(radarrQueue?.records||[]).find(x=>String(x.downloadId||'').toLowerCase()===hash);
const movieId=Number(qr?.movieId||record.find(x=>Number(x.movieId)>0)?.movieId||0);
const movie=(radarrMovies||[]).find(x=>Number(x.id)===movieId);
const current=String(t.content_path||'');
const movieFolder=String(movie?.path||'').replace(/\/$/,'');
const destination=movieFolder?path.posix.join(movieFolder,path.posix.basename(current)):'';
const alreadyAtDestination=Boolean(destination)&&current===destination;
const relocationVerified=alreadyAtDestination&&Number(t.progress)===1&&
  !inMotion&&existsNas(destination);
const qbitRelocationState=hasQbitTag(t,'synoplex-moving');
if(category==='radarr'&&movie&&!movie.hasFile&&relocationVerified&&
  !hasQbitTag(t,'synoplex-rescan-requested')){
  try{
    const cmd=await api(RB,rh,'/api/v3/command',{
      method:'POST',body:JSON.stringify({name:'RescanMovie',movieId:movie.id})
    });
    await qbitForm('/api/v2/torrents/addTags',{hashes:t.hash,tags:'synoplex-rescan-requested'});
    results.push({category,torrent:t.name,status:'MOVE_COMPLETED_RADARR_RESCAN_REQUESTED',
      movieId,commandId:cmd?.id,keepSeeding:true,c411:isC411});
  }catch(e){results.push({category,torrent:t.name,status:'RESCAN_FAILED',error:e.message,keepSeeding:true});}
  continue;
}
if(category==='radarr'&&movie&&movie.hasFile&&
  String(movie.movieFile?.path||'')===current&&
  !inMotion&&Number(t.progress)===1&&existsNas(current)){
  if(!isC411&&seeds.known&&seeds.count>SEEDER_THRESHOLD&&
     !String(t.state||'').toLowerCase().includes('paused')&&
     !String(t.state||'').toLowerCase().includes('stopped')){
    try{
      await qbitForm('/api/v2/torrents/stop',{hashes:t.hash});
      results.push({category,torrent:t.name,status:'IMPORTED_SEED_PAUSED',seeders:seeds.count,keepSeeding:false,c411:false});
    }catch(e){results.push({category,torrent:t.name,status:'PAUSE_FAILED',error:e.message,keepSeeding:true});}
  }else results.push({category,torrent:t.name,status:'IMPORTED_SEED_PRESERVED',seeders:seeds.count,keepSeeding:true,c411:isC411});
  continue;
}
if(category==='radarr'&&movie&&!movie.hasFile&&
  movieFolder.startsWith(RADARR_ROOT+'/') &&
  current.startsWith('/volume1/downloads/') &&
  !qbitRelocationState &&
  !existsNas(destination) &&
  Number(t.progress)===1){
  try{
    const fileRows=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
    const one=Array.isArray(fileRows)&&fileRows.length===1?fileRows[0]:null;
    const name=String(one?.name||'');
    const isSingle=one&&name===path.posix.basename(current)&&
      videoExt.has(path.posix.extname(name).toLowerCase())&&
      Number(one.progress)===1&&!name.includes('/');
    const title=normTitle(movie.title||'');
    const release=normTitle(t.name||'');
    const titleMatches=title.length>=3&&(release===title||release.startsWith(title+' '));
    const year=yearFromText(t.name||'');
    const yearMatches=!year||Math.abs(Number(movie.year||0)-year)<=1;
    if(isSingle&&titleMatches&&yearMatches){
      await qbitForm('/api/v2/torrents/setLocation',{hashes:t.hash,location:movieFolder});
      await qbitForm('/api/v2/torrents/addTags',{hashes:t.hash,tags:'synoplex-moving'});
      results.push({category,torrent:t.name,status:'QBIT_MANAGED_CROSS_FS_RELOCATION_REQUESTED',movieId,
        destination,keepSeeding:true,c411:isC411});
      continue;
    }
  }catch(e){results.push({category,torrent:t.name,status:'QBIT_MOVE_ERROR',error:e.message,keepSeeding:true});continue;}
}
if(category==='sonarr'&&Number(t.progress)===1&&
   (current.startsWith('/volume1/downloads/')||
    current.startsWith('/volume1/VideoFactory/_Plex/media/Series/')||
    current.startsWith('/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/sonarr/'))){
  const release=normTitle(t.name);
  const candidates=(ctx.sonarrSeries||[]).filter(s=>{
    const name=normTitle(s.title);
    return name.length>=5&&(release===name||release.startsWith(name+' '))&&
      String(s.path||'').startsWith('/volume1/VideoFactory/_Plex/media/Series/');
  }).sort((a,b)=>normTitle(b.title).length-normTitle(a.title).length);
  const supernaturalPack=/^Supernatural\.COMPLETE\./i.test(String(t.name||''));
  const exactSupernatural=(ctx.sonarrSeries||[]).filter(s=>
    normTitle(String(s.title||'').replace(/\s*\(2005\)\s*$/,''))==='supernatural'&&
    String(s.path||'').startsWith('/volume1/VideoFactory/_Plex/media/Series/')
  );
  const normSeriesName=s=>normTitle(String(s||'').replace(/\s*\((?:19|20)\d{2}\)\s*$/,''));
  const normalizedRelease=normTitle(t.name);
  const titleMatches=(ctx.sonarrSeries||[]).filter(s=>{
    const name=normSeriesName(s.title);
    const path=String(s.path||'');
    return (name.length>=5||name==='24') && (normalizedRelease===name||normalizedRelease.startsWith(name+' ')) &&
      path.startsWith('/volume1/VideoFactory/_Plex/media/Series/');
  });
  const linkedQueue=(sonarrQueue?.records||[]).filter(q=>
    String(q.downloadId||'').toLowerCase()===hash&&Number(q.seriesId)>0);
  const linkedHistory=(sonarrHistory?.records||[]).filter(h=>
    historyDownloadId(h)===hash&&Number(h.seriesId)>0);
  const linkedIds=[...new Set([...linkedQueue,...linkedHistory].map(h=>Number(h.seriesId)))];
  const linkedMatch=linkedIds.length===1
    ?(ctx.sonarrSeries||[]).find(s=>Number(s.id)===linkedIds[0]):null;
  const match=linkedMatch||(
    supernaturalPack
      ?(exactSupernatural.length===1?exactSupernatural[0]:null)
      :(titleMatches.length===1?titleMatches[0]:null));
  const seriesRoot=String(match?.path||'').replace(/\/$/,'');
  const safePath=seriesRoot.startsWith('/volume1/VideoFactory/_Plex/media/Series/')&&
    seriesRoot!=='/volume1/VideoFactory/_Plex/media/Series';
  const withinSeries=safePath&&(current===seriesRoot||current.startsWith(seriesRoot+'/'));
  if(match&&safePath&&withinSeries){
    if(!hasQbitTag(t,'synoplex-rescan-requested')){
      try{
        const cmd=await api(SB,sh,'/api/v3/command',{
          method:'POST',body:JSON.stringify({name:'RescanSeries',seriesId:match.id})
        });
        await qbitForm('/api/v2/torrents/addTags',{hashes:t.hash,tags:'synoplex-rescan-requested'});
        results.push({category,torrent:t.name,status:'SONARR_RESCAN_AFTER_QBIT_MOVE',
          seriesId:match.id,commandId:cmd?.id,c411:isC411,keepSeeding:true});
      }catch(e){results.push({category,torrent:t.name,status:'SONARR_RESCAN_ERROR',error:e.message,keepSeeding:true});}
    }else{
      try{
        const ef=await api(SB,sh,'/api/v3/episodefile?seriesId='+match.id);
        const allEpisodes=await api(SB,sh,'/api/v3/episode?seriesId='+match.id+'&includeImages=false');
        const torrentFiles=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
        const root=String(match.path||'').replace(/[/]+$/,'');
        const inLibrary=Array.isArray(ef)?ef.filter(f=>String(f.path||'').startsWith(root+'/')):[];
        const fileIds=new Set(inLibrary.map(f=>Number(f.id)));
        const availableEpisodes=Array.isArray(allEpisodes)?allEpisodes:[];
        const videoFiles=(Array.isArray(torrentFiles)?torrentFiles:[]).filter(f=>
          videoExt.has(path.posix.extname(String(f.name||'')).toLowerCase())&&
          !String(f.name||'').toLowerCase().split('/').includes('bonus'));
        const matched=videoFiles.map(f=>
          safePackEpisodeMatch(path.posix.basename(String(f.name||'')),availableEpisodes,match));
        const mappedIds=matched.filter(Boolean).map(e=>Number(e.id));
        const uniqueMapping=videoFiles.length>0&&matched.every(Boolean)&&
          new Set(mappedIds).size===mappedIds.length;
        const covered=matched.filter(e=>e&&e.hasFile&&fileIds.has(Number(e.episodeFileId))).length;
        const confirmed=uniqueMapping&&covered===videoFiles.length&&
          Number(t.progress)===1;
        results.push({category,torrent:t.name,
          status:confirmed?'SONARR_TORRENT_EPISODES_VERIFIED':
            (inLibrary.length?'SONARR_PACK_PARTIALLY_VERIFIED':'SONARR_MOVED_NOT_IMPORTED'),
          seriesId:match.id,seriesEpisodeFiles:inLibrary.length,
          expectedTorrentEpisodes:videoFiles.length,verifiedTorrentEpisodes:covered,
          uniqueMapping,importConfirmedForTorrent:confirmed,
          c411:isC411,keepSeeding:true});
      }catch(e){
        results.push({category,torrent:t.name,status:'SONARR_IMPORT_CHECK_ERROR',
          seriesId:match.id,error:e.message,c411:isC411,keepSeeding:true});
      }
    }
    continue;
  }
  if(match&&safePath&&current.startsWith('/volume1/downloads/')&&
     String(t.state||'').toLowerCase()!=='moving'){
    try{
      const files=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
      const ok=Array.isArray(files)&&files.length>0&&
        files.every(f=>Number(f.progress)===1)&&
        files.some(f=>videoExt.has(path.posix.extname(String(f.name||'')).toLowerCase()))&&
        current.startsWith('/volume1/downloads/incomplete/sonarr/')&&
        !String(t.save_path||'').startsWith(seriesRoot)&&
        !String(t.state||'').toLowerCase().startsWith('checking');
      if(ok){
        if(relocationRequests>=MAX_RELOCATIONS_PER_RUN){
          results.push({category,torrent:t.name,status:'RELOCATION_QUEUED_RATE_LIMIT',
            destinationRoot:seriesRoot,seriesId:match.id,c411:isC411,keepSeeding:true});
          continue;
        }
        await qbitForm('/api/v2/torrents/setLocation',{hashes:t.hash,location:seriesRoot});
        relocationRequests++;
        await qbitForm('/api/v2/torrents/addTags',{hashes:t.hash,tags:'synoplex-moving'});
        results.push({category,torrent:t.name,status:'SONARR_QBIT_RELOCATION_REQUESTED',
          seriesId:match.id,destinationRoot:seriesRoot,files:files.length,
          keepSeeding:true,c411:isC411});
        continue;
      }
    }catch(e){results.push({category,torrent:t.name,status:'SONARR_QBIT_MOVE_ERROR',error:e.message,keepSeeding:true});continue;}
  }
  // Bleach 2004 S17: recover only a single verified completed episode,
  // never the historical S01-S16 files and never move/delete a seeding torrent.
  if(Number(match?.id)===56&&Number(match?.tvdbId)===74796&&Number(match?.year)===2004&&
     /^Bleach[ ._-]+S17E\d{1,2}(?:v\d+)?(?:[ ._-]|$)/i.test(String(t.name||''))&&
     current.startsWith('/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/sonarr/')){
    try{
      const manifest=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
      const video=Array.isArray(manifest)?manifest.filter(f=>
        videoExt.has(path.posix.extname(String(f.name||'')).toLowerCase())):[];
      const numbered=video.length===1?path.posix.basename(String(video[0].name||'')).match(/(?:^|[._\s-])S17E(\d{1,2})(?:v\d+)?(?!\d)/i):null;
      const epno=numbered?Number(numbered[1]):0;
      if(epno>=1&&epno<=50&&Number(video[0].progress)===1&&
         manifest.every(f=>Number(f.progress)===1)){
        const episodeList=await api(SB,sh,'/api/v3/episode?seriesId=56&includeImages=false');
        const ep=(Array.isArray(episodeList)?episodeList:[]).find(e=>
          Number(e.seasonNumber)===17&&Number(e.episodeNumber)===epno);
        const src=path.posix.resolve(String(t.save_path||''),String(video[0].name||''));
        const srcFile=src.startsWith('/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/sonarr/')&&existsNas(src);
        if(ep&&srcFile){
          if(ep.hasFile){
            const record=await api(SB,sh,'/api/v3/episodefile/'+ep.episodeFileId);
            const physical=String(record.path||'').startsWith(seriesRoot+'/Season 17/')&&existsNas(record.path);
            results.push({category:'sonarr',torrent:t.name,status:physical?'BLEACH_S17_VERIFIED_ALREADY_IMPORTED':'BLEACH_S17_REGISTERED_PATH_MISSING',
              seriesId:56,seasonNumber:17,episodeNumber:epno,libraryPath:record.path,importConfirmedForTorrent:physical,
              keepSeeding:true,c411:isC411});
            continue;
          }
          if(!ctx.c411ManualImportBusy){
            const evidence=sonarrImportEvidence(t,ctx.sonarrHistory?.records||[]);
            const recovered=await recoverSonarrSingleFile(t,ctx,evidence,seeds,true);
            if(recovered){
              results.push({...recovered,importConfirmedForTorrent:Boolean(recovered.hasFile),keepSeeding:true});
              continue;
            }
          }
          results.push({category:'sonarr',torrent:t.name,status:'BLEACH_S17_COMPLETE_AWAITING_SONARR_OR_RECOVERY',
            seriesId:56,seasonNumber:17,episodeNumber:epno,source:src,importConfirmedForTorrent:false,keepSeeding:true});
          continue;
        }
      }
    }catch(e){
      results.push({category:'sonarr',torrent:t.name,status:'BLEACH_S17_TARGETED_RECOVERY_ERROR',
        seriesId:56,error:e.message,importConfirmedForTorrent:false,keepSeeding:true});
      continue;
    }
  }
  if(current.startsWith('/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/sonarr/')){
    let libraryEpisodeFiles=null,queueItems=[];
    try{
      if(match&&safePath){
        const ef=await api(SB,sh,'/api/v3/episodefile?seriesId='+match.id);
        libraryEpisodeFiles=Array.isArray(ef)?ef.filter(f=>
          String(f.path||'').startsWith(seriesRoot+'/')).length:null;
      }
      queueItems=(sonarrQueue?.records||[]).filter(q=>
        String(q.downloadId||'').toLowerCase()===hash).map(q=>({
          queueId:q.id,seriesId:q.seriesId,status:q.status,
          trackedDownloadState:q.trackedDownloadState,
          statusMessages:(q.statusMessages||[]).map(m=>m.messages||[]).flat().slice(0,5)
        }));
    }catch(e){queueItems.push({error:e.message});}
    let manifestAudit=null;
    const blocked=queueItems.some(q=>String(q.trackedDownloadState||'').toLowerCase()==='importblocked');
    if(blocked&&match&&safePath&&libraryEpisodeFiles===0&&
      current.startsWith('/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/sonarr/')&&
      relocationRequests<MAX_RELOCATIONS_PER_RUN&&
      canMapNas(current)&&canMapNas(seriesRoot)&&existsNas(current)){
      try{
        const localRoot=localPath(seriesRoot);
        const destExists=fs.existsSync(localRoot);
        let destEmpty=false;
        if(!destExists)destEmpty=true;
        else if(fs.statSync(localRoot).isDirectory()){
          destEmpty=walk(localRoot).length===0;
        }
        const files=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
        const videos=(Array.isArray(files)?files:[]).filter(f=>
          videoExt.has(path.posix.extname(String(f.name||'')).toLowerCase()));
        const completed=Array.isArray(files)&&files.length>0&&files.every(f=>Number(f.progress)===1);
        const epData=await api(SB,sh,'/api/v3/episode?seriesId='+Number(match.id)+'&includeImages=false');
        const episodes=Array.isArray(epData)?epData:[];
        const isBonus=f=>String(f.name||'').toLowerCase().split('/').includes('bonus');
        const bonusVideos=videos.filter(isBonus);
        const episodeVideos=videos.filter(f=>!isBonus(f));
        const matches=episodeVideos.map(f=>safePackEpisodeMatch(path.posix.basename(String(f.name||'')),episodes,match));
        const ids=matches.filter(Boolean).map(e=>Number(e.id));
        const allMapped=episodeVideos.length>0&&matches.every(Boolean)&&new Set(ids).size===ids.length;
        manifestAudit={sourceVideos:videos.length,ignoredBonusVideos:bonusVideos.length,
          mappedEpisodes:ids.length,completeManifest:completed,emptyDestination:destEmpty,
          sampleEpisodeNames:episodeVideos.slice(0,3).map(f=>f.name),
          sampleUnmatched:episodeVideos.filter((f,i)=>!matches[i]).slice(0,4).map(f=>f.name),
          safeToRelocate:completed&&allMapped&&destEmpty};
        if(completed&&allMapped&&destEmpty&&String(t.state||'').toLowerCase()!=='moving'){
          await qbitForm('/api/v2/torrents/setLocation',{hashes:t.hash,location:seriesRoot});
          relocationRequests++;
          results.push({category,torrent:t.name,status:'SONARR_VERIFIED_PACK_RELOCATION_REQUESTED',
            seriesId:match.id,seriesRoot,manifestAudit,c411:isC411,
            keepSeeding:true,importConfirmedForTorrent:false});
          continue;
        }
      }catch(e){manifestAudit={error:e.message};}
    }
    results.push({category,torrent:t.name,
      status:match&&safePath?'SONARR_SEED_FOLDER_IMPORT_CHECK':'SONARR_SEED_FOLDER_SERIES_UNMATCHED',
      current,seriesId:match?.id||null,seriesRoot:seriesRoot||null,
      libraryEpisodeFiles,queueItems,manifestAudit,c411:isC411,keepSeeding:true,
      importConfirmedForTorrent:false,
      message:'Source is in qBittorrent seeding folder. No copy or removal without verified manifest.'});
    continue;
  }
  results.push({category,torrent:t.name,status:'SONARR_RELOCATION_DIAGNOSTIC',
    current,savePath:String(t.save_path||''),matchedSeriesId:match?.id||null,
    matchedSeriesTitle:match?.title||null,seriesRoot,
    linkedIds,matchCount:titleMatches.length,safePath,withinSeries,
    movingTag:hasQbitTag(t,'synoplex-moving'),c411:isC411,keepSeeding:true});
  continue;
}
results.push({category,torrent:t.name,
  status:isC411?'C411_SEED_PRESERVED_MOVE_PENDING':'MOVE_ONLY_RELOCATION_REQUIRED',
  state:t.state,seeders:seeds.count,seedersSource:seeds.source,
  threshold:SEEDER_THRESHOLD,keepSeeding:true,c411:isC411,
  message:'Multi-file or ambiguous move requires manifest-preserving plan. No copy, link, delete or forced import.'});
continue;

const parkedRadarr=hasQbitTag(t,'seed-radarr');
const parkedSonarr=hasQbitTag(t,'seed-sonarr');

if(parkedRadarr||parkedSonarr){
  const seeds=seederInfo(t);
  const c411=hasQbitTag(t,'seed-c411');
  const keepSeeding=c411||!seeds.known||seeds.count<SEEDER_THRESHOLD;
  const category=parkedRadarr?'radarr':'sonarr';

  if(keepSeeding){
    results.push({
      category,torrent:t.name,status:c411?'PARKED_C411_KEEP_SEEDING':'PARKED_KEEP_SEEDING',c411,
      seeders:seeds.count,seedersSource:seeds.source,
      threshold:SEEDER_THRESHOLD,keepSeeding:true,parked:true
    });
  }else{
    try{
      await removeTorrent(t);
      results.push({
        category,torrent:t.name,status:'PARKED_TORRENT_REMOVED',
        seeders:seeds.count,seedersSource:seeds.source,
        threshold:SEEDER_THRESHOLD,keepSeeding:false,parked:true,qbitRemoved:true
      });
    }catch(e){
      results.push({
        category,torrent:t.name,status:'ERROR',
        seeders:seeds.count,seedersSource:seeds.source,
        parked:true,error:e.message
      });
    }
  }
  continue;
}

if(String(t.category)==='radarr') results.push(await processRadarr(t,ctx));
else if(String(t.category)==='sonarr'){
  const res=await processSonarr(t,ctx);
  results.push(res);
  if(res.status==='PACK_MANUAL_IMPORT_SUBMITTED'){
    fs.writeFileSync(ROTATION_FILE,JSON.stringify({
      lastHash:String(t.hash||'').toLowerCase(),
      lastTorrent:String(t.name||''),timestamp:new Date().toISOString()
    }));
  }
}
}


const radarrAudit=[];
for(const t of done.filter(x=>hasQbitTag(x,'seed-radarr')||String(x.category)==='radarr')){
const hash=String(t.hash||'').toLowerCase();
const q=(radarrQueue?.records||[]).find(x=>String(x.downloadId||'').toLowerCase()===hash);
const hist=(radarrHistory?.records||[]).filter(x=>String(x.downloadId||x.data?.downloadId||'').toLowerCase()===hash);
const knownIds=[...new Set([q?.movieId,...hist.map(x=>x.movieId)].map(Number).filter(x=>x>0))];
const releaseNorm=normTitle(t.name);
const releaseYear=yearFromText(t.name);
const names=(m)=>[m.title,m.originalTitle,...(Array.isArray(m.alternateTitles)?m.alternateTitles.map(x=>x.title||x):[])].filter(Boolean);
const guess=radarrMovies.filter(m=>
  (!releaseYear||Math.abs(Number(m.year||0)-releaseYear)<=1)&&
  names(m).some(v=>{
    const title=normTitle(v);
    return title.length>=4&&(releaseNorm===title||releaseNorm.startsWith(title+' '));
  }));
const candidates=knownIds.length?radarrMovies.filter(m=>knownIds.includes(Number(m.id))):guess;
const unique=candidates.length===1?candidates[0]:null;
const movieFile=unique?.movieFile;
radarrAudit.push({
  torrent:t.name,parked:hasQbitTag(t,'seed-radarr'),
  match:knownIds.length?'DOWNLOAD_ID':(unique?'TITLE_YEAR':candidates.length>1?'AMBIGUOUS':'UNKNOWN'),
  candidates:candidates.length,movieId:unique?.id||null,movieTitle:unique?.title||null,
  radarrHasFile:unique?Boolean(unique.hasFile):null,
  movieFilePath:movieFile?.path||null,
  diskFileVisible:movieFile?.path?existsNas(movieFile.path):null,
  sourcePath:t.content_path||null,
  sourcePathVisible:existsNas(String(t.content_path||'')),
  radarrHistoryMatches:hist.length
});
}
const radarrAuditSummary={
checked:radarrAudit.length,
markedSeeding:radarrAudit.filter(x=>x.parked).length,
matchesByDownloadId:radarrAudit.filter(x=>x.match==='DOWNLOAD_ID').length,
matchesByTitleYear:radarrAudit.filter(x=>x.match==='TITLE_YEAR').length,
unmatched:radarrAudit.filter(x=>x.match==='UNKNOWN'||x.match==='AMBIGUOUS').length,
libraryHasFile:radarrAudit.filter(x=>x.radarrHasFile===true).length,
libraryMissingFile:radarrAudit.filter(x=>x.radarrHasFile===false).length,
filePathUnreadable:radarrAudit.filter(x=>x.radarrHasFile===true&&x.diskFileVisible===false).length
};


const sonarrSeedAudit=[];
for(const t of done.filter(x=>hasQbitTag(x,'seed-sonarr'))){
const hash=String(t.hash||'').toLowerCase();
const rows=(sonarrHistory?.records||[]).filter(x=>historyDownloadId(x)===hash);
const imported=rows.filter(looksImportedEvent);
const ids=[...new Set(rows.map(x=>Number(x.seriesId||x.series?.id||0)).filter(x=>x>0))];
const series=ids.length===1?ctx.sonarrSeries.find(x=>Number(x.id)===ids[0]):null;
sonarrSeedAudit.push({
  torrent:t.name,
  historyMatches:rows.length,
  importedHistoryCount:imported.length,
  seriesIds:ids,
  seriesTitle:series?.title||null,
  seriesLibraryFileCount:series?.statistics?.episodeFileCount??null,
  seriesEpisodeCount:series?.statistics?.episodeCount??null,
  sourceAccessible:canMapNas(String(t.content_path||''))?existsNas(t.content_path):null,
  status:!rows.length?'UNVERIFIED_NO_RECENT_HISTORY':!imported.length?'UNVERIFIED_NO_IMPORT_EVENT':'HISTORY_HAS_IMPORT_EVENT'
});
}
const parkedNamed=done.filter(t=>hasQbitTag(t,'seed-sonarr'));
const seriesAliases=(series)=>{
const base=safePackSeriesAliases(series);
const nm=normTitle(series.title||'');
if(nm==='buffy the vampire slayer')base.push(normTitle('Buffy contre les vampires'));
if(nm==='the mysterious cities of gold')base.push(normTitle("Les mysterieuses cites d'or"));
return [...new Set(base.filter(Boolean))];
};
const mappedIds=new Set();
for(const row of sonarrSeedAudit){
const t=parkedNamed.find(x=>x.name===row.torrent);
if(!t)continue;
const norm=normTitle(t.name);
const year=yearFromText(t.name);
const hits=ctx.sonarrSeries.filter(series=>
  (!year||!series.year||Math.abs(Number(series.year)-year)<=1)&&
  seriesAliases(series).some(alias=>norm===alias||norm.startsWith(alias+' '))
);
if(hits.length===1){
  const series=hits[0];
  row.titleMatchSeriesId=series.id;
  row.titleMatchSeries=series.title;
  row.titleMatchConfidence='UNIQUE_NAME_YEAR';
  mappedIds.add(Number(series.id));
}else{
  row.titleMatchConfidence=hits.length?'AMBIGUOUS':'NOT_MATCHED';
}
const explicitSeasons=[...new Set([
  ...[...String(t.name).matchAll(/(?:^|[^a-z0-9])S(\d{1,2})(?!\d)/gi)].map(m=>Number(m[1])),
  ...[...String(t.name).matchAll(/saison[.\s_-]*(\d{1,2})(?!\d)/gi)].map(m=>Number(m[1]))
])].filter(n=>n>=1);
row.explicitSeasons=explicitSeasons;
}
const episodeCoverage=new Map();
const mappedArray=[...mappedIds];
for(let offset=0;offset<mappedArray.length;offset+=5){
const batch=mappedArray.slice(offset,offset+5);
await Promise.all(batch.map(async id=>{
  try{
    const episodes=await api(SB,sh,'/api/v3/episode?seriesId='+id+'&includeImages=false');
    const valid=Array.isArray(episodes)?episodes:[];
    const seasonStats={};
    for(const e of valid.filter(x=>Number(x.seasonNumber)>0)){
      const key=String(e.seasonNumber);
      if(!seasonStats[key])seasonStats[key]={total:0,hasFile:0};
      seasonStats[key].total++;
      if(e.hasFile)seasonStats[key].hasFile++;
    }
    episodeCoverage.set(id,{total:valid.filter(x=>Number(x.seasonNumber)>0).length,
      hasFile:valid.filter(x=>Number(x.seasonNumber)>0&&x.hasFile).length,
      seasons:seasonStats});
  }catch(e){episodeCoverage.set(id,{error:e.message});}
}));
}
for(const row of sonarrSeedAudit){
const id=Number(row.titleMatchSeriesId||0);
if(!id||!episodeCoverage.has(id))continue;
const stat=episodeCoverage.get(id);
row.seriesCoverage=stat;
if(row.explicitSeasons.length===1 && stat.seasons){
  const season=stat.seasons[String(row.explicitSeasons[0])]||null;
  row.targetSeasonCoverage=season;
  row.targetSeasonHasMissing=season?season.hasFile<season.total:null;
}
}
const sonarrSeedSummary={
checked:sonarrSeedAudit.length,
withRecentImportHistory:sonarrSeedAudit.filter(x=>x.importedHistoryCount>0).length,
lackingRecentImportHistory:sonarrSeedAudit.filter(x=>x.importedHistoryCount===0).length,
linkedToKnownSeries:sonarrSeedAudit.filter(x=>Boolean(x.seriesTitle)).length,
linkedByUniqueTitle:sonarrSeedAudit.filter(x=>x.titleMatchConfidence==='UNIQUE_NAME_YEAR').length,
explicitSeasonMissingFiles:sonarrSeedAudit.filter(x=>x.targetSeasonHasMissing===true).length,
explicitSeasonComplete:sonarrSeedAudit.filter(x=>x.targetSeasonHasMissing===false).length
};


let cityHunterAudit=null;
try{
const s=ctx.sonarrSeries.find(x=>Number(x.id)===45);
if(s){
const [e,f]=await Promise.all([api(SB,sh,'/api/v3/episode?seriesId=45&includeImages=false'),api(SB,sh,'/api/v3/episodefile?seriesId=45')]);
const reg=e.filter(x=>x.seasonNumber>0);
cityHunterAudit={regularEpisodes:reg.length,registered:reg.filter(x=>x.hasFile).length,
libraryFiles:f.length,visible:f.filter(x=>existsNas(x.path)).length};
}
}catch(e){cityHunterAudit={error:e.message};}
function synoplexMkvVideoSize(nasPath){
const file=localPath(nasPath),fd=fs.openSync(file,'r');
try{
  const header=Buffer.alloc(16*1024*1024);
  const n=fs.readSync(fd,header,0,header.length,0);
  const b=header.subarray(0,n);
  function eltId(i){
    if(i>=n)return null;
    let k=1;while(k<=4&&!(b[i]&(0x80>>(k-1))))k++;
    if(k>4||i+k>n)return null;
    let v=0;for(let j=0;j<k;j++)v=v*256+b[i+j];
    return {n:k,v};
  }
  function eltSize(i){
    if(i>=n)return null;
    let k=1;while(k<=8&&!(b[i]&(0x80>>(k-1))))k++;
    if(k>8||i+k>n)return null;
    let v=b[i]&((1<<(8-k))-1);
    for(let j=1;j<k;j++)v=v*256+b[i+j];
    const unknown=(v===Math.pow(2,7*k)-1);
    return {n:k,v:unknown?null:v};
  }
  let width=0,height=0;
  function walkEbml(start,end,depth){
    if(depth>6)return;
    let i=start,steps=0;
    while(i<end&&i<n&&++steps<10000){
      const id=eltId(i);if(!id)break;
      const size=eltSize(i+id.n);if(!size)break;
      const p=i+id.n+size.n;
      const next=size.v===null?Math.min(end,n):Math.min(end,n,p+size.v);
      if(next<=i||next<p)break;
      if([0x18538067,0x1654AE6B,0xAE,0xE0].includes(id.v)){
        walkEbml(p,next,depth+1);
      }else if((id.v===0xB0||id.v===0xBA)&&size.v!==null&&size.v>=1&&size.v<=4){
        let v=0;for(let k=0;k<size.v;k++)v=v*256+b[p+k];
        if(id.v===0xB0)width=v;
        if(id.v===0xBA)height=v;
      }
      if(width&&height)return;
      i=next;
    }
  }
  walkEbml(0,n,0);
  return width>=320&&height>=200&&width<=8192&&height<=4320?{width,height}:null;
}finally{fs.closeSync(fd);}
}
const CITY_REPAIR_FILE='/home/node/.n8n/.synoplex-city-hunter-repair.json';
let cityHunterRepair=null;
try{
const s=(ctx.sonarrSeries||[]).find(x=>Number(x.id)===45);
const t=(Array.isArray(torrents)?torrents:[]).find(x=>
  String(x.name||'')==='City Hunter - Nicky Larson [Multi] [BR]'&&
  String(x.hash||'').toLowerCase().startsWith('e447950fdb77')&&
  String(x.category||'').toLowerCase()==='sonarr'&&
  hasTag(x,'seed-c411')&&!hasTag(x,'xyzsubz'));
const status=(value,extra={})=>({status:value,seriesId:45,...extra});
if(!s||!t)cityHunterRepair=status('SOURCE_OR_SERIES_NOT_FOUND');
else if(String(s.path||'')!=='/volume1/VideoFactory/_Plex/media/Series/City Hunter')
  cityHunterRepair=status('UNEXPECTED_SONARR_ROOT',{root:s.path});
else if(Number(t.progress)!==1||String(t.state||'').toLowerCase()==='moving')
  cityHunterRepair=status('SOURCE_NOT_READY',{progress:t.progress,state:t.state});
else{
  const ep=await api(SB,sh,'/api/v3/episode?seriesId=45&includeImages=false');
  const episodes=Array.isArray(ep)?ep:[];
  const regular=episodes.filter(x=>Number(x.seasonNumber)>0&&Number(x.absoluteEpisodeNumber)>0);
  const uniqueAbsolute=new Set(regular.map(x=>Number(x.absoluteEpisodeNumber)));
  const qfiles=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
  const vids=(Array.isArray(qfiles)?qfiles:[]).filter(x=>
    videoExt.has(path.posix.extname(String(x.name||'')).toLowerCase()));
  const source=String(t.content_path||'').replace(/[/]+$/,'');
  const root=String(t.save_path||'').replace(/[/]+$/,'');
  const absFiles=new Map();
  let invalid=0;
  for(const f of vids){
    const basename=path.posix.basename(String(f.name||''));
    const m=basename.match(/^(\d{3})\s*[-. ]/);
    const abs=m?Number(m[1]):0;
    const nas=path.posix.resolve(root,String(f.name||''));
    const mapped=canMapNas(nas)&&nas.startsWith(source+'/');
    if(!abs||absFiles.has(abs)||!mapped||Number(f.progress)!==1){invalid++;continue;}
    absFiles.set(abs,{nas,size:Number(f.size||0)});
  }
  const missing=regular.filter(e=>!e.hasFile&&[3,4].includes(Number(e.seasonNumber)));
  const noSpecials=episodes.filter(e=>Number(e.seasonNumber)===0).every(e=>!e.hasFile);
  let prior={};
  try{prior=JSON.parse(fs.readFileSync(CITY_REPAIR_FILE,'utf8'))||{}}catch{}
  if(prior.episodeIds?.length){
    const doneCount=prior.episodeIds.filter(id=>episodes.some(e=>Number(e.id)===Number(id)&&e.hasFile)).length;
    if(doneCount===prior.episodeIds.length){
      fs.unlinkSync(CITY_REPAIR_FILE);
      cityHunterRepair=status('PRIOR_BATCH_VERIFIED',{commandId:prior.commandId,verified:doneCount});
    }else{
      cityHunterRepair=status('PRIOR_BATCH_PENDING',{
        commandId:prior.commandId,requested:prior.episodeIds.length,verified:doneCount,
        failedOrStillRunning:prior.episodeIds.length-doneCount});
    }
  }
  if(!cityHunterRepair){
    if(regular.length!==140||uniqueAbsolute.size!==140||
      vids.length!==140||absFiles.size!==140||invalid!==0)
      cityHunterRepair=status('MANIFEST_MISMATCH',{
        regular:regular.length,uniqueAbsolute:uniqueAbsolute.size,videos:vids.length,
        mapped:absFiles.size,invalid});
    else if(missing.length===0)cityHunterRepair=status('ALL_REGULAR_EPISODES_PRESENT');
    else if(ctx.c411ManualImportBusy||ctx.safePackSubmitted)
      cityHunterRepair=status('OTHER_SONARR_IMPORT_BUSY');
    else{
      const batch=missing.sort((a,b)=>Number(a.absoluteEpisodeNumber)-Number(b.absoluteEpisodeNumber)).slice(0,13);
      const importRows=[];
      for(const e of batch){
        const f=absFiles.get(Number(e.absoluteEpisodeNumber));
        if(!f)throw new Error('Missing absolute torrent episode '+e.absoluteEpisodeNumber);
        const lp=localPath(f.nas);
        const st=fs.lstatSync(lp);
        if(!st.isFile()||st.isSymbolicLink()||Number(st.size)!==f.size)
          throw new Error('Source file not a complete regular file '+e.absoluteEpisodeNumber);
        importRows.push({episode:e,source:f});
      }
      const video=synoplexMkvVideoSize(importRows[0].source.nas);
      if(!video)cityHunterRepair=status('VIDEO_QUALITY_NOT_DETECTABLE',{
        source:importRows[0].source.nas,missing:missing.length});
      else{
        const res=video.height>=900?1080:video.height>=650?720:480;
        const qualityName='Bluray-'+res+'p';
        const definitions=await api(SB,sh,'/api/v3/qualitydefinition');
        const definition=(Array.isArray(definitions)?definitions:[]).find(d=>
          String(d.quality?.name||'').toLowerCase()===qualityName.toLowerCase());
        if(!definition?.quality?.id)cityHunterRepair=status('QUALITY_DEFINITION_NOT_FOUND',{
          detected:video,qualityName,missing:missing.length});
        else{
          const q={quality:definition.quality,revision:{version:1,real:0}};
          const fileData=importRows.map(x=>({
            path:x.source.nas,seriesId:45,episodeIds:[Number(x.episode.id)],
            quality:q,languages:[],releaseGroup:'',indexerFlags:0,
            releaseType:'singleEpisode'
          }));
          const cmd=await api(SB,sh,'/api/v3/command',{
            method:'POST',body:JSON.stringify({
              name:'ManualImport',importMode:'copy',files:fileData
            })
          });
          const state={commandId:cmd?.id||null,episodeIds:fileData.map(x=>x.episodeIds[0]),
            submittedAt:new Date().toISOString(),quality:qualityName,
            sourceTorrentHashPrefix:String(t.hash||'').slice(0,12)};
          const temp=CITY_REPAIR_FILE+'.tmp';
          fs.writeFileSync(temp,JSON.stringify(state));
          fs.renameSync(temp,CITY_REPAIR_FILE);
          cityHunterRepair=status('SELECTIVE_MANUAL_IMPORT_SUBMITTED',{
            submitted:fileData.length,remainingBefore:missing.length,commandId:cmd?.id||null,
            sourceTorrent:t.name,detectedVideo:video,qualityName,
            absoluteNumbers:importRows.map(x=>Number(x.episode.absoluteEpisodeNumber)),
            importMode:'copy',seedingPreserved:true});
        }
      }
    }
  }
}
}catch(e){cityHunterRepair={status:'CITY_HUNTER_REPAIR_ERROR',error:e.message};}


let cityBrMigration=null;
try{
const CITY='/volume1/VideoFactory/_Plex/media/Series/City Hunter';
const SEED='/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/sonarr';
const specs=[
  {season:1,count:51,release:'City.Hunter.S01.REMASTERED.MULTi.1080p.WEB-DL.H265-T3KASHi',hashPrefix:'c1382511ca30'},
  {season:2,count:63,release:'City.Hunter.S02.REMASTERED.MULTi.1080p.WEB-DL.H265-T3KASHi',hashPrefix:'4fd224365d8c'}
];
const checks=[];
const allT=Array.isArray(torrents)?torrents:[];
const library=await api(SB,sh,'/api/v3/episodefile?seriesId=45');
const registered=Array.isArray(library)?library:[];
for(const spec of specs){
  const old=path.posix.join(CITY,spec.release);
  const t=allT.find(x=>String(x.name||'')===spec.release&&
    String(x.hash||'').toLowerCase().startsWith(spec.hashPrefix)&&
    hasTag(x,'seed-c411')&&!hasTag(x,'xyzsubz'));
  const check={season:spec.season,release:spec.release,expected:spec.count,
    torrentFound:Boolean(t)};
  if(!t){checks.push(check);continue;}
  check.state=t.state;check.progress=t.progress;
  check.savePath=t.save_path;check.contentPath=t.content_path;
  check.oldSourcePresent=existsNas(old);
  check.moved=String(t.save_path||'').replace(/[/]+$/,'')===SEED&&
    String(t.content_path||'').startsWith(SEED+'/'+spec.release);
  check.atOriginal=String(t.save_path||'').replace(/[/]+$/,'')===CITY&&
    String(t.content_path||'')===old;
  const files=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
  const videoFiles=(Array.isArray(files)?files:[]).filter(f=>
    videoExt.has(path.posix.extname(String(f.name||'')).toLowerCase()));
  check.videoFiles=videoFiles.length;
  check.fullProgress=Number(t.progress)===1&&videoFiles.every(f=>Number(f.progress)===1);
  let backupMatches=0,backupSizeMismatch=0,backupLinks=0,missing=0,sourceFilesAccessible=0;
  for(const f of videoFiles){
    const src=path.posix.join(String(t.save_path||''),String(f.name||''));
    const dupe=path.posix.join(CITY,'Season '+spec.season,path.posix.basename(String(f.name||'')));
    try{
      const a=fs.lstatSync(localPath(src));
      if(!a.isFile()||a.isSymbolicLink()||a.size!==Number(f.size)){missing++;continue;}
      sourceFilesAccessible++;
      const b=fs.lstatSync(localPath(dupe));
      if(!b.isFile()||b.isSymbolicLink()){missing++;continue;}
      if(b.size!==a.size){backupSizeMismatch++;continue;}
      if(a.dev===b.dev&&a.ino===b.ino){backupLinks++;continue;}
      backupMatches++;
    }catch(e){missing++;}
  }
  check.sourceFilesAccessible=sourceFilesAccessible;
  check.independentLibraryCopies=backupMatches;
  check.missing=missing;check.sizeMismatch=backupSizeMismatch;check.hardlinks=backupLinks;
  check.registeredInOldSeed=registered.filter(f=>String(f.path||'').startsWith(old+'/')).length;
  check.readyToMove=check.atOriginal&&!check.moved&&check.fullProgress&&
    check.videoFiles===spec.count&&backupMatches===spec.count&&
    backupSizeMismatch===0&&backupLinks===0&&missing===0&&
    !allT.some(x=>x!==t&&String(x.content_path||'').startsWith(old+'/'));
  checks.push(check);
}
const verifiedMoved=x=>x.moved&&!x.oldSourcePresent&&x.fullProgress&&
  x.videoFiles===x.expected&&x.sourceFilesAccessible===x.expected;
let requested=null;
for(let k=0;k<checks.length;k++){
  const x=checks[k];
  if(verifiedMoved(x))continue;
  if(checks.slice(0,k).every(verifiedMoved)&&x.readyToMove&&
    !fs.existsSync(localPath(path.posix.join(SEED,x.release)))&&
    !String(x.state||'').toLowerCase().startsWith('checking')&&
    String(x.state||'').toLowerCase()!=='moving'){
    const t=allT.find(z=>String(z.name||'')===x.release&&
      String(z.hash||'').toLowerCase().startsWith(specs[k].hashPrefix));
    if(t){
      await qbitForm('/api/v2/torrents/setLocation',{
        hashes:String(t.hash||''),location:SEED
      });
      requested={season:x.season,release:x.release,target:SEED};
    }
  }
  break;
}
cityBrMigration={status:requested?'SEED_RELOCATION_REQUESTED':
  checks.every(verifiedMoved)?'SEED_TORRENTS_RELOCATED':'SEED_RELOCATION_WAIT_OR_REVIEW',
  requested,sourceTorrent:'City Hunter - Nicky Larson [Multi] [BR]',destination:SEED,checks};
}catch(e){cityBrMigration={status:'AUDIT_FAILED',error:e.message};}


let cityBrSwitch=null;
const BR_STATE='/home/node/.n8n/.synoplex-city-hunter-br-switch.json';
const BR_DONE='/home/node/.n8n/.synoplex-city-hunter-br-complete.json';
try{
if(fs.existsSync(BR_DONE)){
  const eps=await api(SB,sh,'/api/v3/episode?seriesId=45&includeImages=false');
  const files=await api(SB,sh,'/api/v3/episodefile?seriesId=45');
  const rows=Array.isArray(eps)?eps.filter(e=>Number(e.seasonNumber)>0):[];
  const byId=new Map((Array.isArray(files)?files:[]).map(f=>[Number(f.id),f]));
  const verified=rows.filter(e=>{
    const f=byId.get(Number(e.episodeFileId));
    return e.hasFile&&f&&
      String(f.path||'').startsWith('/volume1/VideoFactory/_Plex/media/Series/City Hunter/')&&
      existsNas(String(f.path||''));
  }).length;
  cityBrSwitch={status:rows.length===140&&verified===140?'BR_COMPLETE_LOCKED':'BR_COMPLETE_INTEGRITY_WARNING',
    expected:140,episodeRows:rows.length,verified,readOnly:true};
}else if(cityBrMigration?.status!=='SEED_TORRENTS_RELOCATED'){
  cityBrSwitch={status:'WAITING_FOR_BOTH_SEED_RELOCATIONS'};
}else{
  const CITY='/volume1/VideoFactory/_Plex/media/Series/City Hunter';
  const SEED='/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/sonarr';
  const oldReleaseNames=['City.Hunter.S01.REMASTERED.MULTi.1080p.WEB-DL.H265-T3KASHi',
    'City.Hunter.S02.REMASTERED.MULTi.1080p.WEB-DL.H265-T3KASHi'];
  const torrentsArr=Array.isArray(torrents)?torrents:[];
  const br=torrentsArr.find(t=>
    String(t.name||'')==='City Hunter - Nicky Larson [Multi] [BR]'&&
    String(t.hash||'').toLowerCase().startsWith('e447950fdb77')&&
    hasTag(t,'seed-c411')&&!hasTag(t,'xyzsubz')&&Number(t.progress)===1&&
    String(t.save_path||'').replace(/[/]+$/,'')===SEED);
  const s=(ctx.sonarrSeries||[]).find(x=>Number(x.id)===45);
  const srcUsed=torrentsArr.filter(t=>!oldReleaseNames.includes(t.name)&&
    ['/Season 1/','/Season 2/'].some(a=>String(t.content_path||'').startsWith(CITY+a)));
  const oldDirs=oldReleaseNames.map(name=>path.posix.join(CITY,name));
  if(!br||!s||s.path!==CITY||srcUsed.length||
    oldDirs.some(existsNas)){
    cityBrSwitch={status:'SOURCE_PATH_GUARD_FAILED',brFound:Boolean(br),correctSeries:s?.path===CITY,
      oldDirsExist:oldDirs.map(existsNas),otherSeedingSources:srcUsed.map(t=>t.name)};
  }else{
    const f=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(br.hash));
    const sourceFiles=(Array.isArray(f)?f:[]).filter(x=>
      videoExt.has(path.posix.extname(String(x.name||'')).toLowerCase()));
    const byAbsolute=new Map();
    for(const row of sourceFiles){
      const m=path.posix.basename(String(row.name||'')).match(/^(\d{3})\s*[-. ]/);
      const abs=m?Number(m[1]):NaN;
      if(!Number.isInteger(abs)||byAbsolute.has(abs))throw new Error('BR duplicate or missing absolute index');
      const full=path.posix.resolve(SEED,String(row.name||''));
      if(!full.startsWith(SEED+'/')||Number(row.progress)!==1||!existsNas(full))
        throw new Error('BR torrent file inaccessible '+abs);
      byAbsolute.set(abs,{path:full,size:Number(row.size||0)});
    }
    const ep=await api(SB,sh,'/api/v3/episode?seriesId=45&includeImages=false');
    const allEpisodes=Array.isArray(ep)?ep:[];
    const targets=allEpisodes.filter(e=>Number(e.seasonNumber)===1||Number(e.seasonNumber)===2)
      .sort((a,b)=>Number(a.absoluteEpisodeNumber)-Number(b.absoluteEpisodeNumber));
    const reg=await api(SB,sh,'/api/v3/episodefile?seriesId=45');
    const regById=new Map((Array.isArray(reg)?reg:[]).map(x=>[Number(x.id),x]));
    const absSet=new Set(targets.map(x=>Number(x.absoluteEpisodeNumber)));
    if(sourceFiles.length!==140||byAbsolute.size!==140||targets.length!==114||
       absSet.size!==114||targets.some(e=>!byAbsolute.has(Number(e.absoluteEpisodeNumber)))){
      cityBrSwitch={status:'EPISODE_MAPPING_GUARD_FAILED',
        sourceVideos:sourceFiles.length,targets:targets.length,uniqueAbs:absSet.size};
    }else{
      const definitions=await api(SB,sh,'/api/v3/qualitydefinition');
      const qdef=(Array.isArray(definitions)?definitions:[]).find(d=>
        String(d.quality?.name||'').toLowerCase()==='bluray-1080p');
      const video=synoplexMkvVideoSize(byAbsolute.get(115).path);
      if(!qdef?.quality?.id||!video||video.height<900)cityBrSwitch={
        status:'QUALITY_GUARD_FAILED',detectedVideo:video,quality:qdef?.quality?.name};
      else{
        const sourceCheck=t=>Boolean(t)&&String(t.path||'').startsWith(CITY+'/')&&
          existsNas(String(t.path||''));
        const upgraded=e=>{
          const row=regById.get(Number(e.episodeFileId));
          const original=byAbsolute.get(Number(e.absoluteEpisodeNumber));
          if(!e.hasFile||!sourceCheck(row)||!original)return false;
          const qname=String(row.quality?.quality?.name||'').toLowerCase();
          try{
            return qname==='bluray-1080p'&&fs.statSync(localPath(row.path)).size===original.size;
          }catch{return false;}
        };
        const converted=targets.filter(upgraded);
        let prior={};
        try{prior=JSON.parse(fs.readFileSync(BR_STATE,'utf8'))||{}}catch{}
        if(prior.phase==='batch'&&Array.isArray(prior.files)&&prior.files.length){
          let verified=0;
          for(const item of prior.files){
            const e=targets.find(x=>Number(x.id)===Number(item.id));
            const row=regById.get(Number(e?.episodeFileId));
            if(e&&upgraded(e)&&Number(e.episodeFileId)!==Number(item.previousFileId)&&
              row?.path&&Number(row.size)===Number(item.size))verified++;
          }
          if(verified===prior.files.length){
            fs.writeFileSync(BR_STATE,JSON.stringify({phase:'ready',pilotVerified:true,verifiedAt:new Date().toISOString()}));
            cityBrSwitch={status:'BR_BATCH_VERIFIED',commandId:prior.commandId,
              verified,convertedCount:converted.length,remaining:114-converted.length};
          }else{
            cityBrSwitch={status:'BR_BATCH_PENDING',commandId:prior.commandId,
              submitted:prior.files.length,verified,convertedCount:converted.length};
          }
        }else{
          const unconverted=targets.filter(e=>!upgraded(e));
          if(!unconverted.length)cityBrSwitch={status:'BR_INTEGRAL_S01_S02_COMPLETE',
            converted:114,season1:51,season2:63,seedingPreserved:true};
          else{
            const filesOutside=unconverted.filter(e=>{
              const row=regById.get(Number(e.episodeFileId));
              return !e.hasFile||!sourceCheck(row);
            });
            const unsafe=unconverted.filter(e=>{
              const row=regById.get(Number(e.episodeFileId));
              return row&&torrentsArr.some(t=>String(t.content_path||'')&&
                (String(t.content_path||'')===row.path||
                String(row.path||'').startsWith(String(t.content_path||'')+'/')));
            });
            const allowAfterSafeRescan=(prior.phase==='rescan'||prior.phase==='ready')&&
              cityBrMigration.checks.length===2&&cityBrMigration.checks.every(x=>
                x.moved&&!x.oldSourcePresent&&x.fullProgress&&
                x.sourceFilesAccessible===x.expected);
            if(filesOutside.length&&!allowAfterSafeRescan){
              if(prior.phase==='rescan'){
                cityBrSwitch={status:'AWAITING_SONARR_RESCAN',
                  missingOrUnregistered:filesOutside.length,alreadyBR:converted.length,
                  rescanCommandId:prior.commandId};
              }else if(ctx.c411ManualImportBusy){
                cityBrSwitch={status:'SONARR_BUSY_BEFORE_RESCAN',alreadyBR:converted.length};
              }else{
                const command=await api(SB,sh,'/api/v3/command',{
                  method:'POST',body:JSON.stringify({name:'RescanSeries',seriesId:45})
                });
                const state={phase:'rescan',commandId:command?.id||null,submittedAt:new Date().toISOString()};
                fs.writeFileSync(BR_STATE,JSON.stringify(state));
                cityBrSwitch={status:'SONARR_RESCAN_REQUESTED',commandId:command?.id||null,
                  missingOrUnregistered:filesOutside.length};
              }
            }else if(unsafe.length)cityBrSwitch={status:'BLOCKED_BY_ACTIVE_QBIT_SOURCE',
              unsafe:unsafe.length};
            else if(ctx.c411ManualImportBusy)cityBrSwitch={status:'SONARR_BUSY',converted:converted.length};
            else{
              const batch=unconverted.slice(0,prior.phase==='ready'?32:1);
              const fileData=[];
              const before=[];
              for(const e of batch){
                const original=byAbsolute.get(Number(e.absoluteEpisodeNumber));
                const st=fs.lstatSync(localPath(original.path));
                if(!st.isFile()||st.isSymbolicLink()||st.size!==original.size)
                  throw new Error('BR manifest mismatch '+e.absoluteEpisodeNumber);
                const existing=regById.get(Number(e.episodeFileId));
                if(!sourceCheck(existing)&&!allowAfterSafeRescan)throw new Error('Existing library episode missing '+e.id);
                fileData.push({
                  path:original.path,seriesId:45,episodeIds:[Number(e.id)],
                  quality:{quality:qdef.quality,revision:{version:1,real:0}},
                  languages:[],releaseGroup:'',indexerFlags:0,releaseType:'singleEpisode'
                });
                before.push({id:Number(e.id),previousFileId:Number(e.episodeFileId),
                  size:original.size,absolute:Number(e.absoluteEpisodeNumber)});
              }
              const cmd=await api(SB,sh,'/api/v3/command',{
                method:'POST',body:JSON.stringify({name:'ManualImport',importMode:'copy',files:fileData})
              });
              const state={phase:'batch',commandId:cmd?.id||null,files:before,
                submittedAt:new Date().toISOString()};
              const temp=BR_STATE+'.tmp';
              fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,BR_STATE);
              cityBrSwitch={status:'BR_REPLACEMENT_SUBMITTED',commandId:cmd?.id||null,
                submitted:batch.length,convertedBefore:converted.length,
                remainingBefore:unconverted.length,absoluteNumbers:before.map(x=>x.absolute),
                seedingPreserved:true};
            }
          }
        }
      }
    }
  }
}
if(cityBrSwitch?.status==='BR_INTEGRAL_S01_S02_COMPLETE'){
  const temp=BR_DONE+'.tmp';
  fs.writeFileSync(temp,JSON.stringify({
    seriesId:45,episodes:140,seasons:{'1':51,'2':63,'3':13,'4':13},
    completedAt:new Date().toISOString(),source:'City Hunter - Nicky Larson [Multi] [BR]'
  }));
  fs.renameSync(temp,BR_DONE);
}
}catch(e){cityBrSwitch={status:'BR_SWITCH_ERROR',error:e.message};}


const QUEUE_RECONCILE_APPLY=true;
let sonarrQueueReconciliation={status:'NOT_CHECKED',items:[]};
try {
const cfgs=await api(SB,sh,'/api/v3/downloadclient');
const qbClients=(Array.isArray(cfgs)?cfgs:[]).filter(x=>
  /qbittorrent/i.test(String(x.implementation||x.name||''))&&x.enable!==false);
const categories=qbClients.map(c=>{
  const f=(Array.isArray(c.fields)?c.fields:[]).find(f=>String(f.name||'').toLowerCase()==='tvcategory');
  return {name:String(c.name||''),implementation:String(c.implementation||''),
    category:String(f?.value??''),categoryFields:(Array.isArray(c.fields)?c.fields:[])
      .filter(z=>/categor|label|postimport/i.test(String(z.name||'')))
      .map(z=>({name:String(z.name||''),value:String(z.value??'')})),
    fieldNames:(Array.isArray(c.fields)?c.fields:[]).map(z=>String(z.name||'')),
    removeCompletedDownloads:c.removeCompletedDownloads===true};
});
const categoryGuard=categories.length>0&&
  categories.every(x=>x.category.toLowerCase()==='sonarr');
const candidates=[
  {name:'Supernatural.COMPLETE.MULTi.1080p.10bit.WEBRiP.x265.HEVC.DDP.AvALoN',seriesId:59,expected:327,kind:'season'},
  {name:'24.INTEGRALE.MULTI.1080p.WEB.H265-TyHD',seriesId:60,expected:204,kind:'season'},
  {name:'Code Geass Lelouch of the Rebellion MULTi 1080p 10bits BluRay x265 AAC -Punisher694',seriesId:37,expected:50,kind:'season'},
  {name:'City Hunter - Nicky Larson [Multi] [BR]',seriesId:45,expected:140,kind:'absolute',hashPrefix:'e447950fdb77'},
  {name:'Nicky.Larson.INTEGRALE.S01.S04.UNCUT.1987.MULTI.VFI.DVDRip.AAC.1.0.x264-DragonMax',seriesId:45,expected:140,kind:'absolute',hashPrefix:'af0126df2041'},
  {name:'Neon.Genesis.Evangelion.1995.iNTEGRALE.CUSTOM.MULTi.1080p.10bits.BluRay.x265.DDP.5.1.v2-Punisher694',seriesId:38,expected:26,kind:'season'},
  {name:'Charmed.1998.COMPLETE.MULTi.1080p.BluRay.10bits.x265.DD2.0-Jarod',seriesId:42,expected:173,kind:'multipart'}
];
const aT=Array.isArray(torrents)?torrents:[];
const qc=sonarrQueue?.records||[];
const auditItems=[];
for(const spec of candidates){
  const t=aT.find(x=>String(x.name||'')===spec.name&&
    (!spec.hashPrefix||String(x.hash||'').toLowerCase().startsWith(spec.hashPrefix)));
  const result={torrent:spec.name,seriesId:spec.seriesId,expected:spec.expected,
    status:'NOT_READY',reason:null};
  if(!t){result.reason='TORRENT_NOT_FOUND';auditItems.push(result);continue;}
  const hash=String(t.hash||'').toLowerCase();
  const qq=qc.filter(x=>String(x.downloadId||'').toLowerCase()===hash);
  result.queueIds=qq.map(x=>x.id);
  result.category=t.category;result.state=t.state;result.c411=hasTag(t,'seed-c411');
  result.progress=t.progress;
  if(String(t.category||'')===''&&hasTag(t,'seed-sonarr')&&
     hasTag(t,'seed-c411')&&!hasTag(t,'xyzsubz')&&Number(t.progress)===1){
    result.status='ALREADY_PARKED';result.reason=null;
    auditItems.push(result);continue;
  }
  if(Number(t.progress)!==1||!hasTag(t,'seed-c411')||hasTag(t,'xyzsubz')||
      !['sonarr',''].includes(String(t.category||'').toLowerCase())||
      /moving|checking/i.test(String(t.state||''))){
    result.reason='TORRENT_GUARD';auditItems.push(result);continue;
  }
  const s=(ctx.sonarrSeries||[]).find(x=>Number(x.id)===spec.seriesId);
  if(!s||!String(s.path||'').startsWith('/volume1/VideoFactory/_Plex/media/Series/')){
    result.reason='UNEXPECTED_SERIES';auditItems.push(result);continue;
  }
  const [eps,files,manifest]=await Promise.all([
    api(SB,sh,'/api/v3/episode?seriesId='+spec.seriesId+'&includeImages=false'),
    api(SB,sh,'/api/v3/episodefile?seriesId='+spec.seriesId),
    api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(hash))
  ]);
  const e=Array.isArray(eps)?eps:[];
  const byFileId=new Map((Array.isArray(files)?files:[]).map(f=>[Number(f.id),f]));
  const all=Array.isArray(manifest)?manifest:[];
  const vids=all.filter(f=>videoExt.has(path.posix.extname(String(f.name||'')).toLowerCase()));
  const episodeVideos=vids.filter(f=>!String(f.name||'').toLowerCase().split('/').includes('bonus'));
  let mapped=[],validNames=true;
  for(const f of episodeVideos){
    const name=path.posix.basename(String(f.name||''));
    let episode=null;
    if(spec.kind==='absolute'){
      const m=name.match(/(?:^|[- ])(\d{3})(?=\s*[-. ]|$)/);
      const number=m?Number(m[1]):0;
      const hits=e.filter(x=>Number(x.seasonNumber)>0&&
        Number(x.absoluteEpisodeNumber)===number);
      episode=hits.length===1?hits[0]:null;
    }else{
      episode=safePackEpisodeMatch(name,e,s);
      if(!episode&&spec.kind==='multipart'){
        const m=name.match(/S(\d{1,2})[ ._-]*E(\d{1,3})[ ._-]*E(\d{1,3})(?!\d)/i);
        if(m){
          const hits=[Number(m[2]),Number(m[3])].map(n=>
            e.find(z=>Number(z.seasonNumber)===Number(m[1])&&
              Number(z.episodeNumber)===n));
          if(hits.every(Boolean)&&hits.every(z=>z.hasFile)&&
            Number(hits[0].episodeFileId)===Number(hits[1].episodeFileId))
            episode=hits[0];
        }
      }
    }
    if(!episode){validNames=false;continue;}
    mapped.push(episode);
  }
  const ids=mapped.map(x=>Number(x.id));
  const unique=validNames&&ids.length===spec.expected&&
    episodeVideos.length===spec.expected&&
    new Set(ids).size===ids.length;
  const linked=mapped.filter(ep=>{
    const f=byFileId.get(Number(ep.episodeFileId));
    return ep.hasFile&&f&&
      String(f.path||'').startsWith(String(s.path||'').replace(/[/]+$/,'')+'/')&&
      existsNas(String(f.path||''));
  }).length;
  const manifestComplete=all.length>0&&all.every(f=>Number(f.progress)===1);
  result.videoFiles=vids.length;result.episodeVideoFiles=episodeVideos.length;
  result.uniqueMapping=unique;result.libraryCovered=linked;
  result.manifestComplete=manifestComplete;
  result.reason=(!unique?'EPISODE_MAPPING_INCOMPLETE':
    !manifestComplete?'TORRENT_INCOMPLETE':
    linked!==spec.expected?'LIBRARY_NOT_FULLY_COVERED':
    !categoryGuard?'SONARR_CLIENT_CATEGORY_NOT_VERIFIED':null);
  result.status=result.reason?'NOT_READY':
    String(t.category||'')==='sonarr'?'READY_TO_PARK':'ALREADY_PARKED';
  if(QUEUE_RECONCILE_APPLY&&result.status==='READY_TO_PARK'){
    await parkTorrent(t,'seed-sonarr');
    result.status='PARKED_KEEP_SEEDING';
  }
  auditItems.push(result);
}
sonarrQueueReconciliation={status:QUEUE_RECONCILE_APPLY?'APPLIED':'DRY_RUN',
  clientCategories:categories,categoryGuard,items:auditItems};
}catch(e){sonarrQueueReconciliation={status:'RECONCILE_ERROR',error:e.message};}


let sonarrRemainingAudit=[];
try {
const list=(Array.isArray(torrents)?torrents:[]).filter(t=>
  String(t.category||'').toLowerCase()==='sonarr'&&
  Number(t.progress)===1&&!hasTag(t,'xyzsubz'));
const seriesCache=new Map();
for(const t of list){
  const row={torrent:t.name,hashPrefix:String(t.hash||'').slice(0,12),
    qbitState:t.state,c411:hasTag(t,'seed-c411'),progress:t.progress,
    sourcePath:t.content_path,queue:[],
    episodeVideoCount:0,mappedCount:0,coveredCount:0,uniqueMapping:false,
    unmatchedNames:[],sampleFiles:[],pathExamples:[]};
  try{
    const hash=String(t.hash||'').toLowerCase();
    row.queue=(sonarrQueue?.records||[]).filter(q=>
      String(q.downloadId||'').toLowerCase()===hash).map(q=>({
        id:q.id,seriesId:q.seriesId,trackedDownloadState:q.trackedDownloadState,
        messages:(q.statusMessages||[]).flatMap(m=>m.messages||[]).slice(0,2)
      }));
    const qSeriesIds=[...new Set(row.queue.map(q=>Number(q.seriesId)).filter(Boolean))];
    const s=qSeriesIds.length===1?
      (ctx.sonarrSeries||[]).find(s=>Number(s.id)===qSeriesIds[0]):null;
    const candidate=(ctx.sonarrSeries||[]).filter(s=>{
      const title=normTitle(s.title);
      const release=normTitle(t.name);
      return title.length>=4&&(release===title||release.startsWith(title+' '));
    });
    const match=s||(candidate.length===1?candidate[0]:null);
    if(!match){row.error='NO_UNIQUE_SERIES';sonarrRemainingAudit.push(row);continue;}
    row.seriesId=Number(match.id);row.seriesTitle=match.title;
    if(!seriesCache.has(match.id)){
      const [episodes,files]=await Promise.all([
        api(SB,sh,'/api/v3/episode?seriesId='+match.id+'&includeImages=false'),
        api(SB,sh,'/api/v3/episodefile?seriesId='+match.id)]);
      seriesCache.set(match.id,{episodes:Array.isArray(episodes)?episodes:[],
        files:Array.isArray(files)?files:[]});
    }
    const data=seriesCache.get(match.id);
    const byFileId=new Map(data.files.map(f=>[Number(f.id),f]));
    const manifest=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
    const files=(Array.isArray(manifest)?manifest:[]).filter(f=>
      videoExt.has(path.posix.extname(String(f.name||'')).toLowerCase())&&
      !String(f.name||'').toLowerCase().split('/').includes('bonus'));
    row.episodeVideoCount=files.length;row.sampleFiles=files.slice(0,3).map(f=>f.name);
    // Only exact known SAO recap filenames are excluded from regular coverage.
    row.ignoredRecapVideos=[];
    row.allVideosComplete=files.length>0&&files.every(f=>Number(f.progress)===1);
    const matched=[];
    for(const f of files){
      const basename=path.posix.basename(String(f.name||''));
      const name=String(t.name||'');
      const recap=Number(match.id)===48&&Number(match.year)===2012&&(
        (name==='Sword.Art.Online.2.MULTI.1080P.BLURAY.X264-SLEEPINGFOREST'&&/\.E14\.5\./i.test(basename))||
        (name==='Sword.Art.Online.Alicization.SUBFRENCH.1080p.WEBRip.x264-SLEEPINGFOREST'&&/\.E18\.5\./i.test(basename)));
      if(recap){row.ignoredRecapVideos.push(basename);continue;}
      let ep=VERIFIED_OP_C411_PACKS[String(t?.hash||'').toLowerCase()]
        ?verifiedOnePieceC411Episode(t,basename,data.episodes,match)
        :safePackEpisodeMatch(basename,data.episodes,match);
      // One Piece (1999) HANAMi labels absolute episodes 1-61 as S01E01-S01E61.
      // Sonarr/TVDB split them across seasons 1-5: use the absolute index only
      // for the exact, verified anime torrent and series identity, never live-action.
      if(!ep&&Number(match.tvdbId)===81797&&Number(match.year)===1999&&
         String(t.name||'')==='One.Piece.S01.MULTi.1080p.WEBRiP.x264-HANAMi'){
        const anime=basename.match(/^One\.Piece\.S01E(\d{2})(?!\d)/i);
        const absolute=anime?Number(anime[1]):0;
        if(absolute>=9&&absolute<=61){
          const hits=data.episodes.filter(e=>Number(e.seasonNumber)>0&&
            Number(e.absoluteEpisodeNumber)===absolute);
          if(hits.length===1)ep=hits[0];
        }
      }
      // Exact One Piece HANAMi packs use continuous absolute episode numbering.
      if(!ep&&Number(match.tvdbId)===81797&&Number(match.year)===1999){
        const pack=String(t.name||'').match(/^One\.Piece\.S(05|06|08|09|10)\.MULTi\.1080p\.WEBRiP\.x264-HANAMi$/i);
        const label=basename.match(/^One\.Piece\.S(\d{2})E(\d{2})(?!\d)/i);
        if(pack&&label&&+pack[1]===+label[1]){
          const first=data.episodes.find(e=>+e.seasonNumber===+pack[1]&&+e.episodeNumber===1);
          const abs=+first?.absoluteEpisodeNumber+(+label[2]-1);
          const hits=first?data.episodes.filter(e=>+e.seasonNumber>0&&+e.absoluteEpisodeNumber===abs):[];
          if(hits.length===1)ep=hits[0];
        }
      }
      // Strictly known SAO packs have E## rather than S##E## filenames.
      if(!ep&&Number(match.id)===48&&Number(match.year)===2012){
        const name=String(t.name||'');
        const season=name==='Sword.Art.Online.2.MULTI.1080P.BLURAY.X264-SLEEPINGFOREST'?2:
          name==='Sword.Art.Online.Alicization.SUBFRENCH.1080p.WEBRip.x264-SLEEPINGFOREST'?3:0;
        const label=basename.match(/^Sword\.Art\.Online\.(?:2|Alicization)\.E(\d{2})(?!\d)/i);
        if(season&&label&&+label[1]>=1&&+label[1]<=24)
          ep=data.episodes.find(e=>+e.seasonNumber===season&&+e.episodeNumber===+label[1])||null;
      }
      // Initial D ROMKENT: Stage names are seasons, never absolute S01 episodes.
      // Read-only audit mapping limited to TVDB 70900 and the exact integral torrent.
      if(!ep&&Number(match.tvdbId)===70900&&Number(match.year)===1998&&
         String(t.name||'')==='Initial.D.1998.A.2014.MULTi.VFi.1080p.mHD.x264.AC3-ROMKENT'){
        const st=basename.match(/^Initial\.D\.(First|Second|Third|Fourth|Fifth|Final)\.Stage\.\d{4}(?:\.E(\d{2}))?/i);
        const sm={First:1,Second:2,Third:3,Fourth:4,Fifth:5,Final:6};
        if(st){
          const season=sm[st[1]],number=st[2]?Number(st[2]):1;
          ep=data.episodes.find(e=>Number(e.seasonNumber)===season&&Number(e.episodeNumber)===number)||null;
        }else if(/^Initial\.D\.Extra\.Stage\.2\.2008\./i.test(basename)){
          ep=data.episodes.find(e=>Number(e.seasonNumber)===0&&Number(e.episodeNumber)===5)||null;
        }else if(/^Initial\.D\.Extra\.Stage\.2001\./i.test(basename)){
          const both=[1,2].map(num=>data.episodes.find(e=>Number(e.seasonNumber)===0&&Number(e.episodeNumber)===num));
          if(both.every(Boolean)&&both.every(e=>e.hasFile)&&Number(both[0].episodeFileId)===Number(both[1].episodeFileId)){
            ep=both[0];row.multiEpisodeValidated=(row.multiEpisodeValidated||0)+1;
          }
        }
      }
      if(!ep){
        const m=basename.match(/^(\d{1,3})\s*[-. ]/);
        const n=m?Number(m[1]):0;
        if(n){
          const hits=data.episodes.filter(e=>Number(e.seasonNumber)>0&&
            Number(e.absoluteEpisodeNumber)===n);
          if(hits.length===1)ep=hits[0];
        }
      }
      if(!ep&&Number(match.id)===42){
        const parts=basename.match(/S(\d{1,2})[ ._-]*E(\d{1,3})[ ._-]*E(\d{1,3})(?!\d)/i);
        if(parts){
          const both=[Number(parts[2]),Number(parts[3])].map(num=>
            data.episodes.find(e=>Number(e.seasonNumber)===Number(parts[1])&&
              Number(e.episodeNumber)===num));
          if(both.every(Boolean)&&both.every(e=>e.hasFile)&&
            Number(both[0].episodeFileId)===Number(both[1].episodeFileId)){
            ep=both[0];
            row.multiEpisodeValidated=(row.multiEpisodeValidated||0)+1;
          }
        }
      }
      if(!ep){
        if(row.unmatchedNames.length<6)row.unmatchedNames.push(f.name);
        continue;
      }
      matched.push(ep);
      const lib=byFileId.get(Number(ep.episodeFileId));
      if(ep.hasFile&&lib&&
        String(lib.path||'').startsWith(String(match.path||'').replace(/[/]+$/,'')+'/')&&
        existsNas(String(lib.path||'')))row.coveredCount++;
      if(row.pathExamples.length<2&&lib)row.pathExamples.push(lib.path);
    }
    row.mappedCount=matched.length;
    row.regularVideoCount=files.length-row.ignoredRecapVideos.length;
    row.uniqueMapping=matched.length===row.regularVideoCount&&new Set(matched.map(e=>Number(e.id))).size===row.regularVideoCount;
    row.fullCoverage=row.allVideosComplete&&row.uniqueMapping&&row.coveredCount===row.regularVideoCount;
    row.registeredFiles=data.files.length;
    row.seriesTotalRegular=data.episodes.filter(e=>Number(e.seasonNumber)>0).length;
  }catch(err){row.error=err.message;}
  sonarrRemainingAudit.push(row);
}
}catch(err){sonarrRemainingAudit=[{error:err.message}];}



const RADARR_PARK_APPLY=true;
let radarrQueueReconciliation={status:'NOT_CHECKED',items:[]};
try{
const cli=await api(RB,rh,'/api/v3/downloadclient');
const clients=(Array.isArray(cli)?cli:[]).filter(x=>/qbittorrent/i.test(x.implementation||'')&&x.enable!==false).map(x=>({
name:x.name,category:String((x.fields||[]).find(f=>f.name==='movieCategory')?.value??'')
}));
const guard=clients.length>0&&clients.every(x=>x.category==='radarr');
const items=[];
for(const t of (Array.isArray(torrents)?torrents:[]).filter(x=>x.category==='radarr'||hasQbitTag(x,'seed-radarr'))){
const entry={torrent:t.name,category:t.category,state:t.state,status:'NOT_READY',reason:null};
if(t.category===''&&hasQbitTag(t,'seed-radarr')){
const ids=[...new Set((radarrHistory?.records||[]).filter(h=>
historyDownloadId(h)===String(t.hash||'').toLowerCase()).map(h=>Number(h.movieId)).filter(Boolean))];
const m=ids.length===1?radarrMovies.find(x=>Number(x.id)===ids[0]):null;
entry.movieId=m?.id||null;
entry.queueIds=(radarrQueue?.records||[]).filter(q=>
String(q.downloadId||'').toLowerCase()===String(t.hash||'').toLowerCase()).map(q=>q.id);
entry.libraryVisible=Boolean(m?.hasFile&&m.movieFile?.path&&existsNas(m.movieFile.path));
entry.sourceVisible=existsNas(String(t.content_path||''));
entry.qbitSavePath=String(t.save_path||'');
entry.qbitContentPath=String(t.content_path||'');
entry.qbitState=String(t.state||'');
entry.qbitAutoManagement=t.auto_tmm;

entry.status=entry.libraryVisible&&entry.sourceVisible&&Number(t.progress)===1&&
!entry.queueIds.length?'ALREADY_PARKED_VERIFIED':'PARKED_REQUIRES_REVIEW';
items.push(entry);continue;
}
const aud=radarrAudit.filter(a=>a.torrent===t.name);
const a=aud.length===1?aud[0]:null;
const c411=hasQbitTag(t,'seed-c411')||isC411Torrent(t,radarrHistory?.records||[],21);
entry.c411=c411;entry.movieId=a?.movieId||null;
if(t.category!=='radarr'||hasQbitTag(t,'xyzsubz')||!c411||
Number(t.progress)!==1||/moving|checking/i.test(t.state||'')){
entry.reason='TORRENT_GUARD';items.push(entry);continue;
}
if(!a||a.match!=='DOWNLOAD_ID'||a.candidates!==1||!a.radarrHasFile||
!a.diskFileVisible||!a.sourcePathVisible||a.radarrHistoryMatches<1){
entry.reason='MOVIE_OR_IMPORT_UNVERIFIED';items.push(entry);continue;
}
const m=radarrMovies.find(x=>Number(x.id)===Number(a.movieId));
const srcRoot=String(t.save_path||'').replace(/[/]+$/,'');
const dst=String(a.movieFilePath||'');
if(!srcRoot.startsWith('/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/radarr')||
!dst.startsWith(String(m?.path||'').replace(/[/]+$/,'')+'/')||
!dst.startsWith(RADARR_ROOT+'/')){
entry.reason='PATH_GUARD';items.push(entry);continue;
}
const manifest=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
const rows=Array.isArray(manifest)?manifest:[];
const videos=rows.filter(f=>videoExt.has(path.posix.extname(f.name||'').toLowerCase()));
if(!rows.length||videos.length!==1||rows.some(f=>Number(f.progress)!==1)){
entry.reason='MANIFEST_NOT_ONE_VIDEO';items.push(entry);continue;
}
const source=path.posix.resolve(srcRoot,String(videos[0].name||''));
if(!source.startsWith(srcRoot+'/')||!existsNas(source)||!existsNas(dst)){
entry.reason='SOURCE_NOT_ACCESSIBLE';items.push(entry);continue;
}
try{
const p1=localPath(source),p2=localPath(dst),s1=fs.lstatSync(p1),s2=fs.lstatSync(p2);
if(!s1.isFile()||!s2.isFile()||s1.isSymbolicLink()||s2.isSymbolicLink()||
s1.size<1048576||s1.size!==s2.size||s1.size!==Number(videos[0].size)){
entry.reason='FILE_SIZE_OR_TYPE_DIFFERENT';items.push(entry);continue;
}
function sample(p,n){
const fd=fs.openSync(p,'r');const bufs=[];
try{
for(const off of [0,Math.floor((n-65536)/2),n-65536]){
const b=Buffer.alloc(65536);
if(fs.readSync(fd,b,0,b.length,off)!==b.length)throw Error('SHORT_READ');
bufs.push(b);
}
}finally{fs.closeSync(fd);}
return bufs;
}
const b1=sample(p1,s1.size),b2=sample(p2,s2.size);
entry.contentSamplesMatch=b1.every((b,i)=>b.equals(b2[i]));
entry.bytes=s1.size;entry.sameInode=s1.dev===s2.dev&&s1.ino===s2.ino;
if(!entry.contentSamplesMatch){entry.reason='FILE_CONTENT_DIFFERENT';items.push(entry);continue;}
}catch(e){entry.reason='PHYSICAL_VERIFICATION_ERROR';entry.error=e.message;items.push(entry);continue;}
if(!guard){entry.reason='DOWNLOAD_CLIENT_CATEGORY_GUARD';items.push(entry);continue;}
entry.status='READY_TO_PARK';
if(RADARR_PARK_APPLY){
await parkTorrent(t,'seed-radarr');
entry.status='PARKED_KEEP_SEEDING';
}
items.push(entry);
}
radarrQueueReconciliation={status:RADARR_PARK_APPLY?'APPLIED':'DRY_RUN',clients,categoryGuard:guard,items};
}catch(e){radarrQueueReconciliation={status:'ERROR',error:e.message};}


let radarrRecovery={status:'NOT_CHECKED'};
try{
const stage='/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/radarr';
const checks=[
  [173,'Moana.2026.MULTi.VF2.1080p.WEBRip.10.bits.EAC3.5.1.x265-GL0P.mkv'],
  [181,"Les Ailes De L'enfer 1997 Multi 1080p BluRay x265 (Con Air) - VMPP.mkv"],
  [142,'Shazam 2019 MULTi VF2 1080p BluRay EAC3 x265-Winks.mkv'],
  [143,'Black.Adam.2022.MULTi.VF2.1080p.WEB.x264-FW'],
  [215,'The.First.Slam.Dunk.2022.MULTi.1080p.WEB.H264-AMB3R.mkv']
];
if(!canMapNas(stage)||!existsNas(stage))
  throw Error('STAGING_NOT_ACCESSIBLE');
radarrRecovery={status:'ALL_VERIFIED',checked:[]};
for(const [id,name] of checks){
  const t=(Array.isArray(torrents)?torrents:[]).find(t=>t.name===name);
  const m=radarrMovies.find(m=>Number(m.id)===id);
  if(!t||!m?.hasFile||!existsNas(m.movieFile?.path)||!hasQbitTag(t,'seed-radarr')||
     !(hasQbitTag(t,'seed-c411')||isC411Torrent(t,radarrHistory?.records||[],21))||hasQbitTag(t,'xyzsubz')||Number(t.progress)!==1)
    throw Error('TORRENT_OR_LIBRARY_GUARD_'+id+JSON.stringify({torrent:!!t,movie:!!m,hasFile:m?.hasFile,visible:existsNas(m?.movieFile?.path),tags:t?.tags,progress:t?.progress}));
  const p=await api(QB,qh,'/api/v2/torrents/files?hash='+encodeURIComponent(t.hash));
  if(!Array.isArray(p)||!p.length||p.some(f=>Number(f.progress)!==1))
    throw Error('INCOMPLETE_MANIFEST_'+id);
  const ready=p.every(f=>{
    const dest=path.posix.resolve(stage,String(f.name||''));
    if(!dest.startsWith(stage+'/')||!existsNas(dest))return false;
    try{return fs.statSync(localPath(dest)).size===Number(f.size)}catch{return false}
  });
  if(String(t.save_path||'')===stage){
    if(!ready||/moving|checking/i.test(String(t.state||''))){
      radarrRecovery={status:'RELOCATED_AWAITING_FILES',movieId:id,torrent:name,state:t.state};
      break;
    }
    radarrRecovery.checked.push({id,verified:true,files:p.length,state:t.state});
    continue;
  }
  if(String(t.save_path||'')!=='/volume1/downloads/complete'||
     /moving|checking/i.test(String(t.state||'')))
    throw Error('UNEXPECTED_TORRENT_STATE_'+id);
  const present=p.filter(f=>existsNas(path.posix.resolve(stage,String(f.name||''))));
  if(present.length){
    if(present.length!==p.length||p.length!==1)
      throw Error('NONUNIQUE_DESTINATION_COLLISION_'+id);
    const f=p[0],dst=path.posix.resolve(stage,String(f.name||''));
    const a=fs.lstatSync(localPath(dst)),b=fs.lstatSync(localPath(m.movieFile.path));
    if(!a.isFile()||a.isSymbolicLink()||a.size!==Number(f.size)||
       a.dev!==b.dev||a.ino!==b.ino)
      throw Error('DESTINATION_NOT_LIBRARY_HARDLINK_'+id);
  }
  await qbitForm('/api/v2/torrents/setAutoManagement',{hashes:t.hash,enable:'false'});
  await qbitForm('/api/v2/torrents/setLocation',{hashes:t.hash,location:stage});
  radarrRecovery={status:'RELOCATION_REQUESTED',movieId:id,torrent:name,target:stage,files:p.length};
  break;
}
}catch(e){radarrRecovery={status:'RECOVERY_BLOCKED',reason:e.message};}

let hunterRepair={status:'NOT_CHECKED'};
try{
const t=torrents.find(t=>t.name==='Hunter x Hunter (2011) Bluray ripp x265 Multi Phoenix'&&t.category==='sonarr'),s=ctx.sonarrSeries.find(s=>Number(s.id)===39);
if(!t||!s||!hasTag(t,'seed-c411')||hasTag(t,'xyzsubz')||t.progress!==1)throw Error('SOURCE_GUARD');
const root=String(t.content_path||'').replace(/[/]+$/,'');
if(!root.startsWith('/volume1/VideoFactory/_Plex/media/downloads/qbittorrent/sonarr/')||!existsNas(root))throw Error('MOUNT_GUARD');
const [es,fsr,mf]=await Promise.all([api(SB,sh,'/api/v3/episode?seriesId=39&includeImages=false'),api(SB,sh,'/api/v3/episodefile?seriesId=39'),api(QB,qh,'/api/v2/torrents/files?hash='+t.hash)]);
const ef=new Map(fsr.map(f=>[Number(f.id),f]));
const vids=mf.filter(f=>videoExt.has(path.posix.extname(f.name||'').toLowerCase()));
const regular=vids.filter(f=>!String(f.name).toLowerCase().split('/').includes('special'));
if(vids.length!==150||regular.length!==148||mf.some(f=>Number(f.progress)!==1))throw Error('MANIFEST_GUARD');
const pairs=regular.map(f=>({f,e:safePackEpisodeMatch(path.posix.basename(f.name),es,s)}));
if(pairs.some(x=>!x.e)||new Set(pairs.map(x=>x.e.id)).size!==148)throw Error('MAPPING_GUARD');
const visible=x=>{const f=ef.get(Number(x.e.episodeFileId));return x.e.hasFile&&f&&String(f.path||'').startsWith(s.path+'/')&&existsNas(f.path)};
const missing=pairs.filter(x=>!x.e.hasFile),stale=pairs.filter(x=>x.e.hasFile&&!visible(x));
hunterRepair={status:'AUDITED',verified:pairs.filter(visible).length,missing:missing.length,stale:stale.length,specialsExcluded:2,physicalVideos:walk(localPath(s.path)).length,staleSamples:stale.slice(0,8).map(x=>({season:x.e.seasonNumber,episode:x.e.episodeNumber,id:x.e.id,registeredPath:ef.get(Number(x.e.episodeFileId))?.path||null,source:x.f.name}))};
const sf='/home/node/.n8n/hunter-sonarr-repair.json';
let prior={};try{prior=JSON.parse(fs.readFileSync(sf,'utf8'))}catch{}
if(prior.ids?.length){
const got=prior.ids.filter(id=>pairs.some(x=>x.e.id===id&&visible(x))).length;
hunterRepair={status:got===prior.ids.length?'BATCH_VERIFIED':'BATCH_PENDING',verified:got,submitted:prior.ids.length,commandId:prior.commandId,missing:missing.length};
if(got===prior.ids.length)fs.writeFileSync(sf,JSON.stringify({phase:'ready'}));
}else if(hunterRepair.physicalVideos!==hunterRepair.verified)hunterRepair.status='UNRECONCILED_PHYSICAL_FILES';
else if(!missing.length&&!stale.length){
await parkTorrent(t,'seed-sonarr');hunterRepair.status='PARKED_KEEP_SEEDING';
}else{
const batch=[...missing,...stale].slice(0,prior.phase==='ready'?24:1),sources=[];
for(const x of batch){
const p=path.posix.resolve(String(t.save_path||''),String(x.f.name||''));
if(!p.startsWith(root+'/')||!existsNas(p))throw Error('SOURCE_MISSING');
const st=fs.lstatSync(localPath(p));if(!st.isFile()||st.isSymbolicLink()||st.size!==Number(x.f.size))throw Error('SOURCE_SIZE');
sources.push({p,id:x.e.id});
}
const size=synoplexMkvVideoSize(sources[0].p);
if(!size)throw Error('QUALITY_UNREADABLE');
const qn='Bluray-'+(size.height>=900?'1080p':size.height>=650?'720p':'480p');
const defs=await api(SB,sh,'/api/v3/qualitydefinition');
const def=defs.find(d=>String(d.quality?.name||'').toLowerCase()===qn.toLowerCase());
if(!def?.quality?.id)throw Error('QUALITY_NOT_CONFIGURED');
const data=sources.map(x=>({path:x.p,seriesId:39,episodeIds:[x.id],quality:{quality:def.quality,revision:{version:1,real:0}},languages:[],releaseGroup:'',indexerFlags:0,releaseType:'singleEpisode'}));
const cmd=await api(SB,sh,'/api/v3/command',{method:'POST',body:JSON.stringify({name:'ManualImport',importMode:'copy',files:data})});
fs.writeFileSync(sf,JSON.stringify({ids:sources.map(x=>x.id),commandId:cmd?.id||null}));
hunterRepair={status:'IMPORT_SUBMITTED',submitted:data.length,remainingBefore:missing.length+stale.length,commandId:cmd?.id,quality:qn};
}
}catch(e){hunterRepair={status:'HUNTER_REPAIR_BLOCKED',reason:e.message};}

let bleachAudit={status:'SUSPENDED_AFTER_PLEX_RECOVERY'};

// Reconcile physically registered Sonarr coverage without pretending to prove provenance.
const byTorrent=new Map(sonarrRemainingAudit.filter(x=>x?.torrent).map(x=>[x.torrent,x]));
for(const r of results){
  const a=byTorrent.get(r.torrent);
  if(r.status==='SONARR_SEED_FOLDER_IMPORT_CHECK'&&r.importConfirmedForTorrent===false&&a){
    r.libraryCoverageVerified=a.fullCoverage===true;
    if(r.libraryCoverageVerified)r.status='SONARR_SEED_FOLDER_LIBRARY_COVERAGE_VERIFIED';
  }
}
const summary={
radarr:results.filter(x=>x.category==='radarr').length,
sonarr:results.filter(x=>x.category==='sonarr').length,
removed:results.filter(x=>x.qbitRemoved).length,
keptSeeding:results.filter(x=>x.keepSeeding===true).length,
c411Kept:results.filter(x=>x.c411===true||x.status==='PARKED_C411_KEEP_SEEDING').length,
waitingImport:results.filter(x=>x.status==='WAITING_OR_INCOMPLETE_IMPORT'||x.status==='PACK_MANUAL_PREVIEW_NEEDS_REVIEW'||x.status==='PACK_IMPORT_DEFERRED'||x.status==='PACK_NAS_ACL_NOT_VERIFIED'||x.status==='PACK_IMPORT_UNCONFIRMED'||x.status==='PACK_RECOVERY_DRY_RUN').length,
manualImportSubmitted:results.filter(x=>x.status==='PACK_MANUAL_IMPORT_SUBMITTED').length,
blockedByNasAcl:results.filter(x=>x.status==='PACK_NAS_ACL_NOT_VERIFIED').length,
importUnconfirmed:results.filter(x=>x.status==='PACK_IMPORT_UNCONFIRMED').length,
needsReview:results.filter(x=>/^(PACK_|C411_IMPORT_AMBIGUOUS_SERIES|SKIP_NO_MOVIE_MATCH)/.test(x.status||'') && !/^(PACK_MANUAL_IMPORT_SUBMITTED|PACK_ALL_EPISODES_PRESENT)$/.test(x.status||'')).length,
packRelocationsRequested:results.filter(x=>/RELOCATION_REQUESTED/.test(x.status||'')).length,
packEpisodeVerified:results.filter(x=>x.status==='SONARR_TORRENT_EPISODES_VERIFIED').length,
packEpisodePartial:results.filter(x=>x.status==='SONARR_PACK_PARTIALLY_VERIFIED').length,
importUnconfirmedTotal:results.filter(x=>x.importConfirmedForTorrent===false).length,
sourceProvenanceUnconfirmedTotal:results.filter(x=>x.importConfirmedForTorrent===false).length,
libraryCoverageVerifiedTotal:results.filter(x=>x.libraryCoverageVerified===true).length,
libraryCoverageUnconfirmedTotal:results.filter(x=>x.importConfirmedForTorrent===false&&x.libraryCoverageVerified!==true).length,
blockedOrNeedsReview:results.filter(x=>x.libraryCoverageVerified!==true&&/^(C411_SEED_PRESERVED_MOVE_PENDING|MOVE_ONLY_RELOCATION_REQUIRED|SONARR_SEED_FOLDER_|SONARR_RELOCATION_DIAGNOSTIC|SONARR_PACK_PARTIALLY_VERIFIED|SONARR_MOVED_NOT_IMPORTED)/.test(x.status||'')).length,
errors:results.filter(x=>x.status==='ERROR'||/ERROR$/.test(x.status||'')).length
};


console.log(JSON.stringify({
service:'media-smart-importer',ok:true,seederThreshold:SEEDER_THRESHOLD,
processed:results.length,summary,cityHunterAudit,cityHunterRepair,cityBrMigration,cityBrSwitch,sonarrQueueReconciliation,sonarrRemainingAudit,results,radarrAuditSummary,radarrAudit,radarrQueueReconciliation,radarrRecovery,hunterRepair,bleachAudit,sonarrSeedSummary,sonarrSeedAudit
}));
})().catch(e=>{
console.log(JSON.stringify({service:'media-smart-importer',ok:false,status:'ERROR',error:e.message}));
});