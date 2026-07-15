/* 注音摩斯輸入引擎（測試版）
 * 第一層：張嘴＝點、長閉眼＝劃（可用 F/J 鍵或畫面按鈕代替）
 * 第二層：點劃 → codebook JSON → 注音
 * 第三層：組字模式（小麥注音 McBopomofoWeb 引擎，MIT）→ 中文字 → 複製
 * 相依全部 vendor 在 repo 內，離線可跑。
 */
'use strict';

// ---------- 設定（localStorage 持久化） ----------
const DEFAULTS = { mouthThr: 0.06, eyeThr: 0.14, holdMs: 400, gapMs: 1500, coolMs: 300 };
const store = JSON.parse(localStorage.getItem('zmi-profile') || '{}');
const cfg = Object.assign({}, DEFAULTS, store);
function saveCfg() { localStorage.setItem('zmi-profile', JSON.stringify(cfg)); }

// ---------- 碼表 ----------
let morseToZhuyin = {};   // ".-"  -> "ㄇ"
let zhuyinToKey = {};     // "ㄇ" -> "a"（大千鍵位，餵組字引擎用）
let morseToControl = {};  // "----" -> {action:"Backspace", name:"退格"}
fetch('codebook/codebook-fuhua.json')
  .then(r => r.json())
  .then(cb => {
    for (const [zy, v] of Object.entries(cb.codes)) {
      morseToZhuyin[v.morse] = zy;
      zhuyinToKey[zy] = v.key;
    }
    for (const [tone, v] of Object.entries(cb.tones)) {
      if (v.morse) { morseToZhuyin[v.morse] = tone; zhuyinToKey[tone] = v.key; }
    }
    for (const [name, v] of Object.entries(cb.controls || {})) {
      morseToControl[v.morse] = { action: v.action, name, char: v.char };
    }
    buildRefTable(cb);
  })
  .catch(e => { setStatus('碼表載入失敗：' + e.message); });

function pretty(m) { return m.replaceAll('.', '·').replaceAll('-', '–'); }
function morseAction(m) {   // ·––→「張、閉、閉」
  return [...m].map(c => c === '.' ? '張' : '閉').join('、');
}
function gridOf(pairs, showAction) {
  let html = '<table class="ref"><tr>';
  pairs.forEach(([name, m], i) => {
    const act = showAction ? `<br><small style="color:#888">${morseAction(m)}</small>` : '';
    html += `<td><b>${name}</b> ${pretty(m)}${act}</td>`;
    if ((i + 1) % 4 === 0) html += '</tr><tr>';
  });
  return html + '</tr></table>';
}
function buildRefTable(cb) {
  const zhuyin = Object.entries(cb.codes).map(([zy, v]) => [zy, v.morse]);
  const tones = Object.entries(cb.tones).filter(([, v]) => v.morse).map(([t, v]) => [t, v.morse]);
  const controls = Object.entries(cb.controls || {}).map(([n, v]) => [n, v.morse]);
  const html =
    '<h3 class="refh">注音符號（37）</h3>' + gridOf(zhuyin, false) +
    '<h3 class="refh">聲調（先打注音，最後打聲調）</h3>' + gridOf(tones, true) +
    '<p class="refnote">此為馥華<b>實際使用</b>的碼表（瑪利亞雲端團隊＋育瑋整理,2026-07）。' + '長短式:點=張嘴、劃=長閉眼。一聲=空白鍵( <code>······</code> 六點,此系統自訂),二~四聲/輕聲=數字鍵碼。</p>' +
    '<h3 class="refh">控制碼</h3>' + gridOf(controls, true);
  document.getElementById('refTable').innerHTML = html;
}

// ---------- UI 元件 ----------
const $ = id => document.getElementById(id);
const out = $('out'), buf = $('buf');
function setStatus(t) { $('status').textContent = t; }

// 滑桿綁定
const sliders = [
  ['sMouth', 'vMouth', 'mouthThr', v => v.toFixed(3)],
  ['sEye',   'vEye',   'eyeThr',   v => v.toFixed(3)],
  ['sCool',  'vCool',  'coolMs',   v => v + ' ms'],
  ['sHold',  'vHold',  'holdMs',   v => v + ' ms'],
  ['sGap',   'vGap',   'gapMs',    v => v + ' ms'],
];
for (const [sid, vid, key, fmt] of sliders) {
  const el = $(sid);
  el.value = cfg[key];
  $(vid).textContent = fmt(cfg[key]);
  el.addEventListener('input', () => {
    cfg[key] = parseFloat(el.value);
    $(vid).textContent = fmt(cfg[key]);
    saveCfg();
    drawThresholds();
  });
}
function drawThresholds() {
  $('thrMouth').style.left = (cfg.mouthThr / 0.15 * 100) + '%';
  $('thrEye').style.left = (cfg.eyeThr / 0.40 * 100) + '%';
}
drawThresholds();

// ---------- 側音（Web Audio） ----------
let audioCtx = null;
function beep(ms, freq = 660) {
  if (!$('ckTone').checked) return;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.25, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000);
  o.start(); o.stop(audioCtx.currentTime + ms / 1000);
}

// ---------- 報讀（系統 TTS） ----------
// 注音符號的標準讀音字（直接丟「ㄋ」給 TTS 不一定念得出來，用讀音字最穩）
const SPEAK_NAME = {
  'ㄅ':'玻','ㄆ':'坡','ㄇ':'摸','ㄈ':'佛','ㄉ':'得','ㄊ':'特','ㄋ':'訥','ㄌ':'勒',
  'ㄍ':'哥','ㄎ':'科','ㄏ':'喝','ㄐ':'基','ㄑ':'欺','ㄒ':'希',
  'ㄓ':'知','ㄔ':'吃','ㄕ':'詩','ㄖ':'日','ㄗ':'資','ㄘ':'雌','ㄙ':'思',
  'ㄧ':'衣','ㄨ':'烏','ㄩ':'迂',
  'ㄚ':'啊','ㄛ':'喔','ㄜ':'鵝','ㄝ':'耶','ㄞ':'哀','ㄟ':'欸','ㄠ':'凹','ㄡ':'歐',
  'ㄢ':'安','ㄣ':'恩','ㄤ':'昂','ㄥ':'鞥','ㄦ':'兒',
  'ˉ':'一聲','ˊ':'二聲','ˇ':'三聲','ˋ':'四聲','˙':'輕聲'
};
let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  zhVoice = vs.find(v => v.lang === 'zh-TW') || vs.find(v => (v.lang || '').startsWith('zh')) || null;
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

function speak(text) {
  if (!$('ckSpeak').checked || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  if (zhVoice) u.voice = zhVoice;
  u.lang = 'zh-TW'; u.rate = 1.15;
  // Chrome 已知 bug：cancel() 後立刻 speak() 會被吃掉——隔 30ms 再講
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  setTimeout(() => speechSynthesis.speak(u), 30);
}

// ---------- 組字引擎（小麥注音，lazy load） ----------
let ime = null;               // { controller }
let imeLoading = null;
let candidatesVisible = false;

const CODE_MAP = { ' ': 'Space', ',': 'Comma', '.': 'Period', ';': 'Semicolon', '/': 'Slash', '-': 'Minus' };
function codeFor(key) {
  if (CODE_MAP[key]) return CODE_MAP[key];
  if (/^[0-9]$/.test(key)) return 'Digit' + key;
  if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
  return key;
}
function sendKeyToIME(key, codeName) {
  if (!ime) return false;
  const ev = new KeyboardEvent('keydown', { key, code: codeName || codeFor(key), bubbles: false });
  return ime.controller.keyEvent(ev);
}

function ensureIME() {
  if (ime) return Promise.resolve(ime);
  if (imeLoading) return imeLoading;
  setStatus('組字引擎載入中…（約 5MB，僅第一次）');
  imeLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/mcbopomofo/bundle.js';
    s.onload = () => {
      try {
        const { InputController } = window.mcbopomofo;
        const ui = {
          reset() {
            $('mcbBuffer').textContent = '';
            $('mcbCands').innerHTML = '';
            candidatesVisible = false;
          },
          commitString(str) {
            out.textContent += str;
            speak(str);
          },
          update(stateJson) {
            const st = JSON.parse(stateJson);
            const text = (st.composingBuffer || []).map(i => i.text).join('');
            $('mcbBuffer').textContent = text;
            const cands = st.candidates || [];
            candidatesVisible = cands.length > 0;
            if (candidatesVisible) {
              let h = '';
              for (const c of cands) {
                h += `<span class="cand${c.selected ? ' sel' : ''}"><b>${c.keyCap}</b> ${c.candidate.displayedText}</span> `;
              }
              if (st.candidatePageCount > 1) h += `<small>${st.candidatePageIndex + 1}/${st.candidatePageCount} 頁</small>`;
              $('mcbCands').innerHTML = h;
            } else {
              $('mcbCands').innerHTML = '';
            }
          },
        };
        const controller = new InputController(ui);
        controller.setLanguageCode('zh-TW');
        if (typeof controller.setUserVerticalCandidates === 'function') controller.setUserVerticalCandidates(false);
        controller.setOnError(() => beep(180, 200));
        ime = { controller };
        setStatus('組字引擎就緒 ✓');
        setTimeout(() => setStatus(''), 1500);
        resolve(ime);
      } catch (e) { setStatus('組字引擎初始化失敗：' + e.message); reject(e); }
    };
    s.onerror = () => { setStatus('組字引擎下載失敗'); reject(new Error('load fail')); };
    document.body.appendChild(s);
  });
  return imeLoading;
}
function imeOn() { return $('ckIME').checked; }
$('ckIME').addEventListener('change', () => { if (imeOn()) ensureIME(); });
if (document.readyState !== 'loading') { if (imeOn()) ensureIME(); }
else document.addEventListener('DOMContentLoaded', () => { if (imeOn()) ensureIME(); });

// ---------- 解碼器（第二層：只認識點劃事件） ----------
let symbols = '';
let gapTimer = null;
function pushSymbol(sym) {          // '.' or '-'
  symbols += sym;
  buf.textContent = symbols.replaceAll('.', '·').replaceAll('-', '–');
  // 雙重編碼：點＝高音短聲、劃＝低音長聲——音高差讓誤判在第一毫秒就聽得出來
  if (sym === '.') beep(70, 880); else beep(220, 440);
  clearTimeout(gapTimer);
  gapTimer = setTimeout(commit, cfg.gapMs);
}
function commit() {
  if (!symbols) return;
  const ctrl = morseToControl[symbols];
  if (ctrl) {
    symbols = ''; buf.textContent = '';
    dispatchControl(ctrl);
    return;
  }
  const zy = morseToZhuyin[symbols];
  if (!zy) {
    beep(180, 200);
    speak('錯誤');                    // 視障者不能只靠低音嗶——用講的
    setStatus('未知碼：' + symbols);
    setTimeout(() => setStatus(''), 1500);
  } else if (imeOn() && ime) {
    sendKeyToIME(zhuyinToKey[zy]);   // 餵大千鍵位給引擎，引擎自己組字
    speak(SPEAK_NAME[zy] || zy);     // 每個注音進去都念出來（她的協定第 3 條）
  } else {
    out.textContent += zy;
    speak(SPEAK_NAME[zy] || zy);
  }
  symbols = '';
  buf.textContent = '';
}
function backspace() {
  if (symbols) { symbols = ''; buf.textContent = ''; clearTimeout(gapTimer); return; }
  if (imeOn() && ime && ($('mcbBuffer').textContent || candidatesVisible)) {
    sendKeyToIME('Backspace', 'Backspace');
    return;
  }
  out.textContent = out.textContent.slice(0, -1);
}
function enterKey() {
  if (imeOn() && ime && ($('mcbBuffer').textContent || candidatesVisible)) {
    sendKeyToIME('Enter', 'Enter');
  }
}

function dispatchControl(ctrl) {
  switch (ctrl.action) {
    case 'Submit': enterKey(); break;
    case 'Backspace': speak('退格'); backspace(); break;
    case 'ClearAll': speak('清空'); clearAll(); break;
    case 'CancelComposing': speak('取消'); if (ime) ime.controller.reset(); break;
    case 'SpeakAll': speak(out.textContent || '沒有內容'); break;
    case 'StopSpeak': if (window.speechSynthesis) speechSynthesis.cancel(); break;
    case 'Punct': if (ctrl.char) { out.textContent += ctrl.char; speak(ctrl.char); } break;
    case 'ToggleMode': speak('中英切換,尚未支援'); break;
    case 'ToggleCase': speak('大小寫切換,尚未支援'); break;
    default: speak(ctrl.name || '');
  }
}

// ---------- 手動輸入（按鈕＋鍵盤） ----------
$('btnDot').addEventListener('click', () => pushSymbol('.'));
$('btnDash').addEventListener('click', () => pushSymbol('-'));
$('btnBack').addEventListener('click', backspace);
$('btnEnter').addEventListener('click', enterKey);
function clearAll() {
  out.textContent = ''; symbols = ''; buf.textContent = '';
  if (ime) ime.controller.reset();
}
$('btnClear').addEventListener('click', clearAll);
$('btnSpeakTest').addEventListener('click', () => speak('報讀正常，玻，二聲'));
$('btnCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(out.textContent);
    setStatus('已複製 ✓ 到 LINE / Word 貼上即可');
    setTimeout(() => setStatus(''), 2500);
  } catch (e) { setStatus('複製失敗：' + e.message); }
});

document.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.key === 'f' || e.key === 'F') { pushSymbol('.'); return; }
  if (e.key === 'j' || e.key === 'J') { pushSymbol('-'); return; }
  if (e.key === 'Backspace') { e.preventDefault(); backspace(); return; }
  if (e.key === 'Enter') { enterKey(); return; }
  // 組字中，讓少數控制鍵直通引擎（候選字換頁／選字）
  if (imeOn() && ime && ($('mcbBuffer').textContent || candidatesVisible)) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) {
      e.preventDefault(); sendKeyToIME(e.key, e.key); return;
    }
    if (candidatesVisible && /^[1-9]$/.test(e.key)) {
      e.preventDefault(); sendKeyToIME(e.key); return;
    }
    if (candidatesVisible && e.key === ' ') {
      e.preventDefault(); sendKeyToIME(' ', 'Space'); return;
    }
  }
});

// ---------- 第一層：MediaPipe FaceMesh（vendor 版） ----------
// 嘴：上唇13/下唇14，臉高：額10/下巴152。眼（EAR）：左 159-145/33-133，右 386-374/362-263
let mouthArmed = true;       // 遲滯：降回門檻七成才重新武裝
let lastDotAt = 0;           // 冷卻：兩個點的最小間隔
let eyeClosedSince = null;
let dashFired = false;
let smMouth = null, smEar = null;   // 指數平滑，濾抖動

const MOUTH_PTS = [13, 14];
const EYE_PTS = [159, 145, 33, 133, 386, 374, 362, 263];

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function drawOverlay(lm) {
  const cv = $('overlay'), video = $('cam');
  if (cv.width !== video.videoWidth) { cv.width = video.videoWidth; cv.height = video.videoHeight; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  for (const p of lm) ctx.fillRect(p.x * cv.width - 1, p.y * cv.height - 1, 2, 2);
  ctx.fillStyle = '#f33';
  for (const i of MOUTH_PTS) { const p = lm[i]; ctx.beginPath(); ctx.arc(p.x * cv.width, p.y * cv.height, 4, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#0cf';
  for (const i of EYE_PTS) { const p = lm[i]; ctx.beginPath(); ctx.arc(p.x * cv.width, p.y * cv.height, 3, 0, 7); ctx.fill(); }
}

function onResults(res) {
  if (!res.multiFaceLandmarks || !res.multiFaceLandmarks.length) {
    $('numMouth').textContent = '（未偵測到臉）';
    return;
  }
  const lm = res.multiFaceLandmarks[0];
  drawOverlay(lm);

  // 嘴巴：平滑 → 遲滯 → 冷卻
  const faceH = dist(lm[10], lm[152]);
  const raw = dist(lm[13], lm[14]) / faceH;
  smMouth = smMouth === null ? raw : smMouth * 0.5 + raw * 0.5;
  const open = smMouth > cfg.mouthThr;
  $('barMouth').style.width = Math.min(smMouth / 0.15 * 100, 100) + '%';
  $('numMouth').textContent = smMouth.toFixed(3) + ' / 門檻 ' + cfg.mouthThr.toFixed(3);
  $('lampMouth').classList.toggle('on', open);
  const now = performance.now();
  if (open && mouthArmed && now - lastDotAt >= cfg.coolMs) {
    pushSymbol('.');
    lastDotAt = now;
    mouthArmed = false;                       // 要先閉回去才能再觸發
  }
  if (smMouth < cfg.mouthThr * 0.7) mouthArmed = true;   // 遲滯下限

  // 眼睛：平滑 EAR
  const earL = dist(lm[159], lm[145]) / dist(lm[33], lm[133]);
  const earR = dist(lm[386], lm[374]) / dist(lm[362], lm[263]);
  const raw2 = (earL + earR) / 2;
  smEar = smEar === null ? raw2 : smEar * 0.5 + raw2 * 0.5;
  const closed = smEar < cfg.eyeThr;
  $('barEye').style.width = Math.min(smEar / 0.40 * 100, 100) + '%';
  $('numEye').textContent = smEar.toFixed(3) + ' / 門檻 ' + cfg.eyeThr.toFixed(3);
  $('lampEye').classList.toggle('on', closed);
  if (closed) {
    if (eyeClosedSince === null) eyeClosedSince = now;
    if (!dashFired && now - eyeClosedSince >= cfg.holdMs) {
      pushSymbol('-');
      dashFired = true;
    }
  } else {
    eyeClosedSince = null;
    dashFired = false;
  }
}

$('btnCam').addEventListener('click', async () => {
  try {
    setStatus('鏡頭啟動中…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' }, audio: false
    });
    const video = $('cam');
    video.srcObject = stream;
    await video.play();

    const faceMesh = new FaceMesh({ locateFile: f => 'vendor/face_mesh/' + f });
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true,
                          minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    faceMesh.onResults(onResults);

    let busy = false;
    async function loop() {
      if (!busy && video.readyState >= 2) {
        busy = true;
        await faceMesh.send({ image: video });
        busy = false;
      }
      requestAnimationFrame(loop);
    }
    loop();
    setStatus('鏡頭運作中 ✓');
    $('btnCam').disabled = true;
  } catch (e) {
    setStatus('鏡頭無法啟動：' + e.message + '（仍可用 F/J 鍵或按鈕測試）');
  }
});
