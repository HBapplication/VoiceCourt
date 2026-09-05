// ============================================================
// VoiceCourt - Firebase-backed version
// Real auth (email/password + Google) via Firebase Auth.
// Real admin-controlled access via Firestore ("users" collection),
// enforced server-side by firestore.rules (not just client UI).
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  collection, getDocs, query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

/* ============ APP STATE ============ */
let authUser = null;     // firebase auth user object
let myUserDoc = null;    // {name,email,role,status,createdAt} from users/{uid}
let users = [];          // all users, loaded for the admin tab
let settings = null;
let game = null;
let gamesIndex = [];      // loaded on demand for the stats/history view
let activeTab = 'game';
let clockDisplayInterval = null;
let recognition = null;
let recognizing = false;
let interimText = '';
let selectedPlayer = null;
let viewingHistoryGame = null;
let statsPeriodFilter = 'all';
let pendingTrackingMode = 'team';
let pendingFixedPlayer = '';
let editingTermId = null;
let gateError = '';
let gateMode = 'signin'; // 'signin' | 'signup'
let unsubConfig = null, unsubGame = null, unsubUsers = null, unsubMe = null;
let deferredInstallPrompt = null;
let installBannerDismissed = false;
function isStandalone(){
  return window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;
}
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  renderGate();
});
window.addEventListener('appinstalled', ()=>{ deferredInstallPrompt=null; renderGate(); });
function installBannerHtml(){
  if(!deferredInstallPrompt || installBannerDismissed || isStandalone()) return '';
  return `<div class="install-banner" id="installBanner">
    <span>📲 התקן את VoiceCourt</span>
    <div class="row" style="gap:8px;">
      <button class="btn primary" style="padding:6px 14px;font-size:13px;" data-gate-action="install-app">התקן</button>
      <button class="icon-btn" data-gate-action="dismiss-install-banner">✕</button>
    </div>
  </div>`;
}

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showToast(msg){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 1800);
}

/* ============ DEFAULT DATA ============ */
function defaultTerms(){
  return [
    {id:'p2', label:'קליעה ל-2', triggers:['קליעה 2','קלע 2','2 נקודות','סל 2','קליעה שתיים'], category:'score', statKey:'pts2', statLabel:'קליעות 2', points:2},
    {id:'p3', label:'קליעה ל-3', triggers:['קליעה 3','קלע 3','3 נקודות','סל 3','קליעה שלוש'], category:'score', statKey:'pts3', statLabel:'קליעות 3', points:3},
    {id:'ft', label:'עונשין', triggers:['עונשין','קליעת עונשין','זריקת עונשין'], category:'score', statKey:'ft', statLabel:'עונשין', points:1},
    {id:'miss', label:'החמצה', triggers:['החמצה','החטאה'], category:'neutral', statKey:'miss', statLabel:'החמצות', points:0},
    {id:'to', label:'איבוד כדור', triggers:['איבוד כדור','איבוד'], category:'negative', statKey:'to', statLabel:'איבודים', points:0},
    {id:'foul', label:'עבירה', triggers:['עבירה','פאול'], category:'negative', statKey:'foul', statLabel:'עבירות', points:0},
    {id:'reb_off', label:'ריבאונד התקפי', triggers:['ריבאונד התקפי','ריבאונד התקפה'], category:'positive', statKey:'reb_off', statLabel:'ריב׳ התקפי', points:0},
    {id:'reb_def', label:'ריבאונד הגנתי', triggers:['ריבאונד הגנתי','ריבאונד הגנה'], category:'positive', statKey:'reb_def', statLabel:'ריב׳ הגנתי', points:0},
    {id:'steal', label:'חטיפה', triggers:['חטיפה','גניבה'], category:'positive', statKey:'steal', statLabel:'חטיפות', points:0},
    {id:'block', label:'חסימה', triggers:['חסימה'], category:'positive', statKey:'block', statLabel:'חסימות', points:0},
    {id:'assist', label:'אסיסט', triggers:['אסיסט','מסירת סל'], category:'positive', statKey:'assist', statLabel:'אסיסטים', points:0},
  ];
}
function defaultSettings(){
  return {
    teamName:'הקבוצה שלי',
    roster:[],
    terms:defaultTerms(),
    periodsDefault:4,
    periodLengthMinDefault:10,
    timeoutsDefault:2,
    langCode:'he-IL'
  };
}

/* ============ AUTH ============ */
onAuthStateChanged(auth, async (user)=>{
  detachRealtimeListeners();
  authUser = user;
  if(!user){ myUserDoc=null; users=[]; renderGate(); return; }
  await ensureUserDoc(user);
  listenToMyUserDoc(user.uid);
});

async function ensureUserDoc(user){
  const ref = doc(db,'users',user.uid);
  const snap = await getDoc(ref);
  if(!snap.exists()){
    await setDoc(ref, {
      name: user.displayName || (user.email? user.email.split('@')[0]:'משתמש'),
      email: user.email || '',
      role: 'member',
      status: 'pending',
      createdAt: serverTimestamp()
    });
  }
}
function listenToMyUserDoc(uid_){
  unsubMe = onSnapshot(doc(db,'users',uid_), (snap)=>{
    myUserDoc = snap.exists()? snap.data(): null;
    if(myUserDoc && myUserDoc.status==='approved'){
      attachAppListeners();
    } else {
      detachAppListeners();
    }
    renderGate();
  });
}
function detachRealtimeListeners(){
  detachAppListeners();
  if(unsubMe){ unsubMe(); unsubMe=null; }
}
function detachAppListeners(){
  if(unsubConfig){ unsubConfig(); unsubConfig=null; }
  if(unsubGame){ unsubGame(); unsubGame=null; }
  if(unsubUsers){ unsubUsers(); unsubUsers=null; }
  stopClockTicker();
}

async function doSignUp(name, email, password){
  gateError='';
  try{
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if(name) await updateProfile(cred.user, {displayName:name});
    await ensureUserDoc({...cred.user, displayName:name||cred.user.displayName});
  }catch(e){ gateError = translateAuthError(e); renderGate(); }
}
async function doSignIn(email, password){
  gateError='';
  try{ await signInWithEmailAndPassword(auth, email, password); }
  catch(e){ gateError = translateAuthError(e); renderGate(); }
}
async function doGoogleSignIn(){
  gateError='';
  try{ await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch(e){ gateError = translateAuthError(e); renderGate(); }
}
async function doSignOut(){ await signOut(auth); }
function translateAuthError(e){
  const code = e && e.code || '';
  if(code.includes('email-already-in-use')) return 'האימייל הזה כבר רשום - נסה/י להתחבר במקום להירשם.';
  if(code.includes('wrong-password') || code.includes('invalid-credential')) return 'אימייל או סיסמה שגויים.';
  if(code.includes('user-not-found')) return 'לא נמצא משתמש עם האימייל הזה.';
  if(code.includes('weak-password')) return 'הסיסמה קצרה מדי (מינימום 6 תווים).';
  if(code.includes('invalid-email')) return 'כתובת אימייל לא תקינה.';
  return 'שגיאה: ' + (e && e.message || 'לא ידועה');
}

/* ============ APP DATA LISTENERS (only once approved) ============ */
function attachAppListeners(){
  if(unsubConfig) return; // already attached
  unsubConfig = onSnapshot(doc(db,'teamData','config'), async (snap)=>{
    if(snap.exists()){
      settings = snap.data();
      settings.terms.forEach(t=>{ if(!t.statLabel) t.statLabel=t.label; });
    } else {
      settings = defaultSettings();
      await setDoc(doc(db,'teamData','config'), settings);
    }
    renderGate();
  });
  unsubGame = onSnapshot(doc(db,'teamData','currentGame'), (snap)=>{
    game = snap.exists()? snap.data(): null;
    restartClockTicker();
    renderMain();
  });
  unsubUsers = onSnapshot(collection(db,'users'), (snap)=>{
    users = snap.docs.map(d=>({id:d.id, ...d.data()}));
    if(activeTab==='admin') renderMain();
  });
}
async function saveSettings(){ if(settings) await setDoc(doc(db,'teamData','config'), settings); }
async function saveGame(){ if(game) await setDoc(doc(db,'teamData','currentGame'), game); }

/* ============ CLOCK MODEL (synced across devices) ============ */
// game.running (bool) + game.runningSince (client epoch ms when it was started).
// Effective remaining = running ? clockRemainingSec - elapsed_since(runningSince) : clockRemainingSec
function effectiveClockSec(g){
  if(!g) return 0;
  if(!g.running) return g.clockRemainingSec;
  const elapsed = Math.floor((Date.now() - (g.runningSince||Date.now()))/1000);
  return Math.max(0, g.clockRemainingSec - elapsed);
}
function fmtClock(sec){
  sec = Math.max(0,sec);
  const m = Math.floor(sec/60), s = sec%60;
  return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function restartClockTicker(){
  stopClockTicker();
  if(!game) return;
  clockDisplayInterval = setInterval(()=>{
    const el = document.getElementById('clockDisplay');
    if(el && game) el.textContent = fmtClock(effectiveClockSec(game));
    if(game && game.running && effectiveClockSec(game)<=0){
      pauseClock(); showToast('הזמן נגמר לרבע');
    }
  },1000);
}
function stopClockTicker(){ if(clockDisplayInterval){ clearInterval(clockDisplayInterval); clockDisplayInterval=null; } }
function startClock(){
  if(!game) return;
  game.running = true; game.runningSince = Date.now();
  saveGame(); renderMain();
}
function pauseClock(){
  if(!game) return;
  game.clockRemainingSec = effectiveClockSec(game);
  game.running = false; game.runningSince = null;
  saveGame(); renderMain();
}

/* ============ VOICE PARSING (local concept bank, fuzzy) ============ */
// Note: unlike the claude.ai-hosted prototype, this deployed version has no
// keyless server-side AI proxy available, so free-form phrases that don't match
// the concept bank fall through to manual assignment. Adding an AI fallback here
// would require a Cloud Function holding your own API key server-side.
function normalizeText(str){
  return (str||'').replace(/[.,!?;:'"׳״]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
}
// Scores a trigger phrase against the spoken text by word overlap (order-independent,
// partial matches allowed) instead of requiring the exact phrase to appear verbatim.
function bestTermMatch(norm){
  const spokenWords = norm.split(' ').filter(Boolean);
  let best=null, bestScore=0;
  for(const term of settings.terms){
    for(const trig of term.triggers){
      const trigWords = normalizeText(trig).split(' ').filter(Boolean);
      if(!trigWords.length) continue;
      const hits = trigWords.filter(w=>spokenWords.includes(w)).length;
      const score = hits / trigWords.length; // fraction of the trigger's words that were said
      // small bonus for longer/more specific triggers so they win ties over short generic ones
      const adjusted = score + trigWords.length*0.001;
      if(hits>0 && score>=0.6 && adjusted>bestScore){ best=term; bestScore=adjusted; }
    }
  }
  return best;
}
/* ============ HEBREW NUMBER WORDS -> DIGITS ============ */
const HE_ONES = {
  'אפס':0,'אחד':1,'אחת':1,'שתיים':2,'שניים':2,'שתי':2,'שני':2,
  'שלוש':3,'שלושה':3,'ארבע':4,'ארבעה':4,'חמש':5,'חמישה':5,
  'שש':6,'שישה':6,'שבע':7,'שבעה':7,'שמונה':8,'תשע':9,'תשעה':9,
  'עשר':10,'עשרה':10
};
const HE_TEENS = {
  'אחד עשר':11,'אחת עשרה':11,'שנים עשר':12,'שתים עשרה':12,'שניים עשר':12,
  'שלושה עשר':13,'שלוש עשרה':13,'ארבעה עשר':14,'ארבע עשרה':14,
  'חמישה עשר':15,'חמש עשרה':15,'שישה עשר':16,'שש עשרה':16,
  'שבעה עשר':17,'שבע עשרה':17,'שמונה עשר':18,'שמונה עשרה':18,
  'תשעה עשר':19,'תשע עשרה':19
};
const HE_TENS = {
  'עשרים':20,'שלושים':30,'ארבעים':40,'חמישים':50,
  'שישים':60,'שבעים':70,'שמונים':80,'תשעים':90
};
function hebrewNumberWordsToDigits(norm){
  // Try two-word teens first (e.g. "שבעה עשר" = 17), longest matches win.
  for(const phrase in HE_TEENS){
    if(norm.includes(phrase)) return String(HE_TEENS[phrase]);
  }
  // Try "tens ו-ones" combos (e.g. "עשרים ושלוש" / "עשרים ו שלוש" = 23).
  for(const tensWord in HE_TENS){
    if(norm.includes(tensWord)){
      for(const onesWord in HE_ONES){
        if(HE_ONES[onesWord]===0) continue;
        if(norm.includes(tensWord+' ו'+onesWord) || norm.includes(tensWord+' '+onesWord)){
          return String(HE_TENS[tensWord]+HE_ONES[onesWord]);
        }
      }
      return String(HE_TENS[tensWord]);
    }
  }
  // Plain single-word number (e.g. "שבע" = 7).
  const words = norm.split(' ');
  for(const w of words){
    if(w in HE_ONES) return String(HE_ONES[w]);
  }
  return null;
}
function parseCommand(transcript){
  const norm = normalizeText(transcript);
  if(/בטל|מחק אחרון|תמחק/.test(norm)) return {type:'undo'};
  const bestTerm = bestTermMatch(norm);
  const isOpponent = /יריב|אורח|הם קלעו|הם קלע|חוץ קלע|קבוצה שלהם/.test(norm);
  if(isOpponent && bestTerm && bestTerm.category==='score'){
    return {type:'opp_event', points:bestTerm.points, raw:transcript};
  }
  const numMatch = norm.match(/\d+/);
  const number = numMatch ? numMatch[0] : hebrewNumberWordsToDigits(norm);
  return {type:'event', number, term:bestTerm, raw:transcript};
}
// Resolves which player a command applies to, based on the game's tracking mode:
// 'team' requires a spoken number every time; 'sticky' remembers the last spoken
// number until a new one is said; 'fixed' always uses the one player set at game setup.
function resolvePlayerNumber(spokenNumber){
  const mode = game.trackingMode || 'team';
  if(mode==='fixed') return game.fixedPlayer || spokenNumber || null;
  if(mode==='sticky'){
    if(spokenNumber){ game.stickyPlayer = spokenNumber; return spokenNumber; }
    return game.stickyPlayer || null;
  }
  return spokenNumber || null;
}
function handleParsedCommand(cmd){
  if(!game) return;
  if(cmd.type==='undo'){
    if(game.events.length){ game.events.pop(); showToast('האירוע האחרון נמחק'); }
    saveGame(); renderMain(); return;
  }
  if(cmd.type==='opp_event'){ logOppScore(cmd.points); showToast('נוספה קליעה ליריבה'); return; }
  const resolvedNumber = resolvePlayerNumber(cmd.number);
  if(resolvedNumber && cmd.term){ logEvent(resolvedNumber, cmd.term.id, cmd.raw); return; }
  game.pending = game.pending||[];
  game.pending.unshift({id:uid(), raw:cmd.raw, ts:Date.now(), period:game.currentPeriod, clock:effectiveClockSec(game)});
  saveGame(); renderMain();
  showToast('לא זוהה - נדרש שיוך ידני');
}
function logEvent(number, termId, raw, override){
  const period = (override && override.period) || game.currentPeriod;
  const clock = (override && typeof override.clock==='number') ? override.clock : effectiveClockSec(game);
  game.events.push({id:uid(), ts:Date.now(), number:String(number), termId, period, clock, raw:raw||''});
  const term = settings.terms.find(t=>t.id===termId);
  showToast(`✓ נקלט: #${number} ${term?term.label:''}`);
  saveGame(); renderMain();
}
function logOppScore(points){
  game.events.push({id:uid(), ts:Date.now(), type:'opp_score', points, period:game.currentPeriod, clock:effectiveClockSec(game)});
  saveGame(); renderMain();
}
function oppPoints(events){ return (events||[]).filter(e=>e.type==='opp_score').reduce((s,e)=>s+(e.points||0),0); }

/* ============ SPEECH RECOGNITION ============ */
function getSR(){ return window.SpeechRecognition || window.webkitSpeechRecognition; }
let committedUpTo = 0;
let finalizedText = '';
function startRecognition(){
  const SR = getSR();
  if(!SR) return;
  try{
    recognition = new SR();
    recognition.lang = settings.langCode || 'he-IL';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    interimText=''; committedUpTo = 0; finalizedText = '';
    recognition.onresult = (e)=>{
      // Rebuild the finalized (stable, won't be revised) text and the live interim
      // text separately - the engine can still rewrite non-final segments, so we must
      // never act on those or we risk committing text that later changes/duplicates.
      let final=''; let interim='';
      for(let i=0;i<e.results.length;i++){
        if(e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      finalizedText = final;
      interimText = final + interim; updateTranscriptDisplay();
      const newPart = finalizedText.slice(committedUpTo).trim();
      if(newPart){
        const cmd = parseCommand(newPart);
        const resolvable = cmd.type==='undo' || cmd.type==='opp_event'
          || (cmd.type==='event' && cmd.term && (cmd.number || (game && (game.trackingMode==='fixed' || (game.trackingMode==='sticky' && game.stickyPlayer)))));
        if(resolvable){
          handleParsedCommand(cmd);
          committedUpTo = finalizedText.length;
          updateMicUI();
        }
      }
    };
    recognition.onerror = (e)=> console.warn('speech error', e.error);
    recognition.onend = ()=>{
      recognizing=false; updateMicUI();
      const leftover = finalizedText.slice(committedUpTo).trim();
      if(leftover) handleParsedCommand(parseCommand(leftover));
      interimText=''; committedUpTo=0; finalizedText=''; updateTranscriptDisplay();
    };
    recognition.start(); recognizing = true; updateMicUI();
  }catch(err){ console.error(err); }
}
function stopRecognition(){ if(recognition && recognizing){ try{ recognition.stop(); }catch(e){} } }
function updateMicUI(){
  const btn = document.getElementById('micBtn');
  if(btn) btn.classList.toggle('active', recognizing);
  const hint = document.getElementById('micHint');
  if(hint) hint.textContent = recognizing? 'מקשיב... שחרר לסיום' : 'החזק ודבר, למשל: "7 איבוד כדור"';
}
function updateTranscriptDisplay(){
  const el = document.getElementById('micTranscript');
  if(el) el.textContent = interimText;
}
document.addEventListener('pointerdown', (e)=>{ if(e.target.closest('#micBtn')){ e.preventDefault(); startRecognition(); } });
document.addEventListener('pointerup', ()=>{ if(recognizing) stopRecognition(); });
document.addEventListener('pointercancel', ()=>{ if(recognizing) stopRecognition(); });

/* ============ GAME LIFECYCLE ============ */
function newGameObject(opponent, periods, periodLenMin, timeouts, kitColor, trackingMode, fixedPlayer){
  return {
    id: uid(), date: new Date().toISOString(), opponent: opponent||'', kitColor: kitColor||'כחול',
    periods, periodLengthSec: periodLenMin*60,
    timeoutsPerTeam: timeouts, timeoutsUsed:0,
    trackingMode: trackingMode||'team', fixedPlayer: fixedPlayer||null, stickyPlayer: null,
    currentPeriod:1, clockRemainingSec: periodLenMin*60, running:false, runningSince:null,
    events:[], pending:[], status:'in_progress'
  };
}
async function startNewGame(){
  const opp = document.getElementById('setupOpponent').value.trim();
  const periods = parseInt(document.getElementById('setupPeriods').value)||settings.periodsDefault;
  const len = parseInt(document.getElementById('setupLen').value)||settings.periodLengthMinDefault;
  const to = parseInt(document.getElementById('setupTO').value)||settings.timeoutsDefault;
  const kit = document.getElementById('setupKit').value;
  const trackingMode = pendingTrackingMode;
  const fixedPlayer = trackingMode==='fixed' ? pendingFixedPlayer : null;
  if(trackingMode==='fixed' && !fixedPlayer){ showToast('נא לבחור שחקן למעקב יחיד'); return; }
  game = newGameObject(opp, periods, len, to, kit, trackingMode, fixedPlayer);
  pendingTrackingMode = 'team'; pendingFixedPlayer = '';
  await saveGame(); renderMain();
}
function nextPeriod(){
  if(!game) return;
  pauseClock();
  if(game.currentPeriod < game.periods){ game.currentPeriod++; game.clockRemainingSec = game.periodLengthSec; saveGame(); }
  else showToast('זה כבר הרבע האחרון');
  renderMain();
}
function takeTimeout(){
  if(!game) return;
  pauseClock();
  game.timeoutsUsed = (game.timeoutsUsed||0)+1;
  game.events.push({id:uid(), ts:Date.now(), number:null, termId:null, period:game.currentPeriod, clock:effectiveClockSec(game), raw:'פסק זמן', isTimeout:true});
  saveGame(); renderMain(); showToast('פסק זמן נרשם');
}
async function endGame(){
  if(!game) return;
  if(!confirm('לסיים את המשחק? הנתונים יישמרו בהיסטוריה.')) return;
  pauseClock();
  const finished = {...game, status:'finished'};
  const stats = computeStats(finished.events, settings.terms, 'all');
  finished.finalPoints = stats.points;
  finished.finalOppPoints = oppPoints(finished.events);
  await setDoc(doc(db,'games',finished.id), finished);
  await deleteDoc(doc(db,'teamData','currentGame'));
  game = null;
  activeTab='stats';
  renderMain();
}

/* ============ STATS ============ */
function computeStats(events, terms, periodFilter){
  const filtered = periodFilter==='all' ? events : events.filter(e=>e.period===periodFilter);
  const byPlayer = {}; const totals = {};
  for(const e of filtered){
    if(e.isTimeout || !e.termId) continue;
    const term = terms.find(t=>t.id===e.termId);
    if(!term) continue;
    byPlayer[e.number] = byPlayer[e.number]||{};
    byPlayer[e.number][term.statKey] = (byPlayer[e.number][term.statKey]||0)+1;
    totals[term.statKey] = (totals[term.statKey]||0)+1;
  }
  let points=0;
  for(const t of terms){ if(t.points){ points += (totals[t.statKey]||0)*t.points; } }
  return {byPlayer, totals, points};
}
async function loadGamesIndex(){
  const q = query(collection(db,'games'), orderBy('date','desc'), limit(25));
  const snap = await getDocs(q);
  gamesIndex = snap.docs.map(d=>d.data());
  renderMain();
}

/* ============ RENDER: ACCESS GATE ============ */
function gateShell(inner){
  return `
  <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;">
    ${installBannerHtml()}
    <img src="logo-v2.png" alt="VoiceCourt" style="width:96px;height:96px;border-radius:22px;margin-bottom:6px;">
    <div class="brand" style="font-size:26px;">Voice<span>Court</span></div>
    <div class="faint" style="margin-bottom:22px;letter-spacing:1px;">קול. סטטיסטיקה. שיפור.</div>
    <div class="card" style="width:100%;max-width:360px;">${inner}</div>
  </div>`;
}
function googleBtnSvg(){
  return `<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.5 5.1 29.5 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.9 19 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34.5 5.1 29.5 3 24 3 16.3 3 9.7 7.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 36.5 26.7 37 24 37c-5.2 0-9.6-3.1-11.3-7.6l-6.5 5C9.6 40.6 16.3 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C40.9 36 44 30.5 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>`;
}
function renderGate(){
  const app = document.getElementById('app');
  if(!authUser){
    app.innerHTML = gateShell(`
      <div class="gate-tabs">
        <button data-gate-tab="signin" class="${gateMode==='signin'?'active':''}">התחברות</button>
        <button data-gate-tab="signup" class="${gateMode==='signup'?'active':''}">הרשמה</button>
      </div>
      ${gateError? `<div style="color:var(--neg);font-size:13px;margin-bottom:8px;">${escapeHtml(gateError)}</div>`:''}
      ${gateMode==='signup'? `<div class="field"><label class="field-label">שם</label><input type="text" id="gateName"></div>`:''}
      <div class="field"><label class="field-label">אימייל</label><input type="text" id="gateEmail"></div>
      <div class="field"><label class="field-label">סיסמה</label><input type="password" id="gatePassword"></div>
      <button class="btn primary block" data-gate-action="${gateMode==='signup'?'signup':'signin'}">${gateMode==='signup'?'הרשמה':'התחברות'}</button>
      <div class="divider">או</div>
      <button class="google-btn" data-gate-action="google">${googleBtnSvg()} המשך עם Google</button>
    `);
    return;
  }
  if(!myUserDoc){
    app.innerHTML = gateShell(`<div class="muted">טוען...</div>`);
    return;
  }
  if(myUserDoc.status==='pending'){
    app.innerHTML = gateShell(`
      <h2>ממתין לאישור</h2>
      <div class="muted">הבקשה של <b>${escapeHtml(myUserDoc.name)}</b> נשלחה למנהל/ת המערכת ועדיין ממתינה לאישור.</div>
      <button class="btn ghost block" style="margin-top:14px;" data-gate-action="signout">התנתקות</button>
    `);
    return;
  }
  if(myUserDoc.status==='blocked'){
    app.innerHTML = gateShell(`
      <h2>הגישה חסומה</h2>
      <div class="muted">הגישה של <b>${escapeHtml(myUserDoc.name)}</b> חסומה כרגע. פנה/י למנהל/ת המערכת.</div>
      <button class="btn ghost block" style="margin-top:14px;" data-gate-action="signout">התנתקות</button>
    `);
    return;
  }
  render(); // approved
}
document.addEventListener('click', (e)=>{
  const tabEl = e.target.closest('[data-gate-tab]');
  if(tabEl){ gateMode = tabEl.dataset.gateTab; gateError=''; renderGate(); return; }
  const el = e.target.closest('[data-gate-action]');
  if(!el) return;
  const val = (id)=> (document.getElementById(id)||{}).value?.trim() || '';
  const action = el.dataset.gateAction;
  if(action==='signin') doSignIn(val('gateEmail'), val('gatePassword'));
  if(action==='signup') doSignUp(val('gateName'), val('gateEmail'), val('gatePassword'));
  if(action==='google') doGoogleSignIn();
  if(action==='signout') doSignOut();
  if(action==='install-app'){
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(()=>{ deferredInstallPrompt=null; renderGate(); });
    return;
  }
  if(action==='dismiss-install-banner'){ installBannerDismissed = true; renderGate(); return; }
  if(action==='admin-approve') updateDoc(doc(db,'users',el.dataset.id), {status:'approved'}).catch(showAdminError);
  if(action==='admin-block') updateDoc(doc(db,'users',el.dataset.id), {status:'blocked'}).catch(showAdminError);
  if(action==='admin-pending') updateDoc(doc(db,'users',el.dataset.id), {status:'pending'}).catch(showAdminError);
  if(action==='admin-delete'){ if(confirm('למחוק את המשתמש?')) deleteDoc(doc(db,'users',el.dataset.id)).catch(showAdminError); }
  if(action==='admin-promote'){ if(confirm('להפוך למנהל/ת?')) updateDoc(doc(db,'users',el.dataset.id), {role:'admin'}).catch(showAdminError); }
});
function showAdminError(e){
  console.warn(e);
  showToast('הפעולה נחסמה: מותר להפוך למנהל/ת רק את החשבון עם האימייל שהוגדר בכללי Firestore');
}

/* ============ RENDER: SHELL ============ */
function render(){
  if(!settings){ document.getElementById('app').innerHTML = `<div style="padding:40px;text-align:center;color:#8A9AB2;">טוען נתוני קבוצה...</div>`; return; }
  const app = document.getElementById('app');
  const isAdmin = myUserDoc && myUserDoc.role==='admin';
  app.innerHTML = `
    ${installBannerHtml()}
    <header class="topbar">
      <div class="row" style="align-items:center;gap:10px;">
        <img src="logo-v2.png" alt="" style="width:34px;height:34px;border-radius:9px;">
        <div>
          <div class="brand" style="font-size:18px;">Voice<span>Court</span></div>
          <div class="team-name">${escapeHtml(settings.teamName)}</div>
        </div>
      </div>
      <div style="text-align:left;">
        <div class="faint">${game? 'משחק פעיל · ':''}${escapeHtml(myUserDoc.name)}</div>
        <button class="icon-btn" style="font-size:11px;padding:2px 4px;" data-gate-action="signout">התנתק/י</button>
      </div>
    </header>
    <main id="mainArea"></main>
    <nav class="tabbar">
      ${tabBtn('game','משחק', iconWhistle())}
      ${tabBtn('stats','סטטיסטיקה', iconChart())}
      ${tabBtn('roster','נבחרת', iconUsers())}
      ${tabBtn('terms','מושגים', iconBook())}
      ${tabBtn('settings','הגדרות', iconGear())}
      ${isAdmin? tabBtn('admin','ניהול', iconUsers()) : ''}
    </nav>
  `;
  attachDelegatedEvents();
  restartClockTicker();
  renderMain();
}
function tabBtn(key,label,svg){ return `<button data-tab="${key}" class="${activeTab===key?'active':''}">${svg}<span>${label}</span></button>`; }

function renderMain(){
  const el = document.getElementById('mainArea');
  if(!el || !settings) return;
  if(activeTab==='game') el.innerHTML = renderGameTab();
  else if(activeTab==='stats') el.innerHTML = renderStatsTab();
  else if(activeTab==='roster') el.innerHTML = renderRosterTab();
  else if(activeTab==='terms') el.innerHTML = renderTermsTab();
  else if(activeTab==='settings') el.innerHTML = renderSettingsTab();
  else if(activeTab==='admin') el.innerHTML = renderAdminTab();
  updateMicUI();
}

/* ============ GAME TAB ============ */
function renderGameTab(){
  if(!game){
    return `
    <div class="card">
      <h2>התחלת משחק חדש</h2>
      <div class="field"><label class="field-label">קבוצה יריבה (לא חובה)</label><input type="text" id="setupOpponent" placeholder="למשל: הפועל צפון"></div>
      <div class="row wrap">
        <div class="field" style="flex:1;min-width:100px;"><label class="field-label">מספר רבעים</label><input type="number" id="setupPeriods" value="${settings.periodsDefault}" min="1" max="8"></div>
        <div class="field" style="flex:1;min-width:100px;"><label class="field-label">דקות לרבע</label><input type="number" id="setupLen" value="${settings.periodLengthMinDefault}" min="1" max="60"></div>
        <div class="field" style="flex:1;min-width:100px;"><label class="field-label">פסקי זמן לקבוצה</label><input type="number" id="setupTO" value="${settings.timeoutsDefault}" min="0" max="10"></div>
      </div>
      <div class="field">
        <label class="field-label">צבע החולצות שלנו במשחק הזה</label>
        <select id="setupKit"><option>כחול</option><option>שחור</option><option>לבן</option><option>אדום</option><option>ירוק</option><option>צהוב</option><option>אפור</option></select>
      </div>
      <div class="field">
        <label class="field-label">מצב מעקב</label>
        <select id="setupTrackingMode" data-action="set-tracking-mode">
          <option value="team" ${pendingTrackingMode==='team'?'selected':''}>קבוצה שלמה - אומרים מספר שחקן בכל פקודה</option>
          <option value="sticky" ${pendingTrackingMode==='sticky'?'selected':''}>כמה שחקנים (שחקן "דביק") - אומרים מספר רק כשעוברים בין שחקנים</option>
          <option value="fixed" ${pendingTrackingMode==='fixed'?'selected':''}>שחקן יחיד קבוע - לא צריך לומר מספר בכלל</option>
        </select>
      </div>
      <div class="field" id="fixedPlayerField" style="${pendingTrackingMode==='fixed'?'':'display:none;'}">
        <label class="field-label">איזה שחקן?</label>
        <select id="setupFixedPlayer" data-action="set-fixed-player">${settings.roster.map(p=>`<option value="${p.number}" ${pendingFixedPlayer===p.number?'selected':''}>#${escapeHtml(p.number)} ${escapeHtml(p.name||'')}</option>`).join('') || '<option value="">אין שחקנים בנבחרת - הוסיפי למטה</option>'}</select>
        <div class="row" style="margin-top:8px;">
          <input type="text" id="quickAddNum" placeholder="מספר חדש" style="max-width:90px;">
          <input type="text" id="quickAddName" placeholder="שם (לא חובה)">
          <button type="button" class="btn ghost" data-action="quick-add-fixed-player">הוסף</button>
        </div>
      </div>
      <div class="muted" style="margin-bottom:10px;">נרשמת רק הקבוצה שלנו לפי שחקנים. ליריבה אפשר לרשום ניקוד כללי בלבד.</div>
      <button class="btn primary block" data-action="start-game">התחל משחק</button>
    </div>
    ${settings.roster.length===0? `<div class="card muted">עדיין לא הוגדרו שחקנים. אפשר להוסיף בטאב "נבחרת".</div>`:''}
    `;
  }
  const stats = computeStats(game.events, settings.terms, 'all');
  const opp = oppPoints(game.events);
  const recent = [...game.events].slice(-8).reverse();
  const srSupported = !!getSR();
  return `
    <div class="card scoreboard">
      <div class="period">רבע ${game.currentPeriod} מתוך ${game.periods}</div>
      <div class="clock num ${game.running?'running':''}" id="clockDisplay">${fmtClock(effectiveClockSec(game))}</div>
      <div class="row" style="justify-content:center;gap:26px;margin-top:8px;">
        <div style="text-align:center;"><div class="faint">${escapeHtml(settings.teamName)} (${escapeHtml(game.kitColor||'')})</div><div class="points num" style="font-size:28px;color:var(--blue-bright);">${stats.points}</div></div>
        <div style="text-align:center;"><div class="faint">${game.opponent? escapeHtml(game.opponent):'יריבה'}</div><div class="points num" style="font-size:28px;">${opp}</div></div>
      </div>
    </div>
    <div class="ctrl-grid">
      <button class="btn ${game.running?'ghost':'primary'}" data-action="toggle-clock">${game.running?'⏸ עצור שעון':'▶ הפעל שעון'}</button>
      <button class="btn ghost" data-action="timeout">⏱ פסק זמן (${game.timeoutsUsed||0}/${game.timeoutsPerTeam})</button>
      <button class="btn ghost" data-action="next-period">⏭ רבע הבא</button>
    </div>
    <div class="card mic-wrap">
      ${trackingModeBadge()}
      ${srSupported ? `
        <button class="mic-btn" id="micBtn">${iconMic()}</button>
        <div class="mic-hint" id="micHint">החזק ודבר, למשל: "7 איבוד כדור"</div>
        <div class="mic-transcript" id="micTranscript"></div>
      ` : `<div class="unsupported-note">זיהוי קול לא נתמך בדפדפן הזה (למשל ספארי/אייפון).<br>אפשר להשתמש ברישום המהיר למטה, או בשדה ההקלדה למטה.</div>`}
      <div style="width:100%;margin-top:14px;" class="row">
        <input type="text" id="manualCmd" placeholder="הקלדה ידנית: 7 עבירה">
        <button class="btn primary" data-action="submit-manual">שלח</button>
      </div>
    </div>
    <div class="card"><h2>ניקוד יריבה מהיר</h2>
      <div class="row">
        <button class="btn ghost" data-action="opp-score" data-points="1">יריבה +1</button>
        <button class="btn ghost" data-action="opp-score" data-points="2">יריבה +2</button>
        <button class="btn ghost" data-action="opp-score" data-points="3">יריבה +3</button>
      </div>
    </div>
    <div class="card">
      <h2>רישום מהיר (בנק המושגים)</h2>
      ${game.trackingMode==='fixed'? `<div class="muted" style="margin-bottom:8px;">מעקב שחקן יחיד - רק בחר/י מושג</div>` : `<div class="muted" style="margin-bottom:8px;">בחר שחקן ואז מושג${game.trackingMode==='sticky'?' (נשאר על אותו שחקן עד שתחליף/י)':''}</div>`}
      ${game.trackingMode!=='fixed'? `<div class="chip-row" style="margin-bottom:10px;">
        ${settings.roster.map(p=>`<div class="chip player ${(selectedPlayer===p.number||game.stickyPlayer===p.number)?'selected':''}" data-action="select-player" data-num="${p.number}">${escapeHtml(p.number)}</div>`).join('') || '<span class="faint">אין שחקנים ברשימה</span>'}
      </div>` : ''}
      <div class="chip-row">${settings.terms.map(t=>`<div class="chip term" data-cat="${t.category}" data-action="quick-term" data-term="${t.id}">${escapeHtml(t.label)}</div>`).join('')}</div>
    </div>
    ${game.pending && game.pending.length? `<div class="card"><h2>ממתין לשיוך</h2>${game.pending.map(renderPendingItem).join('')}</div>` : ''}
    <div class="card"><h2>אירועים אחרונים</h2>${recent.length? recent.map(renderEventItem).join('') : '<div class="muted">עדיין אין אירועים</div>'}</div>
    <button class="btn danger block" data-action="end-game" style="margin-bottom:20px;">סיים משחק</button>
  `;
}
function trackingModeBadge(){
  const mode = game.trackingMode || 'team';
  if(mode==='team') return '';
  if(mode==='fixed'){
    const p = settings.roster.find(x=>x.number===game.fixedPlayer);
    return `<div class="cat-badge positive" style="margin-bottom:10px;">מעקב קבוע: #${escapeHtml(game.fixedPlayer||'')} ${p?escapeHtml(p.name||''):''}</div>`;
  }
  if(mode==='sticky'){
    return `<div class="cat-badge score" style="margin-bottom:10px;">שחקן נוכחי: ${game.stickyPlayer? '#'+escapeHtml(game.stickyPlayer) : 'טרם נבחר - אמרי מספר פעם אחת'}</div>`;
  }
  return '';
}
function renderPendingItem(p){
  return `
  <div class="pending-item">
    <div class="raw">"${escapeHtml(p.raw)}" <span class="faint">· רבע ${p.period||'?'} · ${fmtClock(p.clock||0)}</span></div>
    <select class="small-select" data-pending-player="${p.id}"><option value="">שחקן...</option>${settings.roster.map(pl=>`<option value="${pl.number}">${escapeHtml(pl.number)} - ${escapeHtml(pl.name||'')}</option>`).join('')}</select>
    <select class="small-select" data-pending-term="${p.id}"><option value="">מושג...</option>${settings.terms.map(t=>`<option value="${t.id}">${escapeHtml(t.label)}</option>`).join('')}</select>
    <div class="row" style="margin-top:6px;"><button class="btn primary" data-action="resolve-pending" data-id="${p.id}">שייך</button><button class="btn ghost" data-action="discard-pending" data-id="${p.id}">התעלם</button></div>
  </div>`;
}
function catColor(cat){ return cat==='score'?'var(--score)':cat==='positive'?'var(--pos)':cat==='negative'?'var(--neg)':'var(--text-faint)'; }
function renderEventItem(e){
  const timeTag = `<span class="faint" style="margin-inline-start:8px;">רבע ${e.period} · ${fmtClock(e.clock||0)}</span>`;
  if(e.isTimeout) return `<div class="event-item"><div class="event-left"><span class="dot" style="background:var(--text-faint)"></span><span class="what">פסק זמן</span>${timeTag}</div><button class="icon-btn" data-action="undo-event" data-id="${e.id}">✕</button></div>`;
  if(e.type==='opp_score') return `<div class="event-item"><div class="event-left"><span class="dot" style="background:var(--text-faint)"></span><span class="what">יריבה +${e.points}</span>${timeTag}</div><button class="icon-btn" data-action="undo-event" data-id="${e.id}">✕</button></div>`;
  const term = settings.terms.find(t=>t.id===e.termId);
  return `<div class="event-item"><div class="event-left"><span class="dot" style="background:${catColor(term?term.category:'neutral')}"></span><span class="who">#${escapeHtml(e.number)}</span><span class="what">${term?escapeHtml(term.label):'?'}</span>${timeTag}</div><button class="icon-btn" data-action="undo-event" data-id="${e.id}">✕</button></div>`;
}

/* ============ STATS TAB ============ */
function renderStatsTab(){
  const source = viewingHistoryGame || game;
  if(!source){
    if(!gamesIndex.length) loadGamesIndex();
    return `<div class="card empty-state"><div class="icon">📊</div><div class="muted">אין משחק פעיל כרגע.</div></div>${renderHistoryList()}`;
  }
  const periodOptions = ['all', ...Array.from({length:source.periods},(_,i)=>i+1)];
  const stats = computeStats(source.events, settings.terms, statsPeriodFilter);
  const statKeys = settings.terms.map(t=>({key:t.statKey,label:t.statLabel,points:t.points}));
  return `
  ${viewingHistoryGame? `<div class="card"><div class="row" style="justify-content:space-between;align-items:center;"><div class="muted">משחק שהסתיים ${source.opponent? 'מול '+escapeHtml(source.opponent):''}</div><button class="btn ghost" data-action="back-to-live-stats">חזרה</button></div></div>`:''}
  <div class="card">
    <h2>סיכום קבוצתי <select class="small-select" data-action="filter-period">${periodOptions.map(p=>`<option value="${p}" ${statsPeriodFilter==p?'selected':''}>${p==='all'?'כל המשחק':'רבע '+p}</option>`).join('')}</select></h2>
    <div class="totals-cards">
      <div class="tc"><div class="v">${stats.points}</div><div class="l">הנקודות שלנו</div></div>
      <div class="tc"><div class="v">${oppPoints(source.events)}</div><div class="l">נקודות היריבה</div></div>
      <div class="tc"><div class="v">${stats.totals.to||0}</div><div class="l">איבודים</div></div>
      <div class="tc"><div class="v">${stats.totals.foul||0}</div><div class="l">עבירות</div></div>
      <div class="tc"><div class="v">${(stats.totals.reb_off||0)+(stats.totals.reb_def||0)}</div><div class="l">ריבאונדים</div></div>
      <div class="tc"><div class="v">${stats.totals.assist||0}</div><div class="l">אסיסטים</div></div>
    </div>
  </div>
  <div class="card"><h2>לפי שחקן</h2><div class="stats-scroll"><table class="stats-table">
    <thead><tr><th>שחקן</th>${statKeys.map(s=>`<th>${escapeHtml(s.label)}</th>`).join('')}</tr></thead>
    <tbody>
      ${settings.roster.map(p=>{ const row = stats.byPlayer[p.number]||{}; return `<tr><td>#${escapeHtml(p.number)} ${escapeHtml(p.name||'')}</td>${statKeys.map(s=>`<td>${row[s.key]||0}</td>`).join('')}</tr>`; }).join('') || `<tr><td colspan="${statKeys.length+1}" class="muted">אין שחקנים</td></tr>`}
      <tr class="totals-row"><td>סה"כ</td>${statKeys.map(s=>`<td>${stats.totals[s.key]||0}</td>`).join('')}</tr>
    </tbody>
  </table></div></div>
  ${!viewingHistoryGame? renderHistoryList() : ''}
  `;
}
function renderHistoryList(){
  if(!gamesIndex.length) return '';
  return `<div class="card"><h2>משחקים קודמים</h2>${gamesIndex.map(g=>`
    <div class="list-item"><div class="main"><div class="title">${g.opponent? 'מול '+escapeHtml(g.opponent) : 'משחק'}</div><div class="sub">${new Date(g.date).toLocaleDateString('he-IL')} · ${g.finalPoints}:${g.finalOppPoints||0}</div></div>
    <button class="btn ghost" data-action="view-history" data-id="${g.id}">צפה</button></div>`).join('')}</div>`;
}

/* ============ ROSTER / TERMS / SETTINGS TABS ============ */
function renderRosterTab(){
  return `
  <div class="card"><h2>הוספת שחקן</h2><div class="row"><input type="text" id="newPlayerNum" placeholder="מספר" style="max-width:90px;"><input type="text" id="newPlayerName" placeholder="שם (לא חובה)"><button class="btn primary" data-action="add-player">הוסף</button></div></div>
  <div class="card"><h2>הנבחרת (${settings.roster.length})</h2>
    ${settings.roster.length? settings.roster.map(p=>`<div class="list-item"><div class="main"><div class="title">#${escapeHtml(p.number)}</div><div class="sub">${escapeHtml(p.name||'')}</div></div><button class="icon-btn" data-action="remove-player" data-num="${p.number}">🗑</button></div>`).join('') : '<div class="muted">עדיין לא נוספו שחקנים</div>'}
  </div>`;
}
function catLabel(c){ return c==='score'?'קליעה':c==='positive'?'חיובי':c==='negative'?'שלילי':'ניטרלי'; }
function renderTermsTab(){
  const editing = editingTermId ? settings.terms.find(t=>t.id===editingTermId) : null;
  return `
  <div class="card"><h2>${editing? 'עריכת מושג':'הוספת מושג'}</h2>
    <div class="field"><label class="field-label">שם המושג</label><input type="text" id="newTermLabel" value="${editing?escapeHtml(editing.label):''}" placeholder="למשל: עבירה טכנית"></div>
    <div class="field"><label class="field-label">ביטויים שיזוהו (מופרדים בפסיק)</label><input type="text" id="newTermTriggers" value="${editing?escapeHtml(editing.triggers.join(', ')):''}" placeholder="עבירה טכנית, טכנית"></div>
    <div class="row wrap">
      <div class="field" style="flex:1;min-width:120px;"><label class="field-label">סוג</label>
        <select id="newTermCat">
          <option value="neutral" ${editing&&editing.category==='neutral'?'selected':''}>ניטרלי</option>
          <option value="positive" ${editing&&editing.category==='positive'?'selected':''}>חיובי</option>
          <option value="negative" ${editing&&editing.category==='negative'?'selected':''}>שלילי</option>
          <option value="score" ${editing&&editing.category==='score'?'selected':''}>קליעה (נותן נקודות)</option>
        </select>
      </div>
      <div class="field" style="flex:1;min-width:100px;"><label class="field-label">נקודות (אם קליעה)</label><input type="number" id="newTermPoints" value="${editing?editing.points||0:0}" min="0" max="3"></div>
    </div>
    <div class="row">
      <button class="btn primary block" data-action="add-term">${editing?'עדכן מושג':'הוסף מושג'}</button>
      ${editing? `<button class="btn ghost" data-action="cancel-edit-term">ביטול</button>`:''}
    </div>
  </div>
  <div class="card"><h2>בנק מושגים (${settings.terms.length})</h2>
    ${settings.terms.map(t=>`<div class="list-item"><div class="main"><div class="title">${escapeHtml(t.label)} <span class="cat-badge ${t.category}">${catLabel(t.category)}</span></div><div class="sub">${t.triggers.map(escapeHtml).join(', ')}</div></div><div class="row"><button class="icon-btn" data-action="edit-term" data-id="${t.id}">✏️</button><button class="icon-btn" data-action="remove-term" data-id="${t.id}">🗑</button></div></div>`).join('')}
  </div>`;
}
function renderSettingsTab(){
  return `
  <div class="card"><h2>פרטי קבוצה</h2><div class="field"><label class="field-label">שם הקבוצה</label><input type="text" id="setTeamName" value="${escapeHtml(settings.teamName)}"></div></div>
  <div class="card"><h2>ברירת מחדל למשחק</h2><div class="row wrap">
    <div class="field" style="flex:1;min-width:100px;"><label class="field-label">רבעים</label><input type="number" id="setPeriods" value="${settings.periodsDefault}" min="1" max="8"></div>
    <div class="field" style="flex:1;min-width:100px;"><label class="field-label">דקות לרבע</label><input type="number" id="setLen" value="${settings.periodLengthMinDefault}" min="1" max="60"></div>
    <div class="field" style="flex:1;min-width:100px;"><label class="field-label">פסקי זמן</label><input type="number" id="setTO" value="${settings.timeoutsDefault}" min="0" max="10"></div>
  </div></div>
  <div class="card"><h2>שפת זיהוי קול</h2><div class="field"><select id="setLang">
    <option value="he-IL" ${settings.langCode==='he-IL'?'selected':''}>עברית</option>
    <option value="en-US" ${settings.langCode==='en-US'?'selected':''}>English (US)</option>
    <option value="ar-SA" ${settings.langCode==='ar-SA'?'selected':''}>العربية</option>
    <option value="ru-RU" ${settings.langCode==='ru-RU'?'selected':''}>Русский</option>
  </select></div>
  <div class="muted">זיהוי הקול פועל רק בדפדפני כרום/אדג'. ברישום מהיר או בהקלדה תמיד אפשר להשתמש כחלופה.</div></div>
  <button class="btn primary block" data-action="save-settings">שמור הגדרות</button>
  `;
}

/* ============ ADMIN TAB ============ */
function renderAdminTab(){
  if(!myUserDoc || myUserDoc.role!=='admin') return `<div class="card muted">אין הרשאה.</div>`;
  const pending = users.filter(u=>u.status==='pending');
  const others = users.filter(u=>u.status!=='pending');
  const statusLabel = {approved:'מאושר', pending:'ממתין', blocked:'חסום'};
  const userRow = (u)=>`
    <div class="list-item">
      <div class="main">
        <div class="title">${escapeHtml(u.name)} ${u.role==='admin'?'<span class="cat-badge score">מנהל</span>':`<span class="cat-badge ${u.status==='approved'?'positive':u.status==='blocked'?'negative':'neutral'}">${statusLabel[u.status]||u.status}</span>`}</div>
        <div class="sub">${escapeHtml(u.email||'')}</div>
      </div>
      ${u.role!=='admin' ? `<div class="row">
        ${u.status!=='approved'?`<button class="icon-btn" title="אשר" data-gate-action="admin-approve" data-id="${u.id}">✔️</button>`:''}
        ${u.status!=='blocked'?`<button class="icon-btn" title="חסום" data-gate-action="admin-block" data-id="${u.id}">🚫</button>`:''}
        <button class="icon-btn" title="הפוך למנהל" data-gate-action="admin-promote" data-id="${u.id}">⭐</button>
        <button class="icon-btn" title="מחק" data-gate-action="admin-delete" data-id="${u.id}">🗑</button>
      </div>` : ''}
    </div>`;
  return `
  <div class="card muted">גישה למערכת היא בתשלום ידני: מי שמשלם/ת - "אשר" כאן. מי שלא - נשאר/ת חסום/ה או ממתין/ה.</div>
  ${pending.length? `<div class="card"><h2>ממתינים לאישור (${pending.length})</h2>${pending.map(userRow).join('')}</div>`:''}
  <div class="card"><h2>כל המשתמשים (${users.length})</h2>${others.map(userRow).join('') || '<div class="muted">אין עדיין</div>'}</div>
  `;
}

/* ============ EVENT DELEGATION ============ */
function attachDelegatedEvents(){
  const app = document.getElementById('app');
  if(app.dataset.listenersAttached) return;
  app.dataset.listenersAttached = '1';
  app.addEventListener('click', onDelegatedClick);
  app.addEventListener('change', onDelegatedChange);
}
async function onDelegatedClick(e){
  const tabBtnEl = e.target.closest('[data-tab]');
  if(tabBtnEl){ activeTab = tabBtnEl.dataset.tab; selectedPlayer=null; viewingHistoryGame=null; if(activeTab==='stats') loadGamesIndex(); renderMain(); return; }
  const actionEl = e.target.closest('[data-action]');
  if(!actionEl) return;
  const action = actionEl.dataset.action;

  if(action==='start-game') return startNewGame();
  if(action==='toggle-clock') return game.running? pauseClock() : startClock();
  if(action==='timeout') return takeTimeout();
  if(action==='opp-score') return logOppScore(parseInt(actionEl.dataset.points));
  if(action==='next-period') return nextPeriod();
  if(action==='end-game') return endGame();
  if(action==='select-player'){
    selectedPlayer = actionEl.dataset.num;
    if(game && game.trackingMode==='sticky'){ game.stickyPlayer = selectedPlayer; saveGame(); }
    renderMain(); return;
  }
  if(action==='quick-term'){
    let target = selectedPlayer;
    if(game && game.trackingMode==='fixed') target = game.fixedPlayer;
    else if(game && game.trackingMode==='sticky') target = target || game.stickyPlayer;
    if(!target){ showToast('בחר קודם שחקן'); return; }
    logEvent(target, actionEl.dataset.term, ''); return;
  }
  if(action==='submit-manual'){
    const input = document.getElementById('manualCmd'); const txt = input.value.trim();
    if(!txt) return; handleParsedCommand(parseCommand(txt)); input.value=''; return;
  }
  if(action==='undo-event'){ game.events = game.events.filter(ev=>ev.id!==actionEl.dataset.id); saveGame(); renderMain(); return; }
  if(action==='resolve-pending'){
    const id = actionEl.dataset.id;
    const playerSel = document.querySelector(`[data-pending-player="${id}"]`);
    const termSel = document.querySelector(`[data-pending-term="${id}"]`);
    if(!playerSel.value || !termSel.value){ showToast('בחר שחקן ומושג'); return; }
    const pendingItem = game.pending.find(p=>p.id===id);
    logEvent(playerSel.value, termSel.value, '', pendingItem);
    game.pending = game.pending.filter(p=>p.id!==id);
    saveGame(); renderMain(); return;
  }
  if(action==='discard-pending'){ game.pending = game.pending.filter(p=>p.id!==actionEl.dataset.id); saveGame(); renderMain(); return; }
  if(action==='add-player'){
    const num = document.getElementById('newPlayerNum').value.trim();
    const name = document.getElementById('newPlayerName').value.trim();
    if(!num){ showToast('נא להזין מספר שחקן'); return; }
    if(settings.roster.some(p=>p.number===num)){ showToast('המספר כבר קיים'); return; }
    settings.roster.push({number:num, name});
    settings.roster.sort((a,b)=>parseInt(a.number)-parseInt(b.number));
    await saveSettings(); renderMain(); return;
  }
  if(action==='remove-player'){ settings.roster = settings.roster.filter(p=>p.number!==actionEl.dataset.num); await saveSettings(); renderMain(); return; }
  if(action==='quick-add-fixed-player'){
    const num = document.getElementById('quickAddNum').value.trim();
    const name = document.getElementById('quickAddName').value.trim();
    if(!num){ showToast('נא להזין מספר שחקן'); return; }
    if(settings.roster.some(p=>p.number===num)){ showToast('המספר כבר קיים'); return; }
    settings.roster.push({number:num, name});
    settings.roster.sort((a,b)=>parseInt(a.number)-parseInt(b.number));
    pendingTrackingMode = 'fixed'; pendingFixedPlayer = num;
    await saveSettings();
    document.getElementById('quickAddNum').value=''; document.getElementById('quickAddName').value='';
    showToast('שחקן נוסף ונבחר');
    return;
  }
  if(action==='add-term'){
    const label = document.getElementById('newTermLabel').value.trim();
    const trig = document.getElementById('newTermTriggers').value.trim();
    const cat = document.getElementById('newTermCat').value;
    const pts = parseInt(document.getElementById('newTermPoints').value)||0;
    if(!label || !trig){ showToast('נא למלא שם וביטויים'); return; }
    const triggers = trig.split(',').map(s=>s.trim()).filter(Boolean);
    if(editingTermId){
      const t = settings.terms.find(x=>x.id===editingTermId);
      if(t){ t.label=label; t.triggers=triggers; t.category=cat; t.points=cat==='score'?pts:0; t.statLabel=label; }
      editingTermId = null;
      showToast('המושג עודכן');
    } else {
      settings.terms.push({id:uid(), label, triggers, category:cat, statKey:uid(), statLabel:label, points:cat==='score'?pts:0});
    }
    await saveSettings(); renderMain(); return;
  }
  if(action==='edit-term'){ editingTermId = actionEl.dataset.id; renderMain(); return; }
  if(action==='cancel-edit-term'){ editingTermId = null; renderMain(); return; }
  if(action==='remove-term'){
    if(editingTermId===actionEl.dataset.id) editingTermId=null;
    settings.terms = settings.terms.filter(t=>t.id!==actionEl.dataset.id); await saveSettings(); renderMain(); return;
  }
  if(action==='save-settings'){
    settings.teamName = document.getElementById('setTeamName').value.trim() || settings.teamName;
    settings.periodsDefault = parseInt(document.getElementById('setPeriods').value)||settings.periodsDefault;
    settings.periodLengthMinDefault = parseInt(document.getElementById('setLen').value)||settings.periodLengthMinDefault;
    settings.timeoutsDefault = parseInt(document.getElementById('setTO').value)||settings.timeoutsDefault;
    settings.langCode = document.getElementById('setLang').value;
    await saveSettings(); showToast('ההגדרות נשמרו'); return;
  }
  if(action==='view-history'){ viewingHistoryGame = gamesIndex.find(g=>g.id===actionEl.dataset.id); renderMain(); return; }
  if(action==='back-to-live-stats'){ viewingHistoryGame = null; renderMain(); return; }
}
function onDelegatedChange(e){
  if(e.target.dataset.action==='filter-period'){
    statsPeriodFilter = e.target.value==='all'?'all':parseInt(e.target.value);
    renderMain();
  }
  if(e.target.dataset.action==='set-tracking-mode'){
    pendingTrackingMode = e.target.value;
    const field = document.getElementById('fixedPlayerField');
    if(field) field.style.display = pendingTrackingMode==='fixed' ? 'block' : 'none';
  }
  if(e.target.dataset.action==='set-fixed-player'){
    pendingFixedPlayer = e.target.value;
  }
}

/* ============ ICONS ============ */
function iconMic(){ return `<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`; }
function iconWhistle(){ return `<svg viewBox="0 0 24 24"><circle cx="9" cy="15" r="5"/><path d="M14 10 L21 5 L21 9 L17 11"/></svg>`; }
function iconChart(){ return `<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="4" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="20" y1="20" x2="20" y2="14"/></svg>`; }
function iconUsers(){ return `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M15 20c0-2.2 1-4 2.5-5"/></svg>`; }
function iconBook(){ return `<svg viewBox="0 0 24 24"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5V4.5z"/><line x1="9" y1="7" x2="15" y2="7"/></svg>`; }
function iconGear(){ return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`; }

renderGate();
