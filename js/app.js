/* ============================================================
   Mes comptes — moteur SQLite intégré (sql.js) + IndexedDB
   ============================================================ */
const APP_VERSION=1;
const VERSION = '2.20.0'; // = version du service worker (sw.js) ; changer avec « npm run nouvelle-version »
const APP_BUILD='v'+VERSION;
const IDB='mescomptes',STORE='db',KEY='main';
const PAGE_SIZE=100;
let SQL=null,db=null,idbOK=true,dirty=0,saveTimer=null;

const SCHEMA=`
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS compte(
  id INTEGER PRIMARY KEY, nom TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'courant',
  solde_initial INTEGER NOT NULL DEFAULT 0, date_ouverture TEXT,
  actif INTEGER NOT NULL DEFAULT 1, ordre_affichage INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS categorie(
  id INTEGER PRIMARY KEY, libelle TEXT NOT NULL, parent_id INTEGER REFERENCES categorie(id));
CREATE TABLE IF NOT EXISTS tiers(
  id INTEGER PRIMARY KEY, nom TEXT NOT NULL UNIQUE, date_creation TEXT NOT NULL,
  date_dernier_paiement TEXT, categorie_defaut_id INTEGER REFERENCES categorie(id));
CREATE TABLE IF NOT EXISTS operation(
  id INTEGER PRIMARY KEY, compte_id INTEGER NOT NULL REFERENCES compte(id),
  type TEXT NOT NULL DEFAULT 'debit', date_operation TEXT NOT NULL,
  montant INTEGER NOT NULL, tiers_id INTEGER REFERENCES tiers(id),
  numero TEXT, commentaire TEXT,
  statut TEXT NOT NULL DEFAULT 'non_pointe',
  previsionnel INTEGER NOT NULL DEFAULT 0,
  supprime INTEGER NOT NULL DEFAULT 0, date_suppression TEXT, date_annulation TEXT,
  cat_path TEXT, hay TEXT,
  date_creation TEXT, date_modification TEXT);
CREATE TABLE IF NOT EXISTS ventilation(
  id INTEGER PRIMARY KEY, operation_id INTEGER NOT NULL REFERENCES operation(id) ON DELETE CASCADE,
  categorie_id INTEGER NOT NULL REFERENCES categorie(id), montant INTEGER NOT NULL, commentaire TEXT);
CREATE TABLE IF NOT EXISTS meta(cle TEXT PRIMARY KEY, valeur TEXT);
CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY, ts TEXT NOT NULL, action TEXT, detail TEXT, sauve INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_op_cd ON operation(compte_id,date_operation,id);
CREATE INDEX IF NOT EXISTS idx_op_st ON operation(compte_id,statut);
DROP INDEX IF EXISTS idx_op_sup;
DROP INDEX IF EXISTS idx_op_tiers;
CREATE INDEX IF NOT EXISTS idx_op_tiers3 ON operation(tiers_id,date_operation,id);
CREATE INDEX IF NOT EXISTS idx_v_op ON ventilation(operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_uni ON categorie(parent_id,libelle);
CREATE TABLE IF NOT EXISTS recurrence(
  id INTEGER PRIMARY KEY,
  compte_id INTEGER NOT NULL REFERENCES compte(id),
  type TEXT NOT NULL DEFAULT 'debit',
  montant INTEGER NOT NULL,
  tiers TEXT,
  cat_path TEXT,
  commentaire TEXT,
  frequence TEXT NOT NULL DEFAULT 'mensuelle',
  intervalle INTEGER NOT NULL DEFAULT 1,
  jour INTEGER,
  date_debut TEXT NOT NULL,
  date_fin TEXT,
  prochaine TEXT NOT NULL,
  creer_en TEXT NOT NULL DEFAULT 'previsionnel',
  actif INTEGER NOT NULL DEFAULT 1,
  date_creation TEXT
);
`;

/* ---------- helpers SQL ---------- */
function run(sql,p){db.run(sql,p||[]);}
function qy(sql,p){const st=db.prepare(sql);if(p)st.bind(p);const out=[];while(st.step())out.push(st.getAsObject());st.free();return out;}
function scal(sql,p){const r=qy(sql,p);if(!r.length)return null;return Object.values(r[0])[0];}
function lastId(){return scal('SELECT last_insert_rowid()');}
function nowTS(){const d=new Date(),p=x=>String(x).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}
function todayISO(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function getMeta(k,def){const v=scal('SELECT valeur FROM meta WHERE cle=?',[k]);return v==null?def:v;}
function setMeta(k,v){run('INSERT INTO meta(cle,valeur) VALUES(?,?) ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur',[k,String(v)]);}

/* ---------- IndexedDB ---------- */
function idbOpen(){return new Promise((res,rej)=>{const r=indexedDB.open(IDB,1);
  r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
function idbPut(b){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');
  t.objectStore(STORE).put(b,KEY);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error||new Error('abort'));}));}
function idbGet(){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readonly');
  const g=t.objectStore(STORE).get(KEY);g.onsuccess=()=>res(g.result||null);g.onerror=()=>rej(g.error);}));}
function idbPutKey(k,v){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readwrite');
  t.objectStore(STORE).put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);}));}
function idbGetKey(k){return idbOpen().then(d=>new Promise((res,rej)=>{const t=d.transaction(STORE,'readonly');
  const g=t.objectStore(STORE).get(k);g.onsuccess=()=>res(g.result||null);g.onerror=()=>rej(g.error);}));}
/* ---------- appli Android (Capacitor, dossier mobile/) ----------
   Le même code tourne dans l'appli. Il est alors dans l'APK : pas de service worker. La sauvegarde
   passe par le module natif « MesComptes » (dossier Téléchargements) et l'appli propose elle-même
   ses nouvelles versions : version.json et l'APK sont publiés avec le site (dossier android/). */
const SITE_APPLI='https://marynedey.github.io/Comptabilite/android/';
const enAppli=()=>typeof Capacitor!=='undefined'&&!!(Capacitor.isNativePlatform&&Capacitor.isNativePlatform());
const natif=(methode,options)=>Capacitor.nativePromise('MesComptes',methode,options||{});
/* 'X.Y.Z' : a est-elle plus récente que b ? */
function versionPlusRecente(a,b){
  const pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);
  for(let i=0;i<3;i++)if((pa[i]||0)!==(pb[i]||0))return (pa[i]||0)>(pb[i]||0);
  return false;}
/* contenu de version.json → la mise à jour à proposer, ou null (rien de neuf, ou fichier douteux) */
function majAppliDisponible(info,actuelle){
  if(!info||!/^\d+\.\d+\.\d+$/.test(info.version||'')||typeof info.apk!=='string'||!info.apk.startsWith(SITE_APPLI))return null;
  return versionPlusRecente(info.version,actuelle)?{version:info.version,apk:info.apk}:null;}
/* octets → base64, par morceaux (une base de plusieurs Mo dépasserait la pile en un seul appel) */
function enBase64(u8){let s='';for(let i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));return btoa(s);}
let majAppli=null,majAppliPlusTard=null,majAppliVue=0;
// → true : nouvelle version (bandeau affiché), false : rien de neuf, null : pas pu vérifier (ou déjà vérifié il y a peu)
async function verifierMajAppli(){
  if(Date.now()-majAppliVue<3600e3)return null; // au plus une fois par heure
  majAppliVue=Date.now();
  let info;
  try{const r=await fetch(SITE_APPLI+'version.json',{cache:'no-store'});if(!r.ok){majAppliVue=0;return null;}info=await r.json();}
  catch(e){majAppliVue=0;return null;} // hors ligne : on réessaiera au prochain retour dans l'appli
  majAppli=majAppliDisponible(info,VERSION);
  const b=document.getElementById('maj-appli');
  if(!majAppli||majAppliPlusTard===majAppli.version){b.hidden=true;document.body.classList.remove('maj-appli-visible');return !!majAppli;}
  document.getElementById('maj-appli-v').textContent=majAppli.version;b.hidden=false;
  document.body.classList.add('maj-appli-visible'); // sur téléphone, le bouton + remonte au-dessus du bandeau
  // le message « N opérations chargées » de l'ouverture passe dans le bandeau au lieu de le chevaucher
  if(msgChargement&&Date.now()-msgChargement.t<6000){document.getElementById('toast').classList.remove('show');}
  document.getElementById('maj-appli-info').textContent=(msgChargement?msgChargement.texte+' · ':'')+'Tes données sont gardées.';
  hauteurBandeauMaj();
  return true;
}
// le bouton + se place au-dessus du bandeau avec le même écart qu'entre le bandeau et les onglets : il suit sa hauteur
function hauteurBandeauMaj(){const b=document.getElementById('maj-appli');
  if(b&&!b.hidden)document.documentElement.style.setProperty('--maj-h',b.offsetHeight+'px');}
window.addEventListener('resize',hauteurBandeauMaj);
/* ouverture : « N opérations chargées », dans le bandeau de mise à jour s'il est affiché, sinon en message bref */
let msgChargement=null;
function texteChargement(n){return n.toLocaleString('fr-FR')+' opération'+(n>1?'s':'')+' '+(enAppli()?'retrouvée'+(n>1?'s':'')+' sur ce téléphone':'chargée'+(n>1?'s':'')+' depuis ce navigateur');}
function annoncerChargement(n){
  msgChargement={texte:texteChargement(n),t:Date.now()};
  if(document.body.classList.contains('maj-appli-visible')){document.getElementById('maj-appli-info').textContent=msgChargement.texte+' · Tes données sont gardées.';hauteurBandeauMaj();}
  else toast(msgChargement.texte);
}
function plusTardMajAppli(){ // reproposée au prochain lancement de l'appli
  if(majAppli)majAppliPlusTard=majAppli.version;document.getElementById('maj-appli').hidden=true;
  document.body.classList.remove('maj-appli-visible');}
async function installerMajAppli(){
  if(!majAppli)return;
  try{
    if(!(await natif('peutInstaller')).ok){
      const ok=await dlgConfirm('Pour installer ses mises à jour, l’appli a besoin d’une autorisation d’Android (une seule fois).\n\n'+
        'Dans l’écran qui va s’ouvrir, active « Autoriser cette source », puis reviens ici et touche à nouveau « Mettre à jour ».',
        'Autoriser les mises à jour','Ouvrir le réglage');
      if(ok)await natif('autoriserInstallation');
      return;}
    clearTimeout(saveTimer);await flushIDB(); // les données sont gardées par la mise à jour : on n'en perd aucune
    busy('Téléchargement de la mise à jour…');
    await natif('installer',{url:majAppli.apk}); // Android affiche ensuite sa propre confirmation
  }catch(e){dlgAlert('La mise à jour n’a pas pu être téléchargée.\n\n'+(e.message||e)+
    '\n\nTu peux continuer à utiliser l’appli et réessayer plus tard.','Mise à jour');}
  finally{unbusy();}
}
async function demarrerAppli(){
  // Android ne reconnaît pas les extensions .sqlite, .db, .qif : sans ce tri, le choix de fichier
  // ne s'ouvrirait pas. Chaque import vérifie de toute façon le contenu du fichier.
  ['fileDb','fileQif','fileAmex'].forEach(id=>{const i=document.getElementById(id);if(i)i.removeAttribute('accept');});
  Capacitor.nativeCallback('App','addListener',{eventName:'backButton'},d=>{
    if(estVerrouille()){Capacitor.nativePromise('App','minimizeApp').catch(()=>{});return;} // verrouillée : Retour la met de côté
    if(dlgResolve){dlgClose(false);return;}         // une fenêtre ouverte : Retour la ferme
    if(fermerFeuilles())return;                     // filtres, liste des comptes, fiche d'une opération
    if(d&&d.canGoBack)history.back();else demanderQuitter();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)verifierMajAppli();});
  brancherVerrou();
  // thème « Automatique » : le téléphone passe en clair ou en sombre → les barres suivent
  if(window.matchMedia)matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(REGLAGES.theme==='auto')majBarresAppli();});
  verifierMajAppli();
  if(!scal('SELECT COUNT(*) FROM operation WHERE supprime=0')){
    const v=await dlgOpen({title:'Bienvenue dans l’appli',msg:'L’appli a son propre stockage : tes comptes enregistrés dans Chrome n’y sont pas encore.\n\n'+
      '1. Dans Chrome, ouvre Mes comptes et touche « Sauvegarder » : le fichier va dans Téléchargements.\n'+
      '2. Ici, touche « Charger une sauvegarde » et choisis ce fichier.\n\nC’est à faire une seule fois.',
      buttons:[{t:'Plus tard',v:false},{t:'Charger une sauvegarde',v:true,p:true}]});
    if(v)document.getElementById('fileDb').click();
  }
}
/* ---------- plein écran (tablette / téléphone : masque les barres du navigateur) ---------- */
function pleinEcranActif(){return !!(document.fullscreenElement||document.webkitFullscreenElement);}
async function basculerPleinEcran(){
  const d=document,el=d.documentElement;
  try{
    if(pleinEcranActif())await (d.exitFullscreen||d.webkitExitFullscreen).call(d);
    else await (el.requestFullscreen||el.webkitRequestFullscreen).call(el,{navigationUI:'hide'});
  }catch(e){toast('Plein écran non disponible sur cet appareil');}
}
function majBoutonPleinEcran(){
  const b=document.getElementById('btn-fs'),ico=document.getElementById('fs-ico');if(!b)return;
  const dispo=!!(document.fullscreenEnabled||document.webkitFullscreenEnabled)&&!enAppli();
  b.style.display=dispo?'':'none';
  const on=pleinEcranActif();
  b.title=on?'Quitter le plein écran':'Plein écran';
  if(ico)ico.setAttribute('d',on?'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5':'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5');
}
document.addEventListener('fullscreenchange',majBoutonPleinEcran);
document.addEventListener('webkitfullscreenchange',majBoutonPleinEcran);
async function annulerDerniere(){
  const e=UNDO[UNDO.length-1];
  if(!e){await dlgAlert('Rien à annuler.\n\nSeules les modifications faites depuis l’ouverture de l’appli peuvent être annulées (les '+UNDO_MAX+' dernières).','Annuler');return;}
  const ok=await dlgConfirm('Annuler la modification n°'+e.jid+' ?\n\n'+e.label+'\n\nLes données reviennent exactement à leur état d’avant cette modification. '+
    'Le journal garde une trace : une ligne « Annulation de la modification n°'+e.jid+' » y sera ajoutée.','Annuler une modification','Annuler la modification');
  if(!ok)return;
  UNDO.pop();
  // le journal et les réglages (meta) restent ceux d'aujourd'hui : seules les données reviennent en arrière
  const jr=qy('SELECT id,ts,action,detail,sauve FROM journal ORDER BY id'),mt=qy('SELECT cle,valeur FROM meta');
  db.close();db=new SQL.Database(e.avant);
  run('DELETE FROM journal');jr.forEach(r=>run('INSERT INTO journal(id,ts,action,detail,sauve) VALUES(?,?,?,?,?)',[r.id,r.ts,r.action,r.detail,r.sauve]));
  run('DELETE FROM meta');mt.forEach(r=>run('INSERT INTO meta(cle,valeur) VALUES(?,?)',[r.cle,r.valeur]));
  run('INSERT INTO journal(ts,action,detail,sauve) VALUES(?,?,?,0)',[nowTS(),'Annulation de la modification n°'+e.jid,e.label]);
  touch(null); // nouvelle photo de référence, sans créer d'entrée annulable
  if(state.acc&&!scal('SELECT id FROM compte WHERE id=?',[state.acc]))state.acc=+scal('SELECT id FROM compte WHERE actif=1 ORDER BY ordre_affichage,id LIMIT 1');
  closeModal();render();toast('Modification n°'+e.jid+' annulée');
}
/* ---------- persistance (différée, non bloquante) ---------- */
/* ---------- annulation (Ctrl+Z) : photos de la base en mémoire ----------
   À chaque modification journalisée, on garde l'état d'avant. Limité aux modifications
   faites depuis l'ouverture de l'appli (les photos ne survivent pas à un rechargement). */
const UNDO_MAX=10;
let UNDO=[],undoBase=null;
function undoReset(){UNDO=[];undoBase=db.export();majBoutonUndo();}
function majBoutonUndo(){const b=document.getElementById('btn-undo');if(!b)return;
  const e=UNDO[UNDO.length-1];b.disabled=!e;
  b.title=e?'Annuler la dernière modification (Ctrl+Z) : n°'+e.jid+' '+e.label:'Rien à annuler (Ctrl+Z — jusqu’à 10 modifications faites depuis l’ouverture)';}
function touch(action,detail){
  let jid=null;
  if(action){run('INSERT INTO journal(ts,action,detail,sauve) VALUES(?,?,?,0)',[nowTS(),action,detail||'']);jid=lastId();}
  if(undoBase){
    if(jid){UNDO.push({jid,label:action+(detail?' — '+detail:''),avant:undoBase});if(UNDO.length>UNDO_MAX)UNDO.shift();}
    undoBase=db.export();majBoutonUndo();
  }
  invalidateCaches();setMeta('updated',nowTS());refreshDirty();
  clearTimeout(saveTimer);saveTimer=setTimeout(flushIDB,900);}
function refreshDirty(){try{dirty=scal('SELECT COUNT(*) FROM journal WHERE sauve=0')||0;}catch(e){dirty=0;}updateStatus();}
async function voirModifications(){
  const rows=qy("SELECT id,ts,action,detail FROM journal WHERE sauve=0 ORDER BY id DESC LIMIT 300");
  if(!rows.length){await dlgAlert('Aucune modification en attente : ta base est identique à ta dernière sauvegarde.','Modifications');return;}
  const html='<div style="max-height:44vh;overflow:auto;border:1px solid var(--line);border-radius:9px">'+
    '<table style="width:100%"><tbody>'+rows.map(r=>
      '<tr><td class="num" style="white-space:nowrap;color:var(--ink-3);font-size:.78rem">n°'+r.id+'</td>'+
      '<td class="num" style="white-space:nowrap;color:var(--ink-3);font-size:.78rem">'+esc(r.ts.slice(8,10)+'/'+r.ts.slice(5,7)+' '+r.ts.slice(11,16))+'</td>'+
      '<td style="font-size:.82rem"><b>'+esc(r.action)+'</b>'+(r.detail?'<div style="color:var(--ink-2)">'+esc(r.detail)+'</div>':'')+'</td></tr>').join('')+
    '</tbody></table></div>'+
    '<div style="font-size:.8rem;color:var(--ink-3);margin-top:10px">Version de tes données : révision '+getMeta('rev',0)+
    ', modifiée le '+(getMeta('updated','')||'—')+'.<br>Ces modifications sont bien enregistrées dans ce navigateur. '+
    'Elles ne sont simplement pas encore recopiées dans un fichier de sauvegarde.</div>';
  const go=await dlgOpen({title:rows.length+' modification'+(rows.length>1?'s':'')+' non sauvegardée'+(rows.length>1?'s':''),msg:'',html,
    buttons:[{t:'Fermer',v:false}].concat(UNDO.length?[{t:'Annuler la dernière (n°'+UNDO[UNDO.length-1].jid+')',v:'undo'}]:[]).concat([{t:'Sauvegarder maintenant',v:true,p:true}])});
  if(go==='undo')annulerDerniere();
  else if(go)sauvegarder();
}
async function flushIDB(){
  if(!idbOK||!db)return;
  try{await idbPut(db.export().buffer);idbErr=null;}
  catch(e){idbErr=e;idbOK=false;}
  updateStatus();
}
let idbErr=null;
function updateStatus(){
  const el=document.getElementById('status'),tx=document.getElementById('status-txt');
  if(!el)return;el.className='status';
  if(idbErr){el.classList.add('err');tx.textContent='Stockage local en échec — sauvegarde le fichier !';return;}
  if(dirty>0){el.classList.add('dirty');tx.textContent=dirty+' modification'+(dirty>1?'s':'')+' non sauvegardée'+(dirty>1?'s':'')+' — voir';}
  else tx.textContent='À jour';
  const pt=document.getElementById('m-point');if(pt)pt.hidden=!(dirty>0);
  if(state.view==='plus'&&db)renderPlus(); // carte « à sauvegarder » à jour
}

/* ---------- dialogues maison ---------- */
let dlgResolve=null,dlgKeyHandler=null;
function dlgClose(v){const b=document.getElementById('dlgBack');b.classList.remove('show');
  document.getElementById('dlgProg').style.display='none';document.getElementById('dlgBody').innerHTML='';
  if(dlgKeyHandler){document.removeEventListener('keydown',dlgKeyHandler,true);dlgKeyHandler=null;}
  const r=dlgResolve;dlgResolve=null;if(r)r(v);}
function dlgOpen({title,msg,html,buttons,onOpen,wide,focusBtn,fermeDehors}){
  return new Promise(res=>{
    dlgResolve=res;
    // fermeDehors : un clic à côté de la boîte la ferme (comme le bouton Fermer)
    document.getElementById('dlgBack').onclick=fermeDehors?(e=>{if(e.target.id==='dlgBack')dlgClose(false);}):null;
    document.getElementById('dlgTitle').textContent=title||'';
    document.getElementById('dlgMsg').textContent=msg||'';
    document.getElementById('dlgBody').innerHTML=html||'';
    const foot=document.getElementById('dlgFoot');foot.innerHTML='';
    (buttons||[{t:'OK',v:true,p:true}]).forEach((b,i)=>{
      const el=document.createElement('button');el.textContent=b.t;
      if(b.p)el.className='primary';if(b.d||b.danger)el.className='danger';
      el.onclick=()=>{if(b.before&&b.before()===false)return;dlgClose(b.v);};
      el.dataset.def=b.p?'1':'';foot.appendChild(el);});
    const boite=document.querySelector('#dlgBack .dlg');
    if(boite)boite.classList.toggle('wide',!!wide);
    document.getElementById('dlgBack').classList.add('show');
    const def=foot.querySelector('button[data-def="1"]')||foot.lastChild;
    setTimeout(()=>{if(onOpen)onOpen();
      if(def&&(focusBtn||!document.querySelector('#dlgBody input,#dlgBody select')))def.focus();},40);
    dlgKeyHandler=e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();dlgClose(false);}
      else if(e.key==='Enter'){const t=e.target;if(t&&t.tagName==='BUTTON')return;
        if(t&&t.type==='checkbox'){e.preventDefault();e.stopPropagation();t.checked=!t.checked;t.dispatchEvent(new Event('change',{bubbles:true}));return;}
        e.preventDefault();e.stopPropagation();if(def)def.click();}
    };
    document.addEventListener('keydown',dlgKeyHandler,true);
  });
}
const dlgAlert=(msg,title)=>dlgOpen({title:title||'Information',msg,buttons:[{t:'OK',v:true,p:true}]});
const dlgConfirm=(msg,title,okTxt,danger)=>dlgOpen({title:title||'Confirmation',msg,
  buttons:[{t:'Annuler',v:false},{t:okTxt||'Confirmer',v:true,p:!danger,d:danger}]});
function busy(txt){const b=document.getElementById('busy');document.getElementById('busyTxt').textContent=txt||'Traitement…';b.classList.add('show');}
function unbusy(){document.getElementById('busy').classList.remove('show');}
const nextFrame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));

/* ---------- écran tactile : le clavier ne doit s'ouvrir que sur un toucher volontaire ---------- */
const ecranTactile=()=>window.matchMedia('(pointer:coarse)').matches;
let _dernierToucher={el:null,t:0};
document.addEventListener('pointerdown',e=>{_dernierToucher={el:e.target,t:Date.now()};},true);
// champs de recherche : si le focus arrive sans qu'on les ait touchés (glissement du curseur, défilement,
// mise à jour de l'écran…), on le retire aussitôt pour ne pas ouvrir le clavier
document.addEventListener('focusin',e=>{
  const el=e.target;
  if(!ecranTactile()||!el||['f-search','ti-search','cat-search'].indexOf(el.id)<0)return;
  const t=_dernierToucher;
  if(!(t.el&&(t.el===el||el.contains(t.el))&&Date.now()-t.t<1000))el.blur();
},true);
/* ---------- formats ---------- */
const fmt=new Intl.NumberFormat('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmt0=new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0});
const eur=c=>(c<0?'-':'')+fmt.format(Math.abs(c)/100)+' €';
// montant resserré (centre de l'anneau) : espace fine avant « € », sans signe
const eurSerre=c=>eur(Math.abs(c)).replace(/\s€$/,'\u202F€');
const eur0=c=>fmt0.format(Math.round(c/100))+' €';
const clsSigne=c=>c>0?'credit':c<0?'debit':'zero';
const catParts=c=>(c||'').split(/\s*:\s*/).filter(Boolean);
const catTop=c=>catParts(c)[0]||'Divers';
function frToISO(s){return shortToISO(s);}
/* ===== masque de date par écrasement, format JJ/MM/AA ===== */
const DIGPOS=[0,1,3,4,6,7];
function slotsDe(value){const s=['','','','','',''];for(let k=0;k<6;k++){const c=value[DIGPOS[k]];if(c&&/\d/.test(c))s[k]=c;}return s;}
function construireDate(slots){
  const ch=[slots[0]||' ',slots[1]||' ','/',slots[2]||' ',slots[3]||' ','/',slots[4]||' ',slots[5]||' '];
  let s=ch.join('').replace(/[ /]+$/,'');
  let pref=0;while(pref<6&&slots[pref]!=='')pref++;
  const total=slots.filter(x=>x!=='').length;
  if(pref===total){if(pref===2)s+='/';else if(pref===4)s+='/';}
  return s;
}
function caretPourK(k){return [0,1,3,4,6,7,8][Math.max(0,Math.min(6,k))];}
function kDeCaret(value,caret){let k=0;for(const p of DIGPOS){if(p<caret)k++;}return k;}
function dateStep(value,selStart,selEnd,inputType,data){
  value=(value||'').slice(0,8);let slots=slotsDe(value);const it=inputType||'';
  const cl=(v,c)=>Math.min(c,v.length);
  if(it==='insertText'||it==='insertFromPaste'){
    const digits=(data||'').replace(/\D/g,'');
    if(!digits){const v=construireDate(slots);return {value:v,caret:cl(v,selStart)};}
    let k=kDeCaret(value,selStart);
    for(const d of digits){if(k>=6)break;slots[k]=d;k++;}
    const v=construireDate(slots);return {value:v,caret:cl(v,caretPourK(k))};
  }
  if(it==='deleteContentBackward'||it==='deleteContentForward'){
    if(selStart!==selEnd){const a=kDeCaret(value,selStart),b=kDeCaret(value,selEnd);
      for(let i=a;i<b&&i<6;i++)slots[i]='';const v=construireDate(slots);return {value:v,caret:cl(v,caretPourK(a))};}
    let k=kDeCaret(value,selStart);const cible=it==='deleteContentBackward'?k-1:k;
    if(cible<0||cible>5){const v=construireDate(slots);return {value:v,caret:cl(v,selStart)};}
    slots[cible]='';const v=construireDate(slots);return {value:v,caret:cl(v,caretPourK(cible))};
  }
  const digs=value.replace(/\D/g,'').slice(0,6).split('');while(digs.length<6)digs.push('');
  const v=construireDate(digs);return {value:v,caret:cl(v,caretPourK(kDeCaret(value,selStart)))};
}
function shortToISO(s){
  let m=(s||'').match(/^(\d{2})\/(\d{2})\/(\d{2})$/),d,mo,y;
  if(m){d=+m[1];mo=+m[2];y=2000+ +m[3];}
  else{m=(s||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);if(!m)return '';d=+m[1];mo=+m[2];y=+m[3];}
  const dt=new Date(y,mo-1,d);
  if(dt.getFullYear()!==y||dt.getMonth()!==mo-1||dt.getDate()!==d)return '';
  return String(y).padStart(4,'0')+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');
}
function isoToShort(iso){if(!iso)return '';const p=iso.split('-');return p[2]+'/'+p[1]+'/'+p[0].slice(2);}
function isoToFr(iso){if(!iso)return '';const p=iso.split('-');return p[2]+'/'+p[1]+'/'+p[0];}
/* Masque de saisie : borne les valeurs DÈS la frappe.
   jour 1-31 (ajusté au mois à la sortie du champ), mois 1-12, année 4 chiffres. */
function maskDate(el){el.classList.toggle('bad',el.value.length>0&&!shortToISO(el.value));}
/* Sortie du champ : ramène le jour au dernier jour du mois (31/02 -> 28/02) */
function fixDate(el){
  const raw=(el.value||'').trim();if(!raw){el.classList.remove('bad');return;}
  const m=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}(?:\d{2})?)$/);
  if(!m){el.classList.add('bad');return;}
  let d=+m[1],mo=+m[2];let y=+m[3];if(m[3].length===2)y+=2000;
  if(mo<1)mo=1;if(mo>12)mo=12;
  const dim=new Date(y,mo,0).getDate();if(d<1)d=1;if(d>dim)d=dim;
  el.value=isoToShort(String(y).padStart(4,'0')+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'));
  el.classList.remove('bad');
}
/* écouteur unique : tout champ .datef reçoit le masque par écrasement */
function brancherMasqueDates(){
  document.addEventListener('beforeinput',e=>{
    const el=e.target;
    if(!el||!el.classList||!el.classList.contains('datef'))return;
    if(!/^(insertText|insertFromPaste|deleteContentBackward|deleteContentForward)$/.test(e.inputType||''))return;
    const r=dateStep(el.value,el.selectionStart,el.selectionEnd,e.inputType,e.data);
    e.preventDefault();el.value=r.value;
    try{el.setSelectionRange(r.caret,r.caret);}catch(_){}
    el.classList.toggle('bad',el.value.length>0&&!shortToISO(el.value));
    // date de début : passer à la date de fin uniquement quand on vient de TAPER le dernier chiffre
    if((e.inputType==='insertText'||e.inputType==='insertFromPaste')&&r.caret>=8&&el.value.length===8&&shortToISO(el.value)){
      const suiv=el.id==='f-from'?'f-to':el.id==='an-from'?'an-to':null;
      if(suiv){const e2=document.getElementById(suiv);if(e2&&e2.offsetParent!==null){e2.focus();e2.select&&e2.select();}}
    }
  },true);
}
function bindDate(id,onchg){
  const el=document.getElementById(id);if(!el)return;
  el.addEventListener('input',e=>maskDate(el,e));
  el.addEventListener('blur',()=>{fixDate(el);if(onchg)onchg();});
  el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();fixDate(el);if(onchg)onchg();}});
}
function parseMontantC(s){s=(s||'').trim().replace(/\s/g,'').replace(',','.');const v=parseFloat(s);
  return isNaN(v)?null:Math.round(v*100);}

const META={
  non_pointe:{label:'Non pointé',col:'#F59E0B'},
  pointe:{label:'Pointé',col:'#2563EB'},
  rapproche:{label:'Rapproché',col:'#15803D'},
  previsionnel:{label:'Prévisionnel',col:'#7C3AED'},
  annule:{label:'Annulé',col:'#94A3B8'}
};
const ACC_TYPES={courant:'Compte courant',livret:'Livret',pel:'PEL',autre:'Compte'};
const PAL=['#0F6E56','#3E6FA8','#B5790C','#A8392B','#6B5BA6','#1B8A8A','#C2723A','#8A6D3B'];

let state={view:'registre',acc:null,sort:'date',dir:-1,page:1,anPath:[],tiSort:'last',tiDir:-1,
  editing:null,addType:'debit',anSens:'debit',recSort:'prochaine',recDir:1};
let anGroups=[];

/* ============================================================
   Démarrage
   ============================================================ */
/* ---------- téléphone : onglets en bas, en-tête avec le choix du compte, écran « Plus » ----------
   Actif dans l'appli Android, sur un téléphone et sur une tablette (écran tactile sans souris ni pavé tactile) ;
   le PC garde la barre latérale. Les écrans existants s'affichent dans ce cadre. */
const estTelephone=()=>enAppli()||(typeof matchMedia==='function'&&matchMedia('(pointer: coarse)').matches
  &&!matchMedia('(any-pointer: fine)').matches);
/* onglet du bas allumé pour chaque écran : ce qui n'a pas d'onglet passe par « Plus » */
function ongletDeVue(v){return {registre:'registre',analyse:'analyse',graphiques:'analyse',recurrences:'recurrences'}[v]||'plus';}
const TITRES_MOBILE={recurrences:'Échéances',plus:'Plus',guide:'Guide',tiers:'Tiers',categories:'Catégories',corbeille:'Corbeille',reglages:'Réglages',releve:'Relevé en cours'};
function ongletMobile(o){fermerListeComptes();setView(o);}
function majMobile(){
  if(!document.body.classList.contains('mobile'))return;
  const o=ongletDeVue(state.view);
  document.querySelectorAll('#m-onglets button').forEach(b=>{b.classList.toggle('on',b.dataset.o===o);
    if(b.dataset.o===o)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  const avecCompte=['registre','analyse','graphiques'].indexOf(state.view)>=0; // écrans qui dépendent du compte choisi
  document.getElementById('m-compte-wrap').hidden=!avecCompte;
  const t=document.getElementById('m-titre');t.hidden=avecCompte;t.textContent=TITRES_MOBILE[state.view]||'';
  const c=state.acc?qy('SELECT nom FROM compte WHERE id=?',[state.acc])[0]:null;
  document.getElementById('m-compte-nom').textContent=c?c.nom:'—';
  document.getElementById('m-point').hidden=!(dirty>0);
}
/* liste déroulante des comptes, sous le nom du compte */
function basculerListeComptes(){if(document.getElementById('m-comptes').hidden)ouvrirListeComptes();else fermerListeComptes();}
function ouvrirListeComptes(){
  const l=document.getElementById('m-comptes');
  l.innerHTML=qy('SELECT id,nom FROM compte WHERE actif=1 ORDER BY ordre_affichage,id').map(c=>
      '<button role="option" aria-selected="'+(c.id===state.acc)+'"'+(c.id===state.acc?' class="on"':'')+' data-id="'+c.id+'" onclick="choisirCompteMobile('+c.id+')">'+
      '<span class="mc-nom">'+esc(c.nom)+'</span><span class="mc-solde num">'+eur(soldeReel(c.id))+'</span></button>').join('')+
    '<p class="mc-aide">Appui long sur un compte pour le modifier</p>'+
    '<hr>'+
    '<button class="mc-action" onclick="fermerListeComptes();ajouterCompte()">+ Nouveau compte</button>';
  l.querySelectorAll('button[data-id]').forEach(b=>appuiLong(b,()=>{fermerListeComptes();editCompte(+b.dataset.id);}));
  l.hidden=false;document.getElementById('m-compte-btn').setAttribute('aria-expanded','true');
  // toucher à côté ferme la liste, et rien d'autre : un voile transparent, sous la liste, prend ce toucher
  // (sans lui, le même toucher ouvrait aussi l'opération ou l'onglet qui se trouvait dessous)
  const v=document.createElement('div');v.className='voile-dehors';v.id='m-comptes-voile';
  v.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();fermerListeComptes();});
  document.getElementById('m-entete').classList.add('menu-ouvert');
  document.getElementById('m-entete').insertBefore(v,document.getElementById('m-compte-wrap'));
}
/* appui long (½ s sans bouger) : action ; le clic qui suit le relâchement est alors ignoré */
function appuiLong(el,action){
  let t=null,x=0,y=0,fait=false;
  const stop=()=>{clearTimeout(t);t=null;};
  el.addEventListener('pointerdown',e=>{fait=false;x=e.clientX;y=e.clientY;stop();t=setTimeout(()=>{fait=true;t=null;action();},500);});
  el.addEventListener('pointermove',e=>{if(t&&Math.hypot(e.clientX-x,e.clientY-y)>10)stop();});
  ['pointerup','pointercancel','pointerleave'].forEach(n=>el.addEventListener(n,stop));
  el.addEventListener('click',e=>{if(fait){e.preventDefault();e.stopImmediatePropagation();fait=false;}},true);
  el.addEventListener('contextmenu',e=>e.preventDefault());
}
function fermerListeComptes(){
  const l=document.getElementById('m-comptes');if(!l||l.hidden)return;
  l.hidden=true;document.getElementById('m-compte-btn').setAttribute('aria-expanded','false');
  const v=document.getElementById('m-comptes-voile');if(v)v.remove();
  document.getElementById('m-entete').classList.remove('menu-ouvert');}
function choisirCompteMobile(id){fermerListeComptes();state.acc=id;state.page=1;state.anPath=[];render();remonterEnHaut();}
/* écran « Plus » : sauvegarde, outils et gestion (ce qui était dans la barre latérale et la barre d'outils du PC) */
function icoPlus(d){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+d+'"/></svg>';}
function renderPlus(){
  const n=dirty,sv=document.getElementById('plus-sauvegarde');
  sv.className='m-sauvegarde'+(n>0?' attente':'');
  sv.innerHTML='<div class="ms-txt"><b>'+(n>0?n+' modification'+(n>1?'s':'')+' non sauvegardée'+(n>1?'s':''):'Tout est sauvegardé')+'</b>'+
    (n>0?'<a onclick="voirModifications()">Voir le détail</a>':'Données révision '+esc(String(getMeta('rev',0))))+'</div>'+
    '<button class="primary" onclick="sauvegarder()">Sauvegarder</button>';
  const it=(nom,detail,action,d)=>'<button onclick="'+action+'">'+icoPlus(d)+'<span class="ml-txt">'+nom+(detail?'<small>'+detail+'</small>':'')+'</span>'+
    icoPlus('M9 6l6 6-6 6')+'</button>';
  const nb=(sql,mot)=>{const k=scal(sql)||0;return k+' '+mot+(k>1?'s':'');};
  const e=UNDO[UNDO.length-1];
  const groupes=[
    ['Pointer et importer',[
      REL&&REL.res?it('Relevé en cours','Reprendre la comparaison',"setView('releve')",'M6 3h9l4 4v14H6zM9 14l2 2 4-4'):'',
      it('Pointer avec un relevé PDF','Compare le relevé de la banque à tes opérations',"document.getElementById('filePdf').click()",'M6 3h9l4 4v14H6zM9 14l2 2 4-4'),
      it('Importer un fichier QIF','Opérations exportées par la banque',"document.getElementById('fileQif').click()",'M12 3v12M7 10l5 5 5-5M5 21h14')]],
    ['Organiser',[
      it('Catégories',nb('SELECT COUNT(*) FROM categorie','catégorie'),"setView('categories')",'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10'),
      it('Tiers',nb('SELECT COUNT(*) FROM tiers','destinataire'),"setView('tiers')",'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20a6 6 0 0112 0M16 6a3 3 0 010 6')]],
    // charger une sauvegarde : l'icône à côté de « Sauvegarder », en haut de l'écran
    ['Revenir en arrière',[
      e?it('Annuler la dernière modification',esc('n°'+e.jid+' '+e.label),'annulerDerniere()','M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3'):'',
      it('Corbeille',nb('SELECT COUNT(*) FROM operation WHERE supprime=1','opération'),"setView('corbeille')",'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13')]],
    ['Appli',[
      it('Rechercher une mise à jour','Version '+VERSION,'rechercherMaj(this)','M20 12a8 8 0 11-2.3-5.7M20 4v5h-5'),
      it('Guide','Comment se servir de l’app',"setView('guide')",'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-1 .6-1.5 1.1-1.5 2.2M12 17h.01'),
      it('Réglages',enAppli()?'Verrouillage, thème, dossier de sauvegarde…':'Thème, recherche, dossier de sauvegarde…',"setView('reglages')",'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12h2M3 12h2M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4')]],
  ];
  document.getElementById('plus-groupes').innerHTML=groupes.map(([h,l])=>'<h2 class="m-groupe-h">'+h+'</h2><div class="m-liste">'+l.join('')+'</div>').join('');
  document.getElementById('plus-version').textContent='Mes comptes · version '+VERSION;
}
/* ---------- Guide : les principales fonctions, une rubrique repliable par écran (comme les Réglages) ---------- */
function sectionsGuide(mob){
  return [
    ['Opérations','M4 6h16M4 12h16M4 18h10',[
      mob?'Le bouton <b>+</b> en bas à droite ajoute une opération.':'Le bouton <b>Ajouter</b> (ou la touche A) ajoute une opération. La touche ? liste tous les raccourcis clavier.',
      mob?'En haut, la liste déroulante choisit le compte. Un appui long sur un compte le modifie ; « + Nouveau compte » en crée un.':'Choisis le compte dans la barre de gauche.',
      'La recherche trouve un destinataire, une catégorie, un montant (12,34), une date ou un n°. La croix × la vide.',
      mob?'<b>Filtrer</b> : statuts, période, prévisionnel jusqu’à quand, dépenses ou revenus, catégorie.':'Les filtres au-dessus de la liste : statuts, période, prévisionnel jusqu’à quand.',
      mob?'La barre de couleur à gauche d’une opération : la toucher la pointe ou la dépointe (une prévisionnelle : la confirme).':'La pastille de statut d’une ligne la pointe ou la dépointe.',
      'Statuts : non pointé, pointé (vu sur le compte), rapproché (validé avec un relevé : son montant ne change plus), prévisionnel (à venir), annulé.']],
    [mob?'Fiche d’une opération':'Modifier une opération','M6 3h9l4 4v14H6zM9 12h6M9 16h6',[
      mob?'Touche une opération pour voir sa fiche ; touche un champ (montant, date, catégorie…) pour le modifier.':'Double-clique une ligne pour la modifier.',
      '<b>Répartir</b> une opération sur plusieurs catégories (ventilation) : le total des lignes doit faire le montant.',
      '<b>Dupliquer</b> crée une nouvelle opération avec les mêmes informations ; <b>Supprimer</b> l’envoie à la corbeille.']],
    ['Analyse','M12 3a9 9 0 109 9h-9z',mob?[
      'Dépenses ou revenus du mois (ou de l’année), par catégorie, comparés à une autre période au choix.',
      'Touche une catégorie pour descendre dans ses sous-catégories, puis jusqu’aux opérations.',
      'Les barres montrent les mois voisins : touche une barre pour voir ce mois-là.',
      '« Évolution » : le solde au fil du temps.']:[
      'Dépenses et revenus par catégorie sur la période choisie : clique une catégorie pour descendre dans ses sous-catégories.',
      '« Graphiques » : le solde au fil du temps.']],
    ['Échéances','M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',[
      'Les opérations qui reviennent (loyer, salaire…) : l’app crée les prévisionnelles à l’avance.',
      'Une prévisionnelle se confirme quand elle passe sur le compte.']],
    ['Catégories et tiers','M3 7l9-4 9 4v10l-9 4-9-4z',[
      mob?'Dans Plus › Catégories : toucher une catégorie ouvre son analyse (par mois ou par année).':'Écran Catégories : l’arborescence sur 3 niveaux, avec le nombre d’opérations de chacune.',
      (mob?'Appui long sur une catégorie ou un tiers : <b>Renommer</b> ou <b>Fusionner</b>.':'<b>Renommer / fusionner</b> une catégorie ou un tiers depuis son écran.')+' Une catégorie ne fusionne qu’avec une autre du même niveau ; les sous-catégories de même nom fusionnent.',
      'Les tiers (destinataires) se trient de plusieurs façons'+(mob?' ; toucher un tiers montre ses opérations.':'.')]],
    ['Sauvegarder','M12 3v12M7 10l5 5 5-5M5 21h14',[
      'Tes comptes sont gardés '+(mob?'sur ce téléphone':'dans ce navigateur')+'. <b>Sauvegarder</b> écrit un fichier <code>comptes_….sqlite</code>'+' : c’est lui qui permet de tout retrouver ailleurs.',
      'Par défaut, il va dans Téléchargements. Dans les Réglages › Sauvegarde, tu peux choisir un autre dossier'+(mob?' (même un NAS, avec une appli qui l’ajoute au choix de dossier d’Android)':'')+', et cocher « Aussi dans Téléchargements » pour garder une 2e copie.',
      mob?'Le point sur l’icône de sauvegarde : des modifications ne sont pas encore sauvegardées. Plus › « Voir le détail » les liste.':'Le nombre de modifications non sauvegardées s’affiche en haut.',
      (mob?'L’icône à côté':'« Charger »')+' ouvre une sauvegarde (elle remplace les données de cet appareil).',
      '« Annuler la dernière modification » et la <b>Corbeille</b> rattrapent une erreur.']],
    ['Relevé de banque','M6 3h9l4 4v14H6zM9 14l2 2 4-4',[
      '« Pointer avec un relevé PDF » compare le relevé de la banque à tes opérations : ce qui correspond passe en pointé, il reste ce qui manque d’un côté ou de l’autre.',
      'Une ligne du relevé sans correspondance : « Lier » à une opération, ou l’ajouter.',
      '« Importer un fichier QIF » ajoute les opérations exportées par la banque.']],
    ['Réglages et mises à jour','M12 15a3 3 0 100-6 3 3 0 000 6z',[
      'Thème clair ou sombre, barres de recherche en haut ou en bas, montants masqués à l’ouverture (l’œil les montre)'+(mob?', verrouillage par empreinte ou code (appli Android)':'')+'.',
      'Les nouvelles versions sont cherchées à chaque ouverture ; « Rechercher une mise à jour » le fait tout de suite. Elles s’installent seulement quand tu touches « Mettre à jour », et tes données sont gardées.']]
  ];
}
function renderGuide(){
  const mob=document.body.classList.contains('mobile'),ico=d=>'<svg class="rg-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+d+'"/></svg>';
  const ouvertes=new Set([...document.querySelectorAll('#guide-liste details[open]')].map(d=>d.dataset.i));
  document.getElementById('guide-liste').innerHTML=sectionsGuide(mob).map(([titre,d,lignes],i)=>
    '<details class="reglage guide"'+(ouvertes.has(String(i))?' open':'')+' data-i="'+i+'"><summary>'+ico(d)+'<span><b>'+titre+'</b></span>'+
    '<svg class="rg-fleche" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></summary>'+
    '<ul class="rg-corps guide-corps">'+lignes.map(l=>'<li>'+l+'</li>').join('')+'</ul></details>').join('');
}
/* ---------- Opérations sur téléphone ----------
   Mêmes filtres que sur PC (barre #f-zone, présentée en feuille qui monte du bas) ; liste par jour avec,
   à gauche, la barre de statut qu'on touche pour pointer / dépointer ; recherche directement dans l'écran. */
const MOBILE_PAR_LOT=60;
const JOURS_FR=['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
const majuscule=t=>t.charAt(0).toUpperCase()+t.slice(1);
/* titre d'un jour dans la liste : Aujourd'hui, Hier, Demain, ou « Jeudi 23 octobre » (+ l'année si ce n'est pas la même) */
function libJour(iso,aujourdhui){
  const d=new Date(iso+'T00:00:00'),a=new Date(aujourdhui.getFullYear(),aujourdhui.getMonth(),aujourdhui.getDate());
  const ecart=Math.round((d-a)/86400000);
  if(ecart===0)return 'Aujourd’hui';if(ecart===-1)return 'Hier';if(ecart===1)return 'Demain';
  return majuscule(JOURS_FR[d.getDay()])+' '+d.getDate()+' '+MOIS_FR[d.getMonth()]+(d.getFullYear()!==a.getFullYear()?' '+d.getFullYear():'');
}
/* mois affiché par le sélecteur ‹ › du filtre : celui de la période choisie, sinon le mois en cours */
function moisDePeriode(v,aujourdhui){
  if(v&&v.indexOf('m:')===0){const p=v.slice(2).split('-');return new Date(+p[0],+p[1]-1,1);}
  if(v==='moisdernier')return new Date(aujourdhui.getFullYear(),aujourdhui.getMonth()-1,1);
  return new Date(aujourdhui.getFullYear(),aujourdhui.getMonth(),1);
}
const estPeriodeMois=v=>v==='mois'||v==='moisdernier'||(!!v&&v.indexOf('m:')===0);
/* ‹ / › : mois précédent / suivant de celui affiché (0 = ce mois-là) ; le mois en cours et le précédent
   gardent leurs puces « Ce mois » et « Mois −1 » */
function moisDecale(v,delta,aujourdhui){
  const b=moisDePeriode(v,aujourdhui),d=new Date(b.getFullYear(),b.getMonth()+delta,1);
  const ecart=(d.getFullYear()-aujourdhui.getFullYear())*12+d.getMonth()-aujourdhui.getMonth();
  if(ecart===0)return 'mois';if(ecart===-1)return 'moisdernier';
  return 'm:'+d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
const nomMois=d=>majuscule(MOIS_FR[d.getMonth()])+' '+d.getFullYear();
/* texte de la puce de période */
function libellePeriode(v,aujourdhui,du,au){
  if(estPeriodeMois(v))return nomMois(moisDePeriode(v,aujourdhui));
  return {'3mois':'3 derniers mois',annee:'Cette année',perso:'Du '+(du||'…')+' au '+(au||'…')}[v]||'';
}
function moisFiltre(delta){
  const v=document.getElementById('f-periode').value;
  setPeriode('f',moisDecale(v,delta,new Date()));
}
// la ligne « du … au … » de la feuille des filtres n'occupe de place que si les dates sont affichées
function majDatesFiltre(){const w=document.querySelector('.f-dates'),d=document.getElementById('f-from');if(w&&d)w.classList.toggle('vide',d.style.display==='none');}
function ouvrirFiltres(){document.body.classList.add('filtres-ouverts');}
/* glisser une feuille vers le bas la ferme : depuis sa tête (poignée, titre) toujours, ailleurs seulement
   quand elle est tout en haut (sinon le doigt la fait défiler). Elle suit le doigt, puis se ferme au-delà
   d'un quart de sa hauteur (120 px au plus), ou revient en place. */
function glisserPourFermer(feuille,fermer){
  let y0=null,dy=0,actif=false,tete=false,img=0;
  feuille.addEventListener('touchstart',e=>{
    if(e.touches.length!==1){y0=null;return;}
    y0=e.touches[0].clientY;dy=0;actif=false;tete=!!e.target.closest('.m-feuille-tete');
  },{passive:true});
  feuille.addEventListener('touchmove',e=>{
    if(y0==null)return;
    dy=e.touches[0].clientY-y0;
    if(!actif){
      if(Math.abs(dy)<8)return;
      if(dy<0||!(tete||feuille.scrollTop<=0)||e.target.closest('select,input')){y0=null;return;} // défilement normal
      actif=true;feuille.classList.add('glisse');
    }
    e.preventDefault();
    if(!img)img=requestAnimationFrame(()=>{img=0;feuille.style.transform='translate3d(0,'+Math.max(0,dy)+'px,0)';}); // une fois par image
  },{passive:false});
  const fin=()=>{
    y0=null;if(!actif)return;actif=false;
    if(img){cancelAnimationFrame(img);img=0;}
    feuille.classList.remove('glisse');feuille.style.transform='';
    if(dy>Math.min(120,feuille.offsetHeight/4))fermer();
  };
  feuille.addEventListener('touchend',fin);feuille.addEventListener('touchcancel',fin);
}
function fermerFiltres(){document.body.classList.remove('filtres-ouverts');}
/* Retour d'Android : ferme d'abord ce qui est ouvert par-dessus l'écran */
function fermerFeuilles(){
  if(document.body.classList.contains('filtres-ouverts')){fermerFiltres();return true;}
  const l=document.getElementById('m-comptes');if(l&&!l.hidden){fermerListeComptes();return true;}
  const ov=document.getElementById('overlay');if(ov&&ov.classList.contains('show')){closeModal();return true;}
  const fi=document.getElementById('m-fiche');if(fi&&!fi.hidden){fermerFiche();return true;}
  const ca=document.getElementById('m-catana');if(ca&&!ca.hidden){caRetour();return true;}
  if(state.view==='analyse'&&MA.chemin.length){anaMobileRemonter();return true;}
  return false;
}
/* puces des filtres actifs (✕ pour retirer) ; la recherche a sa propre barre */
function filtresActifsMobile(){
  const out=[],per=document.getElementById('f-periode').value;
  if(per&&per!=='tout')out.push([libellePeriode(per,new Date(),document.getElementById('f-from').value,document.getElementById('f-to').value),"setPeriode('f','tout')"]);
  const ch=statutsChips(),on=ch.filter(c=>c.classList.contains('on'));
  if(on.length<ch.length)out.push([on.length?on.map(c=>c.textContent).join(', '):'Aucun statut','setStatutsTous();goPage(1)']);
  const hz=document.getElementById('f-horizon').value;
  if(hz!=='finmois')out.push([document.getElementById('f-horizon').selectedOptions[0].textContent,"document.getElementById('f-horizon').value='finmois';goPage(1)"]);
  if(state.fSens)out.push([majuscule(SENS_LIB[state.fSens]),'setFSens(null)']);
  if(state.fCat)out.push(['Catégorie : '+state.fCat,'retirerFiltreCat()']);
  return out;
}
/* solde du compte juste après chaque opération affichée (ordre date, id ; ni supprimées ni annulées).
   Calculé seulement entre la plus ancienne et la plus récente opération affichée, au lieu de tout le compte. */
function soldesApres(acc,rows){
  const res=new Map(),k=o=>o.d+'|'+String(o.id).padStart(12,'0');
  const v=rows.filter(o=>o.st!=='annule');if(!v.length)return res;
  let hi=v[0],lo=v[0];v.forEach(o=>{if(k(o)>k(hi))hi=o;if(k(o)<k(lo))lo=o;});
  let cum=scal(`SELECT (SELECT solde_initial FROM compte WHERE id=$a)+COALESCE(SUM(montant),0) FROM operation
    WHERE compte_id=$a AND supprime=0 AND statut<>'annule' AND (date_operation<$hd OR (date_operation=$hd AND id<=$hi))`,{$a:acc,$hd:hi.d,$hi:hi.id})||0;
  qy(`SELECT id,montant m FROM operation WHERE compte_id=$a AND supprime=0 AND statut<>'annule'
    AND (date_operation>$ld OR (date_operation=$ld AND id>=$li)) AND (date_operation<$hd OR (date_operation=$hd AND id<=$hi))
    ORDER BY date_operation DESC,id DESC`,{$a:acc,$ld:lo.d,$li:lo.id,$hd:hi.d,$hi:hi.id}).forEach(o=>{res.set(o.id,cum);cum-=o.m;});
  return res;
}
function renderOperationsMobile(){
  const a=state.acc,r=soldesCompte(a),hz=document.getElementById('f-horizon').value;
  document.getElementById('m-soldes').innerHTML=
    '<div class="ms-haut"><div><div class="ms-k">Solde réel aujourd’hui</div><div class="ms-reel num">'+eur(r.reel)+'</div></div>'+
      '<button class="ms-rapprocher" onclick="ouvrirRapprochement()" aria-label="Rapprocher les opérations pointées">Rapprocher</button></div>'+
    '<div class="ms-grille">'+
      '<div><small>Rapproché</small><span class="num">'+eur(r.rap)+'</span></div>'+
      '<div><small>'+(hz==='masque'?'Sans prévisionnel':hz==='3'?'Dans 3 jours':hz==='finmoisprochain'?'Fin du mois prochain':'Fin du mois')+'</small>'+
        '<span class="num" style="color:var(--st-prev)">'+eur(r.reel+r.prv)+'</span></div>'+
      '<button onclick="filtreAttente()" aria-label="Afficher les opérations à pointer"><small>À pointer</small><span style="color:var(--st-non)">'+r.npt+'</span></button>'+
    '</div>';
  const actifs=filtresActifsMobile();
  // la liste
  const p={};const w=buildWhere(p);
  const total=scal('SELECT COUNT(*) FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id'+w,p)||0;
  // les filtres actifs (puces), puis une ligne : le nombre d'opérations tout à gauche, « Filtrer » tout à droite
  document.getElementById('m-filtres-actifs').innerHTML=(actifs.length?'<div class="m-puces">'+actifs.map(([t,f])=>
      '<span class="m-puce">'+esc(t)+'<button class="ghost" style="padding:0;min-height:0;border:0;background:none;color:inherit" aria-label="Retirer le filtre '+esc(t)+'" onclick="'+f+'"><span>✕</span></button></span>').join('')+'</div>':'')+
    '<div class="m-ligne-filtrer"><span class="m-nb-ops" id="m-nb-ops">'+total.toLocaleString('fr-FR')+' opération'+(total>1?'s':'')+'</span>'+
    '<button class="m-filtrer" onclick="ouvrirFiltres()">Filtrer'+(actifs.length?' · '+actifs.length:'')+'</button></div>';
  const lim=state.mLimite||MOBILE_PAR_LOT;
  const rows=qy(`SELECT o.id,o.date_operation d,o.montant m,o.statut st,o.previsionnel pv,o.cat_path cat,t.nom dest
    FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id
    `+w+` ORDER BY `+orderClause()+` LIMIT $lim`,Object.assign({},p,{$lim:lim}));
  const sol=soldesApres(state.acc,rows);rows.forEach(o=>{o.solde=sol.get(o.id);});
  const auj=new Date(),parJour=state.sort==='date';
  let html='',jour=null;
  rows.forEach(o=>{
    const stt=o.st==='annule'?'annule':(o.pv?'previsionnel':o.st),m=META[stt]||META.non_pointe;
    if(parJour&&o.d!==jour){
      if(jour!==null)html+='</div>';
      jour=o.d;
      html+='<div class="m-jour"><span>'+libJour(o.d,auj)+'</span><span class="num">'+(o.solde==null||stt==='annule'?'':eur(o.solde))+'</span></div><div class="m-carte">';
    }else if(!parJour&&jour===null){jour='';html+='<div class="m-carte">';}
    const action=stt==='previsionnel'?'confirmer':o.st==='pointe'?'dépointer':o.st==='non_pointe'?'pointer':'';
    html+='<div class="m-op'+(stt==='previsionnel'?' prev':stt==='annule'?' ann':'')+'" style="--st:'+m.col+'">'+
      '<button class="m-st" onclick="togglePointe('+o.id+',event)" aria-label="'+m.label+(action?' — toucher pour '+action:'')+'"></button>'+
      '<button class="m-op-corps" onclick="ouvrirFiche('+o.id+')"><span class="m-op-nom">'+esc(o.dest||'(sans destinataire)')+'</span>'+
        '<span class="m-op-det">'+(parJour?'':isoToFr(o.d)+' · ')+esc(o.cat||'')+' · '+m.label.toLowerCase()+'</span></button>'+
      '<span class="m-op-mt num '+(o.m<0?'':'credit')+'">'+(o.m>0?'+':'')+eur(o.m)+'</span></div>';
  });
  if(rows.length)html+='</div>';
  else html='<div class="m-vide">Aucune opération ne correspond à ces filtres.'+(actifs.length||document.getElementById('f-search').value?'<br><button class="ghost" style="margin-top:8px" onclick="resetFilters()">Effacer les filtres</button>':'')+'</div>';
  if(total>rows.length)html+='<button class="m-plus-ops" onclick="state.mLimite=(state.mLimite||MOBILE_PAR_LOT)+MOBILE_PAR_LOT;renderRegistre()">Voir plus ('+(total-rows.length).toLocaleString('fr-FR')+' de plus)</button>';
  document.getElementById('m-ops').innerHTML=html;
  // feuille des filtres : mois choisi, nombre d'opérations
  const per=document.getElementById('f-periode').value,mn=document.getElementById('m-mois-nom');
  mn.textContent=nomMois(moisDePeriode(per,auj));mn.classList.toggle('on',estPeriodeMois(per));
  document.getElementById('m-voir').textContent=total?'Voir '+total.toLocaleString('fr-FR')+' opération'+(total>1?'s':''):'Aucune opération';
}
/* fiche d'une opération (téléphone) : on la lit avant de la modifier. Le statut n'est qu'une information
   (il se change depuis la barre de la liste) ; une opération rapprochée garde son montant total. */
let ficheId=null;
function lignesVentilation(id){
  return qy(`SELECT v.montant m,(SELECT GROUP_CONCAT(libelle,' : ') FROM (
      WITH RECURSIVE up(id,libelle,parent_id,lvl) AS (
        SELECT id,libelle,parent_id,0 FROM categorie WHERE id=v.categorie_id
        UNION ALL SELECT c.id,c.libelle,c.parent_id,up.lvl+1 FROM categorie c JOIN up ON c.id=up.parent_id)
      SELECT libelle FROM up ORDER BY lvl DESC)) cat
    FROM ventilation v WHERE v.operation_id=?`,[id]);
}
function ouvrirFiche(id){
  const o=qy(`SELECT o.*,t.nom dest,c.nom compte,(SELECT c2.nom FROM operation m JOIN compte c2 ON c2.id=m.compte_id WHERE m.id=o.miroir_id) lie
    FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id LEFT JOIN compte c ON c.id=o.compte_id WHERE o.id=?`,[id])[0];
  if(!o)return;
  if(state.exPrev&&state.exPrev!==id)state.exPrev=null; // une autre opération : la précédente perd son 3e état
  ficheId=id;
  const stt=o.statut==='annule'?'annule':(o.previsionnel?'previsionnel':o.statut),m=META[stt]||META.non_pointe;
  const d=new Date(o.date_operation+'T00:00:00');
  const quand=majuscule(JOURS_FR[d.getDay()])+' '+d.getDate()+' '+MOIS_FR[d.getMonth()]+' '+d.getFullYear()+' · '+esc(o.compte||'');
  const vent=lignesVentilation(id);
  const infos=[]; // [libellé, valeur, champ du formulaire à ouvrir en touchant la ligne]
  if(isVirCat(o.cat_path))infos.push(['Virement',(o.montant<0?'vers ':'reçu de ')+esc(o.lie||'un autre compte'),'dest']);
  else if(vent.length>1)vent.forEach((l,i)=>infos.push([esc(l.cat||'Divers'),eur(l.m),'vent'+i]));
  else catParts(o.cat_path||'Divers').forEach((c,i)=>infos.push([['Catégorie','Sous-catégorie','Sous-sous-catégorie'][i]||'Catégorie',esc(c),'cat'+i]));
  infos.push(['N° (chèque…)',o.numero?esc(String(o.numero)):'<em>ajouter</em>','num']);
  infos.push(['Commentaire',o.commentaire?esc(o.commentaire):'<em>ajouter</em>','comm']);
  const rapp=o.statut==='rapproche',ann=o.statut==='annule';
  // toucher un élément : le formulaire s'ouvre directement sur ce champ ; une opération rapprochée reste
  // modifiable (catégories, ventilation, destinataire…), seul son montant total est figé
  const statutTouche=!rapp&&!ann;
  const champ=(cls,f,v)=>'<button class="mf-champ '+cls+'" onclick="modifierDepuisFiche(\''+f+'\')">'+v+'</button>';
  const fi=document.getElementById('m-fiche');
  fi.innerHTML='<div class="mf-tete"><button class="mf-retour" onclick="fermerFiche()" aria-label="Retour">'+icoPlus('M15 6l-6 6 6 6')+'</button>'+
      '<button class="mf-modifier" onclick="modifierDepuisFiche()">Modifier</button></div>'+
    '<div class="mf-haut"><div class="mf-lettre" aria-hidden="true">'+esc((o.dest||'?').charAt(0).toUpperCase())+'</div>'+
      champ('mf-dest','dest',esc(o.dest||'(sans destinataire)'))+
      (rapp?'<div class="mf-montant num '+(o.montant>0?'credit':'')+'">'+(o.montant>0?'+':'')+eur(o.montant)+'</div>'
        :champ('mf-montant num '+(o.montant>0?'credit':''),'montant',(o.montant>0?'+':'')+eur(o.montant)))+
      champ('mf-quand','date',quand)+'</div>'+
    // le statut se change ici d'un toucher, comme avec la barre de couleur de la liste
    (statutTouche?'<button class="mf-statut" onclick="togglePointe('+id+')" aria-label="'+m.label+' — toucher pour changer">':'<div class="mf-statut">')+
      '<i style="background:'+m.col+'"></i>'+m.label+
      (rapp?' — son montant ne peut plus être modifié':stt==='previsionnel'?' — prévue, pas encore effective':'')+
      (statutTouche?'<small>Toucher pour changer</small></button>':'</div>')+
    '<div class="mf-infos">'+infos.map(([k,v,f])=>'<button onclick="modifierDepuisFiche('+(f.indexOf('vent')===0?'event.target.closest(\'span.num\')?\''+f+'\':\'ventc'+f.slice(4)+'\'':'\''+f+'\'')+')"><span>'+k+'</span><span'+(f.indexOf('vent')===0?' class="num"':'')+'>'+v+'</span></button>').join('')+'</div>'+
    '<div class="mf-actions"><button onclick="dupliquerDepuisFiche()">Dupliquer</button>'+
      (rapp||ann?'':'<button class="danger" onclick="corbeilleDepuisFiche()">Mettre à la corbeille</button>')+'</div>';
  fi.hidden=false;fi.scrollTop=0;
}
function fermerFiche(){const fi=document.getElementById('m-fiche');if(fi)fi.hidden=true;ficheId=null;}
/* clavier ouvert (la partie visible de l'écran rapetisse) : de la place sous les fenêtres pour pouvoir remonter, et le
   champ en cours de saisie remonte juste au-dessus du clavier (la liste des catégories s'ouvre au-dessus de lui) */
let hauteurPleine=0;
function champAuDessusDuClavier(){
  const vv=window.visualViewport;if(!vv)return;
  // dans l'appli, Android rétrécit toute la page quand le clavier s'ouvre : on compare à la plus grande hauteur vue
  hauteurPleine=Math.max(hauteurPleine,window.innerHeight,vv.height);
  const clavier=vv.height<hauteurPleine*0.8;document.body.classList.toggle('clavier',clavier);
  const a=document.activeElement;if(!a||!/^(INPUT|TEXTAREA)$/.test(a.tagName))return;
  const sc=a.closest('.modal,.dlg');if(!sc)return;
  setTimeout(()=>{
    // le bas visible : le haut du clavier, ou plus haut celui des boutons du bas (Dupliquer, Enregistrer…) qui restent au-dessus
    let bas=vv.offsetTop+vv.height;
    const pied=sc.querySelector('.modal-foot')||(sc.classList.contains('dlg')?document.getElementById('dlgFoot'):null);
    if(pied){const p=pied.getBoundingClientRect();if(p.height&&p.top<bas&&p.top>vv.offsetTop+vv.height*0.3)bas=p.top;}
    bas-=12;
    const r=a.getBoundingClientRect(),haut=vv.offsetTop+12;
    if(r.bottom>bas)sc.scrollTop+=r.bottom-bas;      // juste au-dessus des boutons
    else if(r.top<haut)sc.scrollTop-=haut-r.top;      // ou pas caché en haut
  },60);
}
// depuis la fiche : en fermant le formulaire (Retour, croix, Enregistrer), on revient à la fiche, pas à la liste
function modifierDepuisFiche(champ){const id=ficheId;fermerFiche();openModal(id,champ);state.retourFiche=id;}
function dupliquerDepuisFiche(){const id=ficheId;fermerFiche();openModal(id);dupliquerOp();}
async function corbeilleDepuisFiche(){
  const id=ficheId;state.editing=id;await deleteOp();
  if(scal('SELECT supprime FROM operation WHERE id=?',[id]))fermerFiche();
  state.editing=null;
}
/* ---------- Analyse sur téléphone ----------
   Un mois (ou une année) à la fois, comparé à n'importe quel autre ; anneau des catégories ; toucher une
   catégorie descend dans ses sous-catégories et montre ses 6 derniers mois et ses opérations. */
const MA={sens:'debit',unite:'mois',debut:null,comp:null,vir:false,chemin:[]}; // debut/comp : 'AAAA-MM' ou 'AAAA'
const clefMois=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
/* bornes ISO d'un mois 'AAAA-MM' ou d'une année 'AAAA' */
/* une année : du 1er janvier au 31 décembre ; l'année en cours s'arrête au dernier mois entier (fin du mois
   précédent), et l'année comparée aux mêmes mois : pas de mois commencé qui fausse les totaux ou les moyennes.
   limite = 'MM-JJ' de fin (null = année entière) */
function limiteAnneeEnCours(cle,auj){
  if(cle.length!==4||+cle!==auj.getFullYear()||auj.getMonth()===0)return null;
  return isoDe(new Date(auj.getFullYear(),auj.getMonth(),0)).slice(5);
}
function bornesPeriodeAna(cle,limite){
  if(cle.length===4)return {f:cle+'-01-01',t:cle+'-'+(limite||'12-31')};
  const [y,m]=cle.split('-').map(Number);return {f:cle+'-01',t:isoDe(new Date(y,m,0))};
}
/* période précédente : le mois (ou l'année) d'avant */
function periodeDecalee(cle,delta){
  if(cle.length===4)return String(+cle+delta);
  const [y,m]=cle.split('-').map(Number);return clefMois(new Date(y,m-1+delta,1));
}
function libellePeriodeAna(cle,limite){
  if(cle.length===4)return cle+(limite?' (janv. → '+MOIS_COURT[+limite.slice(0,2)-1]+')':'');
  const [y,m]=cle.split('-').map(Number);return majuscule(MOIS_FR[m-1])+' '+y;
}
/* lignes de l'analyse sur une période (hors annulées et prévisionnelles, répartitions comprises) */
function lignesAnalyse(acc,cle,limite){
  const b=bornesPeriodeAna(cle,limite),p={$acc:acc,$f:b.f,$t:b.t};
  return lignesOps(" WHERE o.compte_id=$acc AND o.supprime=0 AND o.statut<>'annule' AND o.previsionnel=0 AND o.date_operation>=$f AND o.date_operation<=$t",p);
}
/* lignes retenues pour un sens (dépenses en positif), avec ou sans virements, sous une catégorie */
function lignesSens(lignes,sens,vir,chemin){
  return lignes.filter(l=>{
    if(l.vir&&!vir)return false;
    if(sens==='debit'?l.m>=0:l.m<=0)return false;
    const p=catParts(l.vir?'Virements : '+(l.ti||'Virement'):l.cat);
    // dernier niveau « Sans sous-catégorie » : les opérations rangées directement dans la catégorie du dessus
    if(chemin[chemin.length-1]===SANS_SOUS){const base=chemin.slice(0,-1);return p.length===base.length&&base.every((c,i)=>p[i]===c);}
    return chemin.every((c,i)=>p[i]===c);
  });
}
/* regroupement au niveau suivant : [{nom, total (centimes, positif), n, feuille}] du plus gros au plus petit */
const SANS_SOUS='Sans sous-catégorie';
function regrouperAnalyse(lignes,sens,vir,chemin){
  const g=new Map();
  lignesSens(lignes,sens,vir,chemin).forEach(l=>{
    const p=catParts(l.vir?'Virements : '+(l.ti||'Virement'):l.cat),nom=p[chemin.length]||(chemin.length?SANS_SOUS:'Divers');
    const e=g.get(nom)||{nom,total:0,n:0,feuille:p.length<=chemin.length+1};
    e.total+=Math.abs(l.m);e.n++;if(p.length>chemin.length+1)e.feuille=false;g.set(nom,e);
  });
  return [...g.values()].sort((a,b)=>b.total-a.total||a.nom.localeCompare(b.nom,'fr'));
}
function totalAnalyse(lignes,sens,vir,chemin){return lignesSens(lignes,sens,vir,chemin).reduce((t,l)=>t+Math.abs(l.m),0);}
/* écart avec la période de comparaison : texte « +8 % » / « −12 % » / « = », null sans base */
function ecartPct(a,b){if(!b)return null;const p=Math.round((a-b)/b*100);return p>0?'+'+p+' %':p<0?'−'+(-p)+' %':'=';}
/* barres du détail d'une catégorie : dernière période affichée (fin) quand on choisit la période sel.
   Hors de la fenêtre : sel tout à droite. Dans la moitié droite : rien ne bouge. Dans la moitié gauche : les
   barres se décalent pour mettre sel au milieu, sans dépasser la période en cours (max). */
const NB_BARRES=7; // nombre impair : la barre choisie peut être au milieu
/* les barres glissent d'autant de crans que la fenêtre s'est décalée (au lieu de sauter d'un coup) */
function animerDecalage(c,d){
  if(!c||!d||!c.animate||(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches))return;
  const b=c.querySelectorAll('button');if(b.length<2)return;
  const pas=b[1].getBoundingClientRect().left-b[0].getBoundingClientRect().left;
  b.forEach(x=>x.animate([{transform:'translateX('+(d*pas)+'px)'},{transform:'none'}],{duration:280,easing:'cubic-bezier(.2,.7,.3,1)'}));
}
const rangPeriode=k=>k.length===4?+k:(+k.slice(0,4))*12+(+k.slice(5))-1;
function fenetreBarres(fin,sel,n,max){
  if(!fin||rangPeriode(sel)>rangPeriode(fin)||rangPeriode(fin)-rangPeriode(sel)>=n)return sel;
  const i=n-1-(rangPeriode(fin)-rangPeriode(sel)),milieu=Math.floor(n/2);
  if(i>=milieu)return fin;
  const f=periodeDecalee(sel,n-1-milieu);
  return max&&rangPeriode(f)>rangPeriode(max)?max:f;
}
function anaMobileSens(s){MA.sens=s;MA.chemin=[];if(state.view!=='analyse')setView('analyse');else renderAnalyseMobile();}
function anaMobileAller(k){MA.debut=k;MA.comp=null;renderAnalyseMobile();}
function anaMobileDecaler(d){MA.debut=periodeDecalee(MA.debut,d);MA.comp=null;MA.fin=null;renderAnalyseMobile();}
function anaMobileUnite(u){const auj=new Date();MA.unite=u;MA.debut=u==='annee'?String(auj.getFullYear()):clefMois(auj);MA.comp=null;MA.chemin=[];MA.fin=null;renderAnalyseMobile();}
function anaMobileDescendre(nom){MA.chemin.push(nom);if(MA.chemin.length===1)MA.fin=null;renderAnalyseMobile();document.querySelector('main').scrollTop=0;}
function anaMobileRemonter(){MA.chemin.pop();renderAnalyseMobile();}
/* périodes proposées pour la comparaison : tous les mois (ou années) depuis la 1re opération du compte */
function periodesDuCompte(acc,unite,auj){
  const d0=scal('SELECT MIN(date_operation) FROM operation WHERE compte_id=? AND supprime=0',[acc]);
  const debut=d0?new Date(d0+'T00:00:00'):auj,out=[];
  if(unite==='annee'){for(let y=auj.getFullYear();y>=debut.getFullYear();y--)out.push(String(y));return out;}
  for(let d=new Date(auj.getFullYear(),auj.getMonth(),1);d>=new Date(debut.getFullYear(),debut.getMonth(),1);d.setMonth(d.getMonth()-1))out.push(clefMois(d));
  return out;
}
/* ---------- Évolution (téléphone) : courbe du solde fin de mois, ce compte ou patrimoine ----------
   MA.evo : portee 'compte' | 'tout' ; duree '6' | '12' | 'annee' | 'tout' ; barres : revenus / dépenses par mois */
const EVO_DUREES=[['6','6 mois'],['12','12 mois'],['annee','Cette année'],['tout','Depuis le début']];
MA.evo={portee:'compte',duree:'12',barres:false,mois:null};
function comptesEvolution(acc,portee){
  return portee==='tout'?qy('SELECT id FROM compte WHERE actif=1').map(r=>+r.id):[+acc];
}
// 1er mois affiché ('AAAA-MM') pour une durée
function debutEvolution(ids,duree,auj){
  if(duree==='annee')return auj.getFullYear()+'-01';
  if(duree==='tout'){const m=scal('SELECT MIN(date_operation) FROM operation WHERE supprime=0 AND compte_id IN ('+ids.join(',')+')');
    return m?m.slice(0,7):clefMois(auj);}
  return clefMois(new Date(auj.getFullYear(),auj.getMonth()-(+duree)+1,1));
}
/* solde réel (hors prévisionnel et annulées) à la fin de chaque mois, du mois qui précède `debut` (point de départ)
   jusqu'au mois en cours (solde d'aujourd'hui) : [{cle:'AAAA-MM', v:centimes}] */
function serieEvolution(ids,debut,auj){
  const cles=[],fin=clefMois(auj);
  for(let d=new Date(+debut.slice(0,4),+debut.slice(5)-2,1);;d.setMonth(d.getMonth()+1)){const k=clefMois(d);cles.push(k);if(k>=fin)break;}
  const liste=ids.join(',');
  let v=+scal('SELECT COALESCE(SUM(solde_initial),0) FROM compte WHERE id IN ('+liste+')');
  const rows=qy("SELECT substr(date_operation,1,7) m,SUM(montant) s FROM operation WHERE compte_id IN ("+liste+") AND supprime=0"+
    " AND statut IN('non_pointe','pointe','rapproche') AND previsionnel=0 AND date_operation<=$t GROUP BY m ORDER BY m",{$t:isoDe(auj)});
  let i=0;
  return cles.map(cle=>{while(i<rows.length&&rows[i].m<=cle)v+=rows[i++].s;return {cle,v};});
}
// revenus et dépenses de chaque mois (sans les virements), dépenses en positif
function fluxEvolution(ids,debut,auj){
  const L=lignesOps(" WHERE o.compte_id IN ("+ids.join(',')+") AND o.supprime=0 AND o.statut<>'annule' AND o.previsionnel=0 AND o.date_operation>=$f AND o.date_operation<=$t",
    {$f:debut+'-01',$t:isoDe(auj)});
  const par=new Map();
  for(const l of L){if(l.vir)continue;const k=l.d.slice(0,7),e=par.get(k)||{rev:0,dep:0};
    if(l.m>0)e.rev+=l.m;else e.dep-=l.m;par.set(k,e);}
  return par;
}
const dateCle=cle=>new Date(+cle.slice(0,4),+cle.slice(5)-1,1);
function nomMoisCourt(cle,annee){return MOIS_COURT[+cle.slice(5)-1]+(annee?' '+cle.slice(0,4):'');}
function anaEvo(cle,val){MA.evo[cle]=val;renderAnalyseMobile();}
// plein écran à l'horizontale : la courbe détaillée de l'ancien écran Graphiques, sur la même période ; on revient ici en sortant
function evoPleinEcran(){
  const e=MA.evo,auj=new Date(),ids=comptesEvolution(state.acc,e.portee),debut=debutEvolution(ids,e.duree,auj);
  state.grMode=e.portee==='tout'?'patrimoine':'compte';state.grDepuisEvo=true;
  const gs=grShow();gs.fsBarres=e.barres?1:0; // le plein écran montre la même vue
  setView('graphiques');
  if(e.duree==='annee'||e.duree==='tout')setPeriode('gr',e.duree);
  else{document.getElementById('gr-from').value='01/'+debut.slice(5)+'/'+debut.slice(2,4);document.getElementById('gr-to').value='';setPeriode('gr','perso');}
  grPleinEcran(true);
}
function renderEvolutionMobile(acc,auj){
  const e=MA.evo,ids=comptesEvolution(acc,e.portee);
  const debut=debutEvolution(ids,e.duree,auj),pts=serieEvolution(ids,debut,auj);
  // prévu : avec les prévisionnelles jusqu'à l'horizon choisi dans Opérations (comme la tuile « Solde prévisionnel »)
  const prv=ids.reduce((t,a)=>t+soldesCompte(a).prv,0),actuel=pts[pts.length-1].v,prevu=actuel+prv;
  const ecart=actuel-pts[0].v,txtDuree={annee:'depuis le 1er janvier',tout:'depuis le début'}[e.duree]||'en '+e.duree+' mois';
  const nomCompte=e.portee==='tout'?'Patrimoine (tous les comptes)':'Solde de « '+(scal('SELECT nom FROM compte WHERE id=?',[acc])||'')+' »';
  let h='<div class="m-ana-seg" role="tablist" aria-label="Analyse">'+[['debit','Dépenses'],['credit','Revenus'],['evolution','Évolution']].map(([k,t])=>
    '<button role="tab" aria-selected="'+(k==='evolution')+'"'+(k==='evolution'?' class="on"':'')+' onclick="anaMobileSens(\''+k+'\')">'+t+'</button>').join('')+'</div>';
  h+='<div class="ev-outils"><div class="ev-portee" role="tablist" aria-label="Comptes">'+[['compte','Ce compte'],['tout','Patrimoine']].map(([k,t])=>
      '<button role="tab" aria-selected="'+(e.portee===k)+'" onclick="anaEvo(\'portee\',\''+k+'\')">'+t+'</button>').join('')+'</div>'+
    '<select aria-label="Période" onchange="anaEvo(\'duree\',this.value)">'+EVO_DUREES.map(([k,t])=>'<option value="'+k+'"'+(k===e.duree?' selected':'')+'>'+t+'</option>').join('')+'</select></div>';
  h+='<div class="ev-solde"><small>'+esc(nomCompte)+'</small><div><b class="num">'+eur(actuel)+'</b>'+
    '<span class="'+(ecart>=0?'hausse':'baisse')+'">'+(ecart>=0?'+':'−')+eur(Math.abs(ecart))+' '+txtDuree+'</span></div></div>';
  // une seule vue à la fois, en grand : la courbe du solde ou les barres revenus / dépenses par mois
  h+='<div class="ev-vue" role="tablist" aria-label="Affichage">'+[[false,'Courbe'],[true,'Barres']].map(([v,t])=>
    '<button role="tab" aria-selected="'+(e.barres===v)+'" onclick="anaEvo(\'barres\','+v+')">'+t+'</button>').join('')+'</div>';
  if(!e.barres){
    // courbe : x régulier par mois (+ un pas pour le prévu), y borné aux valeurs
    const W=360,H=250,haut=10,bas=10,avecPrevu=prv!==0,n=pts.length-1+(avecPrevu?1:0);
    const vals=pts.map(p=>p.v).concat(avecPrevu?[prevu]:[]),mn=Math.min(...vals),mx=Math.max(...vals),marge=Math.max(1,(mx-mn)*0.1);
    const X=i=>n?i*W/n:W/2,Y=v=>haut+(1-(v-(mn-marge))/((mx+marge)-(mn-marge)))*(H-haut-bas);
    const ligne=pts.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p.v).toFixed(1)).join(' ');
    const xa=X(pts.length-1),ya=Y(actuel);
    const zero=mn-marge<0&&mx+marge>0?'<path d="M0 '+Y(0).toFixed(1)+'H'+W+'" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>':'';
    h+='<svg class="ev-courbe" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc('Solde fin de mois : '+pts.map(p=>nomMoisCourt(p.cle,true)+' '+eur(p.v)).join(', ')+(avecPrevu?', prévu '+eur(prevu):''))+'">'+
      '<path d="M0 '+(H/3).toFixed(0)+'H'+W+'M0 '+(2*H/3).toFixed(0)+'H'+W+'" stroke="var(--line)" stroke-width="1"/>'+zero+
      '<path d="'+ligne+' L'+xa.toFixed(1)+' '+H+' L0 '+H+'Z" fill="var(--brand-soft)"/>'+
      '<path d="'+ligne+'" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'+
      (avecPrevu?'<path d="M'+xa.toFixed(1)+' '+ya.toFixed(1)+' L'+X(n).toFixed(1)+' '+Y(prevu).toFixed(1)+'" stroke="var(--st-prev)" stroke-width="2.5" stroke-dasharray="5 5" stroke-linecap="round"/>'+
        '<circle cx="'+X(n).toFixed(1)+'" cy="'+Y(prevu).toFixed(1)+'" r="4" fill="var(--st-prev)"/>':'')+
      '<circle cx="'+xa.toFixed(1)+'" cy="'+ya.toFixed(1)+'" r="4.5" fill="var(--brand)"/></svg>';
    const mil=pts[Math.round((pts.length-1)/2)];
    h+='<div class="ev-axe"><span>fin '+nomMoisCourt(pts[0].cle,true)+'</span><span>'+(pts.length>2?nomMoisCourt(mil.cle,false):'')+'</span><span>aujourd’hui</span></div>';
    h+='<div class="ev-legende"><span><i></i>Réel</span>'+(avecPrevu?'<span class="prevu"><i></i>Prévu : <b class="num">'+eur(prevu)+'</b></span>':'')+'</div>';
  }else{
    const flux=fluxEvolution(ids,debut,auj),mois=pts.slice(1).map(p=>p.cle),sel=mois.indexOf(e.mois)>=0?e.mois:mois[mois.length-1];
    const max=Math.max(1,...mois.map(k=>{const f=flux.get(k)||{rev:0,dep:0};return Math.max(f.rev,f.dep);}));
    const f=flux.get(sel)||{rev:0,dep:0};
    h+='<div class="ev-detail"><b>'+nomMois(dateCle(sel))+'</b><span class="credit num">+'+eur(f.rev)+'</span><span class="debit num">−'+eur(f.dep)+'</span></div>';
    h+='<div class="ev-barres" style="grid-template-columns:repeat('+mois.length+',minmax(0,1fr))">'+mois.map(k=>{const g=flux.get(k)||{rev:0,dep:0};
      return '<button'+(k===sel?' class="actuel"':'')+' onclick="anaEvo(\'mois\',\''+k+'\')" aria-label="'+esc(nomMois(dateCle(k))+' : revenus '+eur(g.rev)+', dépenses '+eur(g.dep))+'">'+
        '<span class="ev-b"><i class="rev" style="height:'+Math.round(g.rev/max*100)+'%"></i><i class="dep" style="height:'+Math.round(g.dep/max*100)+'%"></i></span>'+
        '<small>'+(mois.length<=12?nomMoisCourt(k,false).replace('.',''):'')+'</small></button>';}).join('')+'</div>';
    h+='<div class="ev-legende"><span class="rev"><i></i>Revenus</span><span class="dep"><i></i>Dépenses</span><span>hors virements</span></div>';
  }
  h+='<button class="ev-plein" onclick="evoPleinEcran()">Plein écran (paysage)</button>';
  document.getElementById('m-analyse').innerHTML=h;
}
function renderAnalyseMobile(){
  const acc=state.acc,auj=new Date();if(!acc)return;let decalageBarres=0;
  if(MA.sens==='evolution'){renderEvolutionMobile(acc,auj);return;}
  if(!MA.debut)MA.debut=clefMois(auj);
  const comp=MA.comp||periodeDecalee(MA.debut,-1),lim=limiteAnneeEnCours(MA.debut,auj);
  const L=lignesAnalyse(acc,MA.debut,lim),LC=lignesAnalyse(acc,comp,lim);
  const tot=totalAnalyse(L,MA.sens,MA.vir,MA.chemin),totC=totalAnalyse(LC,MA.sens,MA.vir,MA.chemin);
  const groupes=regrouperAnalyse(L,MA.sens,MA.vir,MA.chemin),grC=new Map(regrouperAnalyse(LC,MA.sens,MA.vir,MA.chemin).map(g=>[g.nom,g.total]));
  const motSens=MA.sens==='debit'?'Dépenses':'Revenus',nomP=libellePeriodeAna(MA.debut,lim),nomC=libellePeriodeAna(comp,lim);
  const ec=ecartPct(tot,totC),classeEc=ec&&ec!=='='?((ec[0]==='+')===(MA.sens==='debit')?'hausse':'baisse'):'';
  const fl=d=>icoPlus(d);
  const optsComp=periodesDuCompte(acc,MA.unite,auj).filter(k=>k!==MA.debut);
  if(optsComp.indexOf(comp)<0)optsComp.push(comp);
  const selComp='<select aria-label="Comparer avec" onchange="MA.comp=this.value;renderAnalyseMobile()">'+
    optsComp.map(k=>'<option value="'+k+'"'+(k===comp?' selected':'')+'>'+libellePeriodeAna(k)+'</option>').join('')+'</select>';
  // « vs 2025 (janv. → sept.) » reste d'un seul tenant : la ligne se coupe avant, pas au milieu
  // « vs 2025 » sans répéter « (janv. → sept.) » : les mêmes mois que la période affichée en haut
  const nomCc=comp.length===4?comp:comp.slice(5)+'/'+comp.slice(0,4); // « 09/2025 » plutôt que « septembre 2025 »
  const ecartLigne=(v,vc)=>{const d=v-vc;return d===0?'<span class="nw">comme en '+nomCc+'</span>'
    :(d>0?'+':'−')+eur(Math.abs(d)).replace('-','')+' <span class="nw">vs '+nomCc+'</span>';};
  let h='';
  if(!MA.chemin.length){
    h+='<div class="ma-mois"><button onclick="anaMobileDecaler(-1)" aria-label="Période précédente">'+fl('M15 6l-6 6 6 6')+'</button>'+
      '<div class="ma-mois-centre"><b>'+nomP+'</b><select aria-label="Mois ou année" onchange="anaMobileUnite(this.value)">'+
        '<option value="mois"'+(MA.unite==='mois'?' selected':'')+'>Un mois</option><option value="annee"'+(MA.unite==='annee'?' selected':'')+'>Une année</option></select></div>'+
      '<button onclick="anaMobileDecaler(1)" aria-label="Période suivante">'+fl('M9 6l6 6-6 6')+'</button></div>';
    h+='<div class="m-ana-seg" role="tablist" aria-label="Analyse">'+[['debit','Dépenses'],['credit','Revenus'],['evolution','Évolution']].map(([k,t])=>
      '<button role="tab" aria-selected="'+(k===MA.sens)+'"'+(k===MA.sens?' class="on"':'')+' onclick="anaMobileSens(\''+k+'\')">'+t+'</button>').join('')+'</div>';
    // anneau : 5 plus grosses catégories + « Autres »
    const top=groupes.slice(0,5),autres=groupes.slice(5).reduce((t,g)=>t+g.total,0);
    const parts=top.map((g,i)=>({nom:g.nom,v:g.total,col:PAL[i%PAL.length]})).concat(autres?[{nom:'Autres',v:autres,col:'var(--ink-3)'}]:[]);
    let pos=0;
    const arcs=parts.map(p=>{const pc=tot?p.v/tot*100:0,a='<circle cx="21" cy="21" r="15.9" fill="none" stroke="'+p.col+'" stroke-width="5" pathLength="100" stroke-dasharray="'+pc.toFixed(2)+' '+(100-pc).toFixed(2)+'" stroke-dashoffset="'+(-pos).toFixed(2)+'"/>';pos+=pc;return a;}).join('');
    h+='<div class="ma-anneau"><svg viewBox="0 0 42 42" role="img" aria-label="'+esc(motSens+' : '+parts.map(p=>p.nom+' '+Math.round(tot?p.v/tot*100:0)+' %').join(', '))+'">'+
      '<circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--line)" stroke-width="5"/>'+arcs+'</svg>'+
      '<div class="ma-centre"><b>'+eurSerre(tot)+'</b><small>'+motSens.toLowerCase()+'</small></div></div>';
    h+='<div class="ma-compare">'+(ec?'<span class="ma-ecart '+classeEc+'">'+ec+'</span>':'')+'<span>par rapport à</span>'+selComp+'</div>';
    h+='<div class="ma-puces"><button aria-pressed="'+MA.vir+'" onclick="MA.vir=!MA.vir;renderAnalyseMobile()">Inclure les virements</button></div>';
    h+='<div class="ma-liste">'+(groupes.length?groupes.map((g,i)=>'<button class="ma-ligne" onclick="anaMobileDescendre('+esc(JSON.stringify(g.nom))+')">'+
        '<i style="background:'+(i<5?PAL[i%PAL.length]:'var(--ink-3)')+'"></i><span class="ma-nom">'+esc(g.nom)+
        '<small>'+Math.round(tot?g.total/tot*100:0)+' % · '+ecartLigne(g.total,grC.get(g.nom)||0)+'</small></span>'+
        '<span class="num">'+eur(g.total).replace('-','')+'</span>'+fl('M9 6l6 6-6 6')+'</button>').join('')
      :'<div class="m-vide">Aucune '+(MA.sens==='debit'?'dépense':'rentrée')+' en '+nomP.toLowerCase()+'.</div>')+'</div>';
  }else{
    const nom=MA.chemin[MA.chemin.length-1];
    h+='<div class="ma-tete"><button onclick="anaMobileRemonter()" aria-label="Retour">'+fl('M15 6l-6 6 6 6')+'</button>'+
      '<div><small>'+esc([motSens].concat(MA.chemin.slice(0,-1)).join(' › '))+' › '+nomP+'</small><h2>'+esc(nom)+'</h2></div></div>';
    h+='<div class="ma-total"><b class="num">'+eur(tot).replace('-','')+'</b><span class="ma-ecart '+classeEc+'">'+ecartLigne(tot,totC)+'</span></div>';
    // 6 mois (ou années) de cette catégorie ; la fenêtre ne bouge que si la barre choisie passe dans la moitié gauche
    // 7 barres : la barre choisie au milieu (sauf vers la période en cours, qu'on ne dépasse pas)
    const finAvant=MA.fin;
    MA.fin=fenetreBarres(MA.fin,MA.debut,NB_BARRES,MA.unite==='annee'?String(auj.getFullYear()):clefMois(auj));
    decalageBarres=finAvant&&finAvant.length===MA.fin.length?rangPeriode(MA.fin)-rangPeriode(finAvant):0;
    const ps=[];for(let i=NB_BARRES-1;i>=0;i--)ps.push(periodeDecalee(MA.fin,-i));
    const vals=ps.map(k=>totalAnalyse(lignesAnalyse(acc,k,lim),MA.sens,MA.vir,MA.chemin)),max=Math.max(1,...vals);
    // toucher une barre : le détail de ce mois (ou de cette année), dans la même catégorie
    h+='<div class="ma-barres" style="grid-template-columns:repeat('+NB_BARRES+',minmax(0,1fr))">'+
      ps.map((k,i)=>'<button'+(k===MA.debut?' class="actuel" aria-current="true"':'')+' onclick="anaMobileAller(\''+k+'\')" aria-label="'+esc(libellePeriodeAna(k)+' : '+eur(vals[i]).replace('-',''))+'">'+
        '<span style="height:'+hauteurBarre(vals[i],max,66)+'px"></span><small>'+(k.length===4?k:MOIS_COURT[+k.slice(5)-1])+'</small></button>').join('')+'</div>';
    // des sous-catégories (dont « Sans sous-catégorie ») : on y descend ; sinon, les opérations de la période
    if(groupes.some(g=>!(g.nom===SANS_SOUS&&g.feuille))||groupes.length>1)
      h+='<h3 class="ma-h">Sous-catégories</h3><div class="ma-liste">'+groupes.map(g=>'<button class="ma-ligne" onclick="anaMobileDescendre('+esc(JSON.stringify(g.nom))+')">'+
        '<span class="ma-nom">'+esc(g.nom)+'<small>'+Math.round(tot?g.total/tot*100:0)+' %</small></span><span class="num">'+eur(g.total).replace('-','')+'</span>'+fl('M9 6l6 6-6 6')+'</button>').join('')+'</div>';
    else{
      const ops=lignesSens(L,MA.sens,MA.vir,MA.chemin).sort((a,b)=>b.d.localeCompare(a.d));
      h+='<h3 class="ma-h">Opérations ('+ops.length+')</h3><div class="ma-liste">'+ops.map(o=>'<button class="ma-ligne" onclick="ouvrirFiche('+o.id+')">'+
        '<span class="ma-nom">'+esc(o.ti||'(sans destinataire)')+'<small>'+libJour(o.d,auj)+'</small></span><span class="num">'+eur(Math.abs(o.m))+'</span></button>').join('')+'</div>';
    }
  }
  document.getElementById('m-analyse').innerHTML=h;
  if(MA.chemin.length)animerDecalage(document.querySelector('#m-analyse .ma-barres'),decalageBarres);
  // le total au centre de l'anneau tient dans le cercle : plus petit pour un grand montant
  // (le trou de l'anneau : environ 60 % de la largeur du dessin, pas de toute la ligne)
  const c=document.querySelector('#m-analyse .ma-centre b'),sv=document.querySelector('#m-analyse .ma-anneau svg');
  if(c&&sv){const max=sv.getBoundingClientRect().width*0.6;ajusterTaille(c,()=>c.scrollWidth>max);}
  // comparaisons : toujours sur une ligne (à droite du montant) ; trop longues, la police rapetisse
  document.querySelectorAll('#m-analyse .ma-ligne small').forEach(e=>ajusterTaille(e,()=>e.scrollWidth>e.clientWidth,10));
  const t=document.querySelector('#m-analyse .ma-total');
  if(t){const e=t.querySelector('.ma-ecart'),b=t.querySelector('b');
    ajusterTaille(e,()=>t.scrollWidth>t.clientWidth,10);ajusterTaille(b,()=>t.scrollWidth>t.clientWidth);}
}
/* ---------- une seule fenêtre à la fois (PC) ----------
   Chaque fenêtre garde sa copie de la base en mémoire et la réécrit en entier : deux fenêtres (ou onglets)
   ouvertes en même temps s'écraseraient. La 2e n'ouvre pas la base : elle dit « déjà ouvert », peut faire
   signe à la 1re, et démarre d'elle-même quand la 1re est fermée. (L'appli Android n'a qu'une fenêtre.) */
const VERROU_FENETRE='mescomptes-fenetre';
const canalFenetre=typeof BroadcastChannel==='function'?new BroadcastChannel(VERROU_FENETRE):null;
function prendreLaFenetre(){
  if(enAppli()||!navigator.locks)return Promise.resolve(true);
  return new Promise(res=>navigator.locks.request(VERROU_FENETRE,{ifAvailable:true},verrou=>{
    res(!!verrou);
    if(verrou)return new Promise(()=>{}); // gardé jusqu'à la fermeture de la fenêtre
  }));
}
function dejaOuvert(){
  document.getElementById('deja-ouvert').hidden=false;
  // dès que l'autre fenêtre est fermée, cette page démarre normalement
  navigator.locks.request(VERROU_FENETRE,()=>{}).then(()=>location.reload());
}
function montrerFenetreOuverte(){
  if(canalFenetre)canalFenetre.postMessage('montre-toi');
  toast('L’autre fenêtre clignote dans la barre des tâches');
}
let _clignote=null;
function repondreAuSigne(){ // fenêtre active : se mettre au premier plan si le navigateur le permet, sinon clignoter
  try{window.focus();}catch(e){}
  clearInterval(_clignote);const titre='Mes comptes';let n=1;
  document.title='● Mes comptes est ici';
  _clignote=setInterval(()=>{document.title=(n++%2)?titre:'● Mes comptes est ici';
    if(n>12||document.hasFocus()){clearInterval(_clignote);document.title=titre;}},700);
}
async function boot(){
  chargerReglages();appliquerReglages(true);
  if(enAppli()&&REGLAGES.verrou)verrouiller(); // rien ne s'affiche avant l'empreinte ou le code
  if(estTelephone()){
    document.body.classList.add('mobile');
    // la recherche des opérations est directement dans l'écran (pas dans la feuille des filtres)
    const rch=document.getElementById('f-search');document.getElementById('m-recherche').appendChild(rch.parentElement);
    rch.placeholder='Rechercher (destinataire, catégorie, montant…)';
    brancherListeCategories();
    glisserPourFermer(document.getElementById('f-zone'),fermerFiltres);
    brancherListeVentilation('vent-box');
    // le clavier s'ouvre : le champ en cours de saisie remonte au-dessus de lui (sinon il restait caché dessous)
    if(window.visualViewport)visualViewport.addEventListener('resize',champAuDessusDuClavier);
    window.addEventListener('resize',champAuDessusDuClavier);
    document.addEventListener('focusin',e=>{if(e.target.closest&&e.target.closest('.modal,.dlg'))champAuDessusDuClavier();}); // clavier déjà ouvert
    // « Entrée » / « OK » du clavier dans une recherche : le clavier se ferme pour laisser voir les résultats
    ['f-search','ti-search','cat-search'].forEach(id=>{const el=document.getElementById(id);if(!el)return;
      el.setAttribute('enterkeyhint','search');
      el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();el.blur();}});});
  }
  ['ti-search','cat-search'].forEach(id=>ajouterCroix(document.getElementById(id)));
  if(!(await prendreLaFenetre())){dejaOuvert();return;}
  if(canalFenetre)canalFenetre.onmessage=e=>{if(e.data==='montre-toi')repondreAuSigne();};
  busy('Démarrage du moteur…');
  try{
    const rep=await fetch('vendor/sql-wasm.wasm');if(!rep.ok)throw new Error('vendor/sql-wasm.wasm : '+rep.status);
    SQL=await initSqlJs({wasmBinary:new Uint8Array(await rep.arrayBuffer())});
  }catch(e){unbusy();await dlgAlert('Impossible de démarrer le moteur SQLite.\n\n'+e.message,'Erreur');return;}
  let restored=false;
  try{const b=await idbGet();if(b&&b.byteLength){db=new SQL.Database(new Uint8Array(b));restored=true;}}
  catch(e){idbOK=false;idbErr=e;}
  if(!db){db=new SQL.Database();}
  db.run(SCHEMA);migrer();
  try{const nv=renommerVirements();if(nv)touch('Libellés des virements',nv+' opération(s) renommée(s)');}catch(e){console.error('virements',e);}
  if(!scal('SELECT COUNT(*) FROM compte'))
    run("INSERT INTO compte(nom,type,solde_initial,date_ouverture) VALUES('Compte courant','courant',0,?)",[todayISO()]);
  if(getMeta('app')==null){setMeta('app','mes-comptes');setMeta('rev',0);setMeta('updated',nowTS());}
  try{const hasStat=scal("SELECT COUNT(*) FROM sqlite_master WHERE name='sqlite_stat1'");
      if(!hasStat&&scal('SELECT COUNT(*) FROM operation')>500)run('ANALYZE');}catch(_){}
  state.acc=+scal('SELECT id FROM compte WHERE actif=1 ORDER BY ordre_affichage,id LIMIT 1');
  remplirMois();brancherMasqueDates();setTimeout(()=>setHauteurRegistre(+getMeta('regRows',12)),0);setTimeout(appliquerLargeurs,0);
  setTimeout(()=>{try{let nav=null;try{nav=localStorage.getItem('mc.nav');}catch(e){}nav=nav||getMeta('nav');if(nav){const s=JSON.parse(nav);
    if(s.view==='releve'&&!(REL&&REL.res))s.view='registre';
    if(s.view==='plus'&&!document.body.classList.contains('mobile'))s.view='registre'; // « Plus » n'existe que sur téléphone
    _navSuppress=true;restoreNav(s);_navSuppress=false;}}catch(e){}syncHist();installerGardeRetour();},0);
  try{const _n=genererRecurrences();if(_n){touch('Échéances récurrentes',_n+' opération(s) générée(s)');}}catch(e){console.error('récurrences',e);}
  unbusy();refreshDirty();undoReset();majBoutonPleinEcran();render();
  state.jour=todayISO();
  const verifierJour=()=>{if(todayISO()===state.jour)return;state.jour=todayISO();
    try{const n=genererRecurrences();if(n)touch('Échéances récurrentes',n+' opération(s) générée(s)');}catch(e){console.error('récurrences',e);}
    render();};
  setInterval(verifierJour,60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)verifierJour();});
  if(restored){const n=scal('SELECT COUNT(*) FROM operation WHERE supprime=0');
    if(n)annoncerChargement(n);}
  if(!idbOK)dlgAlert("Le stockage local de ce navigateur n'est pas disponible ici.\nL'application fonctionne, mais pense à Sauvegarder avant de fermer.",'Attention');
  if(enAppli())demarrerAppli();
}

/* ============================================================
   Navigation / rendu
   ============================================================ */
let _navSuppress=false;
function toggleMenu(){document.body.classList.toggle('menu-open');}
function closeMenu(){document.body.classList.remove('menu-open');}
function setView(v,noPush){if(v!=='graphiques'&&document.body.classList.contains('gr-plein'))grPleinEcran(false);state.view=v;
  if(v!=='categories')fermerAnalyseCategorie();
  document.querySelectorAll('.nav a').forEach(a=>a.classList.toggle('on',a.dataset.v===v));
  document.querySelectorAll('.view').forEach(s=>s.classList.toggle('on',s.id==='v-'+v));
  const m=document.querySelector('main');if(m)m.scrollTop=0;render();
  closeMenu();
  if(v==='graphiques')grAuto();
  if(!noPush&&!_navSuppress)pushHist();}
/* ---- historique de navigation (retour / avancer partout) ---- */
function snapshotNav(){
  return {view:state.view,anPath:state.anPath.slice(),anSens:state.anSens,grMode:state.grMode||'compte',
    fSearch:(document.getElementById('f-search')||{}).value||'',
    fStatuts:statutsChips().filter(c=>c.classList.contains('on')).map(c=>c.dataset.s),
    fPeriode:(document.getElementById('f-periode')||{}).value||'tout',
    fHorizon:(document.getElementById('f-horizon')||{}).value||'finmois',
    catSearch:(document.getElementById('cat-search')||{}).value||'',
    tiSearch:(document.getElementById('ti-search')||{}).value||'',
    catVides:!!state.catVides,fSens:state.fSens||null,fCat:state.fCat||null};
}
/* l'écran affiché, retrouvé à la prochaine ouverture : dans le localStorage de l'appareil. Avant, il était écrit dans la
   base, ce qui la faisait réécrire en entier (plusieurs Mo) 0,8 s après chaque changement d'écran ou retour : l'appli
   se figeait un instant. */
function persistNav(){try{const s=snapshotNav();if(s.view==='releve')return; // on ne restaure pas une comparaison en cours
    localStorage.setItem('mc.nav',JSON.stringify(s));
  }catch(e){}}
function pushHist(){try{history.pushState(snapshotNav(),'');}catch(e){}persistNav();}
function syncHist(){try{history.replaceState(Object.assign(snapshotNav(),estBase()?{__base:true}:{}),'');}catch(e){}persistNav();}
/* ---- garde-fou « Retour » : la 1re entrée de l'historique (__base) sert de tampon.
   Y revenir par « retour » ne ferme pas l'appli : on demande d'abord confirmation. ---- */
const estBase=()=>!!(history.state&&history.state.__base);
function armerGardeRetour(){ // ajoute une entrée au-dessus du tampon (à faire pendant un geste de l'utilisateur, sinon Chrome l'ignore)
  if(estBase())try{history.pushState(snapshotNav(),'');}catch(e){}
}
function installerGardeRetour(){
  try{history.replaceState(Object.assign(snapshotNav(),{__base:true}),'');}catch(e){}
  ['pointerdown','keydown'].forEach(t=>document.addEventListener(t,armerGardeRetour,{capture:true,once:true}));
}
async function demanderQuitter(){
  const msg='Tu as appuyé sur Retour : veux-tu vraiment quitter l’application ?'+
    (dirty>0?'\n\nAttention : '+dirty+' modification'+(dirty>1?'s':'')+' pas encore sauvegardée'+(dirty>1?'s':'')+' dans un fichier (elles restent dans '+(enAppli()?'l’appli':'ce navigateur')+').':'');
  const v=await dlgOpen({title:'Quitter ?',msg,buttons:[{t:'Quitter',v:'q',d:true},{t:'Rester',v:false,p:true}]});
  if(v==='q'){
    if(enAppli()){clearTimeout(saveTimer);await flushIDB();Capacitor.nativePromise('App','exitApp');return;}
    toast('Appuie encore sur Retour pour quitter');try{history.back();}catch(e){}return;}
  armerGardeRetour(); // on reste : le tampon est de nouveau protégé
}
function restoreNav(s){
  if(!s)return;
  state.anPath=(s.anPath||[]).slice();state.anSens=s.anSens||'debit';state.grMode=s.grMode||'compte';state.catVides=!!s.catVides;state.fSens=s.fSens||null;state.fCat=s.fCat||null;
  const set=(id,val)=>{const e=document.getElementById(id);if(e&&val!==undefined)e.value=val;};
  set('f-search',s.fSearch||'');set('cat-search',s.catSearch||'');set('ti-search',s.tiSearch||'');
  set('f-periode',s.fPeriode||'tout');set('f-horizon',['3','finmois','finmoisprochain','masque'].indexOf(s.fHorizon)>=0?s.fHorizon:'finmois');
  document.querySelectorAll('#f-periode-wrap .pchip').forEach(b=>b.classList.toggle('on',b.dataset.m===(s.fPeriode||'tout')));
  if(s.fStatuts)statutsChips().forEach(c=>c.classList.toggle('on',s.fStatuts.indexOf(c.dataset.s)>=0));
  const cv=document.getElementById('cat-vides');if(cv)cv.checked=!!s.catVides;
  syncClear&&syncClear();
  _navSuppress=true;setView(s.view||'registre',true);_navSuppress=false;
}
function navBack(){history.back();}
function navFwd(){history.forward();}
function render(){
  if(!document.body.classList.contains('mobile'))sidebar(); // cachée sur téléphone : inutile de la redessiner
  if(state.view==='registre')renderRegistre();
  else if(state.view==='analyse')renderAnalyse();
  else if(state.view==='graphiques')renderGraphiques();
  else if(state.view==='tiers')renderTiers();
  else if(state.view==='categories')renderCategories();
  else if(state.view==='corbeille')renderCorbeille();
  else if(state.view==='reglages')renderReglages();
  else if(state.view==='plus')renderPlus();
  else if(state.view==='guide')renderGuide();

  else if(state.view==='recurrences')renderRecurrences();
  else if(state.view==='releve')renderReleve();
  majNavReleve();
  const n=scal('SELECT COUNT(*) FROM operation WHERE supprime=1');
  document.getElementById('nav-trash-n').textContent=n?n:'';
  showVersion();
  majMobile();
}
/* solde réel = opérations effectives datées jusqu'à aujourd'hui inclus (débits comme crédits) */
function soldeReel(id){return scal(`SELECT (SELECT solde_initial FROM compte WHERE id=$i)
  +COALESCE(SUM(montant),0) FROM operation WHERE compte_id=$i AND supprime=0
  AND statut IN('non_pointe','pointe','rapproche') AND previsionnel=0 AND date_operation<=$t`,{$i:id,$t:todayISO()});}
function _chiffres(s){return (s||'').replace(/\D/g,'');}
function numeroDuTitre(rc){
  if(rc&&rc.cle&&rc.cle.indexOf('n:')===0)return rc.cle.slice(2);
  const m=((rc&&rc.titre)||'').match(/N[°o]\s*([0-9 ]{5,})/i);
  return m?_chiffres(m[1]):'';
}
function compteCorrespondant(numRel){
  if(!numRel||numRel.length<4)return null;
  const last5=numRel.slice(-5);
  const cs=qy('SELECT id,nom,numero FROM compte WHERE actif=1');
  for(const c of cs){
    const nd=_chiffres(c.numero||'');
    if(nd&&(nd.slice(-5)===last5||nd.indexOf(last5)>=0||numRel.indexOf(nd.slice(-5))>=0))return c.id;
  }
  for(const c of cs){ // repli : chiffres présents dans le nom du compte
    const nn=_chiffres(c.nom||'');
    if(last5.length===5&&nn.indexOf(last5)>=0)return c.id;
  }
  return null;
}
async function editCompte(id){
  const c=qy('SELECT nom,type,numero FROM compte WHERE id=?',[id])[0];if(!c)return;
  const nbAutres=scal('SELECT COUNT(*) FROM compte WHERE actif=1 AND id<>?',[id])||0;
  const html='<div class="field"><label>Nom du compte</label><input id="ec-nom" value="'+esc(c.nom)+'"></div>'+
    '<div class="field"><label>Type</label><select id="ec-type">'+
      Object.keys(ACC_TYPES).map(k=>'<option value="'+k+'"'+(c.type===k?' selected':'')+'>'+ACC_TYPES[k]+'</option>').join('')+'</select></div>'+
    '<div class="field"><label>Numéro de compte <span class="hint">facultatif — sert à reconnaître ce compte dans un relevé PDF</span></label>'+
    '<input id="ec-num" value="'+esc(c.numero||'')+'" placeholder="ex. 00012345"></div>';
  let data=null;
  const boutons=[{t:'Annuler',v:false}];
  if(nbAutres>0)boutons.push({t:'Supprimer',v:'del',danger:true});
  boutons.push({t:'Enregistrer',v:true,p:true,before:()=>{
    const nom=document.getElementById('ec-nom').value.trim();
    if(!nom){toast('Le nom est requis');return false;}
    data={nom,type:document.getElementById('ec-type').value,numero:document.getElementById('ec-num').value.trim()||null};
  }});
  const ok=await dlgOpen({title:'Modifier le compte',msg:'',html,buttons:boutons,
    onOpen:()=>{const e=document.getElementById('ec-nom');if(e){e.focus();e.select();}}});
  if(ok==='del'){return supprimerCompte(id);}
  if(!ok||!data)return;
  run('UPDATE compte SET nom=?,type=?,numero=? WHERE id=?',[data.nom,data.type,data.numero,id]);
  renommerVirements();
  touch('Compte modifié',data.nom);render();
}
function remonterEnHaut(){
  const m=document.querySelector('main');if(m)m.scrollTop=0;
  const sc=document.getElementById('reg-scroll');if(sc)sc.scrollTop=0;
}
function sidebar(){
  const el=document.getElementById('acctlist');el.innerHTML='';
  qy('SELECT id,nom,type,numero FROM compte WHERE actif=1 ORDER BY ordre_affichage,id').forEach(c=>{
    const d=document.createElement('div');d.className='acct'+(c.id===state.acc?' on':'');
    d.onclick=()=>{state.acc=c.id;state.page=1;state.anPath=[];render();remonterEnHaut();closeMenu();};
    d.ondblclick=(e)=>{e.stopPropagation();editCompte(c.id);};
    const numTxt=c.numero?('<span class="acct-num">n° '+esc(String(c.numero))+'</span>'):'';
    d.innerHTML='<div class="acct-main"><span class="an">'+esc(c.nom)+numTxt+'</span>'+
      '<span class="av num">'+eur(soldeReel(c.id))+'</span></div>'+
      '<button class="acct-edit" title="Renommer / numéro de compte" onclick="event.stopPropagation();editCompte('+c.id+')">✎</button>';
    el.appendChild(d);});
  const add=document.createElement('button');add.className='acct-add';add.textContent='+ Nouveau compte';
  add.onclick=ajouterCompte;el.appendChild(add);
}
async function supprimerCompte(id){
  const nom=scal('SELECT nom FROM compte WHERE id=?',[id])||'ce compte';
  const nbOps=scal('SELECT COUNT(*) FROM operation WHERE compte_id=? AND supprime=0',[id])||0;
  if(nbOps>0){
    if(!await dlgConfirm('« '+nom+' » contient '+nbOps+' opération(s). Le supprimer effacera aussi ces opérations et leurs ventilations. Cette action est définitive.\n\nSupprimer quand même ?','Supprimer le compte',"Tout supprimer",true))return;
  }else{
    if(!await dlgConfirm('Supprimer le compte « '+nom+' » ?','Supprimer le compte','Supprimer',true))return;
  }
  run('DELETE FROM ventilation WHERE operation_id IN (SELECT id FROM operation WHERE compte_id=?)',[id]);
  run('DELETE FROM operation WHERE compte_id=?',[id]);
  run('DELETE FROM recurrence WHERE compte_id=?',[id]);
  run('DELETE FROM compte WHERE id=?',[id]);
  if(state.acc===id)state.acc=+scal('SELECT id FROM compte WHERE actif=1 ORDER BY ordre_affichage,id LIMIT 1');
  touch('Compte supprimé',nom);render();remonterEnHaut();
  toast('Compte « '+nom+' » supprimé');
}
async function ajouterCompte(){
  let data=null;
  const html='<div class="field"><label>Nom du compte</label><input id="ec-nom" placeholder="ex. Livret A"></div>'+
    '<div class="row2"><div class="field"><label>Type</label><select id="ec-type">'+
      Object.keys(ACC_TYPES).map(k=>'<option value="'+k+'">'+ACC_TYPES[k]+'</option>').join('')+'</select></div>'+
    '<div class="field"><label>Solde initial (€)</label><input id="ec-solde" inputmode="decimal" value="0"></div></div>'+
    '<div class="field"><label>Numéro de compte <span class="hint">facultatif — pour la reconnaissance dans un relevé PDF</span></label>'+
    '<input id="ec-num" placeholder="ex. 00012345"></div>';
  const ok=await dlgOpen({title:'Nouveau compte',msg:'',html,
    buttons:[{t:'Annuler',v:false},{t:'Créer le compte',v:true,p:true,before:()=>{
      const nom=document.getElementById('ec-nom').value.trim();if(!nom){toast('Le nom est requis');return false;}
      data={nom,type:document.getElementById('ec-type').value,
        numero:document.getElementById('ec-num').value.trim()||null,
        solde:parseMontantC(document.getElementById('ec-solde').value)||0};
    }}],
    onOpen:()=>{const e=document.getElementById('ec-nom');if(e)e.focus();}});
  if(!ok||!data)return;
  const ord=(scal('SELECT COALESCE(MAX(ordre_affichage),0) FROM compte')||0)+1;
  run('INSERT INTO compte(nom,type,solde_initial,numero,date_ouverture,actif,ordre_affichage) VALUES(?,?,?,?,?,1,?)',
    [data.nom,data.type,data.solde,data.numero,todayISO(),ord]);
  state.acc=lastId();state.page=1;state.anPath=[];
  touch('Compte créé',data.nom);render();
  toast('Compte « '+data.nom+' » créé');
}
const MOIS_FR=['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
function remplirMois(){/* remplacé par les puces de période */}
function showVersion(){
  const bv=document.getElementById('brandver');if(!bv)return;
  let nops=0,rev=0,upd='';
  try{nops=scal('SELECT COUNT(*) FROM operation WHERE supprime=0')||0;
      rev=+getMeta('rev',0);upd=getMeta('updated','')||'';}catch(e){}
  const quand=upd?(upd.slice(8,10)+'/'+upd.slice(5,7)+'/'+upd.slice(0,4)+' à '+upd.slice(11,16)):'—';
  bv.innerHTML='Application '+APP_BUILD+'<br>'+
    '<span title="Numéro de révision : il augmente à chaque sauvegarde">Données rév. '+rev+'</span><br>'+
    '<span title="Date de la dernière modification enregistrée">'+quand+'</span><br>'+
    nops.toLocaleString('fr-FR')+' opérations';
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

/* ============================================================
   Registre
   ============================================================ */
/* filtre « prévisionnel affiché » et période vont ensemble : fin du mois → « Ce mois » ; fin du mois prochain →
   dates jusqu'au dernier jour du mois prochain. « Ce mois » et « fin du mois prochain » ne vont pas ensemble. */
function horizonChange(){
  const hz=document.getElementById('f-horizon').value,auj=new Date();
  if(hz==='finmois'){setPeriode('f','mois');return;}
  if(hz==='finmoisprochain'){
    const from=document.getElementById('f-from'),to=document.getElementById('f-to');
    const d=scal('SELECT MIN(date_operation) FROM operation WHERE compte_id=? AND supprime=0',[state.acc]);
    from.value=isoToShort(d||todayISO());to.value=isoToShort(borneHorizon('finmoisprochain',auj));
    state.sansFocusDates=true;setPeriode('f','perso');return;}
  majCompatHorizon();goPage(1);
}
function majCompatHorizon(){
  const hz=document.getElementById('f-horizon'),per=document.getElementById('f-periode').value;
  if(per==='mois'&&hz.value==='finmoisprochain')hz.value='finmois';
  const opt=hz.querySelector('option[value="finmoisprochain"]');if(opt)opt.disabled=per==='mois';
  const ch=document.querySelector('#f-periode-wrap .pchip[data-m="mois"]');if(ch)ch.disabled=hz.value==='finmoisprochain';
}
function periodeChanged(pfx){
  if(pfx==='f')majCompatHorizon();
  const mode=document.getElementById(pfx+'-periode').value,show=mode==='perso'?'':'none';
  const from=document.getElementById(pfx+'-from'),to=document.getElementById(pfx+'-to'),sep=document.getElementById(pfx+'-sep');
  from.style.display=show;to.style.display=show;if(sep)sep.style.display=show;
  if(pfx==='f')majDatesFiltre();
  if(mode==='perso'){
    // bornes par défaut, visibles et modifiables : 1re opération du compte -> aujourd'hui
    if(!from.value){const d=scal('SELECT MIN(date_operation) FROM operation WHERE compte_id=? AND supprime=0',[state.acc]);
      from.value=isoToShort(d||todayISO());}
    if(!to.value)to.value=isoToShort(todayISO());
    if(state.sansFocusDates)state.sansFocusDates=false;
    else setTimeout(()=>{if(from){from.focus();from.select&&from.select();}},0);
  }
  pfx==='f'?goPage(1):pfx==='gr'?renderGraphiques():renderAnalyse();}
/* solde du compte à la fin d'une journée (comme la colonne Solde : opérations non annulées,
   prévisionnelles comprises) */
function soldeAu(iso){return scal(`SELECT (SELECT solde_initial FROM compte WHERE id=$a)+COALESCE(SUM(montant),0)
  FROM operation WHERE compte_id=$a AND supprime=0 AND statut<>'annule' AND date_operation<=$d`,{$a:state.acc,$d:iso});}
/* encadré « Pour info » : solde la veille de la période et à son dernier jour */
function majInfoSoldes(dmin,dmax){
  const el=document.getElementById('reg-info');if(!el)return;
  const b=periodBounds('f')||{};const f=b.f||dmin,t=b.t||dmax;
  if(!f||!t){el.style.display='none';return;}
  el.style.display='';
  const veille=avancerJours(f,-1),s1=soldeAu(veille),s2=soldeAu(t),v=s2-s1;
  const futur=t>todayISO()?' <span class="hint">(prévisionnels compris)</span>':'';
  el.innerHTML='<span class="titre">Pour info</span>'+
    '<span class="lb">Solde au '+isoToFr(veille)+' (veille de la période)</span><span class="vl num">'+eur(s1)+'</span>'+
    '<span class="lb">Solde au '+isoToFr(t)+' (fin de la période)'+futur+'</span><span class="vl num">'+eur(s2)+'</span>'+
    '<span class="lb tot">Variation sur la période</span><span class="vl num tot '+clsSigne(v)+'">'+eur(v)+'</span>';
}
function setPeriode(pfx,mode){
  document.getElementById(pfx+'-periode').value=mode;
  document.querySelectorAll('#'+pfx+'-periode-wrap .pchip').forEach(b=>b.classList.toggle('on',b.dataset.m===mode));
  periodeChanged(pfx);
}
/* texte « du JJ/MM/AAAA au JJ/MM/AAAA » des dates réellement prises en compte ;
   une borne absente (Tout, dates partielles) est remplacée par la 1re / dernière opération retenue */
function textePeriode(pfx,dmin,dmax){
  const b=periodBounds(pfx)||{};const f=b.f||dmin,t=b.t||dmax;
  if(!f&&!t)return '';
  return (b.f||b.t?'Période':'Toutes les dates')+' : du '+isoToFr(f||'')+' au '+isoToFr(t||'');
}
/* bornes ISO {f,t} de la période choisie (f ou t peuvent manquer) ; null = toute la période.
   Mêmes définitions dans le registre et l'analyse :
   « Cette année » = du 1er janvier à aujourd'hui,
   « 3 mois » = les 3 derniers mois pleins écoulés (hors mois en cours). */
function periodBounds(pfx){
  const mode=document.getElementById(pfx+'-periode').value;const now=new Date(),y=now.getFullYear(),mo=now.getMonth();
  if(mode.indexOf('m:')===0){const pp=mode.slice(2).split('-');return {f:mode.slice(2)+'-01',t:isoDe(new Date(+pp[0],+pp[1],0))};}
  if(mode==='mois')return {f:isoDe(new Date(y,mo,1)),t:isoDe(new Date(y,mo+1,0))};
  if(mode==='moisdernier')return {f:isoDe(new Date(y,mo-1,1)),t:isoDe(new Date(y,mo,0))};
  if(mode==='3mois')return {f:isoDe(new Date(y,mo-3,1)),t:isoDe(new Date(y,mo,0))};
  if(mode==='annee')return {f:y+'-01-01',t:pfx==='an'&&mo>0?isoDe(new Date(y,mo,0)):isoDe(now)}; // analyse : derniers mois entiers
  if(mode==='perso'){const f=frToISO(document.getElementById(pfx+'-from').value),t=frToISO(document.getElementById(pfx+'-to').value);
    return (f||t)?{f:f||null,t:t||null}:null;}
  return null;
}
function periodClause(pfx,params){
  const b=periodBounds(pfx);if(!b)return '';
  let c='';if(b.f){params.$pf=b.f;c+=" AND o.date_operation>=$pf";}if(b.t){params.$pt=b.t;c+=" AND o.date_operation<=$pt";}return c;
}
function avancerJours(iso,nb){const d=new Date(iso+'T00:00:00');d.setDate(d.getDate()+nb);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
/* borne d'horizon prévisionnel : 'MASQUE'=aucun, sinon date ISO limite.
   (« tout » n'existe plus : un ancien réglage enregistré vaut « fin du mois ».) */
function horizonMax(){return borneHorizon((document.getElementById('f-horizon')||{}).value,new Date());}
function borneHorizon(hz,d){
  if(hz==='masque')return 'MASQUE';
  if(hz==='3')return avancerJours(isoDe(d),3);
  if(hz==='finmoisprochain')return isoDe(new Date(d.getFullYear(),d.getMonth()+2,0));
  return isoDe(new Date(d.getFullYear(),d.getMonth()+1,0)); // fin du mois
}
function buildWhere(params){
  let w=" WHERE o.compte_id=$acc AND o.supprime=0";params.$acc=state.acc;
  const q=(document.getElementById('f-search').value||'').toLowerCase();
  if(/^\(?non pr[ée]cis[ée]e?\)?$/.test(q.trim())){w+=" AND (o.cat_path IS NULL OR TRIM(o.cat_path)='')";}
  else if(q){w+=" AND o.hay LIKE $q";params.$q='%'+q+'%';}
  const chips=[].slice.call(document.querySelectorAll('#f-statuts .schip'));
  const sel=chips.filter(c=>c.classList.contains('on')).map(c=>c.dataset.s);
  if(chips.length&&sel.length<chips.length){
    const parts=[];
    ['non_pointe','pointe','rapproche','annule'].forEach(s=>{if(sel.indexOf(s)>=0)parts.push("(o.previsionnel=0 AND o.statut='"+s+"')");});
    if(sel.indexOf('previsionnel')>=0)parts.push("o.previsionnel=1");
    w+=parts.length?(" AND ("+parts.join(" OR ")+")"):" AND 0";
  }
  const hm=horizonMax();
  if(hm==='MASQUE'){w+=" AND o.previsionnel=0";}
  else if(hm){params.$hmax=hm;w+=" AND (o.previsionnel=0 OR o.date_operation<=$hmax)";}
  w+=periodClause('f',params);
  // loupes (catégorie / débits / crédits / virements) : on garde les opérations ayant au moins une ligne retenue
  if(state.fCat||state.fSens){
    const ids=[...new Set(lignesOps(w,params).filter(ligneFiltre).map(l=>l.id))];
    w+=ids.length?" AND o.id IN ("+ids.join(',')+")":" AND 0";
  }
  return w;
}
function goPage(p){state.page=Math.max(1,p||1);if(state.page===1)state.mLimite=MOBILE_PAR_LOT;renderRegistre();syncHist();}
const COL_DEF=[18,120,100,null,150,150,160];
const COL_DEST_MIN=180; // largeur minimale de la colonne Destinataire avant défilement horizontal
function appliquerLargeurs(){
  // largeurs fixes (toutes les colonnes sauf Destinataire)
  document.querySelectorAll('#reg-head colgroup, #reg-scroll colgroup').forEach(cg=>{
    const cols=cg.querySelectorAll('col');
    COL_DEF.forEach((px,i)=>{if(cols[i]&&px!=null)cols[i].style.width=px+'px';});
  });
  // largeur de la colonne Destinataire calculée explicitement en pixels à partir de la largeur
  // réellement disponible (#reg-scroll, sans sa barre de défilement verticale), puis appliquée
  // à l'identique aux deux tableaux (en-tête + corps) pour garantir un alignement parfait —
  // on ne compte plus sur la répartition automatique du navigateur, source du désalignement.
  const sc=document.getElementById('reg-scroll');
  if(sc){
    const fixedSum=COL_DEF.reduce((s,px)=>s+(px||0),0);
    const dispo=sc.clientWidth-fixedSum;
    const destW=Math.max(COL_DEST_MIN,dispo);
    document.querySelectorAll('#reg-head colgroup, #reg-scroll colgroup').forEach(cg=>{
      const cols=cg.querySelectorAll('col');
      if(cols[3])cols[3].style.width=destW+'px';
    });
  }
}

function syncScrollX(){
  const sc=document.getElementById('reg-scroll');if(!sc)return;
  appliquerLargeurs();
  const sbw=sc.offsetWidth-sc.clientWidth;
  const hd=document.getElementById('reg-head');
  if(hd)hd.style.paddingRight=(sbw>0?sbw:0)+'px';
  if(!sc._xbound){sc.addEventListener('scroll',()=>{
    const x=sc.scrollLeft;if(hd)hd.scrollLeft=x;
  });sc._xbound=true;}
}
function syncHeadWidth(){syncScrollX();}
const estMobile=()=>window.matchMedia('(max-width:700px)').matches;
/* hauteur moyenne réelle d'une ligne (sur mobile les lignes sont des cartes de hauteur variable) */
function hauteurLigneMesuree(){
  let s=0,n=0;
  for(const tr of document.querySelectorAll('#rows tr')){const h=tr.offsetHeight;if(h>0){s+=h;n++;}if(n>=20)break;}
  return n?s/n:null;
}
function appliquerHauteurRegistre(){
  const el=document.getElementById('reg-scroll');if(!el)return;
  const rows=state.regRows||12;
  const hl=estMobile()?hauteurLigneMesuree():null;
  // hauteur maximale (et non fixe) : s'il y a moins de lignes, le tableau se resserre, sans blanc avant les totaux
  el.style.height='';el.style.maxHeight=hl?Math.round(rows*hl)+'px':(rows*2.55)+'rem';   // ~ nb de lignes visibles
}
function setHauteurRegistre(rows){
  rows=Math.max(4,Math.min(60,+rows||12));
  state.regRows=rows;appliquerHauteurRegistre();
  const sl=document.getElementById('reg-hauteur');if(sl&&+sl.value!==rows)sl.value=rows;
  try{setMeta('regRows',rows);}catch(e){}
  setTimeout(syncHeadWidth,0);
}
function statutsChips(){return [].slice.call(document.querySelectorAll('#f-statuts .schip'));}
function toggleStatut(el){el.classList.toggle('on');goPage(1);}
function setStatutsTous(){statutsChips().forEach(c=>c.classList.add('on'));}
/* loupe d'une barre de l'analyse : registre filtré exactement comme l'analyse
   (même période, ni prévisionnels ni annulés, même sens, catégorie précise) */
function voirDepuisAnalyse(chemin){
  const sens=state.anSens||'debit';
  ['periode','from','to'].forEach(k=>{const a=document.getElementById('an-'+k),f=document.getElementById('f-'+k);if(a&&f)f.value=a.value;});
  const mode=document.getElementById('f-periode').value,perso=mode==='perso'?'':'none';
  document.querySelectorAll('#f-periode-wrap .pchip').forEach(b=>b.classList.toggle('on',b.dataset.m===mode));
  ['f-from','f-to','f-sep'].forEach(i=>{const e=document.getElementById(i);if(e)e.style.display=perso;});
  majDatesFiltre();
  statutsChips().forEach(c=>c.classList.toggle('on',['non_pointe','pointe','rapproche'].indexOf(c.dataset.s)>=0));
  const s=document.getElementById('f-search');
  if(sens==='virement'){state.fCat=null;state.fSens='virement';s.value=chemin;}   // virements : regroupés par compte
  else{state.fCat=chemin;state.fSens=(sens==='net')?null:sens;s.value='';}
  syncClear();setView('registre');goPage(1);
  toast('Registre filtré comme l’analyse : « '+chemin+' »');
}
const SENS_LIB={debit:'débits uniquement',credit:'crédits uniquement',virement:'virements uniquement'};
function setFSens(v){state.fSens=(state.fSens===v)?null:v;goPage(1);
  if(state.fSens)toast('Registre filtré : '+SENS_LIB[state.fSens]);}
function retirerFiltreCat(){state.fCat=null;goPage(1);}
function resetFilters(){state.fSens=null;state.fCat=null;document.getElementById('f-search').value='';setStatutsTous();setPeriode('f','tout');
  ['f-from','f-to','f-sep'].forEach(i=>{const e=document.getElementById(i);if(e){if(e.value!==undefined)e.value='';e.style.display='none';if(e.classList)e.classList.remove('bad');}});
  majDatesFiltre();
  state.sort='date';state.dir=-1;syncClear();goPage(1);}
function filtreAttente(){const chips=statutsChips();
  const sel=chips.filter(c=>c.classList.contains('on')).map(c=>c.dataset.s);
  const onlyNP=sel.length===1&&sel[0]==='non_pointe';
  chips.forEach(c=>c.classList.toggle('on', onlyNP?true:c.dataset.s==='non_pointe'));
  goPage(1);toast(onlyNP?'Filtre retiré':'Filtré sur les non pointées');}
function setSort(k){if(state.sort===k)state.dir*=-1;else{state.sort=k;state.dir=k==='date'?-1:1;}goPage(1);}

function _hmPrv(){const hm=horizonMax();return hm==='MASQUE'?'0000-00-00':hm;} // MASQUE -> aucune prévisionnelle
/* soldes d'un compte : rapproché, réel, en attente, prévisionnel à venir (jusqu'à l'horizon choisi), nombre à pointer */
function soldesCompte(a){
  return qy(`SELECT
    (SELECT solde_initial FROM compte WHERE id=$a)+COALESCE(SUM(CASE WHEN statut='rapproche' THEN montant END),0) rap,
    (SELECT solde_initial FROM compte WHERE id=$a)+COALESCE(SUM(CASE WHEN statut IN('non_pointe','pointe','rapproche') AND previsionnel=0 AND date_operation<=$t THEN montant END),0) reel,
    COALESCE(SUM(CASE WHEN statut IN('non_pointe','pointe') AND previsionnel=0 THEN montant END),0) att,
    COALESCE(SUM(CASE WHEN statut<>'annule' AND (previsionnel=1 OR date_operation>$t) AND ($hm IS NULL OR date_operation<=$hm) THEN montant END),0) prv,
    COUNT(CASE WHEN statut='non_pointe' AND previsionnel=0 THEN 1 END) npt
    FROM operation o WHERE compte_id=$a AND supprime=0`,{$a:a,$hm:_hmPrv(),$t:todayISO()})[0];
}
function tiles(){
  const a=state.acc;
  const r=soldesCompte(a);
  const cards=[
    {k:'Solde rapproché',v:eur(r.rap),c:'var(--ink)',d:'Confirmé par la banque'},
    {k:'Solde réel',v:eur(r.reel),c:'var(--ink)',d:'Tout jusqu’à aujourd’hui'},
    {k:'En attente',v:eur(r.att),c:'#F59E0B',d:'Non rapproché · cliquer pour filtrer',click:true},
    {k:'Solde prévisionnel',v:eur(r.reel+r.prv),c:'#7C3AED',d:(()=>{const hz=(document.getElementById('f-horizon')||{}).value;
    return hz==='masque'?'= solde réel (prévisionnel masqué)':hz==='3'?'Réel + à venir sous 3 jours':hz==='finmoisprochain'?'Réel + à venir d’ici fin du mois prochain':'Réel + à venir d’ici fin de mois';})()}];
  document.getElementById('tiles').innerHTML=cards.map(c=>'<div class="tile'+(c.click?' clickable':'')+'"'+(c.click?' onclick="filtreAttente()"':'')+
    '><div class="k">'+c.k+'</div><div class="v num" style="color:'+c.c+'">'+c.v+'</div><div class="d">'+c.d+'</div></div>').join('');
  const cp=qy('SELECT nom,type,numero FROM compte WHERE id=?',[a])[0]||{nom:'—',type:'autre'};
  document.getElementById('acct-title').innerHTML=esc(cp.nom)+(cp.numero?' <span style="font-size:.7em;font-weight:400;color:var(--ink-3)">n° '+esc(String(cp.numero))+'</span>':'');
  document.getElementById('acct-meta').textContent=(ACC_TYPES[cp.type]||'Compte')+' · aujourd’hui le '+new Date().toLocaleDateString('fr-FR');
}
function head(){
  const cols=[['','',0],['N°','num',1],['Date','date',1],['Destinataire','dest',1],['Débit','debit',1],['Crédit','credit',1],['Solde','solde',0]];
  document.getElementById('head').innerHTML=cols.map(c=>{
    const r=(c[1]==='debit'||c[1]==='credit'||c[1]==='solde')?' r':'';
    const arr=state.sort===c[1]?(state.dir===1?' ↑':' ↓'):'';
    return c[2]?'<th class="'+r.trim()+'" onclick="setSort(\''+c[1]+'\')">'+c[0]+arr+'</th>':'<th class="fix'+r+'">'+c[0]+'</th>';
  }).join('');
}
function orderClause(){
  const d=state.dir===1?'ASC':'DESC';
  switch(state.sort){
    case 'num':return 'o.numero '+d+', o.date_operation DESC';
    case 'dest':return 'LOWER(COALESCE(t.nom,\'\')) '+d+', o.date_operation DESC';
    case 'debit':return 'CASE WHEN o.montant<0 THEN -o.montant ELSE 0 END '+d+', o.date_operation DESC';
    case 'credit':return 'CASE WHEN o.montant>0 THEN o.montant ELSE 0 END '+d+', o.date_operation DESC';
    default:return 'o.date_operation '+d+', o.id '+d;
  }
}
function renderRegistre(){
  if(!state.acc)return;
  if(document.body.classList.contains('mobile')){renderOperationsMobile();return;}
  tiles();head();
  const p={};const w=buildWhere(p);
  const total=scal('SELECT COUNT(*) FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id'+w,p)||0;
  const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
  if(state.page>pages)state.page=pages;
  const off=(state.page-1)*PAGE_SIZE;
  const p2=Object.assign({},p,{$lim:PAGE_SIZE,$off:off});
  const rows=qy(`WITH bal AS (SELECT id, SUM(montant) OVER (ORDER BY date_operation,id) cum
      FROM operation WHERE compte_id=$acc AND supprime=0 AND statut<>'annule')
    SELECT o.id,o.date_operation d,o.montant m,o.statut st,o.previsionnel pv,o.numero num,
      o.commentaire comm,o.cat_path cat,t.nom dest,
      (SELECT solde_initial FROM compte WHERE id=$acc)+b.cum solde
    FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id LEFT JOIN bal b ON b.id=o.id
    `+w+` ORDER BY `+orderClause()+` LIMIT $lim OFFSET $off`,p2);

  const tb=document.getElementById('rows');tb.innerHTML='';
  if(!rows.length){tb.innerHTML='<tr><td class="empty-msg" colspan="7" style="padding:22px;text-align:center;color:var(--ink-3)">Aucune opération ne correspond à ces filtres.</td></tr>';}
  const frag=document.createDocumentFragment();
  rows.forEach(o=>{
    const stt=o.st==='annule'?'annule':(o.pv?'previsionnel':o.st);
    const m=META[stt]||META.non_pointe;
    const tr=document.createElement('tr');
    tr.className='click '+(stt==='previsionnel'?'prev':stt==='annule'?'ann':'');
    tr.ondblclick=()=>openModal(o.id);
    const debit=o.m<0?'<span class="debit">'+eur(-o.m)+'</span>':'';
    const credit=o.m>0?'<span class="credit">'+eur(o.m)+'</span>':'';
    const solde=(stt==='annule'||o.solde==null)?'<span style="color:var(--ink-3)">—</span>':eur(o.solde);
    const note=o.comm?'<div class="note">'+esc(o.comm)+'</div>':'';
    tr.innerHTML='<td class="st" title="'+m.label+' — cliquer pour pointer/dépointer" onclick="togglePointe('+o.id+',event)">'+
        '<div class="stbar" style="background:'+m.col+'"></div></td>'+
      '<td class="num" ondblclick="event.stopPropagation();openModal('+o.id+',&#39;num&#39;)">'+esc(o.num||'')+'</td>'+
      '<td class="num" ondblclick="event.stopPropagation();openModal('+o.id+',&#39;date&#39;)">'+isoToFr(o.d)+'</td>'+
      '<td class="dest" ondblclick="event.stopPropagation();openModal('+o.id+',&#39;dest&#39;)">'+esc(o.dest||'')+
        '<div class="cat" ondblclick="event.stopPropagation();openModal('+o.id+',&#39;cat&#39;)">'+esc(o.cat||'')+'</div>'+
        (o.comm?'<div class="note" ondblclick="event.stopPropagation();openModal('+o.id+',&#39;comm&#39;)">'+esc(o.comm)+'</div>':'')+'</td>'+
      '<td class="r num" ondblclick="event.stopPropagation();openModal('+o.id+',&#39;montant&#39;)">'+debit+'</td>'+
      '<td class="r num" ondblclick="event.stopPropagation();openModal('+o.id+',&#39;montant&#39;)">'+credit+'</td>'+
      '<td class="r num">'+solde+'</td>';
    frag.appendChild(tr);});
  tb.appendChild(frag);

  document.getElementById('count').textContent=total.toLocaleString('fr-FR')+' opération'+(total>1?'s':'')+
    (total>PAGE_SIZE?(' · '+(off+1)+'–'+Math.min(off+PAGE_SIZE,total)+' affichées'):'');
  // totaux adaptés au filtre courant (toutes pages), calculés ligne par ligne comme l'analyse :
  // débits et crédits hors virements, virements à part ; les opérations annulées ne comptent pas.
  // Avec une loupe active, seules les lignes concernées comptent (ex. catégorie Salaire = montant de l'analyse).
  const sums={deb:0,cre:0,vir:0};
  lignesOps(w,p).forEach(l=>{if(l.st==='annule'||!ligneFiltre(l))return;
    if(l.vir)sums.vir+=l.m;else if(l.m<0)sums.deb-=l.m;else sums.cre+=l.m;});
  Object.assign(sums,qy('SELECT MIN(o.date_operation) dmin,MAX(o.date_operation) dmax FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id'+w,p)[0]||{});
  const net=sums.cre-sums.deb+sums.vir;
  const per=textePeriode('f',sums.dmin,sums.dmax);
  if(per)document.getElementById('count').textContent+=' · '+per;
  if(state.fCat)document.getElementById('count').insertAdjacentHTML('beforeend',
    ' · <a style="color:var(--brand);cursor:pointer" title="Retirer ce filtre" onclick="retirerFiltreCat()">catégorie : '+esc(state.fCat)+' ✕</a>');
  if(state.fSens)document.getElementById('count').insertAdjacentHTML('beforeend',
    ' · <a style="color:var(--brand);cursor:pointer" title="Retirer ce filtre" onclick="setFSens(null)">filtre : '+SENS_LIB[state.fSens]+' ✕</a>');
  majInfoSoldes(sums.dmin,sums.dmax);
  const foot=document.getElementById('reg-sums');
  if(foot)foot.innerHTML=
    '<span class="lb">Total négatif (hors virements) <span class="voircat'+(state.fSens==='debit'?' on':'')+'" title="Afficher uniquement ces opérations (re-cliquer pour tout réafficher)" onclick="setFSens(&#39;debit&#39;)">🔍</span></span><span class="vl num '+clsSigne(-sums.deb)+'">'+eur(-sums.deb)+'</span>'+
    '<span class="lb">Total positif (hors virements) <span class="voircat'+(state.fSens==='credit'?' on':'')+'" title="Afficher uniquement ces opérations (re-cliquer pour tout réafficher)" onclick="setFSens(&#39;credit&#39;)">🔍</span></span><span class="vl num '+clsSigne(sums.cre)+'">'+eur(sums.cre)+'</span>'+
    '<span class="lb">Total des virements <span class="voircat'+(state.fSens==='virement'?' on':'')+'" title="Afficher uniquement ces opérations (re-cliquer pour tout réafficher)" onclick="setFSens(&#39;virement&#39;)">🔍</span></span><span class="vl num '+clsSigne(sums.vir)+'">'+eur(sums.vir)+'</span>'+
    '<span class="lb tot">Total net</span><span class="vl num tot '+clsSigne(net)+'">'+eur(net)+'</span>';
  appliquerLargeurs();syncScrollX();appliquerHauteurRegistre();
  document.getElementById('legend').innerHTML=Object.keys(META).map(s=>
    '<span><span class="dot" style="background:'+META[s].col+'"></span>'+META[s].label+'</span>').join('');
  document.getElementById('pager').innerHTML=pages>1?
    ('<button onclick="goPage(1)" '+(state.page===1?'disabled':'')+'>«</button>'+
     '<button onclick="goPage('+(state.page-1)+')" '+(state.page===1?'disabled':'')+'>‹</button>'+
     '<span>page</span><input type="number" min="1" max="'+pages+'" value="'+state.page+'" '+
       'onkeydown="if(event.key===\'Enter\'){goPage(+this.value)}" onchange="goPage(+this.value)">'+
     '<span>/ '+pages+'</span>'+
     '<button onclick="goPage('+(state.page+1)+')" '+(state.page===pages?'disabled':'')+'>›</button>'+
     '<button onclick="goPage('+pages+')" '+(state.page===pages?'disabled':'')+'>»</button>'):'';
}

/* ---------- pointage manuel ---------- */
function togglePointe(id,ev){
  if(ev)ev.stopPropagation();
  const o=qy('SELECT statut,previsionnel FROM operation WHERE id=?',[id])[0];
  if(!o)return;
  // une opération prévisionnelle qu'on vient de confirmer garde 3 états tant qu'on reste dessus :
  // prévisionnelle → non pointée → pointée → prévisionnelle… Toucher une autre opération (ou en ouvrir une autre) l'oublie.
  if(state.exPrev!==id)state.exPrev=null;
  if(o.previsionnel){
    run('UPDATE operation SET previsionnel=0,date_modification=? WHERE id=?',[nowTS(),id]);
    touch('Confirmation',libOp(id));state.exPrev=id;
    toast('Opération confirmée : elle compte maintenant dans ton solde. Touche encore pour la pointer.');
    majApresStatut(id);return;
  }
  if(o.statut==='rapproche'){toast('Opération déjà rapprochée (verrouillée)');return;}
  if(o.statut==='annule'){toast('Opération annulée');return;}
  if(o.statut==='pointe'&&state.exPrev===id){
    run("UPDATE operation SET statut='non_pointe',previsionnel=1,date_modification=? WHERE id=?",[nowTS(),id]);
    touch('Retour en prévisionnel',libOp(id));toast('Opération de nouveau prévisionnelle');majApresStatut(id);return;
  }
  const nv=o.statut==='pointe'?'non_pointe':'pointe';
  run('UPDATE operation SET statut=?,date_modification=? WHERE id=?',[nv,nowTS(),id]);
  touch(nv==='pointe'?'Pointage':'Dépointage',libOp(id));majApresStatut(id);
}
function majApresStatut(id){renderRegistre();if(ficheId===id&&!document.getElementById('m-fiche').hidden)ouvrirFiche(id);}
async function ouvrirRapprochement(){
  const r=qy(`SELECT COUNT(*) n,COALESCE(SUM(montant),0) s FROM operation
    WHERE compte_id=? AND supprime=0 AND statut='pointe' AND previsionnel=0`,[state.acc])[0];
  if(!r.n){await dlgAlert('Aucune opération pointée sur ce compte.\n\nPointe d’abord les lignes présentes sur ton relevé en cliquant leur barre de statut à gauche.','Rapprochement');return;}
  const rap=scal(`SELECT (SELECT solde_initial FROM compte WHERE id=$a)+COALESCE(SUM(montant),0)
    FROM operation WHERE compte_id=$a AND supprime=0 AND statut='rapproche'`,{$a:state.acc});
  const ok=await dlgConfirm(
    r.n+' opération'+(r.n>1?'s':'')+' pointée'+(r.n>1?'s':'')+' pour un total de '+eur(r.s)+'.\n\n'+
    'Solde rapproché actuel : '+eur(rap)+'\nAprès rapprochement : '+eur(rap+r.s)+'\n\n'+
    'Les opérations rapprochées seront verrouillées (plus modifiables ni supprimables).','Valider le rapprochement','Rapprocher');
  if(!ok)return;
  const nomC=scal('SELECT nom FROM compte WHERE id=?',[state.acc]);
  run(`UPDATE operation SET statut='rapproche',date_modification=? WHERE compte_id=? AND supprime=0 AND statut='pointe' AND previsionnel=0`,[nowTS(),state.acc]);
  touch('Rapprochement',r.n+' opérations · '+eur(r.s)+' · '+nomC);render();toast(r.n+' opération'+(r.n>1?'s':'')+' rapprochée'+(r.n>1?'s':''));
}

/* ============================================================
   Corbeille
   ============================================================ */
function renderCorbeille(){
  const rows=qy(`SELECT o.id,o.date_operation d,o.montant m,o.numero num,o.cat_path cat,o.commentaire comm,
      o.date_suppression ds,t.nom dest,c.nom cpt
    FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id LEFT JOIN compte c ON c.id=o.compte_id
    WHERE o.supprime=1 ORDER BY o.date_suppression DESC`);
  document.getElementById('tr-meta').textContent=rows.length?
    (rows.length+' opération'+(rows.length>1?'s':'')+' en corbeille — restaurables tant que tu ne vides pas'):'La corbeille est vide';
  if(document.body.classList.contains('mobile')){
    const jour=d=>d?(+d.slice(8,10))+' '+MOIS_COURT[+d.slice(5,7)-1]+' '+d.slice(0,4):'';
    document.getElementById('m-corbeille').innerHTML=
      '<p class="me-aide">Rien n’est supprimé tout seul : les opérations restent ici tant que tu ne vides pas la corbeille.</p>'+
      (rows.length?'<div class="me-liste">'+rows.map(o=>'<div class="mg-ligne">'+
        '<span class="me-nom">'+esc(o.dest||'(sans destinataire)')+'<small>Supprimée le '+jour((o.ds||'').slice(0,10))+' · '+esc(o.cpt||'')+' · opération du '+isoToFr(o.d)+'</small></span>'+
        '<span class="num" style="color:'+(o.m<0?'var(--ink)':'var(--credit)')+'">'+eur(o.m)+'</span>'+
        // Restaurer et la poubelle l'un sous l'autre : la colonne du nom garde de la place
        '<span class="mg-actions"><button class="mg-restaurer" onclick="restaurer('+o.id+')">Restaurer</button>'+
        '<button class="ghost mg-icone" aria-label="Supprimer définitivement" onclick="supprDef('+o.id+')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></span></div>').join('')+'</div>'+
        '<div class="mg-pied"><button class="danger" onclick="viderCorbeille()">Vider la corbeille</button></div>'
      :'<div class="m-vide">La corbeille est vide.</div>');
    return;
  }
  document.getElementById('tr-head').innerHTML=['Supprimée le','Compte','Date','Destinataire','Montant','']
    .map((h,i)=>'<th class="fix'+(i===4?' r':'')+'">'+h+'</th>').join('');
  document.getElementById('tr-rows').innerHTML=rows.map(o=>'<tr>'+
    '<td class="num">'+esc((o.ds||'').slice(0,10).split('-').reverse().join('/'))+'</td>'+
    '<td>'+esc(o.cpt||'')+'</td><td class="num">'+isoToFr(o.d)+'</td>'+
    '<td>'+esc(o.dest||'')+'<div class="cat" style="font-size:.76rem;color:var(--ink-3)">'+esc(o.cat||'')+'</div></td>'+
    '<td class="r num" style="color:'+(o.m<0?'var(--debit)':'var(--credit)')+'">'+eur(o.m)+'</td>'+
    '<td class="r"><button onclick="restaurer('+o.id+')">Restaurer</button> '+
      '<button class="danger" onclick="supprDef('+o.id+')">Supprimer</button></td></tr>').join('');
}
function restaurer(id){const l=libOp(id);
  run('UPDATE operation SET supprime=0,date_suppression=NULL,date_modification=? WHERE id=?',[nowTS(),id]);
  run(`UPDATE operation SET miroir_id=$i WHERE id=(SELECT miroir_id FROM operation WHERE id=$i)
    AND miroir_id IS NULL AND supprime=0`,{$i:id});
  touch('Restauration depuis la corbeille',l);render();toast('Opération restaurée');}
async function supprDef(id){
  const o=qy('SELECT o.montant m,t.nom dest FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id WHERE o.id=?',[id])[0];
  const ok=await dlgConfirm('Supprimer définitivement « '+(o.dest||'')+' » ('+eur(o.m)+') ?\n\nCette action est irréversible.','Suppression définitive','Supprimer',true);
  if(!ok)return;
  const l=libOp(id);
  run('DELETE FROM ventilation WHERE operation_id=?',[id]);run('DELETE FROM operation WHERE id=?',[id]);
  touch('Suppression définitive',l);render();toast('Opération supprimée définitivement');
}
async function viderCorbeille(){
  const n=scal('SELECT COUNT(*) FROM operation WHERE supprime=1');
  if(!n){await dlgAlert('La corbeille est déjà vide.');return;}
  const ok=await dlgConfirm('Supprimer définitivement les '+n+' opérations de la corbeille ?\n\nCette action est irréversible.','Vider la corbeille','Tout supprimer',true);
  if(!ok)return;
  run('DELETE FROM ventilation WHERE operation_id IN (SELECT id FROM operation WHERE supprime=1)');
  run('DELETE FROM operation WHERE supprime=1');
  touch('Corbeille vidée',n+' opération'+(n>1?'s':'')+' définitivement supprimée'+(n>1?'s':''));render();toast('Corbeille vidée');
}

/* ============================================================
   Tiers / Catégories
   ============================================================ */
function setTiSort(k){if(state.tiSort===k)state.tiDir*=-1;else{state.tiSort=k;state.tiDir=(k==='n'||k==='last'||k==='first')?-1:1;}renderTiers();}
function renderTiers(){
  const rows=qy(`SELECT t.nom dest,MIN(o.date_operation) first,MAX(o.date_operation) last,COUNT(o.id) n,
      (SELECT o2.cat_path FROM operation o2 WHERE o2.tiers_id=t.id AND o2.supprime=0 ORDER BY o2.date_operation DESC,o2.id DESC LIMIT 1) cat
    FROM tiers t LEFT JOIN operation o ON o.tiers_id=t.id AND o.supprime=0
    GROUP BY t.id ORDER BY last DESC`);
  const q=((document.getElementById('ti-search')||{}).value||'').trim().toLowerCase();
  const rowsF=q?rows.filter(r=>(r.dest||'').toLowerCase().includes(q)||(r.cat||'').toLowerCase().includes(q)):rows;
  const k=state.tiSort,dir=state.tiDir;
  rowsF.sort((x,y)=>{let vx=x[k],vy=y[k];if(vx==null)vx='';if(vy==null)vy='';
    if(typeof vx==='string'){vx=vx.toLowerCase();vy=String(vy).toLowerCase();}return vx<vy?-dir:vx>vy?dir:0;});
  document.getElementById('ti-meta').textContent=rows.length+' destinataires enregistrés';
  if(document.body.classList.contains('mobile')){renderTiersMobile(rowsF);return;}
  const cols=[['Destinataire','dest'],['Catégorie habituelle','cat'],['Ajouté le','first'],['Dernier paiement','last'],['Opér.','n']];
  document.getElementById('ti-head').innerHTML=cols.map(c=>{const r=c[1]==='n'?' class="r"':'';
    const arr=state.tiSort===c[1]?(state.tiDir===1?' ↑':' ↓'):'';
    return '<th'+r+' onclick="setTiSort(\''+c[1]+'\')">'+c[0]+arr+'</th>';}).join('')+'<th></th>';
  document.getElementById('ti-rows').innerHTML=rowsF.map(t=>'<tr>'+
    '<td>'+esc(t.dest)+'</td><td style="color:var(--ink-2)">'+esc(t.cat||'')+'</td>'+
    '<td class="num">'+(t.first?isoToFr(t.first):'—')+'</td>'+
    '<td class="num">'+(t.last?isoToFr(t.last):'—')+'</td>'+
    '<td class="r num">'+t.n+'</td><td class="r"><button class="ghost" style="padding:2px 8px;font-size:.75rem" onclick="modifierTiers('+esc(JSON.stringify(t.dest))+')">Renommer / fusionner</button></td></tr>').join('');
}
/* Tiers sur téléphone : une ligne par destinataire (initiale, nombre d'opérations, catégorie habituelle, total),
   tri « les plus utilisés » / A → Z / montant total ; toucher → ses opérations */
const TRIS_TIERS=[['n','Plus utilisés'],['az','A → Z'],['total','Montant le plus élevé']];
function trierTiersMobile(rows,tri){
  const r=rows.slice();
  if(tri==='az')r.sort((a,b)=>(a.dest||'').localeCompare(b.dest||'','fr'));
  else if(tri==='total')r.sort((a,b)=>Math.abs(b.total||0)-Math.abs(a.total||0));
  else r.sort((a,b)=>(b.n-a.n)||(a.dest||'').localeCompare(b.dest||'','fr'));
  return r;
}
function renderTiersMobile(rows){
  const tot={};qy('SELECT tiers_id t,SUM(montant) s FROM operation WHERE supprime=0 AND statut<>\'annule\' GROUP BY tiers_id').forEach(x=>tot[x.t]=x.s);
  const ids={};qy('SELECT id,nom FROM tiers').forEach(t=>ids[t.nom]=t.id);
  rows.forEach(r=>r.total=tot[ids[r.dest]]||0);
  const tri=state.tiMTri||'n',liste=trierTiersMobile(rows,tri);
  document.getElementById('m-tiers').innerHTML=
    '<div class="ma-puces mg-tris">'+TRIS_TIERS.map(([k,t])=>'<button aria-pressed="'+(k===tri)+'" onclick="state.tiMTri=\''+k+'\';renderTiers()">'+t+'</button>').join('')+'</div>'+
    // ni lettre ni « ⋯ » : toute la largeur pour le nom et le montant ; appui long → Renommer / Fusionner
    (liste.length?'<div class="me-liste">'+liste.map(t=>'<div class="mg-tiers"><button class="me-item" data-nom="'+esc(t.dest)+'" onclick="voirTiers('+esc(JSON.stringify(t.dest))+')">'+
      '<span class="me-nom">'+esc(t.dest)+'<small>'+t.n+' op.'+(t.cat?' · '+esc(t.cat):'')+'</small></span>'+
      '<span class="num" style="color:'+(t.total<0?'var(--ink)':'var(--credit)')+'">'+(t.total>0?'+':'')+eur(t.total)+'</span></button></div>').join('')+'</div>'
      :'<div class="m-vide">Aucun destinataire ne correspond.</div>')+
    '<p class="me-aide" style="margin-top:12px">Touche un destinataire pour voir ses opérations ; appui long pour le renommer ou le fusionner avec un doublon.</p>';
  document.querySelectorAll('#m-tiers .me-item[data-nom]').forEach(b=>appuiLong(b,()=>menuTiers(b.dataset.nom)));
}
// un destinataire -> registre filtré par la recherche sur son nom
function voirTiers(nom){
  state.fCat=null;state.fSens=null;setStatutsTous();
  const s=document.getElementById('f-search');if(s)s.value=nom;syncClear();
  setView('registre');goPage(1);
}
function cheminCategorie(id){
  const by={};qy('SELECT id,libelle,parent_id FROM categorie').forEach(c=>by[c.id]=c);
  const parts=[];let x=id;while(x!=null){const z=by[x];if(!z)break;parts.unshift(z.libelle);x=z.parent_id;}
  return parts.join(' : ');
}
/* ---------- renommer / fusionner des tiers et des catégories ----------
   Tout ce qui garde le nom en texte suit : chemin de catégorie des opérations (cat_path), texte de recherche
   (hay), échéances. Donner à un tiers (ou à une catégorie, au même niveau) le nom d'un autre = les fusionner. */
function descendantsCategorie(id){
  const tous=qy('SELECT id,parent_id FROM categorie'),ids=[id];
  for(let i=0;i<ids.length;i++)tous.forEach(c=>{if(c.parent_id===ids[i])ids.push(c.id);});
  return ids;
}
function profondeurCategorie(id){let n=0,x=id;while(x!=null&&n<10){n++;x=scal('SELECT parent_id FROM categorie WHERE id=?',[x]);}return n;}
function hauteurCategorie(id){const k=qy('SELECT id FROM categorie WHERE parent_id=?',[id]);return 1+(k.length?Math.max(...k.map(c=>hauteurCategorie(c.id))):0);}
// chemin de catégorie et texte de recherche de ces opérations, d'après leurs lignes de ventilation
function recalculerCatEtHay(ids){
  const path=_catPathFn();
  [...new Set(ids)].forEach(id=>{
    const o=qy('SELECT o.*,t.nom dest FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id WHERE o.id=?',[id])[0];if(!o)return;
    const v=qy('SELECT categorie_id c FROM ventilation WHERE operation_id=? ORDER BY id',[id]).map(r=>path(r.c));
    let cat=o.cat_path,catHay=o.cat_path;
    if(v.length===1){cat=v[0];catHay=cat;}
    else if(v.length>1){const tetes=[...new Set(v.map(c=>catParts(c)[0]))];
      cat=tetes.slice(0,2).join(' + ')+(tetes.length>2?' + …':'');catHay=v.join(' ')+' '+cat;}
    run('UPDATE operation SET cat_path=?,hay=? WHERE id=?',[cat,makeHay(o.dest,catHay,o.numero,o.commentaire,o.montant,o.date_operation),id]);
  });
}
// un chemin qui change (« A : B » → « A : C ») : échéances et opérations sans ventilation (anciennes données)
function remplacerCheminCategorie(ancien,nouveau){
  const a=catParts(ancien),b=catParts(nouveau);
  const conv=c=>{const p=catParts(c);if(p.length<a.length||a.some((x,i)=>p[i]!==x))return null;return b.concat(p.slice(a.length)).join(' : ');};
  qy('SELECT id,cat_path FROM recurrence').forEach(r=>{const n=conv(r.cat_path);if(n!=null)run('UPDATE recurrence SET cat_path=? WHERE id=?',[n,r.id]);});
  const ops=qy('SELECT id,cat_path FROM operation o WHERE NOT EXISTS (SELECT 1 FROM ventilation v WHERE v.operation_id=o.id)').filter(o=>conv(o.cat_path)!=null);
  ops.forEach(o=>run('UPDATE operation SET cat_path=? WHERE id=?',[conv(o.cat_path),o.id]));
  recalculerCatEtHay(ops.map(o=>o.id));
}
function opsDesCategories(ids){return ids.length?qy('SELECT DISTINCT operation_id id FROM ventilation WHERE categorie_id IN ('+ids.map(Number).join(',')+')').map(r=>r.id):[];}
function fusionnerTiersDb(src,dst){
  const a=qy('SELECT * FROM tiers WHERE id=?',[src])[0],b=qy('SELECT * FROM tiers WHERE id=?',[dst])[0];
  if(!a||!b||src===dst)throw new Error('destinataire introuvable');
  const n=scal('SELECT COUNT(*) FROM operation WHERE tiers_id=?',[src]);
  run('UPDATE operation SET tiers_id=? WHERE tiers_id=?',[dst,src]);
  run(`UPDATE tiers SET date_creation=MIN(date_creation,?),date_dernier_paiement=NULLIF(MAX(COALESCE(date_dernier_paiement,''),?),''),
    categorie_defaut_id=COALESCE(categorie_defaut_id,?) WHERE id=?`,[a.date_creation,a.date_dernier_paiement||'',a.categorie_defaut_id,dst]);
  run('UPDATE recurrence SET tiers=? WHERE tiers=?',[b.nom,a.nom]);
  run('DELETE FROM tiers WHERE id=?',[src]);
  recalculerCatEtHay(qy('SELECT id FROM operation WHERE tiers_id=?',[dst]).map(r=>r.id));invalidateCaches();
  return {action:'fusionne',nom:b.nom,n};
}
function renommerTiersDb(id,nom){
  nom=(nom||'').trim();const a=qy('SELECT * FROM tiers WHERE id=?',[id])[0];
  if(!a||!nom||nom===a.nom)return null;
  const b=scal('SELECT id FROM tiers WHERE nom=? AND id<>?',[nom,id]);
  if(b)return fusionnerTiersDb(id,b);
  run('UPDATE tiers SET nom=? WHERE id=?',[nom,id]);run('UPDATE recurrence SET tiers=? WHERE tiers=?',[nom,a.nom]);
  recalculerCatEtHay(qy('SELECT id FROM operation WHERE tiers_id=?',[id]).map(r=>r.id));invalidateCaches();
  return {action:'renomme',nom};
}
/* fusion de deux catégories du même niveau (deux principales, ou deux sous-catégories d'une même catégorie) :
   les opérations de src passent dans dst, ses sous-catégories s'ajoutent à celles de dst, au même niveau (celles
   au nom identique fusionnent à leur tour) ; nom : le nom gardé (celui de dst par défaut) */
function fusionnerCategoriesDb(src,dst,nom){
  if(src===dst||descendantsCategorie(src).indexOf(dst)>=0)throw new Error('une catégorie ne peut pas être fusionnée avec une de ses sous-catégories');
  const ps=scal('SELECT parent_id FROM categorie WHERE id=?',[src]),pd=scal('SELECT parent_id FROM categorie WHERE id=?',[dst]);
  if(ps!==pd)throw new Error('on ne fusionne qu’avec une catégorie du même niveau');
  const ancien=cheminCategorie(src),nouveau=cheminCategorie(dst),n=opsDesCategories(descendantsCategorie(src)).length;
  const fusion=(s,d)=>{
    qy('SELECT id,libelle FROM categorie WHERE parent_id=?',[s]).forEach(k=>{
      const meme=scal('SELECT id FROM categorie WHERE parent_id=? AND libelle=?',[d,k.libelle]);
      if(meme)fusion(k.id,meme);else run('UPDATE categorie SET parent_id=? WHERE id=?',[d,k.id]);});
    run('UPDATE ventilation SET categorie_id=? WHERE categorie_id=?',[d,s]);
    run('UPDATE tiers SET categorie_defaut_id=? WHERE categorie_defaut_id=?',[d,s]);
    run('DELETE FROM categorie WHERE id=?',[s]);
  };
  fusion(src,dst);
  remplacerCheminCategorie(ancien,nouveau);
  recalculerCatEtHay(opsDesCategories(descendantsCategorie(dst)));invalidateCaches();
  nom=(nom||'').trim();
  if(nom&&nom!==scal('SELECT libelle FROM categorie WHERE id=?',[dst]))renommerCategorieDb(dst,nom); // l'autre nom gardé
  return {action:'fusionne',chemin:cheminCategorie(dst),n};
}
function renommerCategorieDb(id,lib){
  lib=(lib||'').trim();const c=qy('SELECT * FROM categorie WHERE id=?',[id])[0];
  if(!c||!lib||lib===c.libelle)return null;
  if(lib.indexOf(':')>=0||lib.indexOf('+')>=0)throw new Error('le nom ne peut pas contenir « : » ni « + »');
  const frere=scal('SELECT id FROM categorie WHERE parent_id IS ? AND libelle=? AND id<>?',[c.parent_id,lib,id]);
  if(frere)return fusionnerCategoriesDb(id,frere);
  const ancien=cheminCategorie(id);
  run('UPDATE categorie SET libelle=? WHERE id=?',[lib,id]);
  remplacerCheminCategorie(ancien,cheminCategorie(id));
  recalculerCatEtHay(opsDesCategories(descendantsCategorie(id)));invalidateCaches();
  return {action:'renomme',chemin:cheminCategorie(id)};
}
/* fenêtres : un champ pour renommer, une liste pour fusionner avec un autre */
/* téléphone : appui long sur un destinataire → menu Renommer / Fusionner */
async function menuTiers(nom){
  const v=await dlgOpen({title:nom,msg:'',fermeDehors:true,buttons:[{t:'Fusionner…',v:'fus'},{t:'Renommer…',v:'ren',p:true}]});
  if(v==='ren')modifierTiers(nom,'renommer');else if(v==='fus')modifierTiers(nom,'fusionner');
}
// mode : 'renommer' ou 'fusionner' (menu du téléphone), sinon les deux dans la même fenêtre (PC)
async function modifierTiers(nom,mode){
  const t=qy('SELECT id,nom FROM tiers WHERE nom=?',[nom])[0];if(!t)return;
  const n=scal('SELECT COUNT(*) FROM operation WHERE tiers_id=? AND supprime=0',[t.id]);
  const autres=qy('SELECT id,nom FROM tiers WHERE id<>? ORDER BY nom COLLATE NOCASE',[t.id]);
  const html=(mode!=='fusionner'?'<div class="field"><label>Nouveau nom</label><input id="mt-nom" value="'+esc(t.nom)+'" autocomplete="off"></div>':'')+
    (mode!=='renommer'?'<div class="field"><label>'+(mode?'Fusionner avec':'Ou fusionner avec')+'</label><select id="mt-avec"><option value="">'+(mode?'— choisir un destinataire —':'— garder séparé —')+'</option>'+
    autres.map(a=>'<option value="'+a.id+'">'+esc(a.nom)+'</option>').join('')+'</select></div>'+
    '<div class="meta">Fusionner : '+(n>1?'ses '+n+' opérations passent':'son opération passe')+' sous l’autre nom (pratique pour un doublon).</div>':'');
  let avec=0,nv='';const lire=()=>{const a=document.getElementById('mt-avec'),m=document.getElementById('mt-nom');avec=a?+a.value||0:0;nv=m?m.value:t.nom;}; // avant que la fenêtre se vide
  const titre=mode==='renommer'?'Renommer « '+t.nom+' »':mode==='fusionner'?'Fusionner « '+t.nom+' »':'Renommer ou fusionner « '+t.nom+' »';
  const v=await dlgOpen({title:titre,msg:'',html,fermeDehors:true,buttons:[{t:'Annuler',v:false},{t:mode==='fusionner'?'Fusionner':'Enregistrer',v:'ok',p:true,before:lire}]});
  if(v!=='ok')return;
  try{
    let r;
    if(avec){const b=autres.find(a=>a.id===avec);
      if(!await dlgConfirm('Fusionner « '+t.nom+' » avec « '+b.nom+' » ?\n\n'+(n>1?'Ses '+n+' opérations passeront':'Son opération passera')+' sous « '+b.nom+' ».','Fusionner','Fusionner'))return;
      r=fusionnerTiersDb(t.id,avec);}
    else r=renommerTiersDb(t.id,nv);
    if(!r)return;
    touch(r.action==='fusionne'?'Tiers fusionnés':'Tiers renommé',t.nom+' → '+r.nom);render();
    toast(r.action==='fusionne'?'« '+t.nom+' » fusionné avec « '+r.nom+' »':'Renommé en « '+r.nom+' »');
  }catch(e){dlgAlert('Impossible : '+(e.message||e),'Tiers');}
}
// fusion : le nom proposé devient celui de la catégorie choisie ; on peut reprendre l'ancien d'un toucher
function mcAvecChange(sel){
  const o=sel.selectedOptions[0],m=document.getElementById('mc-nom'),n=document.getElementById('mc-noms');if(!m)return;
  const lib=o&&o.dataset.lib;m.value=lib||state.mcLib;
  document.getElementById('mc-nom-l').textContent=lib?'Nom après la fusion':'Nouveau nom';
  if(n)n.innerHTML=lib&&lib!==state.mcLib?'Garder plutôt : <button type="button" class="ghost mc-nom-choix" onclick="document.getElementById(&#39;mc-nom&#39;).value=this.textContent">'+esc(state.mcLib)+'</button>':'';
}
/* téléphone : appui long sur une catégorie → menu Renommer / Fusionner (et Supprimer si elle est vide) */
async function menuCategorie(id){
  const chemin=cheminCategorie(id);if(!chemin)return;
  const ids=descendantsCategorie(id);
  const nb=scal('SELECT COUNT(*) FROM ventilation v JOIN operation o ON o.id=v.operation_id WHERE o.supprime=0 AND v.categorie_id IN ('+ids.map(()=>'?').join(',')+')',ids)||0;
  const v=await dlgOpen({title:chemin,msg:'',fermeDehors:true,buttons:(nb?[]:[{t:'Supprimer',v:'suppr',d:true}]).concat([
    {t:'Fusionner…',v:'fus'},{t:'Renommer…',v:'ren',p:true}])});
  if(v==='ren')modifierCategorie(id,'renommer');else if(v==='fus')modifierCategorie(id,'fusionner');else if(v==='suppr')supprCategorie(id);
}
// mode : 'renommer' ou 'fusionner' (menu du téléphone), sinon les deux dans la même fenêtre (PC)
async function modifierCategorie(id,mode){
  const chemin=cheminCategorie(id);if(!chemin)return;
  const c=qy('SELECT * FROM categorie WHERE id=?',[id])[0],exclus=descendantsCategorie(id),haut=hauteurCategorie(id);
  // fusion : seulement avec une catégorie du même niveau (principale avec principale, sous-catégorie avec une autre de la même catégorie)
  const cibles=qy('SELECT id,libelle FROM categorie WHERE parent_id IS ? AND id<>? ORDER BY libelle COLLATE NOCASE',[c.parent_id,id])
    .map(x=>({id:x.id,lib:x.libelle,p:cheminCategorie(x.id)}));
  const n=opsDesCategories(exclus).length;
  // en choisissant la catégorie, le nom proposé devient le sien ; on peut garder l'autre ou en écrire un nouveau
  const html=(mode!=='renommer'?'<div class="field"><label>'+(mode?'Fusionner avec':'Ou fusionner avec')+'</label><select id="mc-avec" onchange="mcAvecChange(this)"><option value="">'+(mode?'— choisir une catégorie —':'— garder séparée —')+'</option>'+
      cibles.map(x=>'<option value="'+x.id+'" data-lib="'+esc(x.lib)+'">'+esc(x.lib)+'</option>').join('')+'</select></div>':'')+
    '<div class="field"><label id="mc-nom-l">'+(mode==='fusionner'?'Nom après la fusion':'Nouveau nom')+'</label><input id="mc-nom" value="'+esc(c.libelle)+'" autocomplete="off"></div>'+
    (mode!=='renommer'?'<div class="meta" id="mc-noms"></div>'+
      '<div class="meta">Fusionner : '+(n>1?'ses '+n+' opérations':n?'son opération':'elle')+(haut>1?' et ses sous-catégories':'')+
      (n>1||haut>1?' rejoignent':' rejoint')+' l’autre catégorie'+(haut>1?' ; les sous-catégories restent au même niveau, celles au nom identique fusionnent':'')+'.</div>'+
      (cibles.length?'':'<div class="meta">Aucune autre catégorie à ce niveau'+(c.parent_id!=null?' dans « '+esc(cheminCategorie(c.parent_id))+' »':'')+'.</div>'):'');
  let avec=0,nv='';const lire=()=>{const a=document.getElementById('mc-avec'),m=document.getElementById('mc-nom');avec=a?+a.value||0:0;nv=m?m.value:c.libelle;};
  state.mcLib=c.libelle;
  const titre=mode==='renommer'?'Renommer « '+chemin+' »':mode==='fusionner'?'Fusionner « '+chemin+' »':'Renommer ou fusionner « '+chemin+' »';
  const v=await dlgOpen({title:titre,msg:'',html,fermeDehors:true,buttons:[{t:'Annuler',v:false},{t:mode==='fusionner'?'Fusionner':'Enregistrer',v:'ok',p:true,before:lire}]});
  if(v!=='ok')return;
  try{
    let r;
    if(avec){const b=cibles.find(x=>x.id===avec),nom=(nv||'').trim()||b.lib;
      if(!await dlgConfirm('Fusionner « '+chemin+' » avec « '+b.p+' » ?\n\n'+(n>1?'Ses '+n+' opérations passeront':n?'Son opération passera':'Elle sera rangée')+
        ' dans « '+b.p+' »'+(nom!==b.lib?', qui s’appellera « '+nom+' »':'')+'.','Fusionner','Fusionner'))return;
      r=fusionnerCategoriesDb(id,avec,nom);}
    else r=renommerCategorieDb(id,nv);
    if(!r)return;
    touch(r.action==='fusionne'?'Catégories fusionnées':'Catégorie renommée',chemin+' → '+r.chemin);render();
    toast(r.action==='fusionne'?'Fusionnée avec « '+r.chemin+' »':'Renommée en « '+r.chemin+' »');
  }catch(e){dlgAlert('Impossible : '+(e.message||e),'Catégorie');}
}
// id d'une catégorie d'après son chemin complet, sans rien créer
function upsertCategorieLecture(chemin){let parent=null;
  for(const p of catParts(chemin)){parent=scal('SELECT id FROM categorie WHERE libelle=? AND parent_id IS ?',[p,parent]);if(!parent)return null;}
  return parent;}
/* clique une catégorie -> registre filtré sur son chemin */
function voirCategorieChemin(chemin){
  if(!chemin)return;
  const s=document.getElementById('f-search');if(s)s.value='';
  state.fCat=chemin;state.fSens=null;syncClear();
  setStatutsTous();
  setView('registre');goPage(1);
  toast('Opérations de « '+chemin+' »');
}
function voirCategorie(id){voirCategorieChemin(cheminCategorie(id));}
async function supprCategorie(id){
  // refuser s'il reste des opérations rattachées (ici ou dans les sous-catégories)
  const ids=[id];const tous=qy('SELECT id,parent_id FROM categorie');
  let chg=true;while(chg){chg=false;tous.forEach(c=>{if(c.parent_id!=null&&ids.includes(c.parent_id)&&!ids.includes(c.id)){ids.push(c.id);chg=true;}});}
  const marks=ids.map(()=>'?').join(',');
  const nb=scal('SELECT COUNT(*) FROM ventilation WHERE categorie_id IN('+marks+')',ids)||0;
  if(nb>0){await dlgAlert('Cette catégorie (ou une de ses sous-catégories) contient encore '+nb+' opération(s). Impossible de la supprimer.','Suppression impossible');return;}
  if(!await dlgConfirm('Supprimer cette catégorie'+(ids.length>1?' et ses '+(ids.length-1)+' sous-catégorie(s)':'')+' ?','Supprimer la catégorie','Supprimer',true))return;
  run('DELETE FROM categorie WHERE id IN('+marks+')',ids);
  touch('Catégorie supprimée',cheminCategorie(id)||'');render();
}
function renderCategories(){
  const cats=qy('SELECT id,libelle,parent_id FROM categorie');
  const cnt={};qy(`SELECT v.categorie_id c,COUNT(*) n FROM ventilation v JOIN operation o ON o.id=v.operation_id
    WHERE o.supprime=0 GROUP BY v.categorie_id`).forEach(r=>cnt[r.c]=r.n);
  const kids={};cats.forEach(c=>{(kids[c.parent_id==null?0:c.parent_id]=kids[c.parent_id==null?0:c.parent_id]||[]).push(c);});
  const tot={};
  function totOf(id){if(tot[id]!=null)return tot[id];let n=cnt[id]||0;(kids[id]||[]).forEach(k=>n+=totOf(k.id));return tot[id]=n;}
  // montant total de la catégorie et de ses sous-catégories (opérations effectives : ni annulées, ni prévisionnelles)
  const som={};qy(`SELECT v.categorie_id c,SUM(v.montant) s FROM ventilation v JOIN operation o ON o.id=v.operation_id
    WHERE o.supprime=0 AND o.statut<>'annule' AND o.previsionnel=0 GROUP BY v.categorie_id`).forEach(r=>som[r.c]=r.s);
  const sTot={};
  function sumOf(id){if(sTot[id]!=null)return sTot[id];let s=som[id]||0;(kids[id]||[]).forEach(k=>s+=sumOf(k.id));return sTot[id]=s;}
  function cheminDe(id){const parts=[];let x=id;const by={};cats.forEach(z=>by[z.id]=z);
    while(x!=null){const z=by[x];if(!z)break;parts.unshift(z.libelle);x=z.parent_id;}return parts.join(' : ');}
  if(document.body.classList.contains('mobile')){renderCategoriesMobile(cats,kids,totOf,sumOf);
    if(!document.getElementById('m-catana').hidden)renderAnalyseCategorie();return;}
  function renderNode(c,depth){const t=totOf(c.id);
    return '<div class="tnode d'+(depth+1)+'" style="padding-left:'+(depth*22)+'px">'+
      '<span class="tname" style="cursor:pointer" title="Voir les opérations" onclick="voirCategorie('+c.id+')">'+esc(c.libelle)+'</span>'+
      '<span class="tcount">'+t+'</span>'+(t?' <span class="tsomme num '+clsSigne(sumOf(c.id))+'">'+eurSigne(sumOf(c.id))+'</span>':'')+
      ' <button class="ghost" style="padding:2px 8px;font-size:.75rem" onclick="modifierCategorie('+c.id+')">Renommer / fusionner</button>'+
      (t===0?' <button class="ghost" style="padding:2px 8px;font-size:.75rem" onclick="supprCategorie('+c.id+')">Supprimer</button>':'')+
      '</div>';}
  function walk(pid,depth){const list=(kids[pid]||[]).slice().sort((a,b)=>a.libelle.localeCompare(b.libelle,'fr'));
    return list.map(c=>renderNode(c,depth)+walk(c.id,depth+1)).join('');}
  const q=((document.getElementById('cat-search')||{}).value||'').trim().toLowerCase();
  const vides=!!state.catVides;
  let html;
  if(q||vides){
    const critere=c=>(!q||c.libelle.toLowerCase().includes(q))&&(!vides||totOf(c.id)===0);
    const keepCache={};
    function keep(c){if(keepCache[c.id]!=null)return keepCache[c.id];
      let k=critere(c);if(!k)k=(kids[c.id]||[]).some(x=>keep(x));return keepCache[c.id]=k;}
    function walkF(pid,depth){
      const list=(kids[pid]||[]).filter(keep).sort((a,b)=>a.libelle.localeCompare(b.libelle,'fr'));
      return list.map(c=>renderNode(c,depth)+(critere(c)?walk(c.id,depth+1):walkF(c.id,depth+1))).join('');
    }
    html=walkF(0,0)||'<div style="color:var(--ink-3)">Aucune catégorie ne correspond.</div>';
  }else{
    html=walk(0,0)||'<div style="color:var(--ink-3)">Aucune catégorie pour l’instant.</div>';
  }
  document.getElementById('cat-tree').innerHTML=html;
}

/* Catégories sur téléphone : arbre qui se déplie (flèche), montant total et nombre d'opérations ;
   toucher le nom → son analyse (par mois / par année), d'où l'on va à ses opérations.
   Pendant une recherche (ou « vides seulement »), tout ce qui correspond est déplié. */
// fermees : catégories repliées à la main pendant une recherche (sinon tout ce qui correspond est déplié)
function lignesCategoriesMobile(kids,totOf,ouvertes,q,vides,fermees){
  const critere=c=>(!q||c.libelle.toLowerCase().includes(q))&&(!vides||totOf(c.id)===0);
  const garde={},keep=c=>garde[c.id]!=null?garde[c.id]:(garde[c.id]=critere(c)||(kids[c.id]||[]).some(keep));
  const filtre=!!(q||vides),out=[];
  (function walk(pid,depth,tout){
    (kids[pid]||[]).filter(c=>tout||!filtre||keep(c)).sort((a,b)=>a.libelle.localeCompare(b.libelle,'fr')).forEach(c=>{
      const enfants=(kids[c.id]||[]).length>0,ouverte=filtre?enfants&&!(fermees&&fermees.has(c.id)):ouvertes.has(c.id);
      out.push({c,depth,enfants,ouverte,n:totOf(c.id)});
      if(enfants&&ouverte)walk(c.id,depth+1,tout||(filtre&&critere(c)));
    });
  })(0,0,false);
  return out;
}
// la flèche replie ou déplie ; pendant une recherche (tout déplié d'office), elle replie aussi
function basculerCategorie(id){
  const q=((document.getElementById('cat-search')||{}).value||'').trim(),filtre=!!(q||state.catVides);
  const o=filtre?(state.catFermees||(state.catFermees=new Set())):(state.catOuvertes||(state.catOuvertes=new Set()));
  if(o.has(id))o.delete(id);else o.add(id);renderCategories();}
function renderCategoriesMobile(cats,kids,totOf,sumOf){
  const q=((document.getElementById('cat-search')||{}).value||'').trim().toLowerCase();
  // une autre recherche : ce qui avait été replié pendant la précédente se déplie de nouveau
  const filtre=q+'|'+!!state.catVides;if(state.catFiltre!==filtre){state.catFiltre=filtre;state.catFermees=new Set();}
  const L=lignesCategoriesMobile(kids,totOf,state.catOuvertes||new Set(),q,!!state.catVides,state.catFermees);
  const fleche=(o)=>'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="'+(o?'M6 9l6 6 6-6':'M9 6l6 6-6 6')+'"/></svg>';
  document.getElementById('m-categories').innerHTML=(L.length?'<div class="me-liste">'+L.map(l=>
    '<div class="mg-cat d'+l.depth+'" data-id="'+l.c.id+'" style="padding-left:'+(6+l.depth*22)+'px">'+
      (l.enfants?'<button class="ghost mg-icone" aria-expanded="'+l.ouverte+'" aria-label="'+(l.ouverte?'Replier ':'Déplier ')+esc(l.c.libelle)+'" onclick="basculerCategorie('+l.c.id+')">'+fleche(l.ouverte)+'</button>':'<span class="mg-icone"></span>')+
      '<button class="mg-nom" onclick="voirAnalyseCategorie('+l.c.id+')">'+esc(l.c.libelle)+'</button>'+
      (l.n===0?'<button class="ghost mg-suppr" onclick="supprCategorie('+l.c.id+')">Supprimer</button>'
        :'<span class="mg-nb"><b class="num '+clsSigne(sumOf(l.c.id))+'">'+eurSigne(sumOf(l.c.id))+'</b>'+l.n+' op.</span>')+
      '</div>').join('')+'</div>'
    :'<div class="m-vide">'+(q||state.catVides?'Aucune catégorie ne correspond.':'Aucune catégorie pour l’instant.')+'</div>')+
    '<p class="me-aide" style="margin-top:12px">Touche une catégorie pour son analyse par mois ou par année, et ses opérations ; la flèche montre ses sous-catégories ; appui long pour la renommer ou la fusionner.</p>';
  // appui long sur le nom : menu Renommer / Fusionner (le toucher simple ouvre toujours l'analyse)
  document.querySelectorAll('#m-categories .mg-cat').forEach(r=>{const b=r.querySelector('.mg-nom');if(b)appuiLong(b,()=>menuCategorie(+r.dataset.id));});
}

/* ---------- Analyse d'une catégorie (téléphone) ----------
   Tous les comptes, opérations effectives (ni annulées, ni prévisionnelles), sous-catégories comprises.
   Par mois : les 12 derniers mois ; par année : depuis la 1re opération (10 ans au plus). Toucher une barre
   choisit la période : son total, la moyenne des périodes passées, ses sous-catégories et ses opérations. */
const CA={pile:[],unite:'mois',sel:null,fin:null};
const eurSigne=c=>(c>0?'+':'')+eur(c);
function cleCategorie(d,unite){return unite==='annee'?d.slice(0,4):d.slice(0,7);}
// lignes [{id,d,m}] → [{cle,total (centimes, signé),n (opérations)}] de la plus ancienne à la plus récente
// fin : dernière période affichée ('AAAA-MM' ou 'AAAA'), la période en cours par défaut (‹ › pour remonter le temps)
function periodesCategorie(lignes,unite,auj,fin){
  const cles=[];
  if(unite==='annee'){
    const f=fin?+fin:auj.getFullYear(),y0=lignes.reduce((y,l)=>Math.min(y,+l.d.slice(0,4)),f);
    for(let y=Math.max(y0,f-9);y<=f;y++)cles.push(String(y));
  }else for(let i=11;i>=0;i--)cles.push(periodeDecalee(fin||clefMois(auj),-i));
  const par=new Map(cles.map(k=>[k,{cle:k,total:0,ops:new Set()}]));
  lignes.forEach(l=>{const e=par.get(cleCategorie(l.d,unite));if(e){e.total+=l.m;e.ops.add(l.id);}});
  return cles.map(k=>{const e=par.get(k);return {cle:k,total:e.total,n:e.ops.size};});
}
// moyenne des périodes affichées, sans la période en cours (commencée) si elle en fait partie ; null s'il n'y en a pas
function moyenneCategorie(P,avecDerniere){const p=avecDerniere?P:P.slice(0,-1);return p.length?Math.round(p.reduce((t,x)=>t+x.total,0)/p.length):null;}
// ‹ › : les barres défilent d'un cran (un mois, ou un an), jamais au-delà de la période en cours
function caDecaler(d){const auj=new Date(),cur=CA.unite==='annee'?String(auj.getFullYear()):clefMois(auj);
  const f=periodeDecalee(CA.fin||cur,d),avant=CA.fin||cur;
  CA.fin=rangPeriode(f)>=rangPeriode(cur)?null:f;renderAnalyseCategorie();
  animerDecalage(document.querySelector('#m-catana .ca-barres'),rangPeriode(CA.fin||cur)-rangPeriode(avant));}
function voirAnalyseCategorie(id){
  CA.pile=[id];CA.sel=null;CA.fin=null;const el=document.getElementById('m-catana');
  el.hidden=false;renderAnalyseCategorie();el.scrollTop=0; // affiché d'abord : les tailles se mesurent sur un écran visible
}
function fermerAnalyseCategorie(){const el=document.getElementById('m-catana');if(el)el.hidden=true;CA.pile=[];}
function caRetour(){CA.pile.pop();if(!CA.pile.length){fermerAnalyseCategorie();return;}renderAnalyseCategorie();document.getElementById('m-catana').scrollTop=0;}
function caDescendre(id){CA.pile.push(id);renderAnalyseCategorie();document.getElementById('m-catana').scrollTop=0;}
function caUnite(u){CA.unite=u;CA.sel=null;CA.fin=null;renderAnalyseCategorie();}
function caPeriode(k){CA.sel=k;renderAnalyseCategorie();}
function caOperations(){const id=Math.abs(CA.pile[CA.pile.length-1]);fermerAnalyseCategorie();voirCategorie(id);}
function renderAnalyseCategorie(){
  // un niveau négatif = « Sans sous-catégorie » de cette catégorie : ses opérations rangées directement dedans
  const el=document.getElementById('m-catana'),haut=CA.pile[CA.pile.length-1],direct=haut<0,id=Math.abs(haut),auj=new Date();
  const by={};qy('SELECT id,libelle,parent_id FROM categorie').forEach(c=>by[c.id]=c);
  if(!by[id]){fermerAnalyseCategorie();return;} // renommée par fusion, supprimée…
  const ids=direct?[id]:descendantsCategorie(id);
  const L=qy(`SELECT o.id,o.date_operation d,v.montant m,v.categorie_id c,t.nom ti,cp.nom compte FROM ventilation v
    JOIN operation o ON o.id=v.operation_id LEFT JOIN tiers t ON t.id=o.tiers_id LEFT JOIN compte cp ON cp.id=o.compte_id
    WHERE v.categorie_id IN (${ids.map(()=>'?').join(',')}) AND o.supprime=0 AND o.statut<>'annule' AND o.previsionnel=0
    AND o.date_operation<=?`,[...ids,isoDe(auj)]);
  const an=CA.unite==='annee',P=periodesCategorie(L,CA.unite,auj,CA.fin),cles=P.map(p=>p.cle);
  const sel=cles.indexOf(CA.sel)>=0?CA.sel:cles[cles.length-1],p=P[cles.indexOf(sel)],moy=moyenneCategorie(P,!!CA.fin);
  // ‹ possible tant qu'il reste des opérations avant la fenêtre
  const premiere=L.reduce((m,l)=>!m||l.d<m?l.d:m,null),avant=!!premiere&&cleCategorie(premiere,CA.unite)<cles[0];
  const LS=L.filter(l=>cleCategorie(l.d,CA.unite)===sel);
  const totalTout=L.reduce((t,l)=>t+l.m,0),nTout=new Set(L.map(l=>l.id)).size;
  const parents=cheminCategorie(id).split(' : ').slice(0,direct?undefined:-1),fl=d=>icoPlus(d);
  const nomPer=k=>an?k:majuscule(MOIS_FR[+k.slice(5)-1])+' '+k.slice(0,4);
  let h='<div class="mf-tete"><button class="mf-retour" onclick="caRetour()" aria-label="Retour">'+fl('M15 6l-6 6 6 6')+'</button>'+
    '<button class="mf-modifier" onclick="caOperations()">Voir les opérations</button></div>';
  h+='<div class="ca-titre"><small>'+esc(parents.length?parents.join(' › '):'Catégorie')+'</small><h2>'+esc(direct?SANS_SOUS:by[id].libelle)+'</h2>'+
    '<p>'+(nTout?'<b class="num '+clsSigne(totalTout)+'">'+eurSigne(totalTout)+'</b> · '+nTout+' opération'+(nTout>1?'s':'')+' en tout':'Aucune opération')+'</p></div>';
  h+='<div class="ev-portee ca-unite" role="tablist" aria-label="Par mois ou par année">'+[['mois','Par mois'],['annee','Par année']].map(([k,t])=>
    '<button role="tab" aria-selected="'+(CA.unite===k)+'" onclick="caUnite(\''+k+'\')">'+t+'</button>').join('')+'</div>';
  const enCours=!CA.fin&&sel===cles[cles.length-1];
  // la période, puis sur une ligne : le montant, et en face (centrés sur lui) le nombre d'opérations et la moyenne
  h+='<div class="ca-total"><small class="ca-per">'+nomPer(sel)+(enCours?' (en cours)':'')+'</small>'+
    '<div class="ca-ligne"><b class="num '+clsSigne(p.total)+'">'+eurSigne(p.total)+'</b>'+
    '<span class="ca-moy">'+p.n+' op.'+(moy!=null?'<br>moyenne <b class="num">'+eurSigne(moy)+'</b> / '+(an?'an':'mois'):'')+'</span></div></div>';
  // la fenêtre des barres : ‹ période · › (12 mois, ou jusqu'à 10 ans)
  const court=k=>an?k:MOIS_COURT[+k.slice(5)-1]+' '+k.slice(0,4);
  h+='<div class="ma-mois ca-fenetre"><button onclick="caDecaler(-1)" aria-label="Période précédente"'+(avant?'':' disabled')+'>'+fl('M15 6l-6 6 6 6')+'</button>'+
    '<div class="ma-mois-centre"><b>'+(cles.length>1?court(cles[0])+' – '+court(cles[cles.length-1]):court(cles[0]))+'</b></div>'+
    '<button onclick="caDecaler(1)" aria-label="Période suivante"'+(CA.fin?'':' disabled')+'>'+fl('M9 6l6 6-6 6')+'</button></div>';
  // toucher une barre : le détail de cette période
  const max=Math.max(1,...P.map(x=>Math.abs(x.total)));
  h+='<div class="ma-barres ca-barres" style="grid-template-columns:repeat('+P.length+',minmax(0,1fr))">'+P.map(x=>
    '<button'+(x.cle===sel?' class="actuel" aria-current="true"':'')+' onclick="caPeriode(\''+x.cle+'\')" aria-label="'+esc(nomPer(x.cle)+' : '+eurSigne(x.total))+'">'+
    '<span style="height:'+hauteurBarre(x.total,max,96)+'px"></span><small>'+(an?(P.length>6?'’'+x.cle.slice(2):x.cle):MOIS_FR[+x.cle.slice(5)-1].charAt(0).toUpperCase())+'</small></button>').join('')+'</div>';
  // sous-catégories de la période (au niveau juste en dessous)
  // rien que des opérations « Sans sous-catégorie » sur la période : on les montre directement
  const enfants=direct||(LS.length&&LS.every(l=>l.c===id))?[]:Object.values(by).filter(c=>c.parent_id===id);
  if(enfants.length){
    const enfantDe=c=>{let x=c;while(x!=null&&by[x]&&by[x].parent_id!==id)x=by[x].parent_id;return x;}; // la sous-catégorie directe
    const g=new Map();LS.forEach(l=>{const k=l.c===id?0:enfantDe(l.c)||0,e=g.get(k)||{k,total:0,ops:new Set()};e.total+=l.m;e.ops.add(l.id);g.set(k,e);});
    const gs=[...g.values()].sort((a,b)=>Math.abs(b.total)-Math.abs(a.total));
    h+='<h3 class="ma-h">Sous-catégories</h3><div class="ma-liste">'+(gs.length?gs.map(e=>e.k?
      '<button class="ma-ligne" onclick="caDescendre('+e.k+')"><span class="ma-nom">'+esc(by[e.k].libelle)+'<small>'+e.ops.size+' op.</small></span>'+
        '<span class="num '+clsSigne(e.total)+'">'+eurSigne(e.total)+'</span>'+fl('M9 6l6 6-6 6')+'</button>'
      :'<button class="ma-ligne" onclick="caDescendre('+(-id)+')"><span class="ma-nom">'+SANS_SOUS+'<small>'+e.ops.size+' op.</small></span>'+
        '<span class="num '+clsSigne(e.total)+'">'+eurSigne(e.total)+'</span>'+fl('M9 6l6 6-6 6')+'</button>').join('')
      :'<div class="m-vide">Rien sur cette période.</div>')+'</div>';
  }else{
    // plus de sous-catégorie (ou « Sans sous-catégorie ») : ses opérations de la période, une ligne par opération
    const ops=new Map();LS.forEach(l=>{const o=ops.get(l.id)||{id:l.id,d:l.d,ti:l.ti,compte:l.compte,m:0};o.m+=l.m;ops.set(l.id,o);});
    const lo=[...ops.values()].sort((a,b)=>b.d.localeCompare(a.d)||b.id-a.id);
    h+='<h3 class="ma-h">Opérations ('+lo.length+')</h3><div class="ma-liste">'+(lo.length?lo.map(o=>'<button class="ma-ligne" onclick="ouvrirFiche('+o.id+')">'+
      '<span class="ma-nom">'+esc(o.ti||'(sans destinataire)')+'<small>'+libJour(o.d,auj)+' · '+esc(o.compte||'')+'</small></span>'+
      '<span class="num '+clsSigne(o.m)+'">'+eurSigne(o.m)+'</span></button>').join('')
      :'<div class="m-vide">Aucune opération sur cette période.</div>')+'</div>';
  }
  el.innerHTML=h;
  const l=el.querySelector('.ca-ligne');ajusterTaille(l.querySelector('b'),()=>l.scrollWidth>l.clientWidth); // le montant ne chevauche plus la moyenne
}
// hauteur d'une barre en px (pas en % : pas toujours suivi par la vue web d'Android) ; un montant non nul se voit toujours
function hauteurBarre(v,max,haut){return v?Math.max(4,Math.round(Math.abs(v)/max*haut)):2;}
// réduit la police d'un élément tant que trop() est vrai (un grand montant qui ne tient pas)
function ajusterTaille(e,trop,min){if(!e)return;e.style.fontSize='';let f=parseFloat(getComputedStyle(e).fontSize)||20;
  while(trop()&&f>(min||12)){f-=0.5;e.style.fontSize=f+'px';}}

/* ============================================================
   Analyse — uniquement des barres horizontales, avec descente
   dans les niveaux de catégories (3 niveaux max).
   ============================================================ */
function _catPathFn(){
  const cats=qy('SELECT id,libelle,parent_id FROM categorie');
  const by={};cats.forEach(c=>by[c.id]=c);const cache={};
  return function(id){
    if(id==null)return null;
    if(cache[id]!=null)return cache[id];
    const parts=[];let g=by[id];while(g){parts.unshift(g.libelle);g=(g.parent_id!=null)?by[g.parent_id]:null;}
    return cache[id]=parts.join(' : ');
  };
}
/* Lignes comptables d'un ensemble d'opérations — MÊME règle pour le registre et l'analyse :
   - une opération répartie compte ligne par ligne, chaque ligne selon SON signe
     (salaire 3 000 € = Salaire +3 500 € en revenu et Impôts −500 € en dépense) ;
   - une opération non répartie compte pour son montant ;
   - si les lignes ne font pas le montant de l'opération, la différence forme une ligne
     « (répartition incomplète) », pour que la somme des lignes = montant de l'opération ;
   - virement = opération de type virement / catégorie « Virement… » (une ligne, montant total),
     ou ligne classée en « Virement… ». */
function lignesOps(w,p){
  const rows=qy('SELECT o.id,o.type ty,o.date_operation d,o.montant om,o.cat_path cp,o.statut st,t.nom ti,v.montant vm,v.categorie_id c '+
    'FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id LEFT JOIN ventilation v ON v.operation_id=o.id'+w,p);
  const path=_catPathFn();const ops=new Map();
  rows.forEach(r=>{let o=ops.get(r.id);if(!o){o={r,lignes:[]};ops.set(r.id,o);}
    if(r.c!=null)o.lignes.push({m:r.vm,cat:path(r.c)});});
  const out=[];
  ops.forEach(({r,lignes})=>{
    const base={id:r.id,d:r.d,ti:r.ti,om:r.om,st:r.st};
    if(r.ty==='virement'||isVirCat(r.cp)){out.push(Object.assign({m:r.om,cat:r.cp,vir:true,opVir:true},base));return;}
    if(!lignes.length)lignes.push({m:r.om,cat:r.cp});
    const somme=lignes.reduce((t,l)=>t+l.m,0);
    if(somme!==r.om)lignes.push({m:r.om-somme,cat:'(répartition incomplète)',adj:true});
    lignes.forEach(l=>out.push(Object.assign({m:l.m,cat:l.cat,vir:isVirCat(l.cat),adj:!!l.adj},base)));
  });
  return out;
}
/* filtres des loupes du registre, appliqués ligne par ligne */
const memeCat=(cat,chemin)=>{const a=catParts(cat).join(' : '),b=catParts(chemin).join(' : ');return a===b||a.indexOf(b+' : ')===0;};
function ligneFiltre(l){
  if(state.fSens==='debit'&&!(!l.vir&&l.m<0))return false;
  if(state.fSens==='credit'&&!(!l.vir&&l.m>0))return false;
  if(state.fSens==='virement'&&!l.vir)return false;
  if(state.fCat&&!memeCat(l.cat,state.fCat))return false;
  return true;
}
function anOps(){
  const p={$acc:state.acc};
  const w=" WHERE o.compte_id=$acc AND o.supprime=0 AND o.statut<>'annule' AND o.previsionnel=0"+periodClause('an',p);
  return lignesOps(w,p);
}
const isVirCat=c=>/^virement/i.test(c||'');

/* boutons Dépenses / Revenus / Net / Virements alignés sur state.anSens (seule référence) */
function majBoutonsSens(){const s=state.anSens||'debit';
  [['an-dep','debit'],['an-cre','credit'],['an-net','net'],['an-vir','virement']].forEach(([id,v])=>{
    const b=document.getElementById(id);if(b)b.classList.toggle('on',s===v);});}
function anSetSens(s){state.anSens=s;
  state.anPath=[];renderAnalyse();
  syncHist();} // l'historique mémorise le sens choisi (sinon « retour » restaurait un ancien sens)
/* moyenne qui s'adapte à la période : par mois si longue, par semaine si moyenne, par jour si courte */
/* nombre de mois du calendrier touchés par la période, bornes comprises (1er janvier → 26 octobre = 10) */
function nbMoisCalendaires(d1,d2){return (d2.getFullYear()-d1.getFullYear())*12+(d2.getMonth()-d1.getMonth())+1;}
function anMoyenne(total,mode,sel){
  if(!total)return null;
  let d1,d2;const b=periodBounds('an');
  if(b&&b.f&&b.t){d1=new Date(b.f+'T00:00:00');d2=new Date(b.t+'T00:00:00');}
  else{ // tout / perso partiel : bornes réelles des opérations affichées
    if(!sel||!sel.length)return null;
    const ds=sel.map(o=>o.d).sort();d1=new Date((b&&b.f||ds[0])+'T00:00:00');d2=new Date((b&&b.t||ds[ds.length-1])+'T00:00:00');
  }
  const jours=Math.max(1,Math.round((d2-d1)/86400000)+1);
  let unite,div;
  if(jours>=80){unite='mois';div=nbMoisCalendaires(d1,d2);}
  else if(jours>=14){unite='semaine';div=jours/7;}
  else{unite='jour';div=jours;}
  div=Math.max(div,1);
  return {montant:Math.round(total/div),unite,div};
}
function renderAnalyse(){
  if(!state.acc)return;
  if(document.body.classList.contains('mobile')){renderAnalyseMobile();return;}
  const cp=qy('SELECT nom FROM compte WHERE id=?',[state.acc])[0];
  document.getElementById('an-meta').textContent=cp?cp.nom:'';

  majBoutonsSens();
  const sens=state.anSens||'debit';
  const virMode=(sens==='virement');
  // dépenses / revenus / net : hors virements intercomptes ; « Virements » : uniquement eux
  const dep=anOps().filter(o=>o.m!==0&&(virMode?o.vir:(!o.vir&&(sens==='net'||(sens==='debit'?o.m<0:o.m>0)))));
  // les virements sont regroupés par compte (« Virement vers … » / « Virement reçu de … »)
  if(virMode)dep.forEach(o=>{o.cat=o.ti||o.cat||'Virement';});

  // on ne garde que celles qui appartiennent au chemin courant
  const depth=state.anPath.length;
  const sel=dep.filter(o=>{const p=catParts(o.cat);return state.anPath.every((s,i)=>p[i]===s);});

  // regroupement sur le niveau suivant
  const net=(state.anSens==='net'||virMode);
  const g={},deeper=new Set(),nb={};
  sel.forEach(o=>{const p=virMode?[o.cat]:catParts(o.cat);const k=p[depth]||'(non précisé)';
    g[k]=(g[k]||0)+(net||sens==='credit'?o.m:-o.m);(nb[k]=nb[k]||new Set()).add(o.id);
    if(p[depth]&&p[depth+1]&&depth<2)deeper.add(k);});
  anGroups=Object.entries(g).map(([c,v])=>({c,v,n:nb[c].size})).sort((x,y)=>Math.abs(y.v)-Math.abs(x.v));
  const tot=anGroups.reduce((t,x)=>t+x.v,0);
  window.__deeper=deeper;
  window.__anMoy=anMoyenne(tot,document.getElementById('an-periode').value,sel);

  // fil d'Ariane
  const motSens=virMode?'virements':state.anSens==='net'?'mouvements (net)':(state.anSens==='credit'?'revenus':'dépenses');
  const nbOps=new Set(sel.map(o=>o.id)).size; // une opération ventilée compte une seule fois
  {const ds=sel.map(o=>o.d).sort();const per=textePeriode('an',ds[0],ds[ds.length-1]);
   document.getElementById('an-meta').textContent=(cp?cp.nom:'')+(per?' · '+per:'');}
  const sumAbs=anGroups.reduce((t,x)=>t+Math.abs(x.v),0)||1;
  let cr='<a onclick="goDepth(0)">'+(motSens==='dépenses'?'Toutes':'Tous')+' les '+motSens+'</a>';
  state.anPath.forEach((x,i)=>{cr+=' <span style="color:var(--ink-3)">›</span> '+
    (i===state.anPath.length-1?'<b>'+esc(x)+'</b>':'<a onclick="goDepth('+(i+1)+')">'+esc(x)+'</a>');});
  if(state.anPath.length)cr+='  <span style="color:var(--ink-3);font-size:.8rem">— bouton retour pour remonter</span>';
  document.getElementById('an-crumb').innerHTML=cr;

  // total de référence des pourcentages
  document.getElementById('an-total').innerHTML=
    '<span class="k">'+(state.anPath.length?esc(state.anPath[state.anPath.length-1]):(state.anSens==='net'?'Total net':virMode?'Total net des virements':'Total des '+motSens))+'</span>'+
    '<span class="v num '+(net?clsSigne(tot):sens==='credit'?'credit':'debit')+'">'+eur(tot)+'</span>'+
    (window.__anMoy?'<span class="d" style="color:var(--accent,#2563EB)">Moyenne '+eur(window.__anMoy.montant)+' / '+window.__anMoy.unite+'</span>':'')+
    '<span class="d">'+nbOps.toLocaleString('fr-FR')+' opération'+(nbOps>1?'s':'')+
    ' · '+anGroups.length+' '+(virMode?'compte':depth===0?'catégorie':depth===1?'sous-catégorie':'sous-sous-catégorie')+(anGroups.length>1?'s':'')+'</span>';

  // les barres
  const el=document.getElementById('an-bars');
  if(!anGroups.length){el.innerHTML='<div style="color:var(--ink-3)">Aucun mouvement sur cette période.</div>';return;}
  const div=(window.__anMoy&&window.__anMoy.div)||1,uni=(window.__anMoy&&window.__anMoy.unite)||'mois';
  el.innerHTML=anGroups.map((x,i)=>{
    const pct=Math.abs(x.v)/sumAbs*100;
    const deep=deeper.has(x.c);
    const chemin=state.anPath.concat([x.c]).join(' : ');
    const moy=eur(Math.round(x.v/div))+'/'+uni;
    const coul=net?(x.v<0?'color:var(--debit)':x.v>0?'color:var(--credit)':'color:var(--ink-3)'):(x.v<0?'color:var(--debit)':''); // déduction en rouge
    return '<div class="barrow'+(deep?' drill':'')+'" '+(deep?'data-i="'+i+'"':'')+
      (deep?' title="Cliquer pour voir le détail"':'')+'>'+
      '<div class="bl">'+esc(x.c)+(deep?' <span class="chev">›</span>':'')+
        ' <span class="voircat" title="Voir ces opérations dans le registre" data-c="'+esc(chemin)+'">🔍</span></div>'+
      '<div class="bartrack"><div class="barfill" style="width:'+pct.toFixed(2)+'%"></div></div>'+
      '<div class="barval num"><b style="'+coul+'">'+eur(x.v)+'</b> · '+pct.toFixed(1).replace('.',',')+' %<div class="sub" style="color:var(--accent,#2563EB)">'+moy+'</div></div></div>';
  }).join('');
  el.querySelectorAll('.barrow.drill').forEach(r=>r.addEventListener('click',e=>{if(e.target.closest('.voircat'))return;drillInto(+r.dataset.i);}));
  el.querySelectorAll('.voircat').forEach(s=>s.addEventListener('click',e=>{e.stopPropagation();voirDepuisAnalyse(s.dataset.c);}));
}

/* --- descente / remontée dans les niveaux --- */
function drillInto(i){
  const x=anGroups[i];
  if(!x||!window.__deeper.has(x.c)||state.anPath.length>=2)return;
  state.anPath.push(x.c);
  renderAnalyse();pushHist();
}
function goDepth(d){
  if(d===state.anPath.length)return;
  state.anPath=state.anPath.slice(0,d);
  renderAnalyse();pushHist();
}
function anBack(){ if(state.anPath.length){history.back();return true;} return false; }

/* ============================================================
   Graphiques : cours du solde d'un compte et patrimoine global
   - solde = opérations réelles (hors prévisionnel / annulées), jusqu'à aujourd'hui ;
   - flux (revenus / dépenses / virements) = lignes de lignesOps, même règle que le registre
     et l'analyse ; les virements entre comptes sont à part (reçus / envoyés) ;
   - solde de fin = solde de début + revenus − dépenses + virements reçus − virements envoyés ;
   - « Solde sans les virements » = solde de départ + cumul (revenus − dépenses) ;
   - patrimoine = somme des comptes actifs (les virements internes s'y annulent).
   ============================================================ */
const GR_SERIES={
  avecvir:{lib:'Solde du compte',col:'var(--brand)',ligne:true,mode:'compte'},
  horsvir:{lib:'Solde sans les virements',col:'var(--ink-2)',ligne:true,tirets:true,mode:'compte'},
  solde:{lib:'Patrimoine',col:'var(--brand)',ligne:true,mode:'patrimoine'},
  parcompte:{lib:'Un trait par compte',col:'var(--g1)',ligne:true,mode:'patrimoine'},
  rev:{lib:'Revenus',col:'var(--credit)'},
  dep:{lib:'Dépenses',col:'var(--debit)'},
  vir:{lib:'Virements',col:'var(--st-prev)',mode:'compte'}
};
const GR_DEF={avecvir:1,horsvir:0,solde:1,parcompte:0,rev:1,dep:1,vir:0};
const GR_PAS={jour:'jour',semaine:'semaine',mois:'mois',annee:'année'};
const GR_CHAQUE={jour:'chaque jour',semaine:'chaque semaine',mois:'chaque mois',annee:'chaque année'};
const GR_PENDANT={jour:'dans la journée',semaine:'dans la semaine',mois:'dans le mois',annee:'dans l’année'};
const MOIS_COURT=['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
let grData=null;
function grShow(){
  if(!state.grShow){let s={};try{s=JSON.parse(getMeta('grShow3','{}'))||{};}catch(e){}
    state.grShow=Object.assign({},GR_DEF,s);
    if(!state.grShow.v63){state.grShow.avecvir=1;state.grShow.horsvir=0;state.grShow.v63=1;}} // v63 : la courbe principale redevient le vrai solde
  return state.grShow;
}
function grToggle(k){const s=grShow();s[k]=s[k]?0:1;try{setMeta('grShow3',JSON.stringify(s));}catch(e){}renderGraphiques();}
function grAideOuverte(o){const s=grShow();if((s.aide===1)===o)return;s.aide=o?1:0;try{setMeta('grShow3',JSON.stringify(s));}catch(e){}}
function grSetMode(m){state.grMode=m;renderGraphiques();syncHist();}
function grPasAuto(f,t){const j=Math.round((new Date(t+'T00:00:00')-new Date(f+'T00:00:00'))/86400000)+1;
  return j<=45?'jour':j<=190?'semaine':j<=366*6?'mois':'annee';}
/* découpe [f,t] en tranches (semaines du lundi au dimanche, mois et années civils, bornées à la période) */
function grTranches(f,t,pas){
  const out=[],fin=new Date(t+'T00:00:00');let d=new Date(f+'T00:00:00');
  while(d<=fin){let e;
    if(pas==='jour')e=new Date(d);
    else if(pas==='semaine'){e=new Date(d);e.setDate(e.getDate()+(7-e.getDay())%7);}
    else if(pas==='mois')e=new Date(d.getFullYear(),d.getMonth()+1,0);
    else e=new Date(d.getFullYear(),11,31);
    if(e>fin)e=new Date(fin);
    out.push({f:isoDe(d),t:isoDe(e)});
    d=new Date(e.getFullYear(),e.getMonth(),e.getDate()+1);
  }
  return out;
}
function grLib(tr,pas,long){const p=tr.f.split('-');
  if(pas==='jour')return long?isoToFr(tr.f):p[2]+'/'+p[1];
  if(pas==='semaine')return long?'Semaine du '+isoToFr(tr.f)+' au '+isoToFr(tr.t):p[2]+'/'+p[1];
  if(pas==='mois')return long?MOIS_FR[+p[1]-1].replace(/^./,c=>c.toUpperCase())+' '+p[0]:MOIS_COURT[+p[1]-1]+' '+p[0].slice(2);
  return long?'Année '+p[0]:p[0];}
function grCalcul(){
  const mode=state.grMode||'compte';
  const comptes=mode==='compte'?qy('SELECT id,nom,solde_initial si FROM compte WHERE id=?',[state.acc])
    :qy('SELECT id,nom,solde_initial si FROM compte WHERE actif=1 ORDER BY ordre_affichage,id');
  if(!comptes.length)return null;
  const OK=" o.compte_id IN ("+comptes.map(c=>+c.id).join(',')+") AND o.supprime=0 AND o.statut<>'annule' AND o.previsionnel=0";
  const auj=todayISO(),b=periodBounds('gr')||{};
  const f=b.f||scal('SELECT MIN(o.date_operation) FROM operation o WHERE'+OK)||auj;
  const t=b.t&&b.t<auj?b.t:auj; // pas d'avenir : le solde s'arrête à aujourd'hui
  if(f>t)return {mode,comptes,f,t,vide:true};
  const pasSel=(document.getElementById('gr-pas')||{}).value||'auto';
  let pas=pasSel==='auto'?grPasAuto(f,t):pasSel,tr=grTranches(f,t,pas);
  const plusGros=['jour','semaine','mois','annee'];
  while(tr.length>400&&pas!=='annee'){pas=plusGros[plusGros.indexOf(pas)+1];tr=grTranches(f,t,pas);}
  // jours de la période : index 0 = f ; chaque tranche couvre les jours [a, b]
  const t0=Date.parse(f+'T00:00:00Z'),jIdx=d=>Math.round((Date.parse(d+'T00:00:00Z')-t0)/864e5),N=jIdx(t)+1;
  tr.forEach(x=>{x.a=jIdx(x.f);x.b=jIdx(x.t);});
  const p={$f:f,$t:t},z=()=>new Array(N).fill(0);
  // solde de chaque compte la veille de la période, puis mouvements jour par jour
  const s0={},delta={};
  comptes.forEach(c=>{s0[c.id]=c.si;delta[c.id]=z();});
  qy('SELECT o.compte_id c,SUM(o.montant) s FROM operation o WHERE'+OK+' AND o.date_operation<$f GROUP BY o.compte_id',{$f:f})
    .forEach(r=>{s0[r.c]+=r.s;});
  qy('SELECT o.compte_id c,o.date_operation d,SUM(o.montant) s FROM operation o WHERE'+OK+
     ' AND o.date_operation BETWEEN $f AND $t GROUP BY o.compte_id,o.date_operation',p)
    .forEach(r=>{delta[r.c][jIdx(r.d)]+=r.s;});
  const jParCompte=comptes.map(c=>{let s=s0[c.id];return {id:c.id,nom:c.nom,s0:s0[c.id],v:delta[c.id].map(x=>s+=x)};});
  const sDebut=jParCompte.reduce((a,c)=>a+c.s0,0);
  const jSolde=z().map((_,k)=>jParCompte.reduce((a,c)=>a+c.v[k],0));
  // flux : lignes comptables (opérations réparties ligne par ligne), virements à part
  const jRev=z(),jDep=z(),jVirIn=z(),jVirOut=z();
  lignesOps(' WHERE'+OK+' AND o.date_operation BETWEEN $f AND $t',p).forEach(l=>{
    const k=jIdx(l.d);if(l.vir){if(l.m>0)jVirIn[k]+=l.m;else jVirOut[k]-=l.m;}else if(l.m>0)jRev[k]+=l.m;else jDep[k]-=l.m;});
  let h=sDebut;const jHors=jRev.map((r,k)=>h+=r-jDep[k]);
  const jours={N,solde:jSolde,horsvir:jHors,parCompte:jParCompte,rev:jRev,dep:jDep,virIn:jVirIn,virOut:jVirOut};
  // tranches (barres, bilan, tableau) : sommes des jours ; soldes = fin du dernier jour de la tranche
  const somme=(a,x)=>{let s=0;for(let k=x.a;k<=x.b;k++)s+=a[k];return s;};
  const rev=tr.map(x=>somme(jRev,x)),dep=tr.map(x=>somme(jDep,x)),virIn=tr.map(x=>somme(jVirIn,x)),virOut=tr.map(x=>somme(jVirOut,x));
  const solde=tr.map(x=>jSolde[x.b]),horsvir=tr.map(x=>jHors[x.b]),debut=tr.map(x=>x.a?jSolde[x.a-1]:sDebut);
  const parCompte=jParCompte.map(c=>({id:c.id,nom:c.nom,s0:c.s0,v:tr.map(x=>c.v[x.b])}));
  return {mode,comptes,f,t,pas,pasSel,tr,sDebut,debut,solde,horsvir,parCompte,rev,dep,virIn,virOut,jours};
}/* graduations « rondes » */
function grNice(min,max,n){
  if(min===max){const e=Math.max(Math.abs(min)*0.1,10000);min-=e;max+=e;}
  const brut=(max-min)/n,mag=Math.pow(10,Math.floor(Math.log10(brut))),r=brut/mag;
  const pas=(r>=7.5?10:r>=3.5?5:r>=1.5?2:1)*mag;
  const lo=Math.floor(min/pas)*pas,hi=Math.ceil(max/pas)*pas,ticks=[];
  for(let v=lo;v<=hi+pas/2;v+=pas)ticks.push(Math.round(v));
  return {lo,hi,ticks};
}
function grEurAxe(c){const a=Math.abs(c)/100,s=c<0?'−':'';
  if(a>=1e6)return s+fmt0.format(a/1e6)+' M€';
  if(a>=1e4)return s+fmt0.format(a/1e3)+' k€';
  return s+fmt0.format(a)+' €';}
/* hauteur de chaque graphique : réglable (curseur ⇕) et mémorisée ; par défaut selon la largeur */
function grH(k,el){
  if(document.body.classList.contains('gr-plein')){
    const bar=document.getElementById('gr-fsbar'),leg=document.getElementById('gr-leg');
    return Math.max(120,window.innerHeight-16-bar.offsetHeight-6-(k==='solde'&&leg?leg.offsetHeight:0)-44-(state.grFsTrop||0));
  }
  const v=+grShow()['h_'+k];if(v)return v;
  return k==='solde'?(el.clientWidth<520?220:270):(el.clientWidth<520?180:220);}
function grHauteur(k,v,garder){const s=grShow();s['h_'+k]=+v;
  if(garder)try{setMeta('grShow3',JSON.stringify(s));}catch(e){}
  const D=grData;if(!D||!D.tr)return;const el=document.getElementById('gr-'+k);grSortie();
  (k==='solde'?grSvgSolde:grSvgFlux)(el,D,s);grBrancherSurvol(el);}
function grBrancherSurvol(root){root.querySelectorAll('.gr-hit').forEach(h=>{
  h.addEventListener('pointermove',grSurvol);h.addEventListener('pointerdown',grSurvol);
  h.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch')grSortie();});});} // au doigt, l'info-bulle reste après avoir levé le doigt
// toucher ailleurs que sur un graphique referme l'info-bulle
document.addEventListener('pointerdown',e=>{if(state.view==='graphiques'&&!(e.target.closest&&e.target.closest('.gr-hit')))grSortie();},true);
/* plein écran (mobile : à l'horizontale) : la courbe seule, les barres en option */
let grFsNatif=false;
function barresAppliCachees(cacher){Capacitor.nativePromise('SystemBars',cacher?'hide':'show',{}).catch(()=>{});}
window.addEventListener('resize',()=>{if(enAppli()&&document.body.classList.contains('gr-plein'))setTimeout(()=>barresAppliCachees(true),250);});
async function grPleinEcran(on,auto){
  const d=document,el=d.documentElement;
  d.body.classList.toggle('gr-plein',on);d.body.classList.toggle('gr-auto',on&&!!auto);
  d.body.classList.toggle('gr-fs-barres',on&&!!grShow().fsBarres);grSortie();
  if(!on)grFsAuto=false;
  // appli : pas le plein écran du navigateur (en sortant, il pouvait faire revenir les barres) ; on cache les barres
  // d'Android (état, navigation), aussi quand le plein écran vient de la rotation, et de nouveau après chaque rotation
  if(enAppli())barresAppliCachees(on);
  if(on&&!auto){
    if(!enAppli()&&!pleinEcranActif()&&(el.requestFullscreen||el.webkitRequestFullscreen)){
      try{await (el.requestFullscreen||el.webkitRequestFullscreen).call(el,{navigationUI:'hide'});grFsNatif=true;}catch(e){grFsNatif=false;}}
    try{if(screen.orientation&&screen.orientation.lock)await screen.orientation.lock('landscape');}catch(e){} // refusé hors plein écran (iPhone…) : on invite à tourner
  }else if(!on){
    try{if(screen.orientation&&screen.orientation.unlock)screen.orientation.unlock();}catch(e){}
    if(grFsNatif&&pleinEcranActif())try{await (d.exitFullscreen||d.webkitExitFullscreen).call(d);}catch(e){}
    grFsNatif=false;
  }
  if(!on&&state.grDepuisEvo){state.grDepuisEvo=false;setView('analyse');return;}
  if(state.view==='graphiques')renderGraphiques();
}
function grFsVue(barres){const s=grShow();s.fsBarres=barres?1:0;try{setMeta('grShow3',JSON.stringify(s));}catch(e){}
  document.body.classList.toggle('gr-fs-barres',!!s.fsBarres);renderGraphiques();}
/* téléphone tourné à l'horizontale sur la vue Graphiques : plein écran automatique ; retour à la verticale : on en sort */
const grMQ=window.matchMedia('(orientation: landscape) and (pointer: coarse) and (max-height: 520px)');
let grFsAuto=false;
function grAuto(){
  const on=grMQ.matches&&state.view==='graphiques',plein=document.body.classList.contains('gr-plein');
  if(on&&!plein){grFsAuto=true;grPleinEcran(true,true);}
  else if(!on&&grFsAuto)grPleinEcran(false,true);
}
if(grMQ.addEventListener)grMQ.addEventListener('change',grAuto);else if(grMQ.addListener)grMQ.addListener(grAuto);
/* téléphone à l'horizontale : le navigateur n'accepte le vrai plein écran (sans sa barre) qu'après un geste ;
   le premier appui sur l'écran le déclenche (pointerup / touchend comptent comme geste, pas la rotation) */
async function grFsNatifAuto(){
  const el=document.documentElement;
  if(!document.body.classList.contains('gr-auto')||pleinEcranActif()||!(el.requestFullscreen||el.webkitRequestFullscreen))return;
  try{await (el.requestFullscreen||el.webkitRequestFullscreen).call(el,{navigationUI:'hide'});grFsNatif=true;}catch(e){}
}
document.addEventListener('pointerup',e=>{if(e.pointerType!=='mouse')grFsNatifAuto();},true);
// sortie du plein écran par le système (retour, Échap) : en mode manuel on quitte la vue plein écran ;
// en mode automatique (téléphone à l'horizontale) on la garde, seule la barre du navigateur revient
['fullscreenchange','webkitfullscreenchange'].forEach(t=>document.addEventListener(t,()=>{
  document.body.classList.toggle('gr-natif',pleinEcranActif());
  if(pleinEcranActif()||!grFsNatif||!document.body.classList.contains('gr-plein'))return;
  if(document.body.classList.contains('gr-auto'))grFsNatif=false;else grPleinEcran(false);}));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('gr-plein')){e.preventDefault();e.stopPropagation();grPleinEcran(false);}},true);
function grGeom(el,h){const w=Math.max(280,el.clientWidth||600);
  const m={l:w<520?50:64,r:12,t:12,b:26};return {w,h,m,iw:w-m.l-m.r,ih:h-m.t-m.b};}
/* cadre commun : grille horizontale, étiquettes Y, étiquettes X (sous-ensemble sans chevauchement) */
function grCadre(G,D,y,nice){
  let s='';
  nice.ticks.forEach(v=>{const yy=y(v).toFixed(1);
    s+='<line x1="'+G.m.l+'" x2="'+(G.w-G.m.r)+'" y1="'+yy+'" y2="'+yy+'" class="'+(v===0?'gr-zero':'gr-grid')+'"/>'+
       '<text x="'+(G.m.l-6)+'" y="'+yy+'" dy=".32em" text-anchor="end" class="gr-ax">'+grEurAxe(v)+'</text>';});
  const n=D.tr.length,lw=D.pas==='mois'?52:D.pas==='annee'?40:44,every=Math.max(1,Math.ceil(lw/(G.iw/n)));
  for(let i=0;i<n;i+=every)
    s+='<text x="'+grXT(G,D,i).cx.toFixed(1)+'" y="'+(G.h-8)+'" text-anchor="middle" class="gr-ax">'+esc(grLib(D.tr[i],D.pas))+'</text>';
  return s;
}
const grXJ=(G,D,k)=>G.m.l+G.iw*(k+.5)/D.jours.N; // centre du jour k
function grXT(G,D,i){const x=D.tr[i],x0=G.m.l+G.iw*x.a/D.jours.N,x1=G.m.l+G.iw*(x.b+1)/D.jours.N;return {x0,x1,cx:(x0+x1)/2};}
function grJourA(G,D,px){return Math.max(0,Math.min(D.jours.N-1,Math.floor((px-G.m.l)/G.iw*D.jours.N)));}
function grTrancheDuJour(D,k){let lo=0,hi=D.tr.length-1;while(lo<hi){const mi=(lo+hi)>>1;if(D.tr[mi].b<k)lo=mi+1;else hi=mi;}return lo;}function grLigne(G,D,y,vals,col,larg,tirets){
  const n=vals.length,X=k=>grXJ(G,D,k),Y=k=>y(vals[k]);
  if(n===1)return '<circle cx="'+X(0).toFixed(1)+'" cy="'+Y(0).toFixed(1)+'" r="4" style="fill:'+col+'"/>';
  // pentes de Fritsch–Carlson
  const dx=[],dy=[],m=[],sl=[];
  for(let k=0;k<n-1;k++){dx[k]=X(k+1)-X(k);dy[k]=Y(k+1)-Y(k);sl[k]=dy[k]/dx[k];}
  m[0]=sl[0];m[n-1]=sl[n-2];
  for(let k=1;k<n-1;k++)m[k]=(sl[k-1]*sl[k]<=0)?0:3*(dx[k-1]+dx[k])/((2*dx[k]+dx[k-1])/sl[k-1]+(dx[k]+2*dx[k-1])/sl[k]);
  let d='M'+X(0).toFixed(1)+','+Y(0).toFixed(1);
  for(let k=0;k<n-1;k++){const h=dx[k]/3;
    d+='C'+(X(k)+h).toFixed(1)+','+(Y(k)+m[k]*h).toFixed(1)+' '+(X(k+1)-h).toFixed(1)+','+(Y(k+1)-m[k+1]*h).toFixed(1)+' '+X(k+1).toFixed(1)+','+Y(k+1).toFixed(1);}
  return '<path d="'+d+'" fill="none" stroke-width="'+larg+'" stroke-linejoin="round" stroke-linecap="round"'+
    (tirets?' stroke-dasharray="6 4"':'')+' style="stroke:'+col+'"/>';
}/* barre à bout arrondi (4px côté valeur), ancrée sur la ligne de base */
function grBarre(x,w,y0,y1,col){
  const h=Math.abs(y1-y0);if(h<0.5||w<=0)return '';
  const r=Math.min(4,w/2,h),haut=y1<y0,a=Math.min(y0,y1),b=Math.max(y0,y1),X=x.toFixed(1),W=(x+w).toFixed(1);
  const d=haut?'M'+X+','+b+'V'+(a+r)+'Q'+X+','+a+' '+(x+r).toFixed(1)+','+a+'H'+(x+w-r).toFixed(1)+'Q'+W+','+a+' '+W+','+(a+r)+'V'+b+'Z'
              :'M'+X+','+a+'V'+(b-r)+'Q'+X+','+b+' '+(x+r).toFixed(1)+','+b+'H'+(x+w-r).toFixed(1)+'Q'+W+','+b+' '+W+','+(b-r)+'V'+a+'Z';
  return '<path d="'+d+'" style="fill:'+col+'"/>';
}
function grColCompte(i){return 'var(--g'+((i%8)+1)+')';}
function grSvgSolde(el,D,sh){
  const G=grGeom(el,grH('solde',el)),series=[];
  const J=D.jours;
  if(sh.parcompte&&D.mode==='patrimoine')J.parCompte.forEach((c,i)=>series.push({v:c.v,col:grColCompte(i),larg:1.5}));
  if(D.mode==='compte'){
    if(sh.horsvir)series.push({v:J.horsvir,col:GR_SERIES.horsvir.col,larg:2,tirets:true});
    if(sh.avecvir)series.push({v:J.solde,col:GR_SERIES.avecvir.col,larg:2.25});
  }else if(sh.solde)series.push({v:J.solde,col:GR_SERIES.solde.col,larg:2.25});
  let mn=Infinity,mx=-Infinity;series.forEach(s=>s.v.forEach(v=>{if(v<mn)mn=v;if(v>mx)mx=v;}));
  const nice=grNice(mn,mx,Math.max(2,Math.round(G.ih/55))),y=v=>G.m.t+G.ih*(1-(v-nice.lo)/(nice.hi-nice.lo));
  let s=grCadre(G,D,y,nice);
  series.forEach(se=>{s+=grLigne(G,D,y,se.v,se.col,se.larg,se.tirets);});
  el.innerHTML='<svg width="'+G.w+'" height="'+G.h+'" role="img" aria-label="Évolution du solde">'+s+
    '<line class="gr-cross" y1="'+G.m.t+'" y2="'+(G.m.t+G.ih)+'" style="display:none"/><g class="gr-dots"></g>'+
    '<rect class="gr-hit" x="'+G.m.l+'" y="0" width="'+G.iw+'" height="'+G.h+'"/></svg>';
  el._gr={G,y,series};
}
/* barres côte à côte : revenus, dépenses, puis virements reçus et envoyés */
function grSvgFlux(el,D,sh){
  const G=grGeom(el,grH('flux',el)),n=D.tr.length,vir=sh.vir&&D.mode==='compte';
  // barres côte à côte, toutes vers le haut (revenus | dépenses | virements reçus | envoyés) : on compare d'un coup d'œil
  const series=[];
  if(sh.rev)series.push([D.rev,GR_SERIES.rev.col]);
  if(sh.dep)series.push([D.dep,GR_SERIES.dep.col]);
  if(vir){series.push([D.virIn,GR_SERIES.vir.col]);series.push([D.virOut,GR_SERIES.vir.col]);}
  let mx=0;for(let i=0;i<n;i++)series.forEach(([v])=>{mx=Math.max(mx,v[i]);});
  const nice=grNice(0,mx,Math.max(2,Math.round(G.ih/55))),y=v=>G.m.t+G.ih*(1-(v-nice.lo)/(nice.hi-nice.lo)),y0=y(0);
  let s=grCadre(G,D,y,nice);
  for(let i=0;i<n;i++){
    const T=grXT(G,D,i),bw=T.x1-T.x0,k=Math.max(1,series.length),gap=Math.min(2,bw*0.06);
    const lc=Math.min((bw*0.8-gap*(k-1))/k,40),x0=T.cx-(lc*k+gap*(k-1))/2;
    series.forEach(([v,col],j)=>{s+=grBarre(x0+j*(lc+gap),lc,y0,y(v[i]),col);});
  }
  s+='<line x1="'+G.m.l+'" x2="'+(G.w-G.m.r)+'" y1="'+y0.toFixed(1)+'" y2="'+y0.toFixed(1)+'" class="gr-zero"/>';
  el.innerHTML='<svg width="'+G.w+'" height="'+G.h+'" role="img" aria-label="Revenus, dépenses et virements">'+s+
    '<rect class="gr-band" y="'+G.m.t+'" width="0" height="'+G.ih+'" style="display:none"/>'+
    '<rect class="gr-hit" x="'+G.m.l+'" y="0" width="'+G.iw+'" height="'+G.h+'"/></svg>';
  el._gr={G};
}
/* ce qui est visible : courbes et infos de virements (le survol et le bilan n'affichent que cela) */
function grVis(D,sh){const patri=D.mode==='patrimoine';
  return {patri,sans:!patri&&!!sh.horsvir,avec:!patri&&!!sh.avecvir,patrimoine:patri&&!!sh.solde,parcompte:patri&&!!sh.parcompte,
    vir:!patri&&!!(sh.avecvir||sh.vir),rev:!!sh.rev,dep:!!sh.dep};}
/* bilan de la période, posé comme un calcul (une ligne = [signe, libellé, montant, classe, repère couleur]) :
   solde de début + revenus − dépenses [= solde sans les virements] [+ reçus − envoyés = solde réel] */
function grBilanLignes(D,V,R,Dp,VI,VO){
  const L=[],sFin=D.solde[D.tr.length-1],hFin=D.horsvir[D.tr.length-1],deb=avancerJours(D.f,-1),fin=isoToFr(D.t);
  const cleS='k-ld:'+GR_SERIES.horsvir.col,cleA='k-l:'+GR_SERIES.avecvir.col;
  L.push(['',(V.patri?'Patrimoine':'Solde')+' au '+isoToFr(deb),eur(D.sDebut),'',null]);
  L.push(['+','Revenus',eur(R),'credit','k-r:'+GR_SERIES.rev.col]);
  L.push(['−','Dépenses',eur(Dp),'debit','k-r:'+GR_SERIES.dep.col]);
  if(V.patri){L.push(['=','Patrimoine au '+fin,eur(sFin),'tot','k-l:'+GR_SERIES.solde.col]);return L;}
  if(!V.vir){L.push(['=','Solde sans les virements au '+fin,eur(hFin),'tot',cleS]);return L;}
  L.push(['+','Virements reçus de tes autres comptes',eur(VI),'','k-r:'+GR_SERIES.vir.col]);
  L.push(['−','Virements envoyés vers tes autres comptes',eur(VO),'','k-r:'+GR_SERIES.vir.col]);
  L.push(['=','Solde au '+fin,eur(sFin),'tot',cleA]);
  if(V.sans)L.push(['','Sans les virements, il serait de',eur(hFin),'',cleS]);
  return L;
}
function grLignesHTML(L){
  return L.map(([sg,lib,val,cls,cle])=>{
    const k=cle?cle.split(':'):null,rep=k?'<i class="'+(k[0]==='k-ld'?'k-l dash':k[0])+'" style="'+(k[0]==='k-r'?'background:':'border-color:')+k[1]+'"></i>':'<i class="k-vide"></i>';
    return '<div class="eq'+(cls==='tot'?' tot':'')+'"><span class="sg">'+sg+'</span>'+rep+'<span class="lb">'+lib+'</span>'+
      '<span class="vl num '+(cls==='tot'?'':cls)+'">'+val+'</span></div>';}).join('');
}
/* survol : réticule synchronisé sur les deux graphiques + info-bulle (le calcul de la tranche survolée) */
function grSurvol(e){
  const D=grData;if(!D||!D.tr)return;
  const svg=e.currentTarget.ownerSVGElement,box=svg.parentNode,G=box._gr.G,r=svg.getBoundingClientRect();
  const surCourbe=box.id==='gr-solde',sh=grShow(),V=grVis(D,sh),J=D.jours;
  let k=grJourA(G,D,e.clientX-r.left);const i=grTrancheDuJour(D,k);
  if(!surCourbe)k=D.tr[i].b; // depuis les barres : la courbe montre la fin de la tranche
  const T=grXT(G,D,i),cx=grXJ(G,D,k);
  ['gr-solde','gr-flux'].forEach(id=>{const b=document.getElementById(id);if(!b||!b._gr)return;
    const c=b.querySelector('.gr-cross'),bd=b.querySelector('.gr-band'),dots=b.querySelector('.gr-dots');
    if(c){c.setAttribute('x1',cx);c.setAttribute('x2',cx);c.style.display='';}
    if(bd){bd.setAttribute('x',T.x0.toFixed(1));bd.setAttribute('width',(T.x1-T.x0).toFixed(1));bd.style.display='';}
    if(dots)dots.innerHTML=b._gr.series.map(se=>'<circle cx="'+cx.toFixed(1)+'" cy="'+b._gr.y(se.v[k]).toFixed(1)+'" r="4" class="gr-dot" style="fill:'+se.col+'"/>').join('');
  });
  const courbe=V.sans||V.avec||V.patrimoine||V.parcompte,mv=[],so=[];
  // mouvements (du jour pointé sur la courbe, de la tranche sur les barres) : seulement ce qui est affiché
  const R=surCourbe?J.rev[k]:D.rev[i],Dp=surCourbe?J.dep[k]:D.dep[i],VI=surCourbe?J.virIn[k]:D.virIn[i],VO=surCourbe?J.virOut[k]:D.virOut[i];
  if(V.rev||courbe)mv.push(['+','Revenus',eur(R),'credit','k-r:'+GR_SERIES.rev.col]);
  if(V.dep||courbe)mv.push(['−','Dépenses',eur(Dp),'debit','k-r:'+GR_SERIES.dep.col]);
  if(V.vir){mv.push(['+','Virements reçus',eur(VI),'','k-r:'+GR_SERIES.vir.col]);mv.push(['−','Virements envoyés',eur(VO),'','k-r:'+GR_SERIES.vir.col]);}
  // soldes en fin de journée k, avec la variation depuis la veille (courbe) ou depuis le début de la tranche (barres)
  const k0=surCourbe?k-1:D.tr[i].a-1,avant=(arr,s0)=>k0>=0?arr[k0]:s0;
  if(V.avec)so.push(['','Solde du compte',eur(J.solde[k]),'','k-l:'+GR_SERIES.avecvir.col,avant(J.solde,D.sDebut),J.solde[k]]);
  if(V.sans)so.push(['','Sans les virements',eur(J.horsvir[k]),'','k-ld:'+GR_SERIES.horsvir.col,avant(J.horsvir,D.sDebut),J.horsvir[k]]);
  if(V.patrimoine)so.push(['','Patrimoine',eur(J.solde[k]),'','k-l:'+GR_SERIES.solde.col,avant(J.solde,D.sDebut),J.solde[k]]);
  if(V.parcompte)J.parCompte.forEach((c,n)=>so.push(['',esc(c.nom),eur(c.v[k]),'','k-l:'+grColCompte(n),avant(c.v,c.s0),c.v[k]]));
  const jour=avancerJours(D.f,k),depuis=isoToFr(avancerJours(D.f,k0));
  let h='<div class="tt-h">'+(surCourbe?esc(new Date(jour+'T00:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}))
    :esc(grLib(D.tr[i],D.pas,true)))+'</div>';
  if(so.length)h+='<div class="tt-s">'+(V.patri?'Patrimoine':'Solde')+(surCourbe?' en fin de journée':' au '+isoToFr(D.tr[i].t))+'</div>'+
    so.map(l=>grLignesHTML([l.slice(0,5)])+(l[6]!==l[5]?'<div class="tt-var">'+sgn(l[6]-l[5])+' depuis le '+depuis+'</div>':'')).join('');
  const rien=!R&&!Dp&&!(V.vir&&(VI||VO));
  if(mv.length)h+='<div class="tt-s">'+(surCourbe?'Mouvements du jour':'Mouvements')+'</div>'+
    (surCourbe&&rien?'<div class="tt-x" style="border:0;margin:0;padding:2px 0">Aucune opération ce jour-là</div>'
      :grLignesHTML(surCourbe?mv.filter(l=>l[2]!==eur(0)):mv)); // au jour près : seulement ce qui a bougé
  const tip=document.getElementById('gr-tip');
  tip.innerHTML=h;tip.style.display='block';
  const tw=tip.offsetWidth,th=tip.offsetHeight,vw=document.documentElement.clientWidth,vh=window.innerHeight;
  let x,yy;
  if(e.pointerType==='touch'){ // au doigt : bien au-dessus (le doigt cache ~50 px), sinon sur le côté
    x=Math.min(Math.max(8,e.clientX-tw/2),vw-tw-8);yy=e.clientY-th-56;
    if(yy<8){yy=Math.min(Math.max(8,e.clientY-th/2),vh-th-8);
      x=e.clientX-48-tw>=8?e.clientX-48-tw:Math.min(e.clientX+48,vw-tw-8);}
  }else{
    x=e.clientX+14;if(x+tw>vw-8)x=e.clientX-14-tw;if(x<8)x=8;
    yy=e.clientY-th-12;if(yy<8)yy=e.clientY+16;
  }
  tip.style.left=x+'px';tip.style.top=yy+'px';
}
const sgn=c=>(c>0?'+':'')+eur(c);
function grSortie(){
  const tip=document.getElementById('gr-tip');if(tip)tip.style.display='none';
  document.querySelectorAll('#v-graphiques .gr-cross,#v-graphiques .gr-band').forEach(c=>c.style.display='none');
  document.querySelectorAll('#v-graphiques .gr-dots').forEach(g=>g.innerHTML='');
}
/* une phrase par série affichée : ce que représente chaque courbe / barre */
function grAide(D,sh){
  const patri=D.mode==='patrimoine',ch=GR_CHAQUE[D.pas],pd=GR_PENDANT[D.pas],A=[];
  const cle=k=>{const s=GR_SERIES[k];return s.ligne?'<i class="k-l'+(s.tirets?' dash':'')+'" style="border-color:'+s.col+'"></i>':'<i class="k-r" style="background:'+s.col+'"></i>';};
  if(sh.solde&&patri)A.push([cle('solde'),'<b>Patrimoine</b> : la somme de tous tes comptes, jour par jour. Un virement d’un compte à l’autre ne le change pas : ce qui sort de l’un entre dans l’autre.']);
  if(sh.avecvir&&!patri)A.push([cle('avecvir'),'<b>Solde du compte</b> (courbe principale) : l’argent réellement présent sur le compte, jour par jour, virements compris — celui de ton relevé.']);
  if(sh.horsvir&&!patri)A.push([cle('horsvir'),'<b>Solde sans les virements</b> (pointillés) : le solde qu’aurait le compte si tu n’avais fait aucun virement avec tes autres comptes depuis le début de la période (seulement tes revenus et tes dépenses). L’écart entre les deux courbes = le total des virements.']);
  if(sh.parcompte&&patri)A.push(['<i class="k-l" style="border-color:var(--g1)"></i>','<b>Un trait par compte</b> : le solde de chaque compte (couleurs sous le graphique).']);
  if(sh.rev)A.push([cle('rev'),'<b>Revenus</b> (barres vers le haut) : l’argent gagné '+pd+' (salaire, remboursements…), virements entre tes comptes exclus.']);
  if(sh.dep)A.push([cle('dep'),'<b>Dépenses</b> (barres rouges, à côté des revenus) : l’argent dépensé '+pd+', virements entre tes comptes exclus.']);
  if(sh.vir&&!patri)A.push([cle('vir'),'<b>Virements</b> (les deux barres de droite) : l’argent reçu de tes autres comptes, puis celui envoyé vers eux, '+pd+'. Ce n’est ni un revenu ni une dépense : il change juste de compte.']);
  return A.map(a=>'<div>'+a[0]+'<span>'+a[1]+'</span></div>').join('');
}
function renderGraphiques(){
  const mode=state.grMode||'compte',sh=grShow(),patri=mode==='patrimoine';
  document.getElementById('gr-m-compte').classList.toggle('on',!patri);
  document.getElementById('gr-m-patri').classList.toggle('on',patri);
  const chip=k=>{const s=GR_SERIES[k];if(s.mode&&s.mode!==mode)return '';
    const cle=s.ligne?'<i class="k-l'+(s.tirets?' dash':'')+'" style="border-color:'+s.col+'"></i>':'<i class="k-r" style="background:'+s.col+'"></i>';
    return '<button type="button" class="grchip'+(sh[k]?' on':'')+'" aria-pressed="'+!!sh[k]+'" title="Afficher / masquer" onclick="grToggle(\''+k+'\')">'+
      cle+s.lib+'</button>';};
  document.getElementById('gr-tog').innerHTML='<span class="grgrp">Courbes</span>'+['avecvir','horsvir','solde','parcompte'].map(chip).join('')+
    '<span class="grgrp">Barres</span>'+['rev','dep','vir'].map(chip).join('');
  grSortie();
  const D=grData=grCalcul();
  const meta=document.getElementById('gr-meta'),bil=document.getElementById('gr-total'),aide=document.getElementById('gr-aide');
  const cS=document.getElementById('gr-solde-card'),cF=document.getElementById('gr-flux-card'),tab=document.getElementById('gr-tab-wrap');
  const titre=patri?'Tous les comptes ('+(D?D.comptes.length:0)+')':(D?D.comptes[0].nom:'');
  if(!D||D.vide){meta.textContent=titre;bil.innerHTML='<div style="color:var(--ink-3)">Aucune donnée sur cette période (le solde n’est tracé que jusqu’à aujourd’hui).</div>';
    cS.style.display=cF.style.display=tab.style.display=aide.style.display='none';return;}
  meta.textContent=titre+' · opérations réelles (hors prévisionnel et annulées)';
  // bilan de la période : le même calcul que l'info-bulle, sur toute la période
  const n=D.tr.length,sum=a=>a.reduce((x,v)=>x+v,0),R=sum(D.rev),Dp=sum(D.dep),VI=sum(D.virIn),VO=sum(D.virOut),sFin=D.solde[n-1];
  const ev=sFin-D.sDebut;
  const V=grVis(D,sh),hFin=D.horsvir[n-1];
  bil.innerHTML='<div class="grtitle">Bilan du '+isoToFr(D.f)+' au '+isoToFr(D.t)+'</div>'+
    grLignesHTML(grBilanLignes(D,V,R,Dp,VI,VO))+
    '<div class="eqnote">En résumé : '+(V.patri?'le patrimoine a '+(ev>=0?'gagné':'perdu')+' <b class="num '+clsSigne(ev)+'">'+eur(Math.abs(ev))+'</b> sur la période.'
      :(V.vir?'le compte a '+(ev>=0?'gagné':'perdu')+' <b class="num '+clsSigne(ev)+'">'+eur(Math.abs(ev))+'</b> sur la période.<br>Tes revenus moins tes dépenses : <b class="num '+clsSigne(R-Dp)+'">'+sgn(R-Dp)+'</b> · tes virements (reçus − envoyés) : <b class="num">'+sgn(VI-VO)+'</b>.'
        :'tes revenus moins tes dépenses font <b class="num '+clsSigne(R-Dp)+'">'+sgn(R-Dp)+'</b> sur la période.'))+'</div>';
  // graphiques
  const voirS=V.sans||V.avec||V.patrimoine||V.parcompte,voirF=sh.rev||sh.dep||(sh.vir&&!patri);
  const fs=document.body.classList.contains('gr-plein');
  if(fs){document.getElementById('gr-fstit').textContent=(patri?'Patrimoine':D.comptes[0].nom)+' · du '+isoToFr(D.f)+' au '+isoToFr(D.t);
    document.getElementById('gr-fs-courbe').classList.toggle('on',!sh.fsBarres);document.getElementById('gr-fs-barres').classList.toggle('on',!!sh.fsBarres);}
  cS.style.display=voirS?'':'none';cF.style.display=voirF?'':'none';tab.style.display='';
  aide.style.display='';aide.innerHTML='<details'+(sh.aide===1?' open':'')+' ontoggle="grAideOuverte(this.open)"><summary>Comment lire ces graphiques</summary>'+
    grAide(D,sh)+'<div class="grastuce">Passe la souris (ou le doigt) sur la courbe pour voir le solde de chaque jour, sur les barres pour le détail de chaque '+GR_PAS[D.pas]+'.</div></details>';
  document.getElementById('gr-solde-titre').textContent=(patri?'Patrimoine':'Solde')+' jour par jour';
  document.getElementById('gr-flux-titre').textContent=[sh.rev&&'revenus',sh.dep&&'dépenses',sh.vir&&!patri&&'virements'].filter(Boolean).join(', ')
    .replace(/^./,c=>c.toUpperCase()).replace(/, ([^,]*)$/,' et $1')+' par '+GR_PAS[D.pas];
  const leg=document.getElementById('gr-leg');
  leg.innerHTML=sh.parcompte&&patri?D.parCompte.map((c,i)=>'<span><i class="k-l" style="border-color:'+grColCompte(i)+'"></i>'+esc(c.nom)+'</span>').join(''):'';
  if(voirS&&!(fs&&sh.fsBarres))grSvgSolde(document.getElementById('gr-solde'),D,sh);
  if(voirF&&!(fs&&!sh.fsBarres))grSvgFlux(document.getElementById('gr-flux'),D,sh);
  if(fs){const sec=document.getElementById('v-graphiques'),trop=sec.scrollHeight-sec.clientHeight; // marges mal estimées : on réduit d'autant
    if(trop>0){state.grFsTrop=trop+2;if(sh.fsBarres){if(voirF)grSvgFlux(document.getElementById('gr-flux'),D,sh);}else if(voirS)grSvgSolde(document.getElementById('gr-solde'),D,sh);state.grFsTrop=0;}}
  grBrancherSurvol(document.getElementById('v-graphiques'));
  ['solde','flux'].forEach(k=>{const r=document.getElementById('gr-h-'+k),b=document.getElementById('gr-'+k);if(r&&b)r.value=grH(k,b);});
  // tableau des valeurs : une ligne par tranche, colonnes dans l'ordre du calcul
  const mot=patri?'Patrimoine':'Solde';
  const reel=patri||V.vir;
  const cols=[['Période',i=>esc(grLib(D.tr[i],D.pas,true)),''],[patri?'Patrimoine début':reel?'Solde début':'Sans vir. début',i=>eur(reel?D.debut[i]:(i?D.horsvir[i-1]:D.sDebut)),'r'],
    ['+ Revenus',i=>'<span class="credit">'+eur(D.rev[i])+'</span>','r'],['− Dépenses',i=>'<span class="debit">'+eur(D.dep[i])+'</span>','r']];
  if(patri)cols.push(['= Patrimoine fin',i=>'<b>'+eur(D.solde[i])+'</b>','r']);
  else if(V.vir){cols.push(['+ Vir. reçus',i=>eur(D.virIn[i]),'r'],['− Vir. envoyés',i=>eur(D.virOut[i]),'r'],['= Solde fin',i=>'<b>'+eur(D.solde[i])+'</b>','r']);
    if(V.sans)cols.push(['Sans les virements',i=>eur(D.horsvir[i]),'r']);}
  else cols.push(['= Sans les virements',i=>'<b>'+eur(D.horsvir[i])+'</b>','r']);
  if(patri&&sh.parcompte)D.parCompte.forEach(c=>cols.push([esc(c.nom),i=>eur(c.v[i]),'r']));
  let h='<thead><tr>'+cols.map(c=>'<th'+(c[2]?' style="text-align:right"':'')+'>'+c[0]+'</th>').join('')+'</tr></thead><tbody>';
  for(let i=n-1;i>=0;i--)h+='<tr>'+cols.map(c=>'<td class="num '+c[2]+'">'+c[1](i)+'</td>').join('')+'</tr>';
  document.getElementById('gr-table').innerHTML=h+'</tbody>';
}

// bouton « retour » de la souris / du navigateur
window.addEventListener('resize',()=>{if(state.view==='registre'){syncHeadWidth();appliquerHauteurRegistre();}
  else if(state.view==='graphiques'){clearTimeout(window._grRsz);window._grRsz=setTimeout(renderGraphiques,120);}});
window.addEventListener('popstate',e=>{
  // Retour pendant qu'une fenêtre ou une feuille est ouverte (clavier ouvert dans l'appli, navigateur du téléphone) :
  // on ferme la fenêtre et on reste sur l'écran derrière, au lieu de revenir en arrière sous la fenêtre
  if(dlgResolve||fermerFeuilles()){if(dlgResolve)dlgClose(false);try{history.pushState(snapshotNav(),'');}catch(_){}return;}
  if(e.state&&e.state.__base){restoreNav(e.state);demanderQuitter();return;} // un « retour » de trop
  if(e.state)restoreNav(e.state);
  else{ _navSuppress=true;setView('registre',true);_navSuppress=false; } });

/* ============================================================
   Modale opération (CRUD)
   ============================================================ */
const destEl=()=>document.getElementById('i-dest');
let acItems=[],acIndex=-1;
let _tiIdx=null;
function invalidateCaches(){_tiIdx=null;}
function tiersIndex(){
  if(_tiIdx)return _tiIdx;
  const out={};qy(`SELECT t.nom nom,(SELECT o.cat_path FROM operation o WHERE o.tiers_id=t.id AND o.supprime=0 AND o.cat_path IS NOT NULL
     GROUP BY o.cat_path ORDER BY COUNT(*) DESC, MAX(o.date_operation) DESC LIMIT 1) cat FROM tiers t ORDER BY t.nom`).forEach(r=>out[r.nom]=r.cat||'');
  return _tiIdx=out;}
function catLevels(){
  const L=[[],[],[]];
  const cats=qy('SELECT id,libelle,parent_id FROM categorie');
  const by={};cats.forEach(c=>by[c.id]=c);
  const depthOf=c=>{let d=0,g=c;while(g&&g.parent_id!=null){d++;g=by[g.parent_id];}return d;};
  cats.forEach(c=>{const d=depthOf(c);if(d<3&&L[d].indexOf(c.libelle)<0)L[d].push(c.libelle);});
  return L.map(a=>a.sort((x,y)=>x.localeCompare(y,'fr')));}
function setCatFields(cat){const p=catParts(cat);['i-cat0','i-cat1','i-cat2'].forEach((id,i)=>document.getElementById(id).value=p[i]||'');}
/* ---- éditeur de ventilation (répartition multi-catégories) ---- */
function catCheminsComplets(){
  const cats=qy('SELECT id,libelle,parent_id FROM categorie');
  const by={};cats.forEach(c=>by[c.id]=c);
  const pathOf=c=>{const p=[];let g=c;while(g){p.unshift(g.libelle);g=(g.parent_id!=null)?by[g.parent_id]:null;}return p.join(' : ');};
  return cats.map(pathOf).filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a.localeCompare(b,'fr'));
}
function ventToggle(on){
  document.getElementById('cat-simple').style.display=on?'none':'';
  document.getElementById('vent-box').style.display=on?'':'none';
  if(on){
    document.getElementById('dlfull').innerHTML=catCheminsComplets().map(x=>'<option value="'+esc(x)+'">').join('');
    if(!state.vent||!state.vent.length){
      const c=getCat();const m=document.getElementById('i-montant').value.trim();
      state.vent=[{cat:c&&c!=='Divers'?c:'',m:m||''},{cat:'',m:''}];
    }
    ventRender();
  }
}
function ventAdd(apres){state.vent=state.vent||[];let idx;
  if(typeof apres==='number'&&apres>=0){state.vent.splice(apres+1,0,{cat:'',m:''});idx=apres+1;}
  else{state.vent.push({cat:'',m:''});idx=state.vent.length-1;}
  ventRender();
  const lignes=document.querySelectorAll('#vent-list .vent-l');
  if(lignes[idx]){const inp=lignes[idx].querySelector('input');if(inp){inp.focus();}}
}
/* cascade des sous-catégories dans le dialogue des récurrences */
function majSousCatsRec(){
  const c0=document.getElementById('rc-c0'),c1=document.getElementById('rc-c1');
  if(!c0)return;
  const l0=document.getElementById('rc-l0'),l1=document.getElementById('rc-l1'),l2=document.getElementById('rc-l2');
  if(l0)l0.innerHTML=catEnfants('').map(x=>'<option value="'+esc(x)+'">').join('');
  if(l1)l1.innerHTML=catEnfants(c0.value.trim()).map(x=>'<option value="'+esc(x)+'">').join('');
  if(l2)l2.innerHTML=catEnfants([c0.value.trim(),c1?c1.value.trim():''].filter(Boolean).join(' : ')).map(x=>'<option value="'+esc(x)+'">').join('');
}
function ventDel(i){state.vent.splice(i,1);if(!state.vent.length)state.vent.push({cat:'',m:''});ventRender();}
function ventSet(i,k,v){if(state.vent&&state.vent[i]){state.vent[i][k]=v;ventTotal();}}
function ventRender(){
  const box=document.getElementById('vent-list');
  box.innerHTML=(state.vent||[]).map((l,i)=>
    '<div class="vent-l">'+
      '<input'+(document.body.classList.contains('mobile')?'':' list="dlfull"')+' value="'+esc(l.cat)+'" placeholder="Alimentation : Supermarché" oninput="ventSet('+i+',&#39;cat&#39;,this.value)">'+
      '<input inputmode="decimal" style="text-align:right" value="'+esc(l.m)+'" placeholder="0,00" oninput="ventSet('+i+',&#39;m&#39;,this.value)">'+
      '<button type="button" class="ghost vx" onclick="ventDel('+i+')" title="Retirer cette ligne">&#10005;</button>'+
    '</div>').join('');
  ventTotal();
}
/* montant signé d'une ligne de ventilation, selon la convention comptable :
   sans signe = même sens que l'opération ; « - » = sens inverse. */
function ventCentimes(raw){
  const c=parseMontantC(raw);if(c==null)return null;
  const mag=Math.abs(c),moins=/^\s*-/.test(raw||'');
  const opSign=(state.addType==='credit')?1:-1;
  return (moins?-opSign:opSign)*mag;
}
function ventTotal(){
  // montant signé de l'opération (le sens vient des boutons dépense/revenu)
  const abs=Math.abs(parseMontantC(document.getElementById('i-montant').value)||0);
  const cible=(state.addType==='credit')?abs:-abs;
  let som=0;(state.vent||[]).forEach(l=>{som+=(ventCentimes(l.m)||0);});
  const reste=cible-som;const el=document.getElementById('vent-tot');
  el.className=(reste===0&&abs>0)?'ok':'bad';
  el.textContent='Réparti '+eur(Math.abs(som))+' / '+eur(Math.abs(cible))+(reste===0?' — équilibré':' — reste '+eur(Math.abs(reste)));
}
function catEnfants(cheminParent){
  const parts=catParts(cheminParent);
  const cats=qy('SELECT id,libelle,parent_id FROM categorie');
  const byId={};cats.forEach(c=>byId[c.id]=c);
  const pathOf=c=>{const p=[];let g=c;while(g){p.unshift(g.libelle);g=(g.parent_id!=null)?byId[g.parent_id]:null;}return p;};
  const res=[];
  cats.forEach(c=>{const p=pathOf(c);
    if(p.length===parts.length+1 && parts.every((x,i)=>x.toLowerCase()===p[i].toLowerCase())){
      if(res.indexOf(c.libelle)<0)res.push(c.libelle);}});
  return res.sort((a,b)=>a.localeCompare(b,'fr'));
}
/* sous-catégories proposées = uniquement celles de la catégorie saisie
   (mais on peut toujours taper un nouveau nom, même s'il existe ailleurs) */
function majSousCats(){
  const c0=document.getElementById('i-cat0'),c1=document.getElementById('i-cat1');
  if(!c0)return;
  const dl0=document.getElementById('dl0'),dl1=document.getElementById('dl1'),dl2=document.getElementById('dl2');
  if(dl0)dl0.innerHTML=catEnfants('').map(x=>'<option value="'+esc(x)+'">').join('');
  if(dl1)dl1.innerHTML=catEnfants(c0.value.trim()).map(x=>'<option value="'+esc(x)+'">').join('');
  if(dl2)dl2.innerHTML=catEnfants([c0.value.trim(),c1?c1.value.trim():''].filter(Boolean).join(' : ')).map(x=>'<option value="'+esc(x)+'">').join('');
}
/* la sous-catégorie existe-t-elle sous ce parent ? (sinon elle vient de l'ancienne catégorie) */
function sousCatValide(parent,enfant){
  if(!enfant)return true;const e=enfant.trim().toLowerCase();
  return catEnfants(parent).some(x=>x.toLowerCase()===e);}
function catChangee(niveau){ // niveau 0 = catégorie, 1 = sous-catégorie
  const v=i=>document.getElementById('i-cat'+i).value.trim();
  if(niveau===0&&!sousCatValide(v(0),v(1))){document.getElementById('i-cat1').value='';document.getElementById('i-cat2').value='';}
  else if(niveau<=1&&!sousCatValide([v(0),v(1)].filter(Boolean).join(' : '),v(2)))document.getElementById('i-cat2').value='';
  majSousCats();
}
/* toucher un champ de catégorie déjà rempli : le texte passe en indication, la liste entière s'affiche ;
   rien choisi → l'ancien texte revient */
function catOuvrir(el){
  if(document.activeElement===el||!el.value)return;
  el.dataset.avant=el.value;el.dataset.indice=el.placeholder;el.placeholder=el.value;el.value='';
}
function catFermer(el){
  if(el.dataset.avant===undefined)return;
  const avant=el.dataset.avant;el.placeholder=el.dataset.indice||'';delete el.dataset.avant;delete el.dataset.indice;
  if(!el.value.trim())el.value=avant;
  else if(el.value.trim()!==avant)catChangee(+el.id.slice(-1));
}
/* téléphone : la liste des catégories proposées est la nôtre (pas celle du navigateur, qui chevauchait le champ
   et passait parfois sur le clavier) : elle s'ouvre toujours AU-DESSUS du champ touché */
function suggestionsCategorie(niveau,valeurs,tape){
  const parent=valeurs.slice(0,niveau).filter(Boolean).join(' : ');
  if(niveau>0&&!parent)return [];
  const q=(tape||'').trim().toLowerCase();
  return catEnfants(parent).filter(x=>!q||x.toLowerCase().includes(q)).slice(0,40);
}
const idListeCategories=pfx=>({'i-cat':'cat-sugg','rc-c':'rc-sugg'})[pfx]||pfx+'-sugg';
function majListeCategories(el,tout){
  const pfx=el.id.slice(0,-1),box=document.getElementById(idListeCategories(pfx));if(!box)return;
  const niveau=+el.id.slice(-1),vals=[0,1,2].map(i=>document.getElementById(pfx+i).value.trim());
  const items=suggestionsCategorie(niveau,vals,tout?'':el.value);
  if(!items.length){box.hidden=true;return;}
  box.innerHTML=items.map(x=>'<button type="button" data-v="'+esc(x)+'">'+esc(x)+'</button>').join('');
  box.dataset.pour=el.id;box.hidden=false;
  const carte=el.closest('.row3'),haut=el.closest('.field').offsetTop;
  box.style.bottom=(carte.clientHeight-haut+4)+'px'; // le bas de la liste juste au-dessus du champ
  box.style.maxHeight=Math.max(120,Math.min(260,haut+carte.getBoundingClientRect().top-90))+'px';
}
/* Répartition (téléphone) : la même liste maison que les catégories, au-dessus du champ, au lieu de la liste
   d'Android (blanche, qui restait dessinée en défilant). conteneurId : 'vent-box' (opération) ou 'rc-vent-box'
   (échéance) ; les lignes sont redessinées, d'où l'écoute sur le conteneur. */
const sansAccents=t=>t.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function suggestionsVentilation(tape){
  const q=sansAccents((tape||'').trim().toLowerCase());
  return catCheminsComplets().filter(x=>!q||sansAccents(x.toLowerCase()).includes(q)).slice(0,40);
}
function brancherListeVentilation(conteneurId){
  const c=document.getElementById(conteneurId);if(!c||c.querySelector('.cat-sugg'))return;
  const box=document.createElement('div');box.className='cat-sugg';box.hidden=true;c.appendChild(box);c.classList.add('avec-sugg');
  const estCat=el=>el&&el.tagName==='INPUT'&&el.closest('.vent-l')&&el===el.closest('.vent-l').querySelector('input');
  let pour=null;
  const montrer=el=>{
    const items=suggestionsVentilation(el.value);if(!items.length){box.hidden=true;return;}
    box.innerHTML=items.map(x=>'<button type="button" data-v="'+esc(x)+'">'+esc(x)+'</button>').join('');
    pour=el;box.hidden=false;
    const haut=el.getBoundingClientRect().top-c.getBoundingClientRect().top;
    box.style.bottom=(c.clientHeight-haut+4)+'px'; // le bas de la liste juste au-dessus du champ
    box.style.maxHeight=Math.max(120,Math.min(260,el.getBoundingClientRect().top-90))+'px';
  };
  c.addEventListener('focusin',e=>{if(estCat(e.target))montrer(e.target);});
  c.addEventListener('input',e=>{if(estCat(e.target))montrer(e.target);});
  c.addEventListener('focusout',e=>{if(estCat(e.target))setTimeout(()=>{if(document.activeElement!==pour)box.hidden=true;},150);});
  box.addEventListener('pointerdown',e=>e.preventDefault()); // le champ garde le clavier
  box.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||!pour)return;
    const el=pour;el.value=b.dataset.v;el.dispatchEvent(new Event('input',{bubbles:true}));box.hidden=true;
    const m=el.closest('.vent-l').querySelectorAll('input')[1];if(m){m.focus();if(m.select)m.select();}}); // puis son montant
}
/* pfx : 'i-cat' (opération) ou 'rc-c' (échéance) ; apres(niveau) : après un choix (sous-catégories à vider…) */
function brancherListeCategories(pfx,carte,apres){
  pfx=pfx||'i-cat';carte=carte||document.querySelector('#cat-simple .row3');apres=apres||(n=>catChangee(n));
  const idBox=idListeCategories(pfx);
  if(!carte||document.getElementById(idBox))return;
  const box=document.createElement('div');box.id=idBox;box.className='cat-sugg';box.hidden=true;carte.appendChild(box);carte.classList.add('avec-sugg');
  box.addEventListener('pointerdown',e=>e.preventDefault()); // le champ garde le clavier
  box.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    const el=document.getElementById(box.dataset.pour);if(!el)return;const n=+el.id.slice(-1);
    el.value=b.dataset.v;delete el.dataset.avant;if(el.dataset.indice!==undefined){el.placeholder=el.dataset.indice;delete el.dataset.indice;}
    box.hidden=true;apres(n);
    const suivant=document.getElementById(pfx+(n+1));
    if(suivant&&catEnfants([0,1,2].slice(0,n+1).map(i=>document.getElementById(pfx+i).value.trim()).join(' : ')).length)suivant.focus();
    else el.blur();});
  [0,1,2].forEach(i=>{const el=document.getElementById(pfx+i);if(!el)return;
    el.removeAttribute('list');
    el.addEventListener('focus',()=>majListeCategories(el,pfx!=='i-cat'));
    el.addEventListener('input',()=>majListeCategories(el));
    el.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement!==el&&box.dataset.pour===el.id)box.hidden=true;},150));});
}
function getCat(){return ['i-cat0','i-cat1','i-cat2'].map(id=>document.getElementById(id).value.trim()).filter(Boolean).join(' : ')||'Divers';}
function setType(t){state.addType=t;document.querySelectorAll('#seg button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
  const vir=(t==='virement');
  const destField=document.getElementById('i-dest').closest('.field');
  const vf=document.getElementById('vir-field');
  if(destField)destField.style.display=vir?'none':'';
  const vl=document.getElementById('vir-label');
  if(vl)vl.textContent=state.virEntrant?'Compte expéditeur':'Compte de destination';
  if(vf){vf.style.display=vir?'':'none';
    if(vir){const sel=document.getElementById('i-vircompte');
      const comptes=qy('SELECT id,nom FROM compte WHERE actif=1 AND id<>? ORDER BY ordre_affichage,id',[state.acc]);
      const cur=sel.value;
      sel.innerHTML=comptes.map(c=>'<option value="'+c.id+'">'+esc(c.nom)+'</option>').join('')||'<option value="">(aucun autre compte)</option>';
      if(cur)sel.value=cur;}}
  // en virement on garde la catégorie et la ventilation (à la demande de l'utilisatrice)
}

function openModal(id,focus){
  state.retourFiche=null;
  const o=id?qy(`SELECT o.*,t.nom dest FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id WHERE o.id=?`,[id])[0]:null;
  if(id&&!o)return;
  state.editing=o?o.id:null;
  state.virEntrant=!!(o&&o.montant>0); // virement reçu : le compte lié est l'expéditeur
  document.getElementById('modal-title').textContent=o?'Modifier l’opération':'Nouvelle opération';
  setType(o?(isVirCat(o.cat_path)?'virement':(o.montant>0?'credit':'debit')):'debit');
  if(o&&isVirCat(o.cat_path)){const mid=scal('SELECT miroir_id FROM operation WHERE id=?',[o.id]);
    const cible=mid?scal('SELECT compte_id FROM operation WHERE id=?',[mid]):null;
    const sel=document.getElementById('i-vircompte');if(sel&&cible)sel.value=cible;}
  document.getElementById('i-dest').value=o?(o.dest||''):'';
  state.vent=null;document.getElementById('i-vent').checked=false;
  document.getElementById('cat-simple').style.display='';document.getElementById('vent-box').style.display='none';
  if(o){
    const vs=qy(`SELECT v.montant,(SELECT GROUP_CONCAT(libelle,' : ') FROM (
        WITH RECURSIVE up(id,libelle,parent_id,lvl) AS (
          SELECT id,libelle,parent_id,0 FROM categorie WHERE id=v.categorie_id
          UNION ALL SELECT c.id,c.libelle,c.parent_id,up.lvl+1 FROM categorie c JOIN up ON c.id=up.parent_id)
        SELECT libelle FROM up ORDER BY lvl DESC)) cat
      FROM ventilation v WHERE v.operation_id=?`,[o.id]);
    if(vs.length>1){
      state.vent=vs.map(r=>{const opSign=o.montant<0?-1:1;
        const meme=(r.montant===0)||(Math.sign(r.montant)===opSign);
        return {cat:r.cat||'',m:(meme?'':'-')+fmt.format(Math.abs(r.montant)/100)};});
      document.getElementById('i-vent').checked=true;
      document.getElementById('cat-simple').style.display='none';
      document.getElementById('vent-box').style.display='';
      document.getElementById('dlfull').innerHTML=catCheminsComplets().map(x=>'<option value="'+esc(x)+'">').join('');
    }
  }
  document.getElementById('i-date').value=isoToShort(o?o.date_operation:todayISO());
  document.getElementById('i-montant').value=o?fmt.format(Math.abs(o.montant)/100):'';
  document.getElementById('i-num').value=o?(o.numero||''):'';
  document.getElementById('i-comm').value=o?(o.commentaire||''):'';
  document.getElementById('i-prev').checked=o?!!o.previsionnel:false;
  setCatFields(o&&!(state.vent)?o.cat_path:'');
  majSousCats();
  if(state.vent)ventRender();   // après que i-montant soit renseigné, sinon le total cible est périmé
  // téléphone, modification : le statut est rappelé sous le type (pour information, il se change dans la liste)
  const stEl=document.getElementById('i-statut'),stK=o?(o.previsionnel&&o.statut!=='annule'?'previsionnel':o.statut):null;
  stEl.hidden=!stK;if(stK)stEl.innerHTML='<i style="background:'+META[stK].col+'"></i>'+META[stK].label;
  const del=document.getElementById('btn-del'),ann=document.getElementById('btn-ann');
  del.style.display='none';ann.style.display='none';
  document.getElementById('btn-dup').style.display=o?'inline-flex':'none';
  const rapp=!!(o&&o.statut==='rapproche');
  state.editingRapproche=rapp;
  const mEl=document.getElementById('i-montant'),mHint=document.getElementById('i-montant-hint');
  mEl.readOnly=rapp;mEl.classList.toggle('locked-field',rapp);mHint.style.display=rapp?'':'none';
  document.querySelectorAll('#seg button').forEach(b=>b.disabled=rapp);
  const prevEl=document.getElementById('i-prev');
  prevEl.disabled=rapp;
  prevEl.title=rapp?'Une opération déjà rapprochée ne peut pas être rendue prévisionnelle':'';
  if(o){
    if(o.statut==='rapproche'){/* verrouillée : tout reste modifiable sauf le montant, confirmation demandée à l'enregistrement */}
    else if(o.statut==='annule'){ann.style.display='inline-flex';ann.textContent='Restaurer (dé-annuler)';}
    // téléphone : « Annuler » (pas d'autre bouton Annuler, on ferme avec la croix) ; PC : il y a déjà « Annuler » (fermer)
    else{del.style.display='inline-flex';ann.style.display='inline-flex';ann.textContent=document.body.classList.contains('mobile')?'Annuler':'Passer en annulé';}
  }
  closeAC();document.getElementById('overlay').classList.add('show');
  document.querySelector('#overlay .modal').scrollTop=0; // toujours ouverte en haut
  setTimeout(()=>{
    // sur écran tactile, pas de placement automatique dans un champ : le clavier ne s'ouvre que si on touche un champ
    // (sauf si on a touché un champ précis, depuis la fiche de l'opération : on y va directement)
    if(ecranTactile()&&!focus){if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();return;}
    const cible=focus==='montant'?document.getElementById('i-montant')
      :focus==='date'?document.getElementById('i-date')
      :focus==='num'?document.getElementById('i-num')
      :focus==='cat'||focus==='cat0'?document.getElementById('i-cat0')
      :focus==='cat1'?document.getElementById('i-cat1')
      :focus==='cat2'?document.getElementById('i-cat2')
      :/^ventc?\d*$/.test(focus||'')?(()=>{const c=focus[4]==='c',l=document.querySelectorAll('#vent-list .vent-l')[+focus.slice(c?5:4)||0];
        return l?l.querySelectorAll('input')[c?0:1]:document.querySelector('#vent-list input');})() // la catégorie ou le montant de la ligne touchée
      :focus==='comm'?document.getElementById('i-comm')
      :destEl();
    if(cible){cible.focus();if(cible.select)cible.select();if(ecranTactile()&&cible.scrollIntoView)cible.scrollIntoView({block:'center'});}
  },30);
}
/* Dupliquer : le formulaire devient une nouvelle opération avec les mêmes informations (destinataire,
   catégories ou répartition, montant, type, commentaire, prévisionnel), datée d'aujourd'hui, non pointée.
   Le n° (chèque…) n'est pas recopié. Rien n'est créé avant « Enregistrer ». */
function dupliquerOp(){
  if(!state.editing)return;
  const val=id=>document.getElementById(id).value;
  const copie={type:state.addType,entrant:state.virEntrant,vent:state.vent?state.vent.map(l=>Object.assign({},l)):null,
    prev:document.getElementById('i-prev').checked,vir:(document.getElementById('i-vircompte')||{}).value,
    champs:['i-dest','i-cat0','i-cat1','i-cat2','i-montant','i-comm'].map(id=>[id,val(id)])};
  openModal(null);
  setType(copie.type);state.virEntrant=copie.entrant;
  const vc=document.getElementById('i-vircompte');if(vc&&copie.vir)vc.value=copie.vir;
  copie.champs.forEach(([id,v])=>{document.getElementById(id).value=v;});
  document.getElementById('i-prev').checked=copie.prev;
  if(copie.vent){
    state.vent=copie.vent;document.getElementById('i-vent').checked=true;
    document.getElementById('cat-simple').style.display='none';document.getElementById('vent-box').style.display='';
    document.getElementById('dlfull').innerHTML=catCheminsComplets().map(x=>'<option value="'+esc(x)+'">').join('');
    ventRender();
  }
  majSousCats();
  document.getElementById('modal-title').textContent='Nouvelle opération (copie)';
  toast('Copie prête : vérifie la date, puis Enregistrer');
}
function closeModal(){document.getElementById('overlay').classList.remove('show');state.editing=null;closeAC();
  const f=state.retourFiche;state.retourFiche=null;
  if(f&&scal('SELECT COUNT(*) FROM operation WHERE id=? AND supprime=0',[f]))ouvrirFiche(f);}
function prefill(){const idx=tiersIndex(),v=destEl().value.trim();if(idx[v])setCatFields(idx[v]);}
function acRender(){
  const box=document.getElementById('ac');
  if(!acItems.length){box.classList.remove('show');box.innerHTML='';return;}
  const idx=tiersIndex();
  box.innerHTML=acItems.map((n,i)=>'<div class="ac-item'+(i===acIndex?' hl':'')+'" data-i="'+i+'"><span>'+esc(n)+
    '</span><span class="acat">'+esc(idx[n]||'')+'</span></div>').join('');
  box.classList.add('show');
  box.querySelectorAll('.ac-item').forEach(el=>el.addEventListener('mousedown',e=>{e.preventDefault();acAccept(+el.dataset.i);}));}
function acUpdate(){prefill();const v=destEl().value.toLowerCase().trim();
  let items=Object.keys(tiersIndex());if(v)items=items.filter(n=>n.toLowerCase().includes(v));
  acItems=items.slice(0,8);acIndex=acItems.length?0:-1;acRender();}
function acAccept(i){if(i<0||i>=acItems.length)return;destEl().value=acItems[i];prefill();closeAC();document.getElementById('i-cat0').focus();}
function closeAC(){const box=document.getElementById('ac');if(box){box.classList.remove('show');box.innerHTML='';}acItems=[];acIndex=-1;}

function upsertCategorie(chemin){
  const parts=catParts(chemin||'Divers').slice(0,3);let parent=null;
  for(const p of parts){
    let id=scal('SELECT id FROM categorie WHERE libelle=? AND parent_id IS ?',[p,parent]);
    if(!id){run('INSERT INTO categorie(libelle,parent_id) VALUES(?,?)',[p,parent]);id=lastId();}
    parent=id;}
  return parent;
}
function upsertTiers(nom){
  if(!nom)return null;
  let id=scal('SELECT id FROM tiers WHERE nom=?',[nom]);
  if(!id){run('INSERT INTO tiers(nom,date_creation) VALUES(?,?)',[nom,nowTS()]);id=lastId();}
  return id;
}
function libOp(id){const o=qy('SELECT o.montant m,o.date_operation d,t.nom dest FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id WHERE o.id=?',[id])[0];
  return o?((o.dest||'(sans tiers)')+' · '+eur(o.m)+' · '+isoToFr(o.d)):'opération #'+id;}
function makeHay(dest,cat,num,comm,mc,dateISO){
  const a=Math.abs(mc)/100;
  return [dest,cat,num,comm,isoToFr(dateISO),dateISO,
          fmt.format(a),                     // 1 234,56
          a.toFixed(2).replace('.',','),     // 1234,56
          a.toFixed(2)]                      // 1234.56
    .filter(Boolean).join(' ').toLowerCase();
}
function firstMissing(){
  if(state.addType==='virement'){
    const s=document.getElementById('i-vircompte');
    if(!s||!s.value)return ['i-vircompte',state.virEntrant?'un compte expéditeur':'un compte de destination'];
    if(!frToISO(document.getElementById('i-date').value))return ['i-date','une date valide (JJ/MM/AA)'];
    if(parseMontantC(document.getElementById('i-montant').value)==null)return ['i-montant','le montant'];
    return null;
  }
  if(!destEl().value.trim())return ['i-dest','le destinataire'];
  const ventile=document.getElementById('i-vent')&&document.getElementById('i-vent').checked;
  if(!ventile&&!document.getElementById('i-cat0').value.trim())return ['i-cat0','la catégorie'];
  if(!frToISO(document.getElementById('i-date').value))return ['i-date','une date valide (JJ/MM/AA)'];
  if(parseMontantC(document.getElementById('i-montant').value)==null)return ['i-montant','le montant'];
  return null;
}
async function saveOp(){
  const miss=firstMissing();
  if(miss){toast('Il manque '+miss[1]);document.getElementById(miss[0]).focus();return;}
  if(state.addType==='virement'){return saveVirement();}
  let mc=Math.abs(parseMontantC(document.getElementById('i-montant').value));
  if(state.addType!=='credit')mc=-mc;
  const dest=destEl().value.trim(),dISO=frToISO(document.getElementById('i-date').value);
  const num=document.getElementById('i-num').value.trim()||null,comm=document.getElementById('i-comm').value.trim()||null;
  const ventile=document.getElementById('i-vent').checked;
  let lignesV=null,cat;
  if(ventile){
    const brut=(state.vent||[]).map(l=>({cat:(l.cat||'').trim(),m:ventCentimes(l.m)||0}))
      .filter(l=>l.cat&&l.m!==0);
    if(brut.length<2){toast('Ajoute au moins deux catégories, ou décoche la répartition');return;}
    const som=brut.reduce((t,l)=>t+l.m,0);
    if(som!==mc){toast('La répartition ('+eur(som)+') doit égaler le montant ('+eur(mc)+')');return;}
    lignesV=brut.map(l=>({cat:l.cat,cid:upsertCategorie(l.cat),montant:l.m}));
    const tetes=[...new Set(brut.map(l=>l.cat.split(/\s*:\s*/)[0]))];
    cat=tetes.slice(0,2).join(' + ')+(tetes.length>2?' + …':'');
  }else{
    cat=getCat();
  }
  const tid=upsertTiers(dest);
  // en mode ventilé, la catégorie affichée « A + B » n'est qu'un libellé : on ne crée PAS de catégorie pour elle
  const cid=ventile?null:upsertCategorie(cat);
  const hay=makeHay(dest,ventile?((state.vent||[]).map(l=>l.cat).join(' ')+' '+cat):cat,num,comm,mc,dISO);
  const typ=state.addType==='virement'?'virement':(mc>0?'credit':'debit');
  let prev=document.getElementById('i-prev').checked?1:0;
  let _jrn=null;
  if(state.editing){
    const cur=qy('SELECT statut,montant FROM operation WHERE id=?',[state.editing])[0];
    if(cur&&cur.statut==='rapproche'){
      if(mc!==cur.montant){toast('Le montant d’une opération rapprochée ne peut pas être modifié');return;}
      prev=0; // une opération déjà rapprochée ne peut pas devenir prévisionnelle
      const ok=await dlgConfirm('Cette opération a déjà été rapprochée avec ton relevé bancaire.\n\nConfirmer la modification de ses autres caractéristiques (catégorie, ventilation, destinataire, commentaire…) ?','Opération rapprochée','Confirmer la modification',true);
      if(!ok)return;
    }
    run(`UPDATE operation SET type=?,date_operation=?,montant=?,tiers_id=?,numero=?,commentaire=?,previsionnel=?,cat_path=?,hay=?,date_modification=? WHERE id=?`,
      [typ,dISO,mc,tid,num,comm,prev,cat,hay,nowTS(),state.editing]);
    run('DELETE FROM ventilation WHERE operation_id=?',[state.editing]);
    if(lignesV){lignesV.forEach(l=>run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[state.editing,l.cid,l.montant]));}
    else run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[state.editing,cid,mc]);
    _jrn=['Modification',dest+' · '+eur(mc)+' · '+isoToFr(dISO)];
    toast('Opération modifiée');
  }else{
    run(`INSERT INTO operation(compte_id,type,date_operation,montant,tiers_id,numero,commentaire,statut,previsionnel,supprime,cat_path,hay,date_creation)
      VALUES(?,?,?,?,?,?,?,'non_pointe',?,0,?,?,?)`,[state.acc,typ,dISO,mc,tid,num,comm,prev,cat,hay,nowTS()]);
    const _oid=lastId();
    if(lignesV){lignesV.forEach(l=>run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[_oid,l.cid,l.montant]));}
    else run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[_oid,cid,mc]);
    _jrn=['Ajout',dest+' · '+eur(mc)+' · '+isoToFr(dISO)];
    toast('Opération ajoutée');
  }
  if(tid)run('UPDATE tiers SET date_dernier_paiement=MAX(COALESCE(date_dernier_paiement,\'\'),?),categorie_defaut_id=? WHERE id=?',[dISO,cid,tid]);
  const majCompare=REL&&REL.res&&REL.relCompte&&REL.compteId!=null;
  closeModal();touch(_jrn?_jrn[0]:null,_jrn?_jrn[1]:null);
  if(majCompare){lancerComparaison(REL.relCompte,REL.compteId,true);toast('Comparaison mise à jour');}
  else render();
}
async function saveVirement(){
  const cible=+document.getElementById('i-vircompte').value;
  if(!cible||cible===state.acc){toast('Choisis un autre compte');return;}
  const abs=Math.abs(parseMontantC(document.getElementById('i-montant').value));
  const dISO=frToISO(document.getElementById('i-date').value);
  const comm=document.getElementById('i-comm').value.trim()||null;
  let prev=document.getElementById('i-prev').checked?1:0;
  let catV=getCat();if(!isVirCat(catV))catV='Virement interne'+(catV&&catV!=='Divers'?' : '+catV:'');
  const cid=upsertCategorie(catV);
  // sens : virement reçu (édité depuis le compte destinataire) ou émis depuis le compte courant
  const entrant=!!(state.editing&&state.virEntrant);
  const src=entrant?cible:state.acc,dst=entrant?state.acc:cible;
  const nomSrc=scal('SELECT nom FROM compte WHERE id=?',[src]);
  const nomDst=scal('SELECT nom FROM compte WHERE id=?',[dst]);
  const libSrc=nomTiersVir(-1,nomDst),libDst=nomTiersVir(1,nomSrc);
  const tSrc=upsertTiers(libSrc),tDst=upsertTiers(libDst);
  const haySrc=makeHay(libSrc,catV,null,comm,-abs,dISO);
  const hayDst=makeHay(libDst,catV,null,comm,abs,dISO);
  // côté de l'opération éditée (moi) et côté miroir (lui)
  const moi=entrant?{c:dst,m:abs,t:tDst,h:hayDst}:{c:src,m:-abs,t:tSrc,h:haySrc};
  const lui=entrant?{c:src,m:-abs,t:tSrc,h:haySrc}:{c:dst,m:abs,t:tDst,h:hayDst};
  if(state.editing){
    const cur=qy('SELECT statut,miroir_id,montant FROM operation WHERE id=?',[state.editing])[0];
    if(cur&&cur.statut==='rapproche'){
      if(abs!==Math.abs(cur.montant)){toast('Le montant d\u2019une op\u00e9ration rapproch\u00e9e ne peut pas \u00eatre modifi\u00e9');return;}
      prev=0; // une opération déjà rapprochée ne peut pas devenir prévisionnelle
      const ok=await dlgConfirm('Ce virement a d\u00e9j\u00e0 \u00e9t\u00e9 rapproch\u00e9 avec ton relev\u00e9 bancaire.\n\nConfirmer la modification de ses autres caract\u00e9ristiques ?','Op\u00e9ration rapproch\u00e9e','Confirmer la modification',true);
      if(!ok)return;
    }
    run(`UPDATE operation SET compte_id=?,type='virement',date_operation=?,montant=?,tiers_id=?,commentaire=?,previsionnel=?,cat_path=?,hay=?,date_modification=? WHERE id=?`,
      [moi.c,dISO,moi.m,moi.t,comm,prev,catV,moi.h,nowTS(),state.editing]);
    run('DELETE FROM ventilation WHERE operation_id=?',[state.editing]);
    run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[state.editing,cid,moi.m]);
    let mid=cur&&cur.miroir_id;
    if(mid){
      run(`UPDATE operation SET compte_id=?,type='virement',date_operation=?,montant=?,tiers_id=?,commentaire=?,previsionnel=?,cat_path=?,hay=?,date_modification=? WHERE id=?`,
        [lui.c,dISO,lui.m,lui.t,comm,prev,catV,lui.h,nowTS(),mid]);
      run('DELETE FROM ventilation WHERE operation_id=?',[mid]);
      run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[mid,cid,lui.m]);
    }else{
      run(`INSERT INTO operation(compte_id,type,date_operation,montant,tiers_id,commentaire,statut,previsionnel,supprime,cat_path,hay,miroir_id,date_creation)
        VALUES(?,'virement',?,?,?,?,'non_pointe',?,0,?,?,?,?)`,[lui.c,dISO,lui.m,lui.t,comm,prev,catV,lui.h,state.editing,nowTS()]);
      mid=lastId();run('UPDATE operation SET miroir_id=? WHERE id=?',[mid,state.editing]);
      run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[mid,cid,lui.m]);
    }
    toast('Virement modifi\u00e9');
  }else{
    run(`INSERT INTO operation(compte_id,type,date_operation,montant,tiers_id,commentaire,statut,previsionnel,supprime,cat_path,hay,date_creation)
      VALUES(?,'virement',?,?,?,?,'non_pointe',?,0,?,?,?)`,[state.acc,dISO,-abs,tSrc,comm,prev,catV,haySrc,nowTS()]);
    const oidSrc=lastId();
    run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[oidSrc,cid,-abs]);
    run(`INSERT INTO operation(compte_id,type,date_operation,montant,tiers_id,commentaire,statut,previsionnel,supprime,cat_path,hay,miroir_id,date_creation)
      VALUES(?,'virement',?,?,?,?,'non_pointe',?,0,?,?,?,?)`,[cible,dISO,abs,tDst,comm,prev,catV,hayDst,oidSrc,nowTS()]);
    const oidDst=lastId();
    run('UPDATE operation SET miroir_id=? WHERE id=?',[oidDst,oidSrc]);
    run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[oidDst,cid,abs]);
    toast('Virement cr\u00e9\u00e9 (op\u00e9ration miroir ajout\u00e9e dans \u00ab '+nomDst+' \u00bb)');
  }
  closeModal();touch('Virement',eur(abs)+' de '+nomSrc+' vers '+nomDst);render();
}
async function deleteOp(){
  const id=state.editing;if(!id)return;
  const o=qy('SELECT statut FROM operation WHERE id=?',[id])[0];
  if(!o||o.statut==='rapproche'){toast('Opération rapprochée : suppression impossible');return;}
  const jum=qy(`SELECT m.id,m.statut,c.nom cpt FROM operation o JOIN operation m ON m.id=o.miroir_id
    LEFT JOIN compte c ON c.id=m.compte_id WHERE o.id=? AND m.supprime=0`,[id])[0];
  if(jum&&jum.statut==='rapproche'){
    const go=await dlgOpen({title:'Opération jumelle déjà rapprochée',
      msg:'Ce virement a une opération jumelle dans « '+(jum.cpt||'autre compte')+' » qui est déjà rapprochée.\n\n'+
        'Il est préférable de ne pas supprimer cette opération.\n\n'+
        'Si tu la supprimes quand même, seule l’opération de ce compte ira à la corbeille : '+
        'l’opération rapprochée de « '+(jum.cpt||'autre compte')+' » ne sera PAS supprimée, '+
        'ce qui peut créer une incohérence entre les deux comptes.',
      buttons:[{t:'Ne pas supprimer',v:false,p:true},{t:'Supprimer uniquement celle-ci',v:true,d:true}]});
    if(!go)return;
    const l=libOp(id);
    run('UPDATE operation SET supprime=1,date_suppression=?,date_modification=? WHERE id=?',[nowTS(),nowTS(),id]);
    run('UPDATE operation SET miroir_id=NULL WHERE id=?',[jum.id]); // la jumelle rapprochée n'est plus liée
    closeModal();touch('Mise à la corbeille (jumelle rapprochée conservée)',l);render();
    toast('Opération mise à la corbeille — l’opération rapprochée de « '+(jum.cpt||'')+' » est conservée');
    return;
  }
  const ok=await dlgConfirm('Mettre cette opération à la corbeille ?\n\nTu pourras la restaurer depuis l’écran Corbeille.','Suppression','Mettre à la corbeille',true);
  if(!ok)return;
  const l=libOp(id);
  run('UPDATE operation SET supprime=1,date_suppression=?,date_modification=? WHERE id=?',[nowTS(),nowTS(),id]);
  const mid=scal('SELECT miroir_id FROM operation WHERE id=?',[id]);
  if(mid)run('UPDATE operation SET supprime=1,date_suppression=?,date_modification=? WHERE id=?',[nowTS(),nowTS(),mid]);
  closeModal();touch('Mise à la corbeille',l);render();toast(mid?'Virement mis à la corbeille (les deux opérations)':'Opération mise à la corbeille');
}
function annulOp(){
  const id=state.editing;if(!id)return;
  const o=qy('SELECT statut FROM operation WHERE id=?',[id])[0];if(!o)return;
  if(o.statut==='rapproche'){toast('Opération rapprochée : action impossible');return;}
  const l=libOp(id);let act;
  if(o.statut==='annule'){run('UPDATE operation SET statut=\'non_pointe\',date_annulation=NULL,date_modification=? WHERE id=?',[nowTS(),id]);act='Dé-annulation';toast('Opération restaurée');}
  else{run('UPDATE operation SET statut=\'annule\',date_annulation=?,date_modification=? WHERE id=?',[nowTS(),nowTS(),id]);act='Annulation';toast('Opération passée en annulé');}
  closeModal();touch(act,l);render();
}

/* ============================================================
   Sauvegarde / chargement fichier
   ============================================================ */
/* nom du fichier de sauvegarde (le module natif de l'appli n'accepte que ce format) */
function nomSauvegarde(d){
  const p2=x=>String(x).padStart(2,'0');
  const stamp=d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+'_'+p2(d.getHours())+'h'+p2(d.getMinutes())+'m'+p2(d.getSeconds());
  return 'comptes_'+stamp+'.sqlite';}
function messageSauvegarde(dossier,nom){return 'Sauvegarde enregistrée dans « '+dossier+' » : '+nom;}
/* Sauvegarder : dans le dossier choisi dans les Réglages, sinon dans Téléchargements. Si le dossier
   n'est plus accessible, on propose Téléchargements. Compté sauvegardé seulement si le fichier est écrit. */
let sauvegardeEnCours=false;
async function sauvegarder(){
  if(sauvegardeEnCours)return;sauvegardeEnCours=true;
  toastDurable('Sauvegarde en cours…');await nextFrame(); // affiché avant le travail (la base peut être grosse)
  try{await sauvegarderMaintenant();}finally{sauvegardeEnCours=false;const t=document.getElementById('toast');if(t.dataset.durable){t.classList.remove('show');delete t.dataset.durable;}}
}
async function sauvegarderMaintenant(){
  let data,nom;
  try{setMeta('updated',nowTS());data=db.export();nom=nomSauvegarde(new Date());}
  catch(e){dlgAlert('Échec de la sauvegarde : '+e.message,'Erreur');return;}
  const dossier=await dossierSauvegarde();
  try{
    if(dossier){
      try{await ecrireDansDossier(dossier,nom,data);}
      catch(e){
        const ok=await dlgConfirm('Le dossier « '+dossier.nom+' » n’est pas accessible ('+(e.message||e)+').\n\n'+
          'Enregistrer la sauvegarde dans Téléchargements à la place ?\nTu peux choisir un autre dossier dans les Réglages.',
          'Sauvegarde','Enregistrer dans Téléchargements');
        if(!ok)return;
        await versTelechargements(nom,data);sauvegardeFaite();toast(messageSauvegarde('Téléchargements',nom));return;
      }
      sauvegardeFaite();
      // case « Aussi dans Téléchargements » : une 2e copie ; si elle échoue, la sauvegarde dans le dossier reste faite
      if(REGLAGES.aussiTelechargements){
        try{await versTelechargements(nom,data);}
        catch(e){dlgAlert('Sauvegarde enregistrée dans « '+dossier.nom+' », mais pas la copie dans Téléchargements ('+(e.message||e)+').','Sauvegarde');return;}
        toast(messageSauvegarde(dossier.nom+' » et « Téléchargements',nom));return;
      }
      toast(messageSauvegarde(dossier.nom,nom));return;
    }
    await versTelechargements(nom,data);sauvegardeFaite();toast(messageSauvegarde('Téléchargements',nom));
  }catch(e){dlgAlert('Échec de la sauvegarde : '+(e.message||e),'Erreur');}
}
async function ecrireDansDossier(dossier,nom,data){
  if(enAppli()){await natif('enregistrer',{nom,donnees:enBase64(data),dossier:true});return;}
  const h=dossier.handle; // le navigateur peut redemander l'autorisation (le clic sur Sauvegarder le permet)
  if(await h.queryPermission({mode:'readwrite'})!=='granted'&&await h.requestPermission({mode:'readwrite'})!=='granted')
    throw new Error('autorisation refusée');
  const w=await (await h.getFileHandle(nom,{create:true})).createWritable();
  await w.write(data);await w.close();
}
async function versTelechargements(nom,data){
  if(enAppli()){await natif('enregistrer',{nom,donnees:enBase64(data)});return;}
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:'application/octet-stream'}));
  a.download=nom;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
}
/* ---------- Réglages de cet appareil : gardés hors de la base (IndexedDB de l'appareil, ou natif dans
   l'appli), donc ils ne voyagent pas avec les fichiers de sauvegarde ---------- */
const choixDossierPossible=()=>enAppli()||typeof window.showDirectoryPicker==='function';
async function dossierSauvegarde(){ // {nom, handle} ou null = Téléchargements
  try{
    if(enAppli()){const r=await natif('dossier');return r&&r.nom?{nom:r.nom}:null;}
    if(!choixDossierPossible())return null;
    const h=await idbGetKey('dossierSauvegarde');return h?{nom:h.name,handle:h}:null;
  }catch(e){return null;}
}
/* ---------- verrouillage de l'appli (Android) : empreinte, visage ou code du téléphone ----------
   Réglage de l'appareil (REGLAGES.verrou, REGLAGES.verrouDelai en minutes). À l'ouverture de l'appli, et au
   retour après verrouDelai minutes passées ailleurs, l'écran #verrou cache tout jusqu'à ce qu'Android confirme
   l'identité (natif 'deverrouiller' : l'appli ne voit jamais l'empreinte ni le code). Pendant la fenêtre
   d'Android, l'appli peut passer en arrière-plan (écran du code) : ce va-et-vient ne compte pas. */
const DELAIS_VERROU=[[0,'Tout de suite'],[1,'Après 1 min'],[5,'Après 5 min'],[15,'Après 15 min']];
let verrouCacheLe=null,verrouEnCours=false;
// l'appli revient au premier plan : faut-il la verrouiller ? (cacheLe : quand elle est passée en arrière-plan)
function doitVerrouiller(r,cacheLe,maintenant){return !!r.verrou&&cacheLe!=null&&maintenant-cacheLe>=r.verrouDelai*60000;}
const estVerrouille=()=>!document.getElementById('verrou').hidden;
function verrouiller(){
  if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();
  document.getElementById('verrou-msg').textContent='';
  document.getElementById('verrou').hidden=false;
}
async function confirmerIdentite(titre){ // true si Android confirme ; sinon le message d'Android
  verrouEnCours=true;
  try{const r=await natif('deverrouiller',{titre});return r&&r.ok?true:((r&&r.message)||'Non confirmé');}
  catch(e){return (e&&e.message)||String(e);}
  finally{verrouEnCours=false;verrouCacheLe=null;}
}
async function deverrouiller(){
  if(verrouEnCours)return;
  const r=await confirmerIdentite('Mes comptes');
  if(r===true)document.getElementById('verrou').hidden=true;
  else document.getElementById('verrou-msg').textContent=r;
}
function brancherVerrou(){
  document.addEventListener('visibilitychange',()=>{
    if(verrouEnCours||!REGLAGES.verrou)return;
    if(document.hidden){if(!estVerrouille())verrouCacheLe=Date.now();return;}
    if(doitVerrouiller(REGLAGES,verrouCacheLe,Date.now())){verrouiller();deverrouiller();}
    verrouCacheLe=null;
  });
  if(estVerrouille())deverrouiller();
}
// activer ou couper le verrouillage : Android confirme d'abord l'identité
async function basculerVerrou(cb){
  const voulu=cb.checked;cb.checked=!voulu;
  if(voulu){
    let r={};try{r=await natif('verrouDisponible');}catch(e){}
    if(!r||!r.ok){dlgAlert('Ce téléphone n’a pas de verrouillage d’écran (empreinte, visage, code ou schéma).\n\n'+
      'Ajoute-en un dans les réglages d’Android (Sécurité), puis reviens ici.','Verrouillage');return;}
  }
  const ok=await confirmerIdentite(voulu?'Activer le verrouillage':'Désactiver le verrouillage');
  if(ok!==true){toast('Verrouillage inchangé');return;}
  changerReglage('verrou',voulu);toast(voulu?'L’appli se verrouillera avec ton empreinte ou ton code':'Verrouillage désactivé');
}
/* ---------- réglages d'affichage de cet appareil : thème, barres de recherche en haut / en bas, montants
   masqués à l'ouverture. Gardés dans le localStorage de l'appareil (jamais dans la base, qui part dans les
   sauvegardes). ---------- */
function lireReglages(txt){
  let r={};try{r=JSON.parse(txt||'{}')||{};}catch(e){}
  return {theme:['clair','sombre'].indexOf(r.theme)>=0?r.theme:'auto',recherche:r.recherche==='bas'?'bas':'haut',masquer:r.masquer===true,
    verrou:r.verrou===true,aussiTelechargements:r.aussiTelechargements===true,verrouDelai:DELAIS_VERROU.some(d=>d[0]===r.verrouDelai)?r.verrouDelai:5};
}
let REGLAGES=lireReglages(null);
function chargerReglages(){try{REGLAGES=lireReglages(localStorage.getItem('mc.reglages'));}catch(e){}}
function appliquerReglages(ouverture){
  const r=REGLAGES,h=document.documentElement;
  if(r.theme==='auto')h.removeAttribute('data-theme');else h.setAttribute('data-theme',r.theme);
  document.body.classList.toggle('recherche-bas',r.recherche==='bas');
  document.body.classList.toggle('masquer-montants',r.masquer);
  if(ouverture||!r.masquer)document.body.classList.toggle('montants-masques',r.masquer);
  majOeil();
  if(enAppli())majBarresAppli();
}
/* appli : fond derrière les barres d'Android et couleur de leurs icônes, selon le thème de l'app (pas celui du
   téléphone : l'app en sombre sur un téléphone en clair, sinon, avait des icônes claires sur fond clair) */
const themeSombre=r=>r.theme==='sombre'||(r.theme==='auto'&&!!(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches));
function majBarresAppli(){
  const sombre=themeSombre(REGLAGES);
  Capacitor.nativePromise('SystemBars','setStyle',{style:sombre?'DARK':'LIGHT'}).catch(()=>{});
  natif('fondBarres',{sombre}).catch(()=>{});
}
function changerReglage(cle,val){
  REGLAGES=Object.assign({},REGLAGES,{[cle]:val});
  try{localStorage.setItem('mc.reglages',JSON.stringify(REGLAGES));}catch(e){}
  appliquerReglages(false);renderReglages();
}
function basculerMontants(){document.body.classList.toggle('montants-masques');majOeil();}
function majOeil(){const m=document.body.classList.contains('montants-masques');
  document.querySelectorAll('.m-oeil').forEach(b=>b.setAttribute('aria-label',m?'Afficher les montants':'Masquer les montants'));}
async function renderReglages(){
  [['rg-theme',REGLAGES.theme],['rg-recherche',REGLAGES.recherche]].forEach(([id,v])=>
    document.querySelectorAll('#'+id+' button').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.v===v))));
  document.getElementById('rg-masquer').checked=REGLAGES.masquer;
  // résumé d'une ligne sous le titre de chaque rubrique repliée
  const resume=(id,t)=>{document.getElementById(id+'-resume').textContent=t;};
  resume('rg-affichage',{auto:'Automatique',clair:'Clair',sombre:'Sombre'}[REGLAGES.theme]+(REGLAGES.masquer?' · montants masqués':''));
  resume('rg-barres',REGLAGES.recherche==='bas'?'En bas':'En haut');
  // verrouillage : seulement dans l'appli Android
  document.getElementById('rg-verrou').hidden=!enAppli();
  document.getElementById('rg-verrou-on').checked=REGLAGES.verrou;
  document.getElementById('rg-verrou-delai-bloc').hidden=!REGLAGES.verrou;
  document.querySelectorAll('#rg-verrou-delai button').forEach(b=>b.setAttribute('aria-checked',String(+b.dataset.v===REGLAGES.verrouDelai)));
  resume('rg-verrou',REGLAGES.verrou?'Empreinte ou code · '+DELAIS_VERROU.find(d=>d[0]===REGLAGES.verrouDelai)[1].toLowerCase():'Désactivé');
  document.getElementById('rg-version').textContent='Mes comptes · version '+VERSION;
  const d=await dossierSauvegarde(),possible=choixDossierPossible();
  const aussi=!!d&&REGLAGES.aussiTelechargements;
  resume('rg-sauvegarde',d?d.nom+(aussi?' + Téléchargements':''):'Téléchargements');
  document.getElementById('rg-aussi-bloc').hidden=!d;document.getElementById('rg-aussi').checked=REGLAGES.aussiTelechargements;
  document.getElementById('rg-dossier').textContent=d?d.nom:'Téléchargements';
  document.getElementById('rg-btns').hidden=!possible;
  document.getElementById('rg-defaut').hidden=!d;
  document.getElementById('rg-note').textContent=!possible
    ?'Ce navigateur ne permet pas de choisir un dossier : les sauvegardes vont dans Téléchargements.'
    :d?'Si ce dossier n’est plus accessible, l’app proposera d’enregistrer dans Téléchargements.':'Par défaut, les sauvegardes vont dans Téléchargements.';
}
async function choisirDossierSauvegarde(){
  try{
    let nom;
    if(enAppli()){const r=await natif('choisirDossier');if(!r||!r.nom)return;nom=r.nom;}
    else{const h=await window.showDirectoryPicker({id:'sauvegardes',mode:'readwrite'});await idbPutKey('dossierSauvegarde',h);nom=h.name;}
    toast('Les sauvegardes iront dans « '+nom+' »');
  }catch(e){if(!e||e.name!=='AbortError')dlgAlert('Impossible d’utiliser ce dossier.\n\n'+((e&&e.message)||e),'Réglages');}
  finally{renderReglages();}
}
async function oublierDossierSauvegarde(){
  try{if(enAppli())await natif('oublierDossier');else await idbPutKey('dossierSauvegarde',null);}
  catch(e){dlgAlert('Impossible de changer ce réglage.\n\n'+(e.message||e),'Réglages');return;}
  renderReglages();toast('Les sauvegardes iront dans « Téléchargements »');
}
function sauvegardeFaite(){
  setMeta('rev',(+getMeta('rev',0))+1);
  run('UPDATE journal SET sauve=1 WHERE sauve=0');refreshDirty();flushIDB();
}
async function chargerFichier(inp){
  const f=inp.files&&inp.files[0];inp.value='';if(!f)return;
  const buf=new Uint8Array(await f.arrayBuffer());
  let inc=null;
  try{const t=new SQL.Database(buf);
    const g=k=>{try{const r=t.exec("SELECT valeur FROM meta WHERE cle='"+k+"'");return r.length?r[0].values[0][0]:null;}catch(e){return null;}};
    inc={updated:g('updated'),rev:+(g('rev')||0),
      nops:(()=>{try{return t.exec('SELECT COUNT(*) FROM operation WHERE supprime=0')[0].values[0][0];}catch(e){return '?';}})()};
    t.close();
  }catch(e){await dlgAlert('Ce fichier ne semble pas être une base « Mes comptes ».','Fichier invalide');return;}
  const curUpd=getMeta('updated','—'),curRev=+getMeta('rev',0);
  const curOps=scal('SELECT COUNT(*) FROM operation WHERE supprime=0');
  const plusAncien=inc.updated&&curUpd!=='—'&&inc.updated<curUpd;
  const note=plusAncien?'\n\nÀ noter : ce fichier est un peu plus ancien que les données déjà présentes dans ce navigateur — normal si tu reviens d’un autre appareil. Choisis simplement la version que tu veux garder.':'';
  const ok=await dlgConfirm(
    'Déjà dans ce navigateur : '+curOps+' opérations · '+curUpd+' (rév. '+curRev+')\n'+
    'Fichier à charger : '+inc.nops+' opérations · '+(inc.updated||'date inconnue')+' (rév. '+inc.rev+')\n\n'+
    'Charger ce fichier remplacera le contenu actuel de ce navigateur.'+note,
    'Charger cette sauvegarde','Charger ce fichier',false);
  if(!ok)return;
  busy('Chargement…');await nextFrame();
  try{
    db.close();db=new SQL.Database(buf);db.run(SCHEMA);migrer();try{renommerVirements();}catch(_){}invalidateCaches();try{db.run('ANALYZE');}catch(_){}
    state.acc=+scal('SELECT id FROM compte WHERE actif=1 ORDER BY ordre_affichage,id LIMIT 1');
    state.page=1;try{run('UPDATE journal SET sauve=1 WHERE sauve=0');}catch(_){}
    refreshDirty();undoReset();await flushIDB();unbusy();render();
    toast('Sauvegarde chargée');
  }catch(e){unbusy();await dlgAlert('Échec du chargement : '+e.message,'Erreur');}
}

/* ============================================================
   Import QIF
   ============================================================ */
function qifParseDate(raw){
  const s=(raw||'').trim().replace(/'/g,'/');const p=s.split('/');
  if(p.length!==3)return null;
  let d=+p[0],m=+p[1],y=+p[2];
  if(isNaN(d)||isNaN(m)||isNaN(y))return null;
  if(y<100)y=y<70?2000+y:1900+y;
  if(m>12&&d<=12){const t=d;d=m;m=t;}
  if(m<1||m>12||d<1||d>31)return null;
  return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
}
function qifParseAmount(raw){
  let s=(raw||'').trim().replace(/\s/g,'');
  if(s.indexOf(',')>=0&&s.indexOf('.')>=0)s=s.replace(/,/g,'');
  else if(s.indexOf(',')>=0)s=s.replace(',','.');
  const v=parseFloat(s);return isNaN(v)?null:Math.round(v*100);
}
function parseQIF(text){
  const lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  const out=[];let cur=null,splits=[],section='transaction';
  const flush=()=>{if(cur){cur.splits=splits;out.push(cur);}cur=null;splits=[];};
  const blank=()=>({date:null,montant:null,statut:'non_pointe',tiers:'',categorie:'',memo:'',numero:''});
  for(const ln of lines){
    if(!ln)continue;
    if(ln[0]==='!'){flush();section=/^!account/i.test(ln)?'account':'transaction';continue;}
    if(ln[0]==='^'){if(section==='transaction')flush();else{cur=null;splits=[];}continue;}
    if(section==='account')continue;
    const code=ln[0],val=ln.slice(1);
    if(!cur)cur=blank();
    switch(code){
      case 'D':cur.date=qifParseDate(val);break;
      case 'T':case 'U':{const a=qifParseAmount(val);if(a!=null)cur.montant=a;break;}
      case 'C':{const c=val.trim();cur.statut=(c==='X'||c==='R')?'rapproche':(c==='*'||c==='c')?'pointe':'non_pointe';break;}
      case 'P':cur.tiers=val.trim();break;
      case 'L':cur.categorie=val.trim();break;
      case 'M':cur.memo=val.trim();break;
      case 'N':cur.numero=val.trim();break;
      case 'S':splits.push({categorie:val.trim(),memo:'',montant:null});break;
      case 'E':if(splits.length)splits[splits.length-1].memo=val.trim();break;
      case '$':if(splits.length)splits[splits.length-1].montant=qifParseAmount(val);break;
    }
  }
  flush();
  return out.filter(o=>o.montant!=null);
}
const isTransferCat=c=>/^\[.*\]$/.test((c||'').trim());
function cleanCat(c){c=(c||'').trim();
  if(isTransferCat(c))return 'Virement interne';
  return c.replace(/:/g,' : ').replace(/\s+/g,' ').trim()||'Divers';}

let qifPending=null;
async function chargerQif(inp){
  const f=inp.files&&inp.files[0];inp.value='';if(!f)return;
  busy('Lecture du fichier…');await nextFrame();
  let ops;
  try{
    const buf=await f.arrayBuffer();
    const txt=new TextDecoder('windows-1252').decode(buf);
    ops=parseQIF(txt);
  }catch(e){unbusy();await dlgAlert('Lecture impossible : '+e.message,'Erreur');return;}
  unbusy();
  if(!ops.length){await dlgAlert('Aucune opération trouvée dans ce fichier.','Import QIF');return;}
  qifPending=ops;
  const comptes=qy('SELECT id,nom FROM compte WHERE actif=1 ORDER BY ordre_affichage,id');
  const dates=ops.map(o=>o.date).filter(Boolean).sort();
  const totC=ops.reduce((t,o)=>t+o.montant,0);
  const html=
    '<div style="font-size:.88rem;color:var(--ink-2);margin-bottom:14px">'+
      ops.length.toLocaleString('fr-FR')+' opérations · du '+(dates.length?isoToFr(dates[0]):'?')+' au '+(dates.length?isoToFr(dates[dates.length-1]):'?')+
      '<br>Somme des montants : <b class="num">'+eur(totC)+'</b></div>'+
    '<div class="field"><label>Compte de destination</label><select id="qCompte" style="width:100%">'+
      comptes.map(c=>'<option value="'+c.id+'">'+esc(c.nom)+'</option>').join('')+'</select></div>'+
    '<div class="field"><label>Solde initial du compte (€)</label>'+
      '<input id="qSolde" type="text" inputmode="decimal" value="0,00" style="width:100%"></div>'+
    '<label class="radio on" id="rRemp"><input type="radio" name="qmode" value="remplacer" checked>'+
      '<span><span class="rt">Remplacer</span><span class="rd">Efface toutes les opérations existantes de ce compte, puis importe. À utiliser pour la migration depuis Money.</span></span></label>'+
    '<label class="radio" id="rAjout"><input type="radio" name="qmode" value="ajouter">'+
      '<span><span class="rt">Ajouter</span><span class="rd">Conserve l’existant et ajoute ces opérations à la suite (risque de doublons).</span></span></label>';
  let picked=null;
  const ok=await dlgOpen({title:'Importer un fichier QIF',msg:'',html,
    buttons:[{t:'Annuler',v:false},{t:'Importer',v:true,p:true,before:()=>{
      const sel=document.getElementById('qCompte');
      const sol=document.getElementById('qSolde');
      const mod=document.querySelector('input[name=qmode]:checked');
      if(!sel||!mod)return false;
      picked={compteId:+sel.value,soldeC:parseMontantC(sol?sol.value:'0')||0,mode:mod.value};
    }}],
    onOpen:()=>{
      const sync=()=>{
        const m=document.querySelector('input[name=qmode]:checked');
        const v=m?m.value:'remplacer';
        document.getElementById('rRemp').classList.toggle('on',v==='remplacer');
        document.getElementById('rAjout').classList.toggle('on',v==='ajouter');
      };
      document.querySelectorAll('input[name=qmode]').forEach(r=>r.addEventListener('change',sync));
      sync();
    }});
  if(!ok||!picked){qifPending=null;return;}
  await runImport(picked.compteId,picked.soldeC,picked.mode);
}
async function runImport(compteId,soldeC,mode){
  const ops=qifPending;qifPending=null;if(!ops)return;
  const t0=performance.now();
  await dlgOpen({title:'Import en cours',msg:'Préparation…',buttons:[],onOpen:async()=>{
    const bar=document.getElementById('dlgProgBar'),msg=document.getElementById('dlgMsg');
    document.getElementById('dlgProg').style.display='block';
    const setP=(p,t)=>{bar.style.width=p+'%';msg.textContent=t;};
    await nextFrame();
    try{
      run('BEGIN');
      if(mode==='remplacer'){
        setP(2,'Suppression des opérations existantes…');await nextFrame();
        run('DELETE FROM ventilation WHERE operation_id IN (SELECT id FROM operation WHERE compte_id=?)',[compteId]);
        run('DELETE FROM operation WHERE compte_id=?',[compteId]);
      }
      run('UPDATE compte SET solde_initial=? WHERE id=?',[soldeC,compteId]);
      const catCache=new Map(),tiCache=new Map();
      const getCat2=p=>{if(catCache.has(p))return catCache.get(p);const id=upsertCategorie(p);catCache.set(p,id);return id;};
      const getTi=n=>{if(!n)return null;if(tiCache.has(n))return tiCache.get(n);const id=upsertTiers(n);tiCache.set(n,id);return id;};
      const stOp=db.prepare(`INSERT INTO operation(compte_id,type,date_operation,montant,tiers_id,numero,commentaire,statut,previsionnel,supprime,cat_path,hay,date_creation)
        VALUES(?,?,?,?,?,?,?,?,0,0,?,?,?)`);
      const stV=db.prepare('INSERT INTO ventilation(operation_id,categorie_id,montant,commentaire) VALUES(?,?,?,?)');
      const ts=nowTS();let n=0,nv=0,desq=0,total=0;
      const N=ops.length,STEP=Math.max(200,Math.ceil(N/60));
      for(const o of ops){
        const cat=cleanCat(o.categorie);
        const dISO=o.date||todayISO();
        const typ=isTransferCat(o.categorie)?'virement':(o.montant>0?'credit':'debit');
        const tid=getTi(o.tiers);
        const hay=makeHay(o.tiers,cat,o.numero,o.memo,o.montant,dISO);
        stOp.run([compteId,typ,dISO,o.montant,tid,o.numero||null,o.memo||null,o.statut,cat,hay,ts]);
        const oid=scal('SELECT last_insert_rowid()');
        total+=o.montant;
        if(o.splits.length){
          let s=0;for(const sp of o.splits){const amt=sp.montant==null?0:sp.montant;
            stV.run([oid,getCat2(cleanCat(sp.categorie)),amt,sp.memo||null]);s+=amt;nv++;}
          if(s!==o.montant)desq++;
        }else stV.run([oid,getCat2(cat),o.montant,null]);
        if(tid)run('UPDATE tiers SET date_dernier_paiement=MAX(COALESCE(date_dernier_paiement,\'\'),?) WHERE id=?',[dISO,tid]);
        n++;
        if(n%STEP===0){setP(Math.round(n/N*96),'Insertion… '+n.toLocaleString('fr-FR')+' / '+N.toLocaleString('fr-FR'));await nextFrame();}
      }
      stOp.free();stV.free();
      setP(98,'Finalisation…');await nextFrame();
      run('COMMIT');
      try{run('ANALYZE');}catch(_){}
      const solde=soldeC+total;
      dlgClose(true);
      state.acc=compteId;state.page=1;
      touch('Import QIF',n.toLocaleString('fr-FR')+' opérations · '+(scal('SELECT nom FROM compte WHERE id=?',[compteId])||'')+' · mode '+(mode==='remplacer'?'remplacement':'ajout'));
      render();
      await flushIDB();
      await dlgAlert(
        n.toLocaleString('fr-FR')+' opérations importées en '+((performance.now()-t0)/1000).toFixed(1)+' s.\n\n'+
        'Ventilations créées : '+nv.toLocaleString('fr-FR')+
        (desq?('\nVentilations déséquilibrées : '+desq):'')+'\n\n'+
        'SOLDE CALCULÉ : '+eur(solde)+'\n\n'+
        'Vérifie que ce solde correspond bien à celui de Microsoft Money.','Import terminé');
    }catch(e){
      try{run('ROLLBACK');}catch(_){}
      dlgClose(false);
      await dlgAlert('Import interrompu : '+e.message+'\n\nAucune modification n’a été enregistrée.','Erreur');
    }
  }});
}

/* ============================================================
   Opérations récurrentes
   ============================================================ */
const FREQS={
  quotidienne:{label:'Chaque jour',pas:'j',n:1,preset:true},
  hebdomadaire:{label:'Chaque semaine',pas:'j',n:7,preset:true},
  mensuelle:{label:'Chaque mois',pas:'m',n:1,preset:true},
  bimestrielle:{label:'Tous les 2 mois',pas:'m',n:2,preset:true},
  trimestrielle:{label:'Chaque trimestre',pas:'m',n:3,preset:true},
  semestrielle:{label:'Chaque semestre',pas:'m',n:6,preset:true},
  annuelle:{label:'Chaque année',pas:'m',n:12,preset:true},
  // unités pour le mode personnalisé « tous les N … »
  jours:{label:'jour(s)',pas:'j',n:1,unite:true},
  semaines:{label:'semaine(s)',pas:'j',n:7,unite:true},
  mois:{label:'mois',pas:'m',n:1,unite:true}
};
/* libellé lisible d'une récurrence (préréglage ou personnalisée) */
function freqLabel(freq,intervalle){
  const f=FREQS[freq];if(!f)return freq;
  if(f.unite)return 'Tous les '+(intervalle||1)+' '+f.label;
  return f.label;
}
function todayISO(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
/* avance une date ISO d'une occurrence, en calant le jour du mois demandé */
function avancerDate(iso,freq,jour,intervalle){
  const f=FREQS[freq]||FREQS.mensuelle;const iv=intervalle||1;
  const d=new Date(iso+'T00:00:00');
  if(f.pas==='j'){d.setDate(d.getDate()+f.n*iv);return isoDe(d);}
  // pas mensuel : n*intervalle mois, puis on cale le jour (borné au dernier jour du mois)
  const m=d.getMonth()+f.n*iv;
  const y=d.getFullYear()+Math.floor(m/12),mm=((m%12)+12)%12;
  const dim=new Date(y,mm+1,0).getDate();
  const jr=Math.min(jour||d.getDate(),dim);
  return y+'-'+String(mm+1).padStart(2,'0')+'-'+String(jr).padStart(2,'0');
}
function isoDe(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}

function colonneExiste(table,col){
  try{return qy('PRAGMA table_info('+table+')').some(r=>r.name===col);}catch(e){return false;}
}
/* libellé d'un virement vu depuis un compte : sortant (montant<0) ou entrant */
function nomTiersVir(montant,nomAutre){return (montant<0?'Virement vers ':'Virement reçu de ')+nomAutre;}
/* met à jour le libellé (tiers) des virements liés d'après le compte d'en face ;
   retourne le nombre d'opérations modifiées */
function renommerVirements(){
  let n=0;
  qy(`SELECT o.id,o.montant,o.date_operation d,o.numero,o.commentaire,o.cat_path,o.tiers_id,c.nom autre
      FROM operation o JOIN operation m ON m.id=o.miroir_id JOIN compte c ON c.id=m.compte_id
      WHERE o.type='virement'`).forEach(o=>{
    const nom=nomTiersVir(o.montant,o.autre),tid=upsertTiers(nom);
    if(tid===o.tiers_id)return;
    run('UPDATE operation SET tiers_id=?,hay=? WHERE id=?',[tid,makeHay(nom,o.cat_path,o.numero,o.commentaire,o.montant,o.d),o.id]);n++;
  });
  // anciens tiers au nom d'un compte, devenus inutilisés
  if(n)run(`DELETE FROM tiers WHERE nom IN (SELECT nom FROM compte)
    AND id NOT IN (SELECT tiers_id FROM operation WHERE tiers_id IS NOT NULL)`);
  return n;
}
function migrer(){
  // opérations générées reliées à leur récurrence (permet la régénération propre)
  if(!colonneExiste('operation','recurrence_id')){
    try{run('ALTER TABLE operation ADD COLUMN recurrence_id INTEGER');}catch(e){}
  }
  if(!colonneExiste('compte','numero')){
    try{run('ALTER TABLE compte ADD COLUMN numero TEXT');}catch(e){}
  }
  if(!colonneExiste('recurrence','ventil')){
    try{run('ALTER TABLE recurrence ADD COLUMN ventil TEXT');}catch(e){}
  }
  if(!colonneExiste('operation','miroir_id')){try{run('ALTER TABLE operation ADD COLUMN miroir_id INTEGER');}catch(e){}}
  if(!colonneExiste('recurrence','compte_cible')){try{run('ALTER TABLE recurrence ADD COLUMN compte_cible INTEGER');}catch(e){}}
  // nettoyage : catégories parasites « A + B » créées par erreur à partir de libellés de ventilation
  try{
    run(`DELETE FROM categorie WHERE parent_id IS NULL AND libelle LIKE '% + %'
         AND id NOT IN (SELECT categorie_id FROM ventilation WHERE categorie_id IS NOT NULL)
         AND id NOT IN (SELECT parent_id FROM categorie WHERE parent_id IS NOT NULL)`);
  }catch(e){}
}
function _occExiste(rid,date){return scal('SELECT id FROM operation WHERE recurrence_id=? AND date_operation=? AND supprime=0',[rid,date]);}
function _creerOcc(r,date,prev){
  if(r.compte_cible){return _creerOccVirement(r,date,prev);}
  const tid=r.tiers?upsertTiers(r.tiers):null;
  let lignesV=null;
  if(r.ventil){try{const arr=JSON.parse(r.ventil);if(arr&&arr.length)lignesV=arr.map(l=>({cid:upsertCategorie(l.cat),montant:l.montant}));}catch(e){}}
  const cid=(!lignesV&&r.cat_path)?upsertCategorie(r.cat_path):null;
  const hay=makeHay(r.tiers||'',r.cat_path||'',null,r.commentaire||'',r.montant,date);
  run(`INSERT INTO operation(compte_id,type,date_operation,montant,tiers_id,numero,commentaire,statut,previsionnel,supprime,cat_path,hay,recurrence_id,date_creation)
    VALUES(?,?,?,?,?,NULL,?,'non_pointe',?,0,?,?,?,?)`,
    [r.compte_id,r.type,date,r.montant,tid,r.commentaire||null,prev,r.cat_path||null,hay,r.id,nowTS()]);
  const oid=lastId();
  if(lignesV){lignesV.forEach(l=>run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[oid,l.cid,l.montant]));}
  else if(cid)run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[oid,cid,r.montant]);
}
/* Génération des occurrences :
   - toute échéance arrivée à terme (date <= aujourd'hui) devient RÉELLE non pointée ;
     si un aperçu prévisionnel existait pour cette date et n'a pas été touché, il est promu ;
   - la PROCHAINE échéance à venir est toujours pré-affichée en PRÉVISIONNEL (aperçu) ;
   - au prochain lancement, dès que sa date est atteinte, elle passe en non pointée. */
function _creerOccVirement(r,date,prev){
  const cid=upsertCategorie(r.cat_path||'Virement interne');
  const abs=Math.abs(r.montant);
  const nomSrc=scal('SELECT nom FROM compte WHERE id=?',[r.compte_id]);
  const nomDst=scal('SELECT nom FROM compte WHERE id=?',[r.compte_cible]);
  const tSrc=upsertTiers(nomTiersVir(-1,nomDst)),tDst=upsertTiers(nomTiersVir(1,nomSrc));
  const insere=(compte,montant,tid,hay)=>{
    run(`INSERT INTO operation(compte_id,type,date_operation,montant,tiers_id,numero,commentaire,statut,previsionnel,supprime,cat_path,hay,recurrence_id,date_creation)
      VALUES(?,'virement',?,?,?,NULL,?,'non_pointe',?,0,?,?,?,?)`,
      [compte,date,montant,tid,r.commentaire||null,prev,r.cat_path||'Virement interne',hay,r.id,nowTS()]);
    const oid=lastId();run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[oid,cid,montant]);return oid;
  };
  const oSrc=insere(r.compte_id,-abs,tSrc,makeHay(nomTiersVir(-1,nomDst),'Virement interne',null,r.commentaire||'',-abs,date));
  const oDst=insere(r.compte_cible,abs,tDst,makeHay(nomTiersVir(1,nomSrc),'Virement interne',null,r.commentaire||'',abs,date));
  run('UPDATE operation SET miroir_id=? WHERE id=?',[oDst,oSrc]);
  run('UPDATE operation SET miroir_id=? WHERE id=?',[oSrc,oDst]);
}
function genererRecurrences(){
  const auj=todayISO(),recs=qy('SELECT * FROM recurrence WHERE actif=1');
  let cree=0;
  for(const r of recs){
    let p=r.prochaine, garde=0;
    // 1) échéances dues -> réelles non pointées
    while(p && p<=auj && (!r.date_fin || p<=r.date_fin) && garde<600){
      const id=_occExiste(r.id,p);
      if(!id){_creerOcc(r,p,0);cree++;}
      else run("UPDATE operation SET previsionnel=0 WHERE id=? AND previsionnel=1 AND statut='non_pointe' AND date_modification IS NULL",[id]);
      p=avancerDate(p,r.frequence,r.jour,r.intervalle);garde++;
    }
    // 2) prochaine échéance à venir -> aperçu prévisionnel
    if(p && (!r.date_fin || p<=r.date_fin) && !_occExiste(r.id,p)){_creerOcc(r,p,1);cree++;}
    if(p!==r.prochaine)run('UPDATE recurrence SET prochaine=? WHERE id=?',[p,r.id]);
  }
  return cree;
}
/* petit sélecteur de date réutilisable (dialogue) */
async function demanderDate(titre,defISO){
  const html='<input id="dq" class="datef" inputmode="numeric" maxlength="8" placeholder="JJ/MM/AA" value="'+(defISO?isoToShort(defISO):'')+'" style="width:170px;font-size:1.1rem" oninput="maskDate(this)" onblur="fixDate(this)">';
  let v=null;
  const ok=await dlgOpen({title:titre,msg:'',html,
    buttons:[{t:'Annuler',v:false},{t:'Valider',v:true,p:true,before:()=>{const iso=frToISO(document.getElementById('dq').value);if(!iso){toast('Date invalide');return false;}v=iso;}}],
    onOpen:()=>{const q=document.getElementById('dq');if(q){q.focus();q.select();}}});
  return ok?v:null;
}

/* Régénère les occurrences d'une récurrence après modification de ses réglages :
   on supprime les échéances encore intactes (non pointées, non modifiées, non rapprochées),
   on repositionne la prochaine échéance sur la date de début, puis on régénère.
   Les opérations déjà pointées/rapprochées/ventilées à la main sont conservées. */
/* échéance modifiée : seules les échéances d'aujourd'hui et à venir sont refaites. Le passé reste tel quel, même
   non pointé : sinon une échéance passée supprimée ou déplacée à une autre date revenait (« 1er septembre » créé
   en octobre). */
function prochaineDepuis(r,auj){let d=r.date_debut,g=0;while(d&&d<auj&&g<2000){d=avancerDate(d,r.frequence,r.jour,r.intervalle);g++;}return d;}
function regenererRecurrence(id){
  const auj=todayISO(),w="recurrence_id=? AND statut='non_pointe' AND supprime=0 AND date_modification IS NULL AND date_operation>=?";
  run('DELETE FROM ventilation WHERE operation_id IN (SELECT id FROM operation WHERE '+w+')',[id,auj]);
  run('DELETE FROM operation WHERE '+w,[id,auj]);
  const r=qy('SELECT * FROM recurrence WHERE id=?',[id])[0];
  if(r)run('UPDATE recurrence SET prochaine=? WHERE id=?',[prochaineDepuis(r,auj),id]);
  return genererRecurrences();
}
function recSort(col){
  if(state.recSort===col)state.recDir=-state.recDir;else{state.recSort=col;state.recDir=1;}
  renderRecurrences();
}
/* ---------- Échéances (téléphone) : ce mois-ci / ensuite / suspendues, ce qui reste à payer ou recevoir ce mois ----------
   r.prochaine = la prochaine échéance à venir (déjà créée en prévisionnel). Les virements ne comptent pas dans les totaux. */
function echeancesMobile(recs,auj){
  const finMois=isoDe(new Date(+auj.slice(0,4),+auj.slice(5,7),0)),out={mois:[],ensuite:[],suspendues:[],aPayer:0,aRecevoir:0};
  recs.slice().sort((a,b)=>(a.prochaine||'').localeCompare(b.prochaine||'')).forEach(r=>{
    const fini=r.date_fin&&r.prochaine>r.date_fin;
    if(!r.actif||fini){out.suspendues.push(r);return;}
    (r.prochaine<=finMois?out.mois:out.ensuite).push(r);
    if(r.compte_cible)return;
    // toutes les échéances d'ici la fin du mois (une hebdomadaire passe plusieurs fois)
    for(let d=r.prochaine,g=0;d&&d<=finMois&&(!r.date_fin||d<=r.date_fin)&&g<40;d=avancerDate(d,r.frequence,r.jour,r.intervalle),g++){
      if(d<auj)continue;
      if(r.montant<0)out.aPayer+=r.montant;else out.aRecevoir+=r.montant;
    }
  });
  return out;
}
function renderEcheancesMobile(){
  const recs=qy('SELECT r.*, c.nom cnom FROM recurrence r JOIN compte c ON c.id=r.compte_id');
  const E=echeancesMobile(recs,todayISO());
  const item=r=>{const d=r.prochaine||'';
    return '<button class="me-item'+(r.actif?'':' suspendue')+'" onclick="actionEcheance('+r.id+')">'+
      '<span class="me-date"><b>'+(r.actif&&d?+d.slice(8,10):'—')+'</b><small>'+(r.actif&&d?MOIS_COURT[+d.slice(5,7)-1]:'')+'</small></span>'+
      '<span class="me-nom">'+esc(r.tiers||'(sans destinataire)')+'<small>'+esc(freqLabel(r.frequence,r.intervalle)+' · '+(r.compte_cible?'virement':r.cnom)+(r.actif?'':' · suspendue'))+'</small></span>'+
      '<span class="num" style="color:'+(r.montant<0?'var(--ink)':'var(--credit)')+'">'+(r.montant<0?'':'+')+eur(r.montant)+'</span></button>';};
  const groupe=(t,l)=>l.length?'<div class="ma-h">'+t+'</div><div class="me-liste">'+l.map(item).join('')+'</div>':'';
  document.getElementById('m-echeances').innerHTML=
    '<p class="me-aide">Opérations qui reviennent : elles sont créées toutes seules, en prévisionnel, à chaque échéance.</p>'+
    '<div class="me-totaux"><div><small>Encore à payer ce mois</small><b class="num" style="color:var(--debit)">'+eur(E.aPayer)+'</b></div>'+
      '<div><small>Encore à recevoir</small><b class="num" style="color:var(--credit)">+'+eur(E.aRecevoir)+'</b></div></div>'+
    (recs.length?groupe('Ce mois-ci',E.mois)+groupe('Ensuite',E.ensuite)+groupe('Suspendues ou terminées',E.suspendues)
      :'<div class="m-vide">Aucune échéance pour le moment. Ajoute un loyer, un abonnement, un salaire…</div>')+
    '<button class="me-nouvelle" onclick="editRec(0)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Nouvelle échéance</button>';
}
// toucher une échéance : son détail, puis Modifier / Suspendre (Réactiver) / Supprimer
async function actionEcheance(id){
  const r=qy('SELECT r.*, c.nom cnom FROM recurrence r JOIN compte c ON c.id=r.compte_id WHERE r.id=?',[id])[0];if(!r)return;
  // toucher une ligne : la fenêtre de modification s'ouvre directement sur ce champ (comme la fiche d'une opération)
  const ligne=(k,v,champ)=>'<button type="button" class="me-info" onclick="dlgClose(&#39;champ:'+champ+'&#39;)"><span>'+k+'</span><b>'+v+'</b></button>';
  const html=ligne('Montant','<span class="num">'+(r.montant<0?'':'+')+eur(r.montant)+'</span>','rc-m')+ligne('Fréquence',esc(freqLabel(r.frequence,r.intervalle)),'rc-f')+
    ligne('Compte',esc(r.cnom),'rc-cpt')+ligne('Prochaine',r.actif?isoToFr(r.prochaine):'suspendue','rc-d')+
    ligne('Jusqu’au',r.date_fin?isoToFr(r.date_fin):'sans fin','rc-fin')+ligne('Commentaire',r.commentaire?esc(r.commentaire):'<em>ajouter</em>','rc-com');
  const v=await dlgOpen({title:r.tiers||'Échéance',html,fermeDehors:true,buttons:[
    {t:'Supprimer',v:'suppr',d:true},{t:r.actif?'Suspendre':'Réactiver',v:'susp'},{t:'Modifier',v:'mod',p:true}]});
  if(v==='mod')editRec(id);else if(v==='susp')toggleRec(id,r.actif?0:1);else if(v==='suppr')supprRec(id);
  else if(typeof v==='string'&&v.indexOf('champ:')===0)editRec(id,v.slice(6));
}
function renderRecurrences(){
  if(document.body.classList.contains('mobile')){renderEcheancesMobile();return;}
  const map={tiers:'LOWER(COALESCE(r.tiers,\'\'))',compte:'LOWER(c.nom)',montant:'r.montant',
    frequence:'r.frequence',debut:'r.date_debut',prochaine:'r.prochaine',commentaire:'LOWER(COALESCE(r.commentaire,\'\'))'};
  const col=map[state.recSort]||'r.prochaine',dir=state.recDir<0?'DESC':'ASC';
  const recs=qy(`SELECT r.*, c.nom cnom FROM recurrence r JOIN compte c ON c.id=r.compte_id
    ORDER BY r.actif DESC, `+col+` `+dir+`, r.prochaine`);
  // indicateur de tri dans l'en-tête
  ['tiers','compte','montant','frequence','debut','prochaine','commentaire'].forEach(k=>{
    const th=document.getElementById('rh-'+k);if(!th)return;
    th.textContent=th.textContent.replace(/[ ↑↓]+$/,'');
    if(state.recSort===k)th.textContent+=(state.recDir<0?' ↓':' ↑');
  });
  const body=document.getElementById('rec-rows');
  document.getElementById('rec-meta').textContent=recs.length?
    (recs.filter(r=>r.actif).length+' active(s) sur '+recs.length):'Aucune opération récurrente pour le moment.';
  if(!recs.length){body.innerHTML='<tr><td colspan="8" style="color:var(--ink-3);padding:18px">'+
    'Rien ici. Utilise « Nouvelle opération récurrente » pour créer un loyer, un abonnement, un salaire…</td></tr>';return;}
  body.innerHTML=recs.map(r=>{
    const signe=r.montant<0?'':'+';
    // seules les cellules de contenu sont estompées ; les boutons restent bien visibles
    const dim=r.actif?'':' style="opacity:.45"';
    return '<tr ondblclick="editRec('+r.id+')" title="Double-clic pour modifier">'+
      '<td'+dim+'><b>'+esc(r.tiers||'(sans destinataire)')+'</b><div class="sub">'+esc(r.cat_path||'À trier')+'</div>'+
        (r.actif?'':'<div class="sub" style="color:var(--debit)">suspendue</div>')+'</td>'+
      '<td'+dim+'>'+esc(r.cnom)+'</td>'+
      '<td class="num"'+(r.actif?'':' style="opacity:.45"')+' style="text-align:right;color:'+(r.montant<0?'var(--debit)':'var(--credit)')+'">'+signe+eur(r.montant)+'</td>'+
      '<td'+dim+'>'+freqLabel(r.frequence,r.intervalle)+'</td>'+
      '<td class="num"'+dim+'>'+isoToFr(r.date_debut)+(r.date_fin?'<div class="sub">→ '+isoToFr(r.date_fin)+'</div>':'<div class="sub">sans fin</div>')+'</td>'+
      '<td class="num"'+dim+'>'+(r.actif?isoToFr(r.prochaine):'—')+(r.actif?'<div class="sub" style="color:#7C3AED">aperçu prévisionnel</div>':'')+'</td>'+
      '<td'+dim+'>'+(r.commentaire?esc(r.commentaire):'<span style="color:var(--ink-3)">—</span>')+'</td>'+
      '<td style="white-space:nowrap">'+
        '<button class="ghost" onclick="editRec('+r.id+')">Modifier</button> '+
        '<button class="'+(r.actif?'ghost':'primary')+'" onclick="toggleRec('+r.id+','+(r.actif?0:1)+')">'+(r.actif?'Suspendre':'Réactiver')+'</button> '+
        '<button class="ghost danger" onclick="supprRec('+r.id+')">Supprimer</button>'+
      '</td></tr>';
  }).join('');
}

function rcFreqMaj(){
  const sel=document.getElementById('rc-f'),bloc=document.getElementById('rc-perso');
  if(sel&&bloc)bloc.style.display=(sel.value==='__perso')?'':'none';
}
function rcSetType(t){const s=document.getElementById('rc-s');if(s)s.value=t;
  document.querySelectorAll('#rc-seg button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
  rcSensMaj();const vc=document.getElementById('rc-vent');if(vc&&vc.checked)rcVentTotal();}
function rcSensMaj(){
  const sel=document.getElementById('rc-s');if(!sel)return;const vir=(sel.value==='virement');
  const set=(id,d)=>{const e=document.getElementById(id);if(e)e.style.display=d;};
  set('rc-vir-field',vir?'':'none');set('rc-dest-field',vir?'none':'');
  const lbl=document.getElementById('rc-cpt-lbl');if(lbl)lbl.textContent=vir?'Compte source':'Compte';
}
function rcVentSensSign(){const s=document.getElementById('rc-s');return (s&&s.value==='credit')?1:-1;}
function rcVentCentimes(raw){const c=parseMontantC(raw);if(c==null)return null;const mag=Math.abs(c),moins=/^\s*-/.test(raw||'');const op=rcVentSensSign();return (moins?-op:op)*mag;}
function rcVentToggle(on){
  document.getElementById('rc-cat-simple').style.display=on?'none':'';
  document.getElementById('rc-vent-box').style.display=on?'':'none';
  if(on){
    document.getElementById('rc-dlfull').innerHTML=catCheminsComplets().map(x=>'<option value="'+esc(x)+'">').join('');
    if(!state.rcVent||!state.rcVent.length){
      const g=x=>(document.getElementById(x)||{}).value||'';
      const c=[g('rc-c0').trim(),g('rc-c1').trim(),g('rc-c2').trim()].filter(Boolean).join(' : ');
      state.rcVent=[{cat:c||'',m:g('rc-m').trim()||''},{cat:'',m:''}];
    }
    rcVentRender();
  }
}
function rcVentAdd(apres){state.rcVent=state.rcVent||[];let idx;
  if(typeof apres==='number'&&apres>=0){state.rcVent.splice(apres+1,0,{cat:'',m:''});idx=apres+1;}
  else{state.rcVent.push({cat:'',m:''});idx=state.rcVent.length-1;}
  rcVentRender();
  const l=document.querySelectorAll('#rc-vent-list .vent-l');if(l[idx]){const inp=l[idx].querySelector('input');if(inp)inp.focus();}
}
function rcVentDel(i){state.rcVent.splice(i,1);if(!state.rcVent.length)state.rcVent.push({cat:'',m:''});rcVentRender();}
function rcVentSet(i,k,v){if(state.rcVent&&state.rcVent[i]){state.rcVent[i][k]=v;rcVentTotal();}}
function rcVentRender(){
  const box=document.getElementById('rc-vent-list');
  box.innerHTML=(state.rcVent||[]).map((l,i)=>
    '<div class="vent-l">'+
      '<input'+(document.body.classList.contains('mobile')?'':' list="rc-dlfull"')+' value="'+esc(l.cat)+'" placeholder="Alimentation : Supermarché" oninput="rcVentSet('+i+',&#39;cat&#39;,this.value)">'+
      '<input inputmode="decimal" style="text-align:right" value="'+esc(l.m)+'" placeholder="0,00" oninput="rcVentSet('+i+',&#39;m&#39;,this.value)">'+
      '<button type="button" class="ghost vx" onclick="rcVentDel('+i+')" title="Retirer cette ligne">&#10005;</button>'+
    '</div>').join('');
  rcVentTotal();
}
function rcVentTotal(){
  const abs=Math.abs(parseMontantC(document.getElementById('rc-m').value)||0);
  const cible=rcVentSensSign()>0?abs:-abs;
  let som=0;(state.rcVent||[]).forEach(l=>{som+=(rcVentCentimes(l.m)||0);});
  const reste=cible-som;const el=document.getElementById('rc-vent-tot');
  el.className=(reste===0&&abs>0)?'ok':'bad';
  el.textContent='Réparti '+eur(Math.abs(som))+' / '+eur(Math.abs(cible))+(reste===0?' — équilibré':' — reste '+eur(Math.abs(reste)));
}
async function editRec(id,champ){
  const r=id?qy('SELECT * FROM recurrence WHERE id=?',[id])[0]:null;
  const comptes=qy('SELECT id,nom FROM compte WHERE actif=1 ORDER BY ordre_affichage,id');
  const lv=catLevels(),dl=k=>lv[k].map(v=>'<option value="'+esc(v)+'">').join('');
  const pc=catParts(r?r.cat_path:'');
  const estPerso=r&&FREQS[r.frequence]&&FREQS[r.frequence].unite;
  const optF=Object.keys(FREQS).filter(k=>FREQS[k].preset).map(k=>'<option value="'+k+'"'+(!estPerso&&r&&r.frequence===k?' selected':(!r&&k==='mensuelle'?' selected':''))+'>'+FREQS[k].label+'</option>').join('')
    +'<option value="__perso"'+(estPerso?' selected':'')+'>Personnalisée…</option>';
  const optU=Object.keys(FREQS).filter(k=>FREQS[k].unite).map(k=>'<option value="'+k+'"'+(estPerso&&r.frequence===k?' selected':'')+'>'+FREQS[k].label+'</option>').join('');
  const optC=comptes.map(c=>'<option value="'+c.id+'"'+(r&&r.compte_id===c.id?' selected':(!r&&c.id===state.acc?' selected':''))+'>'+esc(c.nom)+'</option>').join('');
  const mt=r?fmt.format(Math.abs(r.montant)/100):'';
  const sens=r?(r.compte_cible?'virement':(r.montant<0?'debit':'credit')):'debit';
  const optVir=comptes.map(c=>'<option value="'+c.id+'"'+((r&&r.compte_cible===c.id)?' selected':'')+'>'+esc(c.nom)+'</option>').join('');
  const html=
    '<div class="seg" id="rc-seg" style="margin-bottom:12px">'+
      '<button type="button" data-t="debit" class="'+(sens==='debit'?'on':'')+'" onclick="rcSetType(&#39;debit&#39;)">Dépense</button>'+
      '<button type="button" data-t="credit" class="'+(sens==='credit'?'on':'')+'" onclick="rcSetType(&#39;credit&#39;)">Revenu</button>'+
      '<button type="button" data-t="virement" class="'+(sens==='virement'?'on':'')+'" onclick="rcSetType(&#39;virement&#39;)">Virement</button>'+
    '</div>'+
    '<input type="hidden" id="rc-s" value="'+sens+'">'+
    '<div class="field" id="rc-dest-field"><label>Destinataire</label><input id="rc-t" list="rc-tl" autocomplete="off" value="'+esc(r&&!r.compte_cible?(r.tiers||''):'')+'"></div>'+
    '<datalist id="rc-tl">'+Object.keys(tiersIndex()).map(t=>'<option value="'+esc(t)+'">').join('')+'</datalist>'+
    '<label class="ventchk" id="rc-ventchk"><input type="checkbox" id="rc-vent" onchange="rcVentToggle(this.checked)"> Répartir sur plusieurs catégories</label>'+
    '<div id="rc-cat-simple"><div class="row3">'+
      '<div class="field"><label>Catégorie</label><input id="rc-c0" list="rc-l0" value="'+esc(pc[0]||'')+'" oninput="majSousCatsRec()"></div>'+
      '<div class="field"><label>Sous-catégorie</label><input id="rc-c1" list="rc-l1" value="'+esc(pc[1]||'')+'" oninput="majSousCatsRec()"></div>'+
      '<div class="field"><label>Sous-sous-catégorie</label><input id="rc-c2" list="rc-l2" value="'+esc(pc[2]||'')+'"></div>'+
    '</div></div>'+
    '<div id="rc-vent-box" style="display:none">'+
      '<div class="venthead"><span>Catégorie</span><span style="text-align:right">Montant</span><span></span></div>'+
      '<div id="rc-vent-list"></div>'+
      '<div class="ventfoot"><button type="button" class="ghost" onclick="rcVentAdd()" title="Raccourci : touche +">+ Ajouter une ligne</button><span id="rc-vent-tot"></span></div>'+
      '<datalist id="rc-dlfull"></datalist>'+
    '</div>'+
    '<datalist id="rc-l0">'+dl(0)+'</datalist><datalist id="rc-l1">'+dl(1)+'</datalist><datalist id="rc-l2">'+dl(2)+'</datalist>'+
    '<div class="row3">'+
      '<div class="field rc-f-montant"><label for="rc-m">Montant (\u20ac)</label><input id="rc-m" inputmode="decimal" value="'+esc(mt)+'" oninput="if(document.getElementById(&#39;rc-vent&#39;).checked)rcVentTotal()"></div>'+
      '<div class="field rc-f-compte"><label id="rc-cpt-lbl">Compte</label><select id="rc-cpt">'+optC+'</select></div>'+
      '<div class="field" id="rc-vir-field" style="display:none"><label>Compte de destination</label><select id="rc-vircompte">'+optVir+'</select></div>'+
    '</div>'+
    '<div class="row2">'+
      '<div class="field rc-f-freq"><label>Fr\u00e9quence</label><select id="rc-f" onchange="rcFreqMaj()">'+optF+'</select></div>'+
      '<div class="field" id="rc-perso" style="'+(estPerso?'':'display:none')+'"><label>Tous les\u2026</label>'+
        '<div style="display:flex;gap:6px"><input id="rc-iv" inputmode="numeric" style="width:70px" value="'+(estPerso?(r.intervalle||1):'1')+'">'+
        '<select id="rc-u" style="flex:1">'+optU+'</select></div></div>'+
    '</div>'+
    '<div class="row3">'+
      '<div class="field rc-f-debut"><label>Premi\u00e8re \u00e9ch\u00e9ance</label><input id="rc-d" class="date datef" inputmode="numeric" maxlength="8" placeholder="JJ/MM/AA" value="'+(r?isoToShort(r.date_debut):isoToShort(todayISO()))+'" oninput="maskDate(this)" onblur="fixDate(this)"></div>'+
      '<div class="field rc-f-fin"><label>Fin (facultatif)</label><input id="rc-fin" class="date datef" inputmode="numeric" maxlength="8" placeholder="JJ/MM/AA" value="'+(r&&r.date_fin?isoToShort(r.date_fin):'')+'" oninput="maskDate(this)" onblur="fixDate(this)"></div>'+
      '<div class="field rc-f-com"><label>Commentaire</label><input id="rc-com" value="'+esc(r&&r.commentaire?r.commentaire:'')+'"></div>'+
    '</div>'+
    '<div class="rc-note" style="font-size:.8rem;color:var(--ink-3)">Les \u00e9ch\u00e9ances pass\u00e9es sont g\u00e9n\u00e9r\u00e9es automatiquement jusqu\u2019\u00e0 aujourd\u2019hui (en non point\u00e9). La prochaine \u00e9ch\u00e9ance \u00e0 venir est affich\u00e9e d\u2019avance en <b>pr\u00e9visionnel</b>.</div>';
  let data=null;
  const ok=await dlgOpen({title:id?'Modifier l’opération récurrente':'Nouvelle opération récurrente',msg:'',html,wide:true,
    buttons:[{t:'Annuler',v:false},{t:'Enregistrer',v:true,p:true,before:()=>{
      const g=x=>document.getElementById(x),val=x=>g(x)?g(x).value.trim():'';
      const dISO=frToISO(val('rc-d'));
      if(!dISO){toast('Première échéance invalide');return false;}
      let mc=Math.abs(parseMontantC(val('rc-m')));
      if(!mc){toast('Montant manquant');return false;}
      const estVir=g('rc-s').value==='virement';
      if(g('rc-s').value==='debit'||estVir)mc=-mc;
      if(estVir){
        const cible=+g('rc-vircompte').value;
        if(!cible||cible===+g('rc-cpt').value){toast('Choisis un autre compte de destination');return false;}
        const finISOv=val('rc-fin')?frToISO(val('rc-fin')):null;
        let freqv=g('rc-f').value,ivv=1;if(freqv==='__perso'){freqv=g('rc-u').value;ivv=Math.max(1,parseInt(val('rc-iv'),10)||1);}
        let catVr=[val('rc-c0'),val('rc-c1'),val('rc-c2')].filter(Boolean).join(' : ');
        if(!isVirCat(catVr))catVr='Virement interne'+(catVr?' : '+catVr:'');
        data={compte_id:+g('rc-cpt').value,type:'virement',montant:mc,compte_cible:cible,
          tiers:scal('SELECT nom FROM compte WHERE id=?',[cible]),cat_path:catVr,commentaire:val('rc-com')||null,
          frequence:freqv,intervalle:ivv,jour:+dISO.slice(8,10),date_debut:dISO,date_fin:finISOv,creer_en:'previsionnel',ventil:null};
        return;
      }
      const ventile=g('rc-vent')&&g('rc-vent').checked;
      let cats,ventil=null;
      if(ventile){
        const brut=(state.rcVent||[]).map(l=>({cat:(l.cat||'').trim(),m:rcVentCentimes(l.m)||0})).filter(l=>l.cat&&l.m!==0);
        if(brut.length<2){toast('Ajoute au moins deux catégories, ou décoche la répartition');return false;}
        const som=brut.reduce((t,l)=>t+l.m,0);
        if(som!==mc){toast('La répartition ('+eur(som)+') doit égaler le montant ('+eur(mc)+')');return false;}
        ventil=brut.map(l=>({cat:l.cat,montant:l.m}));
        const tetes=[...new Set(brut.map(l=>l.cat.split(/\s*:\s*/)[0]))];
        cats=tetes.slice(0,2).join(' + ')+(tetes.length>2?' + …':'');
      }else{
        cats=[val('rc-c0'),val('rc-c1'),val('rc-c2')].filter(Boolean).join(' : ');
        if(!cats){toast('Indique au moins une catégorie');return false;}
      }
      const finISO=val('rc-fin')?frToISO(val('rc-fin')):null;
      let freq=g('rc-f').value,iv=1;
      if(freq==='__perso'){freq=g('rc-u').value;iv=Math.max(1,parseInt(val('rc-iv'),10)||1);}
      data={compte_id:+g('rc-cpt').value,type:mc<0?'debit':'credit',montant:mc,
        tiers:val('rc-t')||null,cat_path:cats,commentaire:val('rc-com')||null,
        frequence:freq,intervalle:iv,jour:+dISO.slice(8,10),date_debut:dISO,date_fin:finISO,
        creer_en:'previsionnel',ventil:ventil?JSON.stringify(ventil):null,compte_cible:null};
    }}],
    onOpen:()=>{majSousCatsRec();rcFreqMaj();rcSensMaj();
      if(document.body.classList.contains('mobile')){ // téléphone : même liste de catégories que la saisie d'une opération
        brancherListeCategories('rc-c',document.querySelector('#rc-cat-simple .row3'),()=>majSousCatsRec());
        brancherListeVentilation('rc-vent-box');
        document.querySelector('#dlgBack .dlg').scrollTop=0;}
      state.rcVent=null;const vv=document.getElementById('rc-vent');if(vv)vv.checked=false;
      const cs=document.getElementById('rc-cat-simple'),vb=document.getElementById('rc-vent-box');
      if(cs)cs.style.display='';if(vb)vb.style.display='none';
      if(r&&r.ventil){try{const arr=JSON.parse(r.ventil);if(arr&&arr.length>1){
        const opSign=r.montant<0?-1:1;
        state.rcVent=arr.map(l=>{const meme=(l.montant===0)||(Math.sign(l.montant)===opSign);return {cat:l.cat||'',m:(meme?'':'-')+fmt.format(Math.abs(l.montant)/100)};});
        if(vv)vv.checked=true;rcVentToggle(true);
      }}catch(e){}}
      // nouvelle échéance sur téléphone : directement dans le montant (le clavier des chiffres s'ouvre)
      const vir=document.getElementById('rc-s').value==='virement',mob=document.body.classList.contains('mobile');
      // une ligne du détail touchée : directement sur ce champ (la liste s'ouvre pour une fréquence ou un compte)
      const foc=document.getElementById(champ||(vir||(mob&&!id)?'rc-m':'rc-t'));
      if(foc&&(!ecranTactile()||!id||champ)){foc.focus();if(champ&&foc.select&&foc.tagName==='INPUT')foc.select();
        if(champ&&foc.tagName==='SELECT'&&foc.showPicker)try{foc.showPicker();}catch(e){}
        if(champ&&foc.scrollIntoView)foc.scrollIntoView({block:'center'});}}});
  if(!ok||!data)return;
  if(id){
    run(`UPDATE recurrence SET compte_id=?,type=?,montant=?,tiers=?,cat_path=?,commentaire=?,
        frequence=?,intervalle=?,jour=?,date_debut=?,date_fin=?,creer_en=?,ventil=?,compte_cible=? WHERE id=?`,
      [data.compte_id,data.type,data.montant,data.tiers,data.cat_path,data.commentaire,
       data.frequence,data.intervalle,data.jour,data.date_debut,data.date_fin,data.creer_en,data.ventil,data.compte_cible||null,id]);
    regenererRecurrence(id);   // recale la prochaine échéance et régénère les occurrences intactes
    touch('Récurrence modifiée',(data.tiers||'')+' · '+eur(data.montant));
  }else{
    run(`INSERT INTO recurrence(compte_id,type,montant,tiers,cat_path,commentaire,frequence,intervalle,jour,date_debut,date_fin,prochaine,creer_en,ventil,compte_cible,actif,date_creation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [data.compte_id,data.type,data.montant,data.tiers,data.cat_path,data.commentaire,
       data.frequence,data.intervalle,data.jour,data.date_debut,data.date_fin,data.date_debut,data.creer_en,data.ventil,data.compte_cible||null,nowTS()]);
    touch('Récurrence créée',(data.tiers||'')+' · '+eur(data.montant));
  }
  const nb=genererRecurrences();
  render();
  if(nb)toast(nb+' échéance(s) générée(s)');
}
async function toggleRec(id,on){
  if(!on){run('UPDATE recurrence SET actif=0 WHERE id=?',[id]);touch('Récurrence suspendue','');render();return;}
  // réactivation : compter les échéances manquées pendant la suspension
  const r=qy('SELECT * FROM recurrence WHERE id=?',[id])[0];const auj=todayISO();
  let p=r.prochaine,manques=0,g=0;
  while(p&&p<=auj&&(!r.date_fin||p<=r.date_fin)&&g<600){if(!_occExiste(id,p))manques++;p=avancerDate(p,r.frequence,r.jour,r.intervalle);g++;}
  run('UPDATE recurrence SET actif=1 WHERE id=?',[id]);
  if(manques>0){
    const choix=await dlgOpen({title:'Réactiver la récurrence',
      msg:manques+' échéance(s) sont arrivées à terme pendant la suspension. Comment reprendre ?',
      buttons:[{t:'Tout rattraper',v:'all',p:true},{t:'Reprendre à une date…',v:'date'},{t:'Seulement à partir de la prochaine à venir',v:'next'}]});
    if(choix==='next'){
      let q=r.prochaine,gg=0;while(q&&q<=auj&&gg<600){q=avancerDate(q,r.frequence,r.jour,r.intervalle);gg++;}
      run('UPDATE recurrence SET prochaine=? WHERE id=?',[q,id]);
    }else if(choix==='date'){
      const d=await demanderDate('Reprendre à partir du',auj);
      if(d)run('UPDATE recurrence SET prochaine=?,jour=? WHERE id=?',[d,+d.slice(8,10),id]);
    }
    // 'all' ou annulé : on laisse prochaine tel quel -> tout rattraper
  }
  const nb=genererRecurrences();touch('Récurrence réactivée','');render();
  if(nb)toast(nb+' échéance(s) générée(s)');
}
async function supprRec(id){
  const r=qy('SELECT tiers,montant FROM recurrence WHERE id=?',[id])[0];
  if(!await dlgConfirm('Supprimer cette opération récurrente ?\n\nLes opérations déjà générées ne sont pas touchées.',
    'Supprimer la récurrence','Supprimer',true))return;
  run('DELETE FROM recurrence WHERE id=?',[id]);
  touch('Récurrence supprimée',(r&&r.tiers||'')+'');render();
}

/* ============================================================
   Comparaison avec un relevé PDF
   ============================================================ */
function relDateISO(s){const m=(s||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);return m?(m[3]+'-'+m[2]+'-'+m[1]):null;}
function relMontant(s){let t=(s||'').replace(/\s/g,'').replace(/\./g,'').replace(',','.');
  const v=parseFloat(t);return isNaN(v)?null:Math.round(v*100);}
function addDays(iso,n){const d=new Date(iso+'T00:00:00');d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function normLib(s){return (s||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
const BRUIT=/^(PAIEMENT|CB|PSC|PRLV|SEPA|VIR|VIREMENT|CARTE|REF|FACTURE|ECHEANCE|DU|DE|LE|CHEQUE|N|RETRAIT|DAB)$/;
function motsUtiles(lib){return normLib(lib).split(' ').filter(m=>m.length>2&&!BRUIT.test(m)&&!/^\d+$/.test(m));}

/* Rapprochement UNIQUEMENT sur les nombres : montant strictement égal,
   date de l'opération (jamais la date de valeur) à +/- TOL_J jours.
   Les opérations DÉJÀ RAPPROCHÉES participent à la recherche exacte,
   pour ne jamais proposer de recréer un doublon de ce qui est soldé. */
const TOL_J=5;
function comparer(relOps,appOps){
  const pris=new Set(),res={rapproches:[],deja:[],proches:[],aCreer:[],ignores:[]};
  const dates=relOps.map(o=>o.date).filter(Boolean).sort();
  const dMin=dates[0],dMax=dates[dates.length-1];
  const ecart=(a,b)=>Math.round((new Date(a)-new Date(b))/86400000);
  const fen=(r,a)=>Math.abs(ecart(r.date,a.date))<=TOL_J;
  const valides=relOps.filter(r=>r.date&&r.montant!=null);

  // PASSE 1 — montants STRICTEMENT égaux : ils sont prioritaires sur tout le reste
  const reste=[];
  for(const r of valides){
    let c=appOps.filter(a=>!pris.has(a.id)&&a.montant===r.montant&&fen(r,a));
    if(!c.length){reste.push(r);continue;}
    c.sort((x,y)=>Math.abs(ecart(r.date,x.date))-Math.abs(ecart(r.date,y.date)));
    const a=c[0];pris.add(a.id);
    const item={rel:r,app:a,ecartJours:ecart(r.date,a.date),ambigu:c.length>1,on:true,
      cands:c.slice(0,8).map(z=>({id:z.id,date:z.date,montant:z.montant,dest:z.dest,cat:z.cat,statut:z.statut}))};
    if(a.statut==='rapproche'){item.on=false;res.deja.push(item);}else res.rapproches.push(item);
  }
  // PASSE 2 — montants proches, uniquement sur ce qui n'a pas trouvé son jumeau exact
  for(const r of reste){
    const seuil=Math.max(100,Math.round(Math.abs(r.montant)*0.02));
    let pr=appOps.filter(a=>!pris.has(a.id)&&a.statut!=='rapproche'&&fen(r,a)&&
      Math.sign(a.montant)===Math.sign(r.montant)&&Math.abs(a.montant-r.montant)<=seuil);
    if(pr.length){
      pr.sort((x,y)=>Math.abs(x.montant-r.montant)-Math.abs(y.montant-r.montant));
      pris.add(pr[0].id);   // réservée : ne pas la proposer à une autre ligne du relevé
      res.proches.push({rel:r,app:pr[0],ecartMontant:pr[0].montant-r.montant,
        ecartJours:ecart(r.date,pr[0].date),on:false,cands:pr.slice(0,8).map(z=>({id:z.id,date:z.date,montant:z.montant,dest:z.dest,cat:z.cat,statut:z.statut}))});
    }else res.aCreer.push({rel:r,on:true});
  }
  // PASSE 3 — dans les comptes, absentes du relevé (hors déjà rapprochées)
  for(const a of appOps){
    if(pris.has(a.id)||a.statut==='rapproche')continue;
    if(dMin&&a.date<addDays(dMin,-TOL_J))continue;
    if(dMax&&a.date>addDays(dMax,TOL_J))continue;
    if(res.proches.some(x=>x.app.id===a.id))continue;
    res.ignores.push({app:a});
  }
  return res;
}
function proposer(libelle,tiersList){
  const mots=motsUtiles(libelle);let best=null,bs=0;
  for(const t of tiersList){const nt=normLib(t.nom);if(nt.length<3)continue;let sc=0;
    if(normLib(libelle).includes(nt))sc=nt.length*2;
    else{const mt=motsUtiles(t.nom),inter=mt.filter(m=>mots.includes(m));if(inter.length)sc=inter.join('').length;}
    if(sc>bs){bs=sc;best=t;}}
  if(best)return {tiers:best.nom,cat:best.cat||'À trier',trouve:true};
  return {tiers:(mots.slice(0,3).join(' ')||normLib(libelle).slice(0,40)||'Inconnu'),cat:'À trier',trouve:false};
}

/* --- lecture du PDF : reconstitution des lignes puis des opérations --- */
function lignesDePage(items){
  const L={};
  items.forEach(i=>{const s=(i.str||'').trim();if(!s)return;
    const k=Math.round(i.transform[5]/3);
    (L[k]=L[k]||[]).push({s,x:Math.round(i.transform[4])});});
  return Object.keys(L).sort((a,b)=>b-a).map(k=>{
    const ln=L[k].sort((a,b)=>a.x-b.x);ln.y=k*3;return ln;});
}
/* bas de page : mentions légales, adresses, pagination — jamais un libellé d'opération */
const PIED=/(protection des comptes|garantie des d.p.ts|sous r.serve des extournes|caisse de cr.dit mutuel|soci.t. coop.rative|tva intracommunautaire|m.diateur|orias|rcs |r.gie par les art|www\.|page \d|suite au verso|appel non surtax)/i;
const RE_MONTANT=/^\d{1,3}(?:\.?\d{3})*,\d{2}$/;
function parseReleve(pagesItems){
  const comptes=[];let cur=null,lastOp=null,lastOpY=0,seuil=475;
  for(const items of pagesItems){
    for(const ln of lignesDePage(items)){
      const txt=ln.map(i=>i.s).join(' ');
      const dbt=ln.find(i=>/^D.bit/i.test(i.s)),cdt=ln.find(i=>/^Cr.dit/i.test(i.s));
      if(dbt&&cdt){seuil=Math.round((dbt.x+cdt.x)/2);continue;}
      if(/^(C\/C|LIVRET|PEL|CSL|CEL|LDD|COMPTE)\b/i.test(txt)&&/en euros/i.test(txt)){
        cur={titre:txt.trim(),cle:cleReleveCompte(txt),ops:[],soldes:[]};comptes.push(cur);lastOp=null;continue;}
      if(!cur)continue;
      if(PIED.test(txt)){lastOp=null;continue;}
      const mt=ln.find(i=>i.x>350&&RE_MONTANT.test(i.s));
      if(/SOLDE\s+(CR.DITEUR|D.BITEUR)/i.test(txt)){
        if(mt){const v=relMontant(mt.s);const neg=/D.BITEUR/i.test(txt);
          const d=(txt.match(/(\d{2}\/\d{2}\/\d{4})/)||[])[1];
          cur.soldes.push({date:relDateISO(d||''),montant:neg?-v:v});}
        lastOp=null;continue;}
      // les dates sont repérées partout et retirées du libellé ;
      // la 1re est la date d'opération, la 2e la date de valeur (non utilisée)
      const RE_D=/^\d{2}\/\d{2}\/\d{4}$/;
      const datesLn=ln.filter(i=>RE_D.test(i.s)&&i.x<260);
      const estDate=datesLn.length>0&&datesLn[0].x<160;
      const lib=ln.filter(i=>i.x>=100&&i.x<380&&!RE_D.test(i.s)&&i!==mt).map(i=>i.s).join(' ').trim();
      if(estDate&&mt){
        const v=relMontant(mt.s);
        lastOp={date:relDateISO(datesLn[0].s),dateValeur:datesLn[1]?relDateISO(datesLn[1].s):null,
                montant:mt.x<seuil?-v:v,libelle:lib,colonne:mt.x<seuil?'débit':'crédit',xm:mt.x};
        cur.ops.push(lastOp);
        lastOpY=ln.y;
      }else if(lib&&lastOp&&!estDate){
        // une ligne de continuation doit être JUSTE en dessous de son opération
        // et ne pas ressembler au pied de page
        if(PIED.test(txt)||Math.abs(lastOpY-ln.y)>26){lastOp=null;continue;}
        lastOp.libelle=(lastOp.libelle+' '+lib).trim();
        lastOpY=ln.y;
      }
    }
  }
  return fusionnerComptes(comptes.filter(c=>c.ops.length));
}
/* clé d'un compte : son numéro si présent, sinon le type + le titre nettoyé.
   Sert à réunir un même compte réparti sur plusieurs pages. */
function cleReleveCompte(titre){
  const num=(titre.match(/N[°o]\s*([0-9 ]{6,})/i)||[])[1];
  if(num)return 'n:'+num.replace(/\s/g,'');
  return 't:'+normLib(titre).replace(/EN EUROS.*$/,'').trim();
}
/* réunit les blocs de même clé : opérations concaténées (doublons éludés),
   soldes fusionnés en gardant le plus ancien et le plus récent. */
function fusionnerComptes(list){
  const par={},ordre=[];
  for(const c of list){
    if(!par[c.cle]){par[c.cle]={titre:c.titre,cle:c.cle,ops:[],soldes:[]};ordre.push(c.cle);}
    const d=par[c.cle];
    for(const o of c.ops){
      if(d.ops.some(z=>z.date===o.date&&z.montant===o.montant&&z.libelle===o.libelle))continue;
      d.ops.push(o);
    }
    for(const s of c.soldes){
      if(d.soldes.some(z=>z.date===s.date&&z.montant===s.montant))continue;
      d.soldes.push(s);
    }
  }
  const out=ordre.map(k=>par[k]);
  out.forEach(c=>{
    c.ops.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    c.soldes.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    // ne conserver que le solde le plus ancien et le plus récent (début / fin de période)
    if(c.soldes.length>2)c.soldes=[c.soldes[0],c.soldes[c.soldes.length-1]];
  });
  return out;
}
async function lirePdf(buf){
  pdfjsLib.GlobalWorkerOptions.workerSrc='vendor/pdf.worker.min.js';
  const doc=await pdfjsLib.getDocument({data:buf,isEvalSupported:false,disableFontFace:true}).promise;
  const pages=[];
  for(let i=1;i<=doc.numPages;i++){const pg=await doc.getPage(i);pages.push((await pg.getTextContent()).items);}
  return pages;
}

/* --- état de la comparaison en cours (en mémoire, pas en base) --- */
let REL=null;   // {comptes:[...], idx, compteId, relCompte, res}

async function chargerReleve(inp){
  const f=inp.files&&inp.files[0];inp.value='';if(!f)return;
  if(REL&&REL.res){
    const ok=await dlgConfirm('Une comparaison est déjà en cours sur ce relevé.\n\n'+
      'La reprendre par « Relevé en cours » dans la barre de gauche, ou l’abandonner pour démarrer celle-ci ?',
      'Comparaison en cours','Abandonner et recommencer',true);
    if(!ok){setView('releve');return;}
    REL=null;majNavReleve();
  }
  busy('Lecture du relevé…');await nextFrame();
  let comptes;
  try{comptes=parseReleve(await lirePdf(new Uint8Array(await f.arrayBuffer())));}
  catch(e){unbusy();await dlgAlert('Lecture du PDF impossible : '+e.message,'Erreur');return;}
  unbusy();
  if(!comptes.length){await dlgAlert("Aucune opération reconnue dans ce PDF.\n\nL'analyse attend un relevé avec les colonnes Date / Opération / Débit / Crédit.",'Relevé illisible');return;}
  REL={comptes,idx:0,compteId:null,relCompte:null,res:null,filtre:null,amexTraite:false,amexManquants:null,amexTrace:null};
  demarrerCompte(0);
}

async function demarrerCompte(i){
  if(!REL)return;
  REL.amexTraite=false;REL.amexManquants=null;REL.amexACreer=null;REL.amexTrace=null;
  if(i>=REL.comptes.length){
    const n=REL.comptes.length;REL=null;majNavReleve();
    if(state.view==='releve')setView('registre');else render();
    await dlgAlert('Tous les comptes du relevé ont été traités ('+n+').','Comparaison terminée');
    return;}
  REL.idx=i;
  const rc=REL.comptes[i],d=rc.ops.map(o=>o.date).filter(Boolean).sort();
  const cptApp=qy('SELECT id,nom FROM compte WHERE actif=1 ORDER BY ordre_affichage,id');
  const numRel=numeroDuTitre(rc);
  const auto=compteCorrespondant(numRel)||state.acc;
  const html='<div style="font-size:.9rem;margin-bottom:12px"><b>Compte '+(i+1)+' sur '+REL.comptes.length+'</b><br>'+
    '<span style="color:var(--ink-2)">'+esc(rc.titre.slice(0,70))+'</span><br>'+
    '<span style="color:var(--ink-3);font-size:.84rem">'+rc.ops.length+' opérations'+
    (d.length?' du '+isoToFr(d[0])+' au '+isoToFr(d[d.length-1]):'')+'</span></div>'+
    '<div class="field"><label>Rapprocher avec le compte</label><select id="rDst" style="width:100%">'+
    cptApp.map(c=>'<option value="'+c.id+'"'+(c.id===auto?' selected':'')+'>'+esc(c.nom)+'</option>').join('')+
    '</select></div>'+
    (compteCorrespondant(numRel)?'<div class="hint" style="color:var(--credit);margin-top:6px">✓ Compte reconnu par son numéro'+(numRel?' ('+numRel.slice(-5)+')':'')+'</div>':
      (numRel?'<div class="hint" style="margin-top:6px">Numéro du relevé : …'+numRel.slice(-5)+'. Astuce : renseigne ce numéro sur ton compte (double-clic sur le compte à gauche) pour la reconnaissance automatique.</div>':''));
  let dst=null;
  const ok=await dlgOpen({title:'Comparer un relevé',msg:'',html,focusBtn:true,
    buttons:[{t:'Ignorer ce compte',v:'skip'},{t:'Comparer',v:true,p:true,before:()=>{
      const e=document.getElementById('rDst');if(!e)return false;dst=+e.value;}}]});
  if(ok==='skip'){demarrerCompte(i+1);return;}
  if(!ok||dst==null){REL=null;majNavReleve();render();return;}
  lancerComparaison(rc,dst);
}

function lancerComparaison(relCompte,compteId,garderVue){
  const appOps=qy(`SELECT o.id,o.date_operation date,o.montant,o.statut,t.nom dest,o.cat_path cat
    FROM operation o LEFT JOIN tiers t ON t.id=o.tiers_id
    WHERE o.compte_id=? AND o.supprime=0 AND o.statut<>'annule' AND o.previsionnel=0`,[compteId]);
  const res=comparer(relCompte.ops,appOps);
  // catégorie la plus FRÉQUENTE du tiers (à égalité, la plus récente)
  const tiersList=qy(`SELECT t.nom nom,(SELECT o.cat_path FROM operation o
      WHERE o.tiers_id=t.id AND o.supprime=0 AND o.cat_path IS NOT NULL
      GROUP BY o.cat_path ORDER BY COUNT(*) DESC, MAX(o.date_operation) DESC LIMIT 1) cat
    FROM tiers t`);
  res.aCreer.forEach(x=>{x.prop=proposer(x.rel.libelle,tiersList);});
  REL.compteId=compteId;REL.relCompte=relCompte;REL.res=res;REL.filtre=null;
  if(REL.amexTraite){['aCreer','proches','rapproches','deja','ignores'].forEach(sec=>{
    if(REL.res[sec])REL.res[sec]=REL.res[sec].filter(x=>!(x.rel&&RE_AMEX.test(x.rel.libelle||'')));});}
  if(REL.amexACreer&&REL.amexACreer.length)REL.res.aCreer=(REL.res.aCreer||[]).concat(REL.amexACreer);
  majNavReleve();
  if(garderVue)render(); else setView('releve');
}
function majNavReleve(){const a=document.getElementById('nav-releve');if(a)a.style.display=REL&&REL.res?'flex':'none';}
function relTog(sec,i,on){if(REL&&REL.res&&REL.res[sec]&&REL.res[sec][i])REL.res[sec][i].on=on;}
function relCoche(sec,on){if(!REL||!REL.res)return;REL.res[sec].forEach(x=>x.on=on);renderReleve();}

/* ===== relevé American Express (CSV séparé) ===== */
const RE_AMEX=/AMERICAN\s*EXPRESS|AMEX/i;
function csvSplit(line){const out=[];let cur='',q=false;
  for(let i=0;i<line.length;i++){const c=line[i];
    if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=c;}
    else{if(c==='"')q=true;else if(c===','){out.push(cur);cur='';}else cur+=c;}}
  out.push(cur);return out;}
function usDateToISO(s){const m=(s||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);if(!m)return null;
  const mo=+m[1],d=+m[2],y=+m[3];if(mo<1||mo>12||d<1||d>31)return null;
  return y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');}
function parseAmexCSV(text){
  const rows=text.split(/\r?\n/).filter(l=>l.trim());if(!rows.length)return [];
  let start=(/date/i.test(rows[0])&&/montant/i.test(rows[0]))?1:0;
  const lignes=[];
  for(let i=start;i<rows.length;i++){
    const c=csvSplit(rows[i]);if(c.length<5)continue;
    const d=usDateToISO(c[0]);const desc=(c[1]||'').replace(/\s+/g,' ').trim();
    const m=parseMontantC((c[c.length-1]||'').replace(/"/g,''));
    if(d&&m!=null)lignes.push({date:d,desc,montant:m});
  }
  return lignes;
}
/* repère les lignes Amex dans le relevé en cours */
function amexLignesReleve(){
  if(!REL||!REL.res)return [];
  const out=[];
  ['rapproches','deja','proches','aCreer'].forEach(sec=>{
    (REL.res[sec]||[]).forEach((x,i)=>{if(x.rel&&RE_AMEX.test(x.rel.libelle||''))out.push({sec,i,x});});
  });
  return out;
}
function detaillerAmex(){document.getElementById('fileAmex').click();}
async function chargerAmexCSV(inp){
  const file=inp.files&&inp.files[0];inp.value='';if(!file)return;
  let lignes=[];
  try{lignes=parseAmexCSV(await file.text());}catch(e){await dlgAlert('Fichier CSV illisible : '+e.message,'Erreur');return;}
  if(!lignes.length){await dlgAlert('Aucune transaction lue dans ce CSV.','CSV vide');return;}
  amexDialog(lignes);
}
async function amexDialog(lignes){
  const amex=amexLignesReleve();
  // les lignes de prélèvement (paiement à Amex) sont le prélèvement bancaire lui-même : à ignorer
  const estPaiement=l=>/PRELEV|MERCI|REGLEMENT|REMBOURSEMENT\s+CB/i.test(l.desc||'');
  const aPointer=lignes.filter(l=>!estPaiement(l));
  const ignorees=lignes.filter(estPaiement);
  const pris=new Set();
  const res=aPointer.map(l=>{
    const cands=qy(`SELECT id,date_operation d,montant m,statut s,(SELECT nom FROM tiers WHERE id=tiers_id) t
      FROM operation o WHERE compte_id=? AND supprime=0 AND previsionnel=0 AND statut<>'rapproche' AND ABS(montant)=?
      ORDER BY ABS(julianday(date_operation)-julianday(?)) ASC`,[REL.compteId,Math.abs(l.montant),l.date]);
    const op=cands.find(c=>!pris.has(c.id)&&Math.abs(Math.round((new Date(c.d)-new Date(l.date))/86400000))<=62);
    if(op)pris.add(op.id);
    return {csv:l,op:op||null};
  });
  const nbTrouve=res.filter(r=>r.op).length;
  const nbAPointer=res.filter(r=>r.op&&r.op.s!=='pointe').length;
  const nbManque=res.filter(r=>!r.op).length;
  // vérification des montants
  const sommeAchats=aPointer.reduce((t,l)=>t+Math.abs(l.montant),0);        // total des achats du CSV
  const sommeTrouvees=res.filter(r=>r.op).reduce((t,r)=>t+Math.abs(r.op.m),0); // total des opérations retrouvées
  const ligneRel=amex.length?amex[0].x.rel:null;
  const cible=ligneRel?Math.abs(ligneRel.montant):null;                     // montant de la ligne du relevé
  const coherent=(cible!=null)&&cible===sommeAchats;                         // égalité exacte (aucune tolérance)
  const verif='<div class="card" style="padding:9px 12px;margin-bottom:10px;'+(cible!=null&&!coherent?'border-color:var(--debit)':'')+'">'+
    '<div>Total des achats (CSV) : <b class="num">'+eur(sommeAchats)+'</b></div>'+
    '<div>Total des opérations retrouvées dans tes comptes : <b class="num">'+eur(sommeTrouvees)+'</b></div>'+
    (cible!=null?'<div>Ligne du relevé bancaire : <b class="num">'+eur(cible)+'</b></div>'+
      '<div style="margin-top:4px">'+(coherent?'<span style="color:var(--credit)">✓ Les achats correspondent au montant prélevé.</span>':
        '<span style="color:var(--debit)">Écart de '+eur(Math.abs(cible-sommeAchats))+' entre les achats et le prélèvement</span> — le CSV couvre peut-être une autre période.')+'</div>':'')+
    '</div>';
  const rows=[];
  res.forEach(r=>{const l=r.csv;
    const etat=r.op
      ? '<span style="color:'+(r.op.s==='pointe'?'#2563EB':'var(--credit)')+'">'+(r.op.s==='pointe'?'déjà pointée':'✓ trouvée')+'</span>'
        +' <span class="sub">('+isoToFr(r.op.d)+(r.op.t?' · '+esc(r.op.t):'')+')</span>'
      : '<span style="color:var(--debit)">à saisir dans tes comptes</span>';
    rows.push('<tr><td class="num">'+isoToFr(l.date)+'</td><td>'+esc(l.desc)+'</td><td class="num r">'+eur(l.montant)+'</td><td>'+etat+'</td></tr>');});
  ignorees.forEach(l=>rows.push('<tr style="opacity:.55"><td class="num">'+isoToFr(l.date)+'</td><td>'+esc(l.desc)+'</td><td class="num r">'+eur(l.montant)+'</td><td><span class="sub">ignorée (c’est le prélèvement Amex)</span></td></tr>'));
  const html=
    '<div style="margin-bottom:10px">'+aPointer.length+' achat(s) Amex à rapprocher'+(ignorees.length?' ('+ignorees.length+' ligne(s) de prélèvement ignorée(s))':'')+'. '+
      '<b>'+nbTrouve+'</b> retrouvé(s) dans tes comptes'+(nbManque?', <b style="color:var(--debit)">'+nbManque+' à saisir</b>':'')+'.</div>'+
    verif+
    '<div class="rlues" style="max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px">'+
      '<table class="auto" style="width:100%"><thead><tr><th>Date</th><th>Descriptif</th><th class="r">Montant</th><th>Dans tes comptes</th></tr></thead>'+
      '<tbody>'+rows.join('')+'</tbody></table></div>'+
    '<div style="font-size:.82rem;color:var(--ink-3);margin-top:8px">En validant : les opérations <b>retrouvées</b> seront <b>pointées</b>, et la ligne « American Express » du relevé sera retirée (traitée). '+
      'Les lignes non retrouvées seront <b>proposées à la création</b> dans « À créer » (avec le destinataire et sa catégorie la plus fréquente si connu), à valider comme le reste.</div>';
  const boutons=[{t:'Fermer',v:false},{t:(nbAPointer>0?('Pointer '+nbAPointer+' et traiter la ligne Amex'):'Traiter la ligne Amex'),v:true,p:true}];
  const ok=await dlgOpen({title:'Rapprochement American Express',msg:'',html,wide:true,buttons:boutons});
  if(!ok)return;
  pointerAmex(res);
}
function pointerAmex(res){
  let n=0;
  res.forEach(r=>{
    if(r.op){
      // marquer l'opération comme Amex (numéro) + pointer si pas déjà pointée/rapprochée
      const pointe=(r.op.s!=='pointe'&&r.op.s!=='rapproche');
      if(pointe){run("UPDATE operation SET statut='pointe',numero='AMEX',date_modification=? WHERE id=?",[nowTS(),r.op.id]);n++;}
      else{run("UPDATE operation SET numero='AMEX',date_modification=? WHERE id=?",[nowTS(),r.op.id]);}
    }
  });
  // la ligne Amex du relevé est retirée des sections de rapprochement (traitée via le CSV)
  REL.amexTraite=true;
  ['aCreer','proches','rapproches','deja','ignores'].forEach(sec=>{
    if(REL.res[sec])REL.res[sec]=REL.res[sec].filter(x=>!(x.rel&&RE_AMEX.test(x.rel.libelle||'')));
  });
  // les achats non retrouvés sont PROPOSÉS à la création (comme le reste), montant en débit
  const tiersList=qy(`SELECT t.nom nom,(SELECT o.cat_path FROM operation o
      WHERE o.tiers_id=t.id AND o.supprime=0 AND o.cat_path IS NOT NULL
      GROUP BY o.cat_path ORDER BY COUNT(*) DESC, MAX(o.date_operation) DESC LIMIT 1) cat FROM tiers t`);
  REL.amexACreer=res.filter(r=>!r.op).map(r=>{
    const rel={date:r.csv.date,montant:-Math.abs(r.csv.montant),libelle:r.csv.desc};
    return {rel,on:true,prop:proposer(r.csv.desc,tiersList),amex:true};
  });
  REL.res.aCreer=(REL.res.aCreer||[]).concat(REL.amexACreer);
  touch('Rapprochement Amex',n+' opération(s) marquée(s) AMEX');
  render();
  toast(n+' opération(s) pointée(s) — ligne Amex traitée'+(REL.amexACreer.length?' ('+REL.amexACreer.length+' proposée(s) à créer)':''));
}


function renderReleve(){
  if(!REL||!REL.res){document.getElementById('rl-corps').innerHTML=
    '<div class="card" style="color:var(--ink-3)">Aucune comparaison en cours. Utilise « Comparer un relevé PDF » en haut.</div>';
    document.getElementById('rl-ctrl').innerHTML='';document.getElementById('rl-chips').innerHTML='';
    document.getElementById('rl-meta').textContent='';return;}
  const r=REL.res,rc=REL.relCompte;
  const nomC=scal('SELECT nom FROM compte WHERE id=?',[REL.compteId])||'';
  document.getElementById('rl-titre').textContent='Relevé — compte '+(REL.idx+1)+' sur '+REL.comptes.length;
  document.getElementById('rl-meta').innerHTML=esc(rc.titre.slice(0,80))+' &nbsp;→&nbsp; <b>'+esc(nomC)+'</b>'+
    ' · rapprochement sur le montant exact et la date, à ±'+TOL_J+' jours';

  // contrôle de lecture
  let ctrl='';
  if(rc.soldes&&rc.soldes.length>=2){
    const som=rc.ops.reduce((t,o)=>t+o.montant,0),s0=rc.soldes[0],s1=rc.soldes[rc.soldes.length-1];
    const att=s1.montant-s0.montant,ec=som-att;
    const rapAct=scal(`SELECT (SELECT solde_initial FROM compte WHERE id=$a)+COALESCE(SUM(montant),0)
      FROM operation WHERE compte_id=$a AND supprime=0 AND statut='rapproche'`,{$a:REL.compteId});
    ctrl='<div class="card" style="padding:11px 14px;'+(ec?'border-color:var(--debit)':'')+'">'+
      '<b>Objectif :</b> le relevé se termine sur un solde de <b class="num">'+eur(s1.montant)+'</b> au '+
      isoToFr(s1.date||'')+'. Une fois toutes ces opérations rapprochées, ton <b>solde rapproché</b> devrait '+
      'être exactement égal à ce montant (il est aujourd’hui de <span class="num">'+eur(rapAct)+'</span>).<br>'+
      '<b>Contrôle de lecture :</b> '+rc.ops.length+' opérations lues, total '+eur(som)+
      ' — variation des soldes du relevé '+eur(att)+'. '+
      (ec===0?'<b style="color:var(--credit)">Cohérent.</b>':
       '<b style="color:var(--debit)">Écart de '+eur(ec)+' : une ligne a peut-être été mal lue, vérifie avec « Voir les lignes lues ».</b>')+'</div>';
  }
  if(REL.amexTraite){
    ctrl+='<div class="card" style="padding:10px 14px;margin-top:8px;border-color:#7C3AED">'+
      '<b style="color:#7C3AED">American Express traité</b> — les opérations concernées portent le numéro « AMEX » (filtre/recherche « AMEX » pour les retrouver).</div>';
  }
  const _amex=amexLignesReleve();
  if(_amex.length&&!REL.amexTraite){ctrl+='<div class="card" style="padding:11px 14px;margin-top:8px;border-color:#7C3AED">'+
    '<b>American Express détectée</b> — une ligne du relevé correspond à un prélèvement Amex ('+eur(_amex[0].x.rel.montant)+'). '+
    'Charge le relevé CSV Amex : les opérations de tes comptes qui y figurent seront pointées, et une fois toutes pointées la ligne Amex sera traitée.<br>'+
    '<button class="primary" style="margin-top:8px" onclick="detaillerAmex()">Charger le relevé Amex (CSV) et pointer</button></div>';}
  document.getElementById('rl-ctrl').innerHTML=ctrl;

  if(document.body.classList.contains('mobile')){renderReleveMobile(r);return;}
  const secs=[['rapproches','Rapprochements proposés'],['deja','Déjà rapprochées'],
              ['proches','Montants proches — à trancher'],['aCreer','À créer'],['ignores','Absentes du relevé']];
  document.getElementById('rl-chips').innerHTML=
    '<span class="rchip'+(REL.filtre?'':' sel')+'" onclick="relFiltre(null)">Tout afficher</span>'+
    secs.map(([k,l])=>'<span class="rchip'+(REL.filtre===k?' sel':'')+(r[k].length?'':' vide')+
      '" onclick="relFiltre(\''+k+'\')" title="Cliquer pour n’afficher que cette section">'+
      l+' <span class="n">'+r[k].length+'</span></span>').join('');
  const vis=k=>!REL.filtre||REL.filtre===k;

  const cb=(sec,i,on)=>'<input type="checkbox" '+(on?'checked ':'')+'onchange="relTog(\''+sec+'\','+i+',this.checked)">';
  const H=(t,sec)=>'<div style="display:flex;align-items:center;gap:12px;margin:22px 0 8px">'+
    '<h3 style="margin:0;font-size:.95rem">'+t+'</h3>'+
    (sec?'<button class="ghost" onclick="relCoche(\''+sec+'\',true)">tout cocher</button>'+
         '<button class="ghost" onclick="relCoche(\''+sec+'\',false)">tout décocher</button>':'')+'</div>';
  const TH=(extra)=>'<thead><tr><th style="width:34px"></th><th style="width:96px">Date relevé</th>'+
    '<th class="r" style="width:110px">Montant</th><th>Libellé du relevé</th><th>Opération de tes comptes</th>'+
    (extra?'<th style="width:150px">'+extra+'</th>':'')+'</tr></thead>';
  const card=x=>'<div class="tablecard" style="overflow:auto">'+x+'</div>';
  let h='';

  if(vis('rapproches')){h+=H('Rapprochements proposés — '+r.rapproches.length,'rapproches');
  h+=r.rapproches.length?card('<table class="rtab">'+TH('Écart')+'<tbody>'+r.rapproches.map((x,i)=>
    '<tr><td>'+cb('rapproches',i,x.on)+'</td><td class="num">'+isoToFr(x.rel.date)+'</td>'+
    '<td class="r num">'+eur(x.rel.montant)+'</td><td>'+esc(x.rel.libelle)+'</td>'+
    '<td><b>'+esc(x.app.dest||'(sans tiers)')+'</b><div class="sub">'+isoToFr(x.app.date)+' · '+esc(x.app.cat||'')+
      ' · '+(META[x.app.statut]||{}).label+(x.manuel?' · <span style="color:var(--credit)">lié manuellement</span>':'')+'</div>'+
      '<button class="ghost rbtn" onclick="relLier(&#39;rapproches&#39;,'+i+')">Lier à une autre…</button> '+
      '<button class="ghost rbtn" onclick="relVersCreer(&#39;rapproches&#39;,'+i+')">Plutôt la créer</button></td>'+
    '<td class="num">'+(x.ecartJours>0?'+':'')+x.ecartJours+' j'+
      (x.ambigu?'<select class="rcand" onchange="relChoix('+i+',this.value)">'+
        x.cands.map(z=>'<option value="'+z.id+'"'+(z.id===x.app.id?' selected':'')+'>'+
          isoToFr(z.date)+' · '+esc((z.dest||'?').slice(0,18))+'</option>').join('')+'</select>':'')+
      '</td></tr>').join('')+
    '</tbody></table>'):'<div class="card" style="color:var(--ink-3)">Aucun.</div>';

  }
  if(vis('deja')){h+=H('Déjà rapprochées — '+r.deja.length+' (aucune action)');
  h+=r.deja.length?card('<table class="rtab">'+TH('Écart')+'<tbody>'+r.deja.map(x=>
    '<tr><td></td><td class="num">'+isoToFr(x.rel.date)+'</td><td class="r num">'+eur(x.rel.montant)+'</td>'+
    '<td>'+esc(x.rel.libelle)+'</td><td><b>'+esc(x.app.dest||'')+'</b><div class="sub">'+isoToFr(x.app.date)+
    ' · déjà rapprochée</div></td><td class="num">'+(x.ecartJours>0?'+':'')+x.ecartJours+' j</td></tr>').join('')+
    '</tbody></table>'):'<div class="card" style="color:var(--ink-3)">Aucune.</div>';

  }
  if(vis('proches')){h+=H('Montants proches — à trancher — '+r.proches.length,'proches');
  h+=r.proches.length?card('<table class="rtab">'+TH('Écart')+'<tbody>'+r.proches.map((x,i)=>
    '<tr class="warn"><td>'+cb('proches',i,x.on)+'</td><td class="num">'+isoToFr(x.rel.date)+'</td>'+
    '<td class="r num">'+eur(x.rel.montant)+'</td><td>'+esc(x.rel.libelle)+'</td>'+
    '<td><b>'+esc(x.app.dest||'')+'</b><div class="sub">'+isoToFr(x.app.date)+' · <b>'+eur(x.app.montant)+'</b>'+(x.app.cat?' · '+esc(x.app.cat):'')+'</div>'+
      '<button class="ghost rbtn" onclick="openModal('+x.app.id+',&#39;montant&#39;)">Modifier l’opération</button> '+
      '<button class="ghost rbtn" onclick="relLier(&#39;proches&#39;,'+i+')">Lier à une autre…</button> '+
      '<button class="ghost rbtn" onclick="relVersCreer(&#39;proches&#39;,'+i+')">Plutôt la créer</button></td>'+
    '<td class="num" style="color:var(--debit)">'+eur(x.ecartMontant)+'<div class="sub">'+(x.ecartJours>0?'+':'')+x.ecartJours+' j</div></td></tr>').join('')+
    '</tbody></table>'):'<div class="card" style="color:var(--ink-3)">Aucun.</div>';

  }
  if(vis('aCreer')){h+=H('À créer — sur le relevé, absentes des comptes — '+r.aCreer.length,'aCreer');
  h+=r.aCreer.length?card('<table class="rtab">'+TH('')+'<tbody>'+r.aCreer.map((x,i)=>
    '<tr><td>'+cb('aCreer',i,x.on)+'</td><td class="num">'+isoToFr(x.rel.date)+'</td>'+
    '<td class="r num">'+eur(x.rel.montant)+'</td><td>'+esc(x.rel.libelle)+'</td>'+
    '<td ondblclick="relEditProp('+i+')" title="Double-clic pour modifier"><b>'+esc(x.prop.tiers)+'</b>'+
      '<div class="sub">'+esc(x.prop.cat)+(x.prop.trouve?' · tiers connu':' · nouveau tiers')+'</div>'+
      '<button class="ghost rbtn" onclick="relEditProp('+i+')">Modifier</button> '+
      '<button class="ghost rbtn" onclick="relLier(&#39;aCreer&#39;,'+i+')">Lier à une opération existante…</button>'+
      '</td></tr>').join('')+
    '</tbody></table>'):'<div class="card" style="color:var(--ink-3)">Aucune.</div>';

  }
  if(vis('ignores')){h+=H('Dans tes comptes, absentes du relevé — '+r.ignores.length+' (aucune action)');
  h+=r.ignores.length?card('<table class="rtab"><thead><tr><th style="width:34px"></th><th style="width:96px">Date</th>'+
    '<th class="r" style="width:110px">Montant</th><th>Opération de tes comptes</th><th></th></tr></thead><tbody>'+
    r.ignores.map(x=>'<tr><td></td><td class="num">'+isoToFr(x.app.date)+'</td><td class="r num">'+eur(x.app.montant)+
    '</td><td><b>'+esc(x.app.dest||'')+'</b><div class="sub">'+esc(x.app.cat||'')+' · '+(META[x.app.statut]||{}).label+'</div></td><td></td></tr>').join('')+
    '</tbody></table>'):'<div class="card" style="color:var(--ink-3)">Aucune.</div>';

  }
  h+='<div style="font-size:.84rem;color:var(--ink-3);margin:18px 0 4px">Les lignes cochées passeront en <b>pointé</b> (bleu). '+
     'Rien n’est rapproché définitivement : tu valideras toi-même avec le bouton « Rapprocher » du registre. '+
     'Tu peux quitter cet écran et y revenir par « Relevé en cours » dans la barre de gauche.</div>';
  document.getElementById('rl-corps').innerHTML=h;
}

/* ---------- relevé PDF sur téléphone : trois tuiles qui filtrent (retrouvées / à vérifier / absentes),
   une ligne par opération avec sa case, le reste des actions derrière « ⋯ », « Appliquer » en bas ---------- */
const REL_TUILES=[['trouvees','retrouvée','retrouvées','ok'],['proches','à vérifier','à vérifier','verif'],['aCreer','absente','absentes','abs']];
function relNbTuile(r,k){return k==='trouvees'?r.rapproches.length+r.deja.length:r[k].length;}
function renderReleveMobile(r){
  const f=REL.filtre;
  document.getElementById('rl-chips').innerHTML='<div class="rm-tuiles">'+REL_TUILES.map(([k,s1,pl,c])=>{const n=relNbTuile(r,k);
    return '<button class="rm-tuile '+c+'" aria-pressed="'+(f===k)+'" onclick="relFiltre(\''+k+'\')"><b>'+n+'</b><span>'+(n>1?pl:s1)+'</span></button>';}).join('')+'</div>'+
    (f?'<button class="ghost rm-tout" onclick="relFiltre(null)">Tout afficher</button>':'');
  const ligne=(sec,i,x,nom,sous,montant)=>'<div class="rm-ligne">'+
    (sec&&sec!=='deja'?'<input type="checkbox" aria-label="Retenir '+esc(nom)+'" '+(x.on?'checked ':'')+'onchange="relTog(\''+sec+'\','+i+',this.checked);renderReleve()">':'<span class="rm-vide"></span>')+
    '<span class="rm-nom">'+esc(nom)+'<small>'+sous+'</small></span><span class="num">'+eur(montant)+'</span>'+
    (sec&&sec!=='deja'?'<button class="ghost rm-plus" aria-label="Autres actions" onclick="relActionsMobile(\''+sec+'\','+i+')">⋯</button>':'')+'</div>';
  const jour=d=>d?(+d.slice(8,10))+' '+MOIS_COURT[+d.slice(5,7)-1]:'';
  const bloc=(t,lignes)=>'<div class="ma-h">'+t+'</div><div class="rm-liste">'+(lignes.length?lignes.join(''):'<div class="m-vide">Aucune.</div>')+'</div>';
  let h='';
  if(!f||f==='proches')h+=bloc('À vérifier : montant ou date un peu différents',r.proches.map((x,i)=>ligne('proches',i,x,x.app.dest||x.rel.libelle,
    'Relevé '+eur(x.rel.montant)+' le '+jour(x.rel.date)+' · noté '+eur(x.app.montant)+' le '+jour(x.app.date),x.rel.montant)));
  if(!f||f==='aCreer')h+=bloc('Absentes de tes comptes',r.aCreer.map((x,i)=>ligne('aCreer',i,x,x.rel.libelle,
    jour(x.rel.date)+' · sera ajoutée : '+esc(x.prop.tiers)+(x.prop.cat?' · '+esc(x.prop.cat):''),x.rel.montant)));
  if(f==='trouvees')h+=bloc('Retrouvées dans tes comptes',r.rapproches.map((x,i)=>ligne('rapproches',i,x,x.app.dest||x.rel.libelle,
      jour(x.rel.date)+' · '+esc(x.rel.libelle)+(x.ambigu?' · <b>plusieurs possibles</b>':''),x.rel.montant))
    .concat(r.deja.map(x=>ligne('deja',0,x,x.app.dest||x.rel.libelle,jour(x.rel.date)+' · déjà rapprochée',x.rel.montant))));
  else if(!f)h+='<button class="ghost rm-voir" onclick="relFiltre(\'trouvees\')">Voir les '+relNbTuile(r,'trouvees')+' opérations retrouvées</button>';
  if(f==='trouvees'&&r.ignores.length)h+='<div class="ma-h">Dans tes comptes, absentes du relevé (aucune action)</div><div class="rm-liste">'+
    r.ignores.map(x=>ligne(null,0,x,x.app.dest||'',jour(x.app.date)+' · '+((META[x.app.statut]||{}).label||''),x.app.montant)).join('')+'</div>';
  const nP=r.rapproches.filter(x=>x.on).length+r.proches.filter(x=>x.on).length,nC=r.aCreer.filter(x=>x.on).length;
  h+='<div class="rm-pied"><div class="rm-autres"><button class="ghost" onclick="relDiag()">Lignes lues</button>'+
    '<button class="ghost" onclick="relSuivant(true)">Passer ce compte</button><button class="ghost" onclick="relAbandonner()">Abandonner</button></div>'+
    '<button class="primary" onclick="relAppliquer()">Appliquer : '+nP+' pointée'+(nP>1?'s':'')+(nC?', '+nC+' créée'+(nC>1?'s':''):'')+'</button></div>';
  document.getElementById('rl-corps').innerHTML=h;
}
async function relActionsMobile(sec,i){
  const x=REL.res[sec][i];if(!x)return;
  const btns=sec==='aCreer'?[{t:'Lier à une opération existante',v:'lier'},{t:'Modifier',v:'prop',p:true}]
    :[{t:'Plutôt la créer',v:'creer'},{t:'Lier à une autre',v:'lier'}].concat(sec==='proches'?[{t:'Modifier l’opération',v:'modif',p:true}]:[]);
  const v=await dlgOpen({title:x.rel.libelle,msg:isoToFr(x.rel.date)+' · '+eur(x.rel.montant),buttons:btns,fermeDehors:true});
  if(v==='lier')relLier(sec,i);else if(v==='creer')relVersCreer(sec,i);else if(v==='prop')relEditProp(i);else if(v==='modif')openModal(x.app.id,'montant');
}
function relFiltre(k){if(!REL)return;REL.filtre=(REL.filtre===k)?null:k;renderReleve();}
function relChoix(i,id){
  if(!REL||!REL.res)return;
  const it=REL.res.rapproches[i];if(!it)return;
  id=+id;
  const pris=REL.res.rapproches.concat(REL.res.deja).some((z,j)=>j!==i&&z.app&&z.app.id===id);
  if(pris){toast('Cette opération est déjà associée à une autre ligne du relevé');renderReleve();return;}
  const c=it.cands.find(z=>z.id===id);if(!c)return;
  it.app=c;it.ecartJours=Math.round((new Date(it.rel.date)-new Date(c.date))/86400000);
  renderReleve();
}
/* ---- rattachement manuel d'une ligne du relevé à une opération du registre ---- */
function relIdsLies(){
  const s=new Set();
  ['rapproches','deja','proches'].forEach(k=>REL.res[k].forEach(x=>{if(x.app)s.add(x.app.id);}));
  return s;
}
function relRechFiltrer(){
  const q=(document.getElementById('rq').value||'').toLowerCase().trim();
  const mots=q.split(/\s+/).filter(Boolean);
  let sql="SELECT o.id,o.date_operation d,o.montant m,o.statut s,(SELECT nom FROM tiers WHERE id=o.tiers_id) t FROM operation o WHERE o.compte_id=? AND o.supprime=0 AND o.statut<>'rapproche' AND o.statut<>'annule'";
  const p=[REL.compteId];
  mots.forEach(w=>{sql+=" AND o.hay LIKE ?";p.push('%'+w+'%');});
  sql+=" ORDER BY o.date_operation DESC LIMIT 80";
  const rows=qy(sql,p);
  const lies=relIdsLies();
  const box=document.getElementById('rlist');
  box.innerHTML=rows.map(o=>{
    const lie=lies.has(o.id),sel=REL._pick===o.id;
    return '<div onclick="relPick('+o.id+')" style="cursor:'+(lie?'not-allowed':'pointer')+';padding:7px 9px;border-bottom:1px solid var(--line);'+
      (sel?'background:var(--sel,rgba(80,120,255,.14));':'')+(lie?'opacity:.4;':'')+'">'+
      '<span class="num">'+isoToFr(o.d)+'</span> &nbsp; <span class="num" style="color:'+(o.m<0?'var(--debit)':'var(--credit)')+'">'+eur(o.m)+'</span> &nbsp; '+esc(o.t||'(sans tiers)')+
      (o.s==='pointe'?' <span class="sub">· pointé</span>':'')+(lie?' <span class="sub">· déjà liée</span>':'')+
      '</div>';
  }).join('')||'<div class="sub" style="padding:10px">Aucune opération trouvée. Affine ta recherche.</div>';
}
function relPick(id){
  const lies=relIdsLies();if(lies.has(+id)){toast('Cette opération est déjà liée à une autre ligne');return;}
  REL._pick=+id;relRechFiltrer();
}
async function relChercherOp(rel){
  REL._pick=null;
  const rappel=rel?('<div style="background:var(--card-alt);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:.86rem">'+
    '<b>Ligne du relevé à lier :</b><br><span class="num">'+isoToFr(rel.date)+'</span> · <b class="num" style="color:'+(rel.montant<0?'var(--debit)':'var(--credit)')+'">'+eur(rel.montant)+'</b> · '+esc(rel.libelle||'')+'</div>'):'';
  const html=rappel+'<div style="font-size:.82rem;color:var(--ink-3);margin-bottom:8px">Choisis dans tes comptes l’opération qui correspond à cette ligne du relevé. '+
      'Elle passera en <b>pointé</b>, quel que soit le rapprochement proposé automatiquement.</div>'+
    '<input id="rq" placeholder="Rechercher : nom, montant (12,34), date (JJ/MM), catégorie, n°…" style="width:100%;margin-bottom:8px" oninput="relRechFiltrer()">'+
    '<div id="rlist" class="rlues" style="max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:8px"></div>';
  const ok=await dlgOpen({title:'Lier à une opération du registre',msg:'',html,wide:true,
    buttons:[{t:'Annuler',v:false},{t:'Lier',v:true,p:true,before:()=>{if(!REL._pick){toast('Choisis une opération dans la liste');return false;}}}],
    onOpen:()=>{const q=document.getElementById('rq');if(q){ajouterCroix(q);q.value='';relRechFiltrer();q.focus();}}});
  return ok?REL._pick:null;
}
async function relLier(section,i){
  if(!REL||!REL.res)return;
  const it=REL.res[section][i];if(!it||!it.rel)return;
  const id=await relChercherOp(it.rel);
  if(!id)return;
  const op=qy("SELECT o.id,o.date_operation date,o.montant,(SELECT nom FROM tiers WHERE id=o.tiers_id) dest,o.cat_path cat,o.statut FROM operation o WHERE o.id=?",[id])[0];
  if(!op)return;
  REL.res[section].splice(i,1);
  REL.res.rapproches.push({rel:it.rel,app:{id:op.id,date:op.date,montant:op.montant,dest:op.dest,cat:op.cat,statut:op.statut},
    ecartJours:Math.round((new Date(it.rel.date)-new Date(op.date))/86400000),ambigu:false,on:true,manuel:true,
    cands:[{id:op.id,date:op.date,montant:op.montant,dest:op.dest,cat:op.cat,statut:op.statut}]});
  toast('Ligne liée manuellement');renderReleve();
}
function relVersCreer(section,i){
  if(!REL||!REL.res)return;
  const it=REL.res[section][i];if(!it||!it.rel)return;
  const tiersList=qy(`SELECT t.nom nom,(SELECT o.cat_path FROM operation o
      WHERE o.tiers_id=t.id AND o.supprime=0 AND o.cat_path IS NOT NULL
      GROUP BY o.cat_path ORDER BY COUNT(*) DESC, MAX(o.date_operation) DESC LIMIT 1) cat
    FROM tiers t`);
  REL.res[section].splice(i,1);
  REL.res.aCreer.push({rel:it.rel,on:true,prop:proposer(it.rel.libelle,tiersList)});
  toast('Déplacée vers « À créer »');renderReleve();
}
async function relEditProp(i){
  if(!REL||!REL.res)return;
  const x=REL.res.aCreer[i];if(!x)return;
  const lv=catLevels(),dl=k=>lv[k].map(v=>'<option value="'+esc(v)+'">').join('');
  const pc=catParts(x.prop.cat);
  const html='<div style="font-size:.82rem;color:var(--ink-3);margin-bottom:10px">Ligne du relevé : '+
      isoToFr(x.rel.date)+' · '+eur(x.rel.montant)+'<br>'+esc(x.rel.libelle)+'</div>'+
    '<div class="field"><label>Destinataire</label><input id="epT" list="epLT" style="width:100%" value="'+esc(x.prop.tiers)+'"></div>'+
    '<datalist id="epLT">'+Object.keys(tiersIndex()).map(t=>'<option value="'+esc(t)+'">').join('')+'</datalist>'+
    '<div class="row3">'+
    '<div class="field"><label>Catégorie</label><input id="epC0" list="epL0" value="'+esc(pc[0]||'')+'"></div>'+
    '<div class="field"><label>Sous-catégorie</label><input id="epC1" list="epL1" value="'+esc(pc[1]||'')+'"></div>'+
    '<div class="field"><label>Sous-sous-catégorie</label><input id="epC2" list="epL2" value="'+esc(pc[2]||'')+'"></div></div>'+
    '<datalist id="epL0">'+dl(0)+'</datalist><datalist id="epL1">'+dl(1)+'</datalist><datalist id="epL2">'+dl(2)+'</datalist>';
  let v=null;
  const ok=await dlgOpen({title:'Modifier l’opération à créer',msg:'',html,
    buttons:[{t:'Annuler',v:false},{t:'Valider',v:true,p:true,before:()=>{
      const t=document.getElementById('epT');if(!t)return false;
      const c=[0,1,2].map(k=>{const e=document.getElementById('epC'+k);return e?e.value.trim():'';}).filter(Boolean);
      v={tiers:t.value.trim()||'Inconnu',cat:c.join(' : ')||'À trier'};}}],
    onOpen:()=>{const t=document.getElementById('epT');if(t){t.focus();t.select();}}});
  if(ok&&v){x.prop.tiers=v.tiers;x.prop.cat=v.cat;x.prop.trouve=true;renderReleve();}
}
async function relDiag(){
  if(!REL||!REL.relCompte){await dlgAlert('Aucune comparaison en cours.');return;}
  const ops=REL.relCompte.ops;
  const html='<div style="font-size:.8rem;color:var(--ink-3);margin-bottom:8px">Ce que l’application a lu dans le PDF. '+
    'Compare avec ton relevé : si une date, un montant ou une colonne est faux, dis-le moi.</div>'+
    '<div class="rlues"><table class="rtab"><thead><tr><th>Date</th><th>Date valeur</th><th class="r">Montant</th>'+
    '<th>Colonne</th><th>Libellé</th></tr></thead><tbody>'+
    ops.map(o=>'<tr><td class="num">'+isoToFr(o.date||'')+'</td><td class="num" style="color:var(--ink-3)">'+
      isoToFr(o.dateValeur||'')+'</td><td class="r num">'+eur(o.montant)+'</td><td>'+esc(o.colonne||'')+
      '</td><td>'+esc(o.libelle)+'</td></tr>').join('')+'</tbody></table></div>';
  await dlgOpen({title:ops.length+' lignes lues dans le relevé',msg:'',html,wide:true,focusBtn:true,
    buttons:[{t:'Fermer',v:true,p:true}]});
}
async function relAbandonner(){
  if(!await dlgConfirm('Es-tu sûre de vouloir abandonner cette comparaison ?\n\nLes rapprochements non appliqués seront perdus (aucune opération n\'est modifiée).','Abandonner la comparaison','Abandonner',true))return;
  REL=null;majNavReleve();setView('registre');toast('Comparaison abandonnée');
}
function relSuivant(demander){
  if(!REL)return;
  const i=REL.idx+1;
  REL.res=null;REL.relCompte=null;majNavReleve();
  demarrerCompte(i);
}
async function relAppliquer(){
  if(!REL||!REL.res)return;
  const r=REL.res,compteId=REL.compteId;
  const aP=r.rapproches.filter(x=>x.on).concat(r.proches.filter(x=>x.on));
  const aC=r.aCreer.filter(x=>x.on);
  if(!aP.length&&!aC.length){await dlgAlert('Rien n’est coché : aucune modification à faire.');return;}
  const ok=await dlgConfirm(aP.length+' opération(s) passeront en pointé et '+aC.length+' seront créées.\n\nOn applique ?',
    'Appliquer la comparaison','Appliquer');
  if(!ok)return;
  let nP=0,nC=0;
  run('BEGIN');
  try{
    const ts=nowTS();
    aP.forEach(x=>{run("UPDATE operation SET statut='pointe',date_modification=? WHERE id=? AND statut<>'rapproche'",[ts,x.app.id]);nP++;});
    aC.forEach(x=>{
      const tid=upsertTiers(x.prop.tiers),cid=upsertCategorie(x.prop.cat);
      const hay=makeHay(x.prop.tiers,x.prop.cat,null,x.rel.libelle,x.rel.montant,x.rel.date);
      run(`INSERT INTO operation(compte_id,type,date_operation,montant,tiers_id,numero,commentaire,statut,previsionnel,supprime,cat_path,hay,date_creation)
        VALUES(?,?,?,?,?,?,?,'pointe',0,0,?,?,?)`,
        [compteId,x.rel.montant>0?'credit':'debit',x.rel.date,x.rel.montant,tid,(x.amex?'AMEX':null),x.rel.libelle,x.prop.cat,hay,ts]);
      run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)',[lastId(),cid,x.rel.montant]);nC++;});
    run('COMMIT');
  }catch(e){try{run('ROLLBACK');}catch(_){}await dlgAlert('Échec : '+e.message,'Erreur');return;}
  state.acc=compteId;
  touch('Comparaison relevé PDF',nP+' pointée(s), '+nC+' créée(s)');
  toast(nP+' pointée(s), '+nC+' créée(s)');
  relSuivant();
}

/* ============================================================
   Divers
   ============================================================ */
let toastT;
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');delete t.dataset.durable;
  clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2400);}
// message qui reste affiché jusqu'au suivant (travail en cours)
function toastDurable(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');t.dataset.durable='1';clearTimeout(toastT);}

function syncClear(){const v=document.getElementById('f-search').value;
  document.getElementById('f-clear').style.display=v?'block':'none';}
// croix pour vider une barre de recherche : affichée seulement quand le champ n'est pas vide (CSS :placeholder-shown,
// donc juste aussi quand le texte est remis par le code) ; vider = comme si on avait effacé au clavier (événement input)
function ajouterCroix(input){
  if(!input||input.parentElement.classList.contains('croix-zone'))return;
  const z=document.createElement('span');z.className='croix-zone';
  ['width','maxWidth','minWidth','flex'].forEach(k=>{if(input.style[k]){z.style[k]=input.style[k];input.style[k]='';}});
  input.parentElement.insertBefore(z,input);z.appendChild(input);
  if(!input.placeholder)input.placeholder=' ';
  const b=document.createElement('button');b.type='button';b.className='croix';b.textContent='×';
  b.title='Effacer la recherche (Échap)';b.setAttribute('aria-label','Effacer la recherche');
  b.addEventListener('click',()=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
    if(!ecranTactile())input.focus();});
  z.appendChild(b);
}
function clearSearch(){const e=document.getElementById('f-search');e.value='';syncClear();goPage(1);if(!ecranTactile())e.focus();}
bindDate('f-from',()=>goPage(1));bindDate('f-to',()=>goPage(1));
bindDate('an-from',()=>renderAnalyse());bindDate('an-to',()=>renderAnalyse());
bindDate('gr-from',()=>renderGraphiques());bindDate('gr-to',()=>renderGraphiques());
let searchT;
document.getElementById('f-search').addEventListener('input',()=>{syncClear();clearTimeout(searchT);searchT=setTimeout(()=>goPage(1),250);});
document.getElementById('f-search').addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();clearSearch();}
  else if(e.key==='Enter'){e.preventDefault();clearTimeout(searchT);goPage(1);}});
destEl().addEventListener('input',acUpdate);
destEl().addEventListener('keydown',e=>{
  const open=document.getElementById('ac').classList.contains('show');
  if(open){
    if(e.key==='ArrowDown'){e.preventDefault();acIndex=Math.min(acIndex+1,acItems.length-1);acRender();}
    else if(e.key==='ArrowUp'){e.preventDefault();acIndex=Math.max(acIndex-1,0);acRender();}
    else if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();acAccept(acIndex<0?0:acIndex);}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeAC();}
  }else if(e.key==='Enter'){e.preventDefault();saveOp();}
});
// handler délégué unique du modal : marche aussi pour les champs créés dynamiquement (ventilation)
document.getElementById('overlay').addEventListener('keydown',e=>{
  const t=e.target;if(!t||t.id==='i-dest')return;         // i-dest géré par l'autocomplétion
  if(e.key==='Enter'){
    if(t.type==='checkbox'){e.preventDefault();t.checked=!t.checked;t.dispatchEvent(new Event('change',{bubbles:true}));return;}
    if(t.tagName==='TEXTAREA')return;
    e.preventDefault();saveOp();return;
  }
  if(e.key==='+'){const v=document.getElementById('i-vent');
    if(v&&v.checked&&t.tagName!=='SELECT'){e.preventDefault();ventAdd();}}
});
document.getElementById('overlay').addEventListener('click',e=>{if(e.target.id==='overlay')closeModal();});
document.addEventListener('keydown',e=>{
  const dlgOuvert=document.getElementById('dlgBack').classList.contains('show');
  // Ctrl/Cmd+S : sauvegarder (partout, même dans un champ)
  if((e.key==='s'||e.key==='S')&&(e.ctrlKey||e.metaKey)&&!e.altKey){e.preventDefault();if(!dlgOuvert)sauvegarder();return;}
  // Alt+flèches : se déplacer entre les sections (s'adapte aux sections ajoutées, ex. relevé)
  if(e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight'||e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();if(!dlgOuvert)changerSection((e.key==='ArrowLeft'||e.key==='ArrowUp')?-1:1);return;}
  if(dlgOuvert)return;
  const modal=document.getElementById('overlay').classList.contains('show');
  if(e.key==='Escape'&&modal){closeModal();return;}
  if(modal)return;
  const tag=(document.activeElement&&document.activeElement.tagName)||'';
  const dansChamp=(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA');
  // Échap dans la recherche : 1re fois -> vider ; 2e fois (déjà vide) -> sortir du champ
  if(e.key==='Escape'&&dansChamp)return;
  if(dansChamp)return;
  if((e.key==='z'||e.key==='Z')&&(e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey){e.preventDefault();annulerDerniere();return;}
  // « ? » : afficher l'aide des raccourcis
  if(e.key==='?'){e.preventDefault();aideRaccourcis();return;}
  // « / » : aller à la recherche du registre
  if(e.key==='/'){e.preventDefault();
    const map={registre:'f-search',categories:'cat-search',tiers:'ti-search'};
    let id=map[state.view];if(!id){setView('registre');id='f-search';}
    const s=document.getElementById(id);if(s){s.focus();s.select&&s.select();}return;}
  if(e.key==='Enter'&&state.view==='releve'&&REL&&REL.res){e.preventDefault();relAppliquer();return;}
  if((e.key==='a'||e.key==='A'||e.key==='+')&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();
    if(state.view==='recurrences')editRec(0);else openModal(null);return;}
  // « r » : rapprocher un relevé PDF
  if((e.key==='r'||e.key==='R')&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();if(typeof ouvrirRapprochement==='function')ouvrirRapprochement();return;}
});
/* liste ordonnée des sections actuellement visibles dans la barre de gauche */
function sectionsVisibles(){
  return [].slice.call(document.querySelectorAll('.nav a[data-v]'))
    .filter(a=>a.offsetParent!==null)   // exclut les liens masqués (ex. relevé si pas de comparaison)
    .map(a=>a.dataset.v);
}
function changerSection(dir){
  const vues=sectionsVisibles();if(!vues.length)return;
  let i=vues.indexOf(state.view);if(i<0)i=0;
  let j=i+dir;if(j<0)j=0;if(j>vues.length-1)j=vues.length-1;   // s'arrête aux extrémités
  if(vues[j]!==state.view)setView(vues[j]);
}
/* ---- aide des raccourcis clavier (découvrable via « ? » ou le bouton en haut) ---- */
function aideRaccourcis(){
  const cats=[
    ['Navigation',[['Alt+↑','Section suivante'],['Alt+↓','Section précédente'],['Alt+→','Section suivante'],['Alt+←','Section précédente']]],
    ['Actions',[['A','Nouvelle opération (ou récurrence)'],['R','Rapprocher un relevé PDF'],['Ctrl+S','Sauvegarder'],['Ctrl+Z','Annuler la dernière modification (10 max, depuis l’ouverture)'],['/','Rechercher dans le registre'],['Échap','Vider la recherche, puis en sortir'],['Entrée','Appliquer le rapprochement (dans un relevé)']]],
    ['Astuce',[['?','Afficher cette aide']]]
  ];
  const keyCell=l=>l[0].split('+').map(k=>'<kbd>'+k+'</kbd>').join(' + ');
  let rows='';
  cats.forEach(([titre,lignes])=>{
    rows+='<tr><td colspan="2" style="font-weight:600;padding:12px 0 4px">'+titre+'</td></tr>';
    lignes.forEach(l=>{rows+='<tr><td style="padding:4px 20px 4px 0;white-space:nowrap;vertical-align:top;min-width:118px">'+keyCell(l)+'</td>'+
      '<td style="color:var(--ink-2);padding:4px 0;white-space:normal;overflow-wrap:anywhere">'+l[1]+'</td></tr>';});
  });
  const html='<table style="border-collapse:collapse;width:100%;table-layout:auto">'+rows+'</table>';
  dlgOpen({title:'Raccourcis clavier',msg:'',html,wide:true,fermeDehors:true,buttons:[{t:'Fermer',v:true,p:true}]});
}
window.addEventListener('beforeunload',e=>{if(dirty>0&&!majEnCours){e.preventDefault();e.returnValue='';}});

/* ---------- application installable, hors ligne (sw.js) ----------
   Une nouvelle version publiée s'installe en arrière-plan puis attend :
   le bandeau « Nouvelle version » la propose, rien ne se recharge pendant une saisie.
   Sans clic, elle est utilisée au prochain lancement de l'application. */
let swEnAttente=null,majEnCours=false,swReg=null;
/* « Rechercher une mise à jour » (Plus, Réglages) : sans attendre la vérification automatique (ouverture, retour dans l'app).
   Nouvelle version → le bandeau habituel (installée seulement au clic) ; sinon un message. */
async function rechercherMaj(btn){
  if(btn){if(btn.classList.contains('cherche'))return;btn.classList.add('cherche');}
  const fin=t=>{if(btn)btn.classList.remove('cherche');if(t)toast(t);};
  const aJour='Tu as la dernière version ('+VERSION+')',horsLigne='Impossible de vérifier : pas de connexion ?';
  if(enAppli()){
    majAppliVue=0;majAppliPlusTard=null;const r=await verifierMajAppli();
    return fin(r===true?'Version '+majAppli.version+' disponible : touche « Mettre à jour »':r===false?aJour:horsLigne);
  }
  if(!swReg)return fin(swEnAttente?null:aJour);
  if(swEnAttente||swReg.waiting){proposerMaj(swEnAttente||swReg.waiting);return fin('Nouvelle version prête : touche « Mettre à jour »');}
  try{await swReg.update();}catch(e){return fin(horsLigne);}
  // la nouvelle version se télécharge : on attend qu'elle soit prête (le bandeau s'affiche alors tout seul)
  const sw=swReg.installing;
  if(sw)await new Promise(res=>{const t=setTimeout(res,20000);sw.addEventListener('statechange',()=>{if(sw.state!=='installing'){clearTimeout(t);res();}});});
  if(swReg.waiting){proposerMaj(swReg.waiting);return fin('Nouvelle version prête : touche « Mettre à jour »');}
  fin(aJour);
}
function proposerMaj(sw){swEnAttente=sw;document.getElementById('maj').hidden=false;}
async function installerMaj(){
  if(!swEnAttente)return;
  majEnCours=true;clearTimeout(saveTimer);await flushIDB();   // rien ne se perd au rechargement
  swEnAttente.postMessage('installer');
}
if('serviceWorker' in navigator&&location.protocol!=='file:'&&!enAppli()){ // dans l'appli : code dans l'APK, voir verifierMajAppli()
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(majEnCours)location.reload();});
  navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(reg=>{swReg=reg;
    const guetter=sw=>{if(!sw)return;
      const pret=()=>{if(sw.state==='installed'&&navigator.serviceWorker.controller)proposerMaj(sw);};
      pret();sw.addEventListener('statechange',pret);};
    guetter(reg.waiting);guetter(reg.installing);
    reg.addEventListener('updatefound',()=>guetter(reg.installing));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)reg.update().catch(()=>{});});
  }).catch(e=>console.warn('SW',e));
}

boot();
