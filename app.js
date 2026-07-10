/* 注音摩斯輸入引擎（測試版）
 * 第一層：張嘴＝點、長閉眼＝劃（可用 F/J 鍵或畫面按鈕代替）
 * 第二層：點劃 → codebook JSON → 注音
 * 第三層：頁面顯示 ＋ 側音 ＋ 報讀
 * 相依全部 vendor 在 repo 內，離線可跑。
 */
'use strict';

// ---------- 設定（localStorage 持久化） ----------
const DEFAULTS = { mouthThr: 0.06, eyeThr: 0.14, holdMs: 400, gapMs: 1500 };
const store = JSON.parse(localStorage.getItem('zmi-profile') || '{}');
const cfg = Object.assign({}, DEFAULTS, store);
function saveCfg() { localStorage.setItem('zmi-profile', JSON.stringify(cfg)); }

// ---------- 碼表 ----------
let morseToZhuyin = {};   // ".-" -> "ㄇ"
let codebookMeta = null;
fetch('codebook/zhuyin-morse-dachen-draft.json')
  .then(r => r.json())
  .then(cb => {
    codebookMeta = cb._meta;
    for (const [zy, v] of Object.entries(cb.codes)) morseToZhuyin[v.morse] = zy;
    for (const [tone, v] of Object.entries(cb.tones)) if (v.morse) morseToZhuyin[v.morse] = tone;
    buildRefTable(cb);
  })
  .catch(e => { setStatus('碼表載入失敗：' + e.message); });

function buildRefTable(cb) {
  const items = Object.entries(cb.codes).map(([zy, v]) => [zy, v.morse])
    .concat(Object.entries(cb.tones).filter(([, v]) => v.morse).map(([t, v]) => [t, v.morse]));
  let html = '<table class="ref"><tr>';
  items.forEach(([zy, m], i) => {
    html += `<td><b>${zy}</b> ${m.replaceAll('.', '·').replaceAll('-', '–')}</td>`;
    if ((i + 1) % 4 === 0) html += '</tr><tr>';
  });
  html += '</tr></table>';
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
  $('thrEye').style.left = (cfg.eyeThr / 0.30 * 100) + '%';
}
drawThresholds();

// ---------- 側音（Web Audio，不用任何外部函式庫） ----------
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

// ---------- 報讀（實驗性：交給系統 TTS） ----------
function speak(text) {
  if (!$('ckSpeak').checked || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-TW'; u.rate = 1.1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------- 解碼器（第二層：只認識點劃事件，不知道訊號從哪來） ----------
let symbols = '';
let gapTimer = null;
function pushSymbol(sym) {          // sym: '.' or '-'
  symbols += sym;
  buf.textContent = symbols.replaceAll('.', '·').replaceAll('-', '–');
  beep(sym === '.' ? 70 : 220);
  clearTimeout(gapTimer);
  gapTimer = setTimeout(commit, cfg.gapMs);
}
function commit() {
  if (!symbols) return;
  const zy = morseToZhuyin[symbols];
  if (zy) {
    out.textContent += zy;
    speak(zy);
  } else {
    beep(180, 200);                 // 低音＝未知碼
    setStatus('未知碼：' + symbols);
    setTimeout(() => setStatus(''), 1500);
  }
  symbols = '';
  buf.textContent = '';
}
function backspace() {
  if (symbols) { symbols = ''; buf.textContent = ''; clearTimeout(gapTimer); return; }
  out.textContent = out.textContent.slice(0, -1);
}

// ---------- 手動輸入（按鈕＋鍵盤） ----------
$('btnDot').addEventListener('click', () => pushSymbol('.'));
$('btnDash').addEventListener('click', () => pushSymbol('-'));
$('btnBack').addEventListener('click', backspace);
$('btnClear').addEventListener('click', () => { out.textContent = ''; symbols = ''; buf.textContent = ''; });
document.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.key === 'f' || e.key === 'F') pushSymbol('.');
  else if (e.key === 'j' || e.key === 'J') pushSymbol('-');
  else if (e.key === 'Backspace') { e.preventDefault(); backspace(); }
});

// ---------- 第一層：MediaPipe FaceMesh（vendor 版，離線可跑） ----------
// 嘴：上唇13/下唇14，臉高：額10/下巴152。眼（EAR）：左 159-145/33-133，右 386-374/362-263
let mouthWasOpen = false;
let eyeClosedSince = null;
let dashFired = false;

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function onResults(res) {
  if (!res.multiFaceLandmarks || !res.multiFaceLandmarks.length) return;
  const lm = res.multiFaceLandmarks[0];

  // 嘴巴
  const faceH = dist(lm[10], lm[152]);
  const mouthRatio = dist(lm[13], lm[14]) / faceH;
  const open = mouthRatio > cfg.mouthThr;
  $('barMouth').style.width = Math.min(mouthRatio / 0.15 * 100, 100) + '%';
  $('lampMouth').classList.toggle('on', open);
  if (open && !mouthWasOpen) pushSymbol('.');          // 張嘴瞬間＝一個點
  mouthWasOpen = open;

  // 眼睛（雙眼平均 EAR）
  const earL = dist(lm[159], lm[145]) / dist(lm[33], lm[133]);
  const earR = dist(lm[386], lm[374]) / dist(lm[362], lm[263]);
  const ear = (earL + earR) / 2;
  const closed = ear < cfg.eyeThr;
  $('barEye').style.width = Math.min(ear / 0.30 * 100, 100) + '%';
  $('lampEye').classList.toggle('on', closed);
  const now = performance.now();
  if (closed) {
    if (eyeClosedSince === null) eyeClosedSince = now;
    if (!dashFired && now - eyeClosedSince >= cfg.holdMs) {
      pushSymbol('-');                                  // 閉夠久＝一個劃
      dashFired = true;                                 // 需張眼後才能再打
    }
  } else {
    eyeClosedSince = null;
    dashFired = false;
  }
}

// 鏡頭啟動
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
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false,
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
