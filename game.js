import * as THREE from "three";

/* =========================================================
   AR FPS — 침공  (개선판)
   카메라 영상 배경 + 자이로/마우스 조준 + 다종 적 + 콤보/파워업
   성능: 오브젝트 풀링, 공유 지오메트리, 프레임당 할당 최소화
   ========================================================= */

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const videoEl = $("camera");
const appEl = $("app");
const hudEl = $("hud");
const startScreen = $("start-screen");
const pauseScreen = $("pause-screen");
const upgradeScreen = $("upgrade-screen");
const gameoverScreen = $("gameover-screen");
const permNote = $("permission-note");
const popupsEl = $("popups");
const powerupsEl = $("powerups");

const ui = {
  score: $("score"), wave: $("wave"), kills: $("kills"),
  health: $("health-fill"), ammo: $("ammo"),
  hitmarker: $("hitmarker"), vignette: $("damage-vignette"), lowhp: $("lowhp-vignette"),
  combo: $("combo"), comboX: $("combo-x"),
  reloadBar: $("reload-bar"), reloadFill: $("reload-bar").firstElementChild,
  crosshair: $("crosshair"), fps: $("fps"), fireBtn: $("fire-btn"),
  finalScore: $("final-score"), finalWave: $("final-wave"), finalKills: $("final-kills"),
  finalAcc: $("final-acc"), finalCombo: $("final-combo"),
  hiStart: $("hi-start"), hiOver: $("hi-over"), newRecord: $("newrecord"),
};

// ---------- 상수 / 적 종류 ----------
const State = { MENU: "menu", PLAYING: "playing", PAUSED: "paused", UPGRADE: "upgrade", OVER: "over" };
const HISCORE_KEY = "arfps_highscore";
const AIM_KEY = "arfps_aim";
const MUTE_KEY = "arfps_muted";
const GAIN_KEY = "arfps_gyrogain";
const SCORES_KEY = "arfps_scores";   // 로컬 Top 10 랭킹
const NAME_KEY = "arfps_name";       // 마지막 입력 이름
const ARENA_KEY = "arfps_arena";     // 비-AR 아레나 모드

// 온라인 글로벌 랭킹 (Supabase) — 값이 채워지면 자동으로 글로벌 모드, 비어 있으면 로컬 폴백
const SUPABASE_URL = "";   // 예: https://xxxx.supabase.co
const SUPABASE_KEY = "";   // anon / publishable key (공개키)
const ONLINE_LB = !!(SUPABASE_URL && SUPABASE_KEY);
async function fetchGlobalScores() {
  if (!ONLINE_LB) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scores?select=name,score,wave&order=score.desc&limit=10`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
async function submitGlobalScore(name, score, wave) {
  if (!ONLINE_LB) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ name, score, wave }),
    });
    return r.ok;
  } catch (e) { return false; }
}
const INDICATOR_COUNT = 6; // 화면 밖 위협 표시기 수

// AR 테마(구역) — 카메라 배경 위 3D 연출(조명/안개/그리드/파티클/색감)을 구간마다 전환
const THEMES = [
  { name: "사이버 그리드", amb: 0x335544, dir: 0xbfffe9, grid: 0x2bf5c8, particle: 0x2bf5c8, fogColor: 0x06231d, fogDensity: 0.018, tint: "rgba(20,90,75,0.12)",  sky: 0x2faa7e, glow: 1.5 },
  { name: "용암 지대",     amb: 0x553322, dir: 0xffd0a0, grid: 0xff6a1a, particle: 0xff7a30, fogColor: 0x2a0a00, fogDensity: 0.022, tint: "rgba(130,45,0,0.16)",  sky: 0xc24216, glow: 1.4 },
  { name: "심해",          amb: 0x223355, dir: 0x9fd0ff, grid: 0x3aa0ff, particle: 0x6ad0ff, fogColor: 0x041025, fogDensity: 0.030, tint: "rgba(10,45,95,0.18)",  sky: 0x2470c8, glow: 1.7 },
  { name: "우주 정거장",   amb: 0x333355, dir: 0xffffff, grid: 0xb14dff, particle: 0xffffff, fogColor: 0x0a0a18, fogDensity: 0.012, tint: "rgba(45,20,85,0.14)",  sky: 0x4a3fa0, glow: 1.5 },
  { name: "사막 폭풍",     amb: 0x554433, dir: 0xffe8b0, grid: 0xffb347, particle: 0xffcf80, fogColor: 0x2a2010, fogDensity: 0.025, tint: "rgba(125,95,30,0.14)", sky: 0xc2923a, glow: 1.4 },
];
const reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

// 적 종류: 색뿐 아니라 형태(geo)로도 구분(색약 대응), 속도 상한(speedCap)으로 후반 난이도 폭주 방지
const ENEMY_TYPES = {
  scout:  { hp: 1, speed: 3.0, speedCap: 4.6, scale: 0.65, geo: "scout",  color: 0x2bf5c8, emissive: 0x0a4a3c, damage: 7,  score: 110, ranged: false },
  drone:  { hp: 1, speed: 1.9, speedCap: 4.0, scale: 1.0,  geo: "drone",  color: 0xff3b5c, emissive: 0x550010, damage: 12, score: 100, ranged: false },
  brute:  { hp: 3, speed: 1.1, speedCap: 2.4, scale: 1.6,  geo: "brute",  color: 0xff7a1a, emissive: 0x5a2400, damage: 22, score: 280, ranged: false },
  turret: { hp: 2, speed: 1.4, speedCap: 2.4, scale: 1.05, geo: "turret", color: 0xb14dff, emissive: 0x3a0a5a, damage: 16, score: 220, ranged: true, range: 7.5, fireCD: 2.2, projDamage: 10, maxShots: 5 },
  splitter:{ hp: 2, speed: 1.7, speedCap: 3.0, scale: 1.1, geo: "drone", color: 0x9bff3b, emissive: 0x2a5500, damage: 12, score: 160, ranged: false, splits: 2 },
  shield: { hp: 4, speed: 1.2, speedCap: 2.3, scale: 1.2, geo: "turret", color: 0x4db5ff, emissive: 0x0a2a4a, damage: 16, score: 240, ranged: false, shielded: true },
  boss:   { hp: 26, speed: 0.7, speedCap: 1.3, scale: 2.6, geo: "brute", color: 0xffd23b, emissive: 0x5a4000, damage: 34, score: 1500, ranged: true, range: 9.5, fireCD: 1.1, projDamage: 12, maxShots: 9999, boss: true, pellets: 5 },
};

const game = {
  state: State.MENU,
  score: 0, kills: 0, wave: 0,
  health: 100, maxHealth: 100,
  ammo: 12, magSize: 12, reloading: false, reloadTimer: 0, reloadDur: 800,
  combo: 0, comboTimer: 0,
  enemiesToSpawn: 0, spawnTimer: 0, betweenWaves: false, waveBreakTimer: 0,
  // 파워업
  overdrive: 0,      // 남은 시간(초)
  fireCooldown: 0,   // 발사 간격 타이머
  highscore: 0,
  muted: false,
  // 로그라이트 강화 스탯 (dmg/fireInterval/magSize/reloadDur는 무기+보너스로 재계산되는 유효값)
  dmg: 1, fireInterval: 0.12, critRadius: 0.34, lifesteal: 0, scoreMult: 1,
  critMult: 2, pierce: 0, explosive: 0, explosiveDmg: 0,
  // 무기
  weapon: 0, weaponAmmo: [12, 6, 30], pellets: 1, spread: 0, auto: false, firing: false,
  dmgBonus: 0, magBonus: 0, fireMult: 1, reloadMult: 1,
  wpMods: null,          // 무기별 전용 강화 (resetGame에서 초기화)
  // 통계
  shotsFired: 0, shotsHit: 0, maxCombo: 0,
  // 궁극기
  ult: 0, ultGain: 0.075,
  boss: null,
  theme: -1,
  arena: false,
};

// 무기 3종 — 발사간격/탄창/펠릿/탄퍼짐/연사 여부로 차별화
const WEAPONS = [
  { key: "pistol",  name: "권총",    icon: "🔫", mag: 12, fireInterval: 0.12, reloadDur: 800,  pellets: 1, spread: 0.0,   dmg: 1.3, auto: false },
  { key: "shotgun", name: "산탄총",  icon: "💥", mag: 6,  fireInterval: 0.55, reloadDur: 1100, pellets: 6, spread: 0.07,  dmg: 1.5, auto: false },
  { key: "smg",     name: "기관단총", icon: "🔥", mag: 30, fireInterval: 0.06, reloadDur: 1000, pellets: 1, spread: 0.025, dmg: 1, auto: true },
];

// ---------- Three.js ----------
let renderer, scene, camera, raycaster;
let ambLight, dirLight, ambientMotes, mapTintEl, arenaGrid, skyMesh;
let enemyGlow = 1.5; // 구역별 적 발광(대비) 기준값
const clock = new THREE.Clock();

// 재사용 임시 벡터 (프레임당 할당 방지)
const _dir = new THREE.Vector3();
const _proj = new THREE.Vector3();
const playerPos = new THREE.Vector3(0, 0, 0);
const centerVec = new THREE.Vector2(0, 0);
const _aim = new THREE.Vector2();

// 공유 지오메트리 (적 외형은 공유, 색/스케일만 변경)
let SHARED;

function initThree() {
  // 고해상도(모바일) 기기는 AA를 끄고 픽셀비를 보수적으로 시작 → 적응형으로 자동 조절
  const hiDPI = window.devicePixelRatio > 1.5;
  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: !hiDPI, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, hiDPI ? 1.5 : 2));
  appEl.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 0);

  ambLight = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambLight);
  dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(2, 5, 3);
  scene.add(dirLight);

  raycaster = new THREE.Raycaster();

  SHARED = {
    drone: new THREE.OctahedronGeometry(0.55, 0),
    scout: new THREE.TetrahedronGeometry(0.6, 0),
    brute: new THREE.DodecahedronGeometry(0.6, 0),
    turret: new THREE.BoxGeometry(0.7, 0.7, 0.7),
    ring: new THREE.TorusGeometry(0.8, 0.06, 8, 20),
    core: new THREE.SphereGeometry(0.18, 8, 8),
    proj: new THREE.IcosahedronGeometry(0.16, 0),
  };
  initPickupAssets();

  // 부유 파티클(분위기) — 테마 색으로 틴트
  const N = 90, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 44; pos[i * 3 + 1] = (Math.random() - 0.5) * 22; pos[i * 3 + 2] = (Math.random() - 0.5) * 44; }
  const ageo = new THREE.BufferGeometry();
  ageo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  ambientMotes = new THREE.Points(ageo, new THREE.PointsMaterial({ size: 0.13, transparent: true, opacity: 0.5, color: 0x2bf5c8 }));
  scene.add(ambientMotes);

  mapTintEl = document.getElementById("map-tint");
  applyTheme(0);

  window.addEventListener("resize", onResize);
}

// 테마 적용 — 조명/안개/그리드/파티클/화면 틴트 전환
function ensureSky() {
  if (skyMesh) return;
  const mat = new THREE.ShaderMaterial({
    uniforms: { topColor: { value: new THREE.Color() }, bottomColor: { value: new THREE.Color() }, offset: { value: 6 }, exponent: { value: 0.7 } },
    vertexShader: "varying vec3 vWorldPosition; void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vWorldPosition = wp.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 topColor; uniform vec3 bottomColor; uniform float offset; uniform float exponent; varying vec3 vWorldPosition; void main(){ float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y; float f = max(pow(max(h,0.0), exponent), 0.0); gl_FragColor = vec4(mix(bottomColor, topColor, f), 1.0); }",
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(60, 24, 12), mat);
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);
}
function applyTheme(i) {
  const t = THEMES[i];
  game.theme = i;
  enemyGlow = t.glow;
  scene.fog = new THREE.FogExp2(t.fogColor, game.arena ? t.fogDensity * 1.4 : t.fogDensity);
  ambLight.color.setHex(t.amb);
  dirLight.color.setHex(t.dir);
  ambientMotes.material.color.setHex(t.particle);
  if (arenaGrid) { scene.remove(arenaGrid); arenaGrid.geometry.dispose(); arenaGrid.material.dispose(); arenaGrid = null; }
  if (game.arena) {
    // 비-AR 아레나: 그라디언트 스카이박스 + 네온 그리드 바닥 (카메라 미사용)
    scene.background = new THREE.Color(t.fogColor);
    ensureSky();
    skyMesh.material.uniforms.topColor.value.setHex(t.sky);
    skyMesh.material.uniforms.bottomColor.value.setHex(t.fogColor);
    skyMesh.visible = true;
    arenaGrid = new THREE.GridHelper(80, 40, t.grid, t.grid);
    arenaGrid.position.y = -3.5;
    arenaGrid.material.transparent = true;
    arenaGrid.material.opacity = 0.35;
    scene.add(arenaGrid);
    if (mapTintEl) mapTintEl.style.backgroundColor = "rgba(0,0,0,0)";
  } else {
    // AR: 배경 투과(카메라) + 색감 틴트
    scene.background = null;
    if (skyMesh) skyMesh.visible = false;
    if (mapTintEl) mapTintEl.style.backgroundColor = t.tint;
  }
}

function onResize() {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* =========================================================
   조준 컨트롤: 자이로(우선) + 포인터 드래그(폴백)
   ========================================================= */
const controls = {
  preferred: "gyro",          // 'gyro' | 'touch' — 사용자 선택(localStorage 저장)
  yaw: 0, pitch: 0, dragging: false,
  lastX: 0, lastY: 0,
  deviceQ: new THREE.Quaternion(),
  calibQ: new THREE.Quaternion(),  // 정면 보정 오프셋
  hasOrientation: false,
  gyroListening: false,
  gyroGain: 1.5,                   // 자이로 회전 증폭(앉아서/태블릿 조작 보조)
};
const zee = new THREE.Vector3(0, 0, 1);
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const tmpEuler = new THREE.Euler();
const tmpQ = new THREE.Quaternion();
const _camTarget = new THREE.Quaternion();

// 자이로 사용 중인지(선택이 자이로 + 실제 센서 존재). 아니면 터치 드래그.
function aimingByTouch() { return controls.preferred === "touch" || !controls.hasOrientation; }

function gyroToQuaternion(quaternion, alpha, beta, gamma, orient) {
  tmpEuler.set(beta, alpha, -gamma, "YXZ");
  quaternion.setFromEuler(tmpEuler);
  quaternion.multiply(q1);
  quaternion.multiply(tmpQ.setFromAxisAngle(zee, -orient));
}
function onDeviceOrientation(e) {
  if (e.alpha == null) return;
  const first = !controls.hasOrientation;
  controls.hasOrientation = true;
  const alpha = THREE.MathUtils.degToRad(e.alpha);
  const beta = THREE.MathUtils.degToRad(e.beta);
  const gamma = THREE.MathUtils.degToRad(e.gamma);
  const orient = THREE.MathUtils.degToRad((screen.orientation && screen.orientation.angle) || window.orientation || 0);
  gyroToQuaternion(controls.deviceQ, alpha, beta, gamma, orient);
  if (first) { recalibrate(true); refreshControlsUI(); } // 첫 신호에 자동 정면 보정
}
function recalibrate(silent) {
  if (!controls.hasOrientation) { if (!silent) showCenterText("자이로 미지원"); return; }
  controls.calibQ.copy(controls.deviceQ).invert();
  if (!silent) showCenterText("정면 보정됨");
}
// 쿼터니언 회전 각도를 gain배 증폭 (정면 기준 상대회전을 키워 작은 움직임으로 넓게 둘러보기)
function scaleQuat(q, gain, out) {
  let x = q.x, y = q.y, z = q.z, w = q.w;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; } // 최단 경로
  if (w > 1) w = 1;
  const half = Math.acos(w), s = Math.sin(half);
  if (s < 1e-4) { out.set(q.x, q.y, q.z, q.w); return out; }
  const nh = half * gain, k = Math.sin(nh) / s;
  out.set(x * k, y * k, z * k, Math.cos(nh));
  return out.normalize();
}
function updateCameraFromControls() {
  if (!aimingByTouch()) {
    _camTarget.copy(controls.deviceQ).premultiply(controls.calibQ);
    if (controls.gyroGain !== 1) scaleQuat(_camTarget, controls.gyroGain, _camTarget);
    camera.quaternion.slerp(_camTarget, 0.5);
  } else {
    tmpEuler.set(controls.pitch, controls.yaw, 0, "YXZ");
    camera.quaternion.setFromEuler(tmpEuler);
  }
}
function setupPointer() {
  const el = renderer.domElement;
  let moved = 0;
  const onDown = (x, y) => { controls.dragging = true; controls.lastX = x; controls.lastY = y; moved = 0; };
  const onMove = (x, y) => {
    if (!controls.dragging) return;
    const dx = x - controls.lastX, dy = y - controls.lastY;
    controls.lastX = x; controls.lastY = y;
    moved += Math.abs(dx) + Math.abs(dy);
    if (aimingByTouch()) {  // 터치/마우스 드래그로 조준 (자이로 모드에선 무시)
      controls.yaw -= dx * 0.0035;
      controls.pitch -= dy * 0.0035;
      controls.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, controls.pitch));
    }
  };
  const onUp = () => {
    if (controls.dragging && moved < 12 && game.state === State.PLAYING) fire();
    controls.dragging = false;
  };
  el.addEventListener("mousedown", (e) => onDown(e.clientX, e.clientY));
  window.addEventListener("mousemove", (e) => onMove(e.clientX, e.clientY));
  window.addEventListener("mouseup", onUp);
  el.addEventListener("touchstart", (e) => { const t = e.touches[0]; onDown(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener("touchend", onUp);
}

// 조준 방식(자이로/터치) 선택·저장·UI 동기화
function setAimMode(mode) {
  controls.preferred = mode;
  try { localStorage.setItem(AIM_KEY, mode); } catch (e) {}
  document.querySelectorAll(".aim-seg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  // 터치 모드로 막 바꾸면 현재 보는 방향(yaw+pitch)에서 이어가도록 동기화 (시점 튐 방지)
  if (mode === "touch" && camera) {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    controls.yaw = e.y; controls.pitch = e.x;
  }
  refreshControlsUI();
}
function refreshControlsUI() {
  const showRecalib = controls.preferred === "gyro" && controls.hasOrientation && game.state === State.PLAYING;
  const rc = document.getElementById("recalib-btn");
  if (rc) rc.classList.toggle("hidden", !showRecalib);
}
function loadAimMode() {
  const saved = localStorage.getItem(AIM_KEY);
  setAimMode(saved === "touch" || saved === "gyro" ? saved : "gyro");
}
function setGyroGain(g) {
  controls.gyroGain = g;
  try { localStorage.setItem(GAIN_KEY, String(g)); } catch (e) {}
  document.querySelectorAll(".gain-seg button").forEach((b) => b.classList.toggle("active", parseFloat(b.dataset.gain) === g));
}
function loadGyroGain() {
  const v = parseFloat(localStorage.getItem(GAIN_KEY));
  setGyroGain(v === 1 || v === 1.5 || v === 2 ? v : 1.5);
}

// 무기: 유효 스탯 = 무기 기본값 + 강화 보너스
function recomputeWeaponStats() {
  const w = WEAPONS[game.weapon];
  const m = game.wpMods ? game.wpMods[game.weapon] : { dmg: 0, pellets: 0, spreadMult: 1, fireMult: 1, magBonus: 0 };
  game.dmg = w.dmg + game.dmgBonus + m.dmg;
  game.magSize = w.mag + game.magBonus + m.magBonus;
  game.fireInterval = w.fireInterval * game.fireMult * m.fireMult;
  game.reloadDur = w.reloadDur * game.reloadMult;
  game.pellets = w.pellets + m.pellets;
  game.spread = w.spread * m.spreadMult;
  game.auto = w.auto;
}
function updateWeaponUI() {
  const b = document.getElementById("weapon-btn");
  if (!b) return;
  const w = WEAPONS[game.weapon];
  b.innerHTML = `<span class="wp-icon">${w.icon}</span><span class="wp-name">${w.name}</span>`;
}
function selectWeapon(idx) {
  if (idx < 0 || idx >= WEAPONS.length || idx === game.weapon || game.state !== State.PLAYING) return;
  game.weaponAmmo[game.weapon] = game.ammo;     // 현재 탄 저장
  game.weapon = idx;
  game.reloading = false; ui.reloadBar.classList.remove("active"); ui.reloadFill.style.width = "0%";
  recomputeWeaponStats();
  game.ammo = Math.min(game.weaponAmmo[idx], game.magSize);
  game.fireCooldown = Math.max(game.fireCooldown, 0.15); // 교체 딜레이
  sfx.swap();
  updateWeaponUI(); updateAmmo();
}
function cycleWeapon() { selectWeapon((game.weapon + 1) % WEAPONS.length); }

/* =========================================================
   사운드 (WebAudio 신스)
   ========================================================= */
let audioCtx = null;
let musicGain = null;
function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    musicGain = audioCtx.createGain();
    musicGain.gain.value = 0.55;
    musicGain.connect(audioCtx.destination);
  } catch (e) { audioCtx = null; }
}
function blip({ type = "square", freq = 440, dur = 0.1, vol = 0.2, slide = 0 }) {
  if (!audioCtx || game.muted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t); osc.stop(t + dur);
}
function noise({ dur = 0.15, vol = 0.25, hp = 800 }) {
  if (!audioCtx || game.muted) return;
  const t = audioCtx.currentTime;
  const buf = audioCtx.createBuffer(1, (audioCtx.sampleRate * dur) | 0, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = audioCtx.createBufferSource(); src.buffer = buf;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const filt = audioCtx.createBiquadFilter(); filt.type = "highpass"; filt.frequency.value = hp;
  src.connect(filt).connect(g).connect(audioCtx.destination);
  src.start(t);
}
const sfx = {
  shoot() { noise({ dur: 0.07, vol: 0.16 }); blip({ type: "square", freq: 220 * (0.92 + Math.random() * 0.16), dur: 0.06, vol: 0.1, slide: -120 }); },
  // 명중음은 콤보가 오를수록 음정이 올라가 상승감 부여
  hit() { const f = 880 * (1 + Math.min(game.combo, 14) * 0.03) * (0.98 + Math.random() * 0.04); blip({ type: "sine", freq: f, dur: 0.05, vol: 0.16, slide: 300 }); },
  crit() { blip({ type: "sine", freq: 1200 * (0.97 + Math.random() * 0.06), dur: 0.09, vol: 0.2, slide: 500 }); },
  explode() { noise({ dur: 0.22, vol: 0.28 }); blip({ type: "sawtooth", freq: 140, dur: 0.22, vol: 0.16, slide: -100 }); },
  reload() { blip({ type: "square", freq: 300, dur: 0.05, vol: 0.1 }); setTimeout(() => blip({ type: "square", freq: 520, dur: 0.08, vol: 0.12 }), 180); },
  empty() { blip({ type: "square", freq: 120, dur: 0.05, vol: 0.08 }); },
  hurt() { noise({ dur: 0.16, vol: 0.26 }); blip({ type: "sawtooth", freq: 90, dur: 0.16, vol: 0.18, slide: -40 }); },
  wave() { blip({ type: "sine", freq: 440, dur: 0.12, vol: 0.16 }); setTimeout(() => blip({ type: "sine", freq: 660, dur: 0.18, vol: 0.18 }), 120); },
  power() { blip({ type: "square", freq: 660, dur: 0.08, vol: 0.16 }); setTimeout(() => blip({ type: "square", freq: 990, dur: 0.12, vol: 0.18 }), 90); },
  enemyShoot() { blip({ type: "sawtooth", freq: 420, dur: 0.1, vol: 0.1, slide: -200 }); },
  block() { blip({ type: "square", freq: 700, dur: 0.05, vol: 0.12, slide: -300 }); },
  ult() { noise({ dur: 0.5, vol: 0.32, hp: 200 }); blip({ type: "sawtooth", freq: 180, dur: 0.5, vol: 0.24, slide: 600 }); blip({ type: "sine", freq: 900, dur: 0.4, vol: 0.18, slide: -600 }); },
  over() { blip({ type: "sawtooth", freq: 300, dur: 0.6, vol: 0.22, slide: -250 }); },
  // 무기별 발사음
  shotgun() { noise({ dur: 0.18, vol: 0.3, hp: 400 }); blip({ type: "square", freq: 160 * (0.95 + Math.random() * 0.1), dur: 0.14, vol: 0.16, slide: -100 }); },
  smg() { noise({ dur: 0.04, vol: 0.12 }); blip({ type: "square", freq: 280 * (0.9 + Math.random() * 0.2), dur: 0.04, vol: 0.08, slide: -80 }); },
  swap() { blip({ type: "square", freq: 420, dur: 0.05, vol: 0.12 }); setTimeout(() => blip({ type: "square", freq: 640, dur: 0.06, vol: 0.12 }), 70); },
};
function weaponSound() {
  const k = WEAPONS[game.weapon].key;
  if (k === "shotgun") sfx.shotgun();
  else if (k === "smg") sfx.smg();
  else sfx.shoot();
}

// 절차적 BGM — 베이스 + 패드 + 희소 아르페지오. 웨이브/보스에 따라 강도 증가. 음소거 존중.
function mnote(freq, dur, type, vol) {
  if (!audioCtx || game.muted || !musicGain) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain(), f = audioCtx.createBiquadFilter();
  o.type = type; o.frequency.value = freq;
  f.type = "lowpass"; f.frequency.value = 1400;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f).connect(g).connect(musicGain);
  o.start(t); o.stop(t + dur);
}
// 하이햇(고강도 레이어)
function mhat(vol) {
  if (!audioCtx || game.muted || !musicGain) return;
  const t = audioCtx.currentTime, dur = 0.04;
  const buf = audioCtx.createBuffer(1, (audioCtx.sampleRate * dur) | 0, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = audioCtx.createBufferSource(); src.buffer = buf;
  const g = audioCtx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const f = audioCtx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 6500;
  src.connect(f).connect(g).connect(musicGain); src.start(t);
}
const musicState = { on: false, timer: null, step: 0 };
function musicTick() {
  if (!audioCtx) return;
  const s = musicState.step % 16;
  const boss = !!game.boss;
  // 강도(intensity): 웨이브 + 보스 + 현재 적 수에 따라 레이어가 늘어남
  const intensity = Math.min(1.5, game.wave / 8 + (boss ? 0.5 : 0) + enemies.length / 20);
  const root = boss ? 49 : 55; // A1 / 보스 시 더 낮게(긴장)

  // 레이어1: 베이스 (항상)
  if (s % 4 === 0 || (intensity > 0.7 && s % 2 === 0)) mnote(root, 0.35, "sawtooth", 0.05);
  // 레이어2: 패드 + 5도 화음 (중강도)
  if (s === 0) {
    mnote(root * 2, 1.4, "sine", 0.028);
    if (intensity > 0.4) mnote(root * 2 * Math.pow(2, 7 / 12), 1.4, "sine", 0.02);
  }
  // 레이어3: 하이햇 퍼커션 (고강도/보스)
  if (intensity > 0.6 && s % 2 === 1) mhat(0.025 + intensity * 0.02);
  // 레이어4: 아르페지오 (강도에 따라 밀도 증가)
  const density = Math.min(0.12 + intensity * 0.35, 0.62);
  if (Math.random() < density) {
    const scale = [0, 3, 5, 7, 10, 12];
    const semi = scale[(Math.random() * scale.length) | 0];
    mnote(root * 4 * Math.pow(2, semi / 12), 0.16, "triangle", 0.03);
  }
  musicState.step++;
}
function startMusic() {
  if (musicState.on || !audioCtx) return;
  musicState.on = true; musicState.step = 0;
  musicState.timer = setInterval(musicTick, 250); // 120bpm 8분음표
}
function stopMusic() {
  musicState.on = false;
  if (musicState.timer) { clearInterval(musicState.timer); musicState.timer = null; }
}

// 햅틱
function vibrate(ms) { if (!game.muted && navigator.vibrate) navigator.vibrate(ms); }

// 음소거 토글
function setMute(m) {
  game.muted = m;
  try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch (e) {}
  document.querySelectorAll(".mute-btn").forEach((b) => { b.textContent = m ? "🔇" : "🔊"; b.classList.toggle("muted", m); });
}
function loadMute() { setMute(localStorage.getItem(MUTE_KEY) === "1"); }

/* =========================================================
   유틸: 좌표 투영 / 팝업 / 스크린 셰이크
   ========================================================= */
function worldToScreen(v3) {
  _proj.copy(v3).project(camera);
  return {
    x: (_proj.x * 0.5 + 0.5) * window.innerWidth,
    y: (-_proj.y * 0.5 + 0.5) * window.innerHeight,
    visible: _proj.z < 1,
  };
}
function showPopup(text, screenX, screenY, cls) {
  const el = document.createElement("div");
  el.className = "popup" + (cls ? " " + cls : "");
  el.textContent = text;
  el.style.left = screenX + "px";
  el.style.top = screenY + "px";
  popupsEl.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

// 스크린 셰이크 (CSS transform — 레이캐스트에 영향 없음)
const shake = { mag: 0, x: 0, y: 0 };
function addShake(amount) { if (reducedMotion) return; shake.mag = Math.min(28, shake.mag + amount); }
function updateShake(dt) {
  if (shake.mag > 0.2) {
    shake.x = (Math.random() * 2 - 1) * shake.mag;
    shake.y = (Math.random() * 2 - 1) * shake.mag;
    shake.mag *= Math.pow(0.0001, dt); // 빠르게 감쇠
    const tf = `translate(${shake.x.toFixed(1)}px,${shake.y.toFixed(1)}px) scale(1.04)`;
    videoEl.style.transform = tf;
    appEl.style.transform = tf;
  } else if (shake.x !== 0 || shake.y !== 0) {
    shake.x = shake.y = 0;
    videoEl.style.transform = appEl.style.transform = "scale(1.04)";
  }
}

// 화면 밖 위협 방향 표시기 (뒤/측면에서 오는 적·돌격 포탑을 화살표로 안내)
const indicatorEls = [];
const _cs = new THREE.Vector3();
const _ind = new THREE.Vector3();
function initIndicators() {
  const c = document.getElementById("indicators");
  for (let i = 0; i < INDICATOR_COUNT; i++) {
    const d = document.createElement("div");
    d.className = "indicator hidden";
    c.appendChild(d);
    indicatorEls.push(d);
  }
}
function hideIndicators() { indicatorEls.forEach((el) => el.classList.add("hidden")); }
function updateIndicators() {
  const offs = [];
  for (let i = 0; i < enemies.length; i++) {
    const en = enemies[i];
    if (!en.alive) continue;
    // 카메라 공간 z<0 = 정면. 정면일 때만 NDC로 화면 안 판정 (뒤쪽은 project()가 오판정함)
    _cs.copy(en.group.position).applyMatrix4(camera.matrixWorldInverse);
    const inFront = _cs.z < 0;
    let onScreen = false;
    if (inFront) {
      _ind.copy(en.group.position).project(camera);
      onScreen = Math.abs(_ind.x) <= 1 && Math.abs(_ind.y) <= 1;
    }
    if (onScreen) continue;
    offs.push({ en, d: en.group.position.lengthSq(), front: inFront });
  }
  offs.sort((a, b) => a.d - b.d);
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  const r = Math.min(window.innerWidth, window.innerHeight) / 2 - 46;
  for (let i = 0; i < INDICATOR_COUNT; i++) {
    const el = indicatorEls[i];
    if (i < offs.length) {
      const en = offs[i].en;
      _cs.copy(en.group.position).applyMatrix4(camera.matrixWorldInverse);
      if (!offs[i].front) { _cs.x = -_cs.x; _cs.y = -_cs.y; } // 뒤쪽이면 반전
      const ang = Math.atan2(_cs.x, _cs.y);
      const ix = cx + Math.sin(ang) * r, iy = cy - Math.cos(ang) * r;
      el.style.transform = `translate(${(ix - 12).toFixed(0)}px,${(iy - 12).toFixed(0)}px) rotate(${ang}rad)`;
      el.style.color = "#" + en.cfg.color.toString(16).padStart(6, "0");
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }
}

/* =========================================================
   적(드론) — 오브젝트 풀링
   ========================================================= */
const enemies = [];      // 활성 적
const enemyPool = [];    // 비활성(재사용 대기)
const targets = [];      // 레이캐스트 대상 메쉬 (적 본체 + 적 탄환)

function buildEnemy() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(SHARED.drone, new THREE.MeshStandardMaterial({ metalness: 0.6, roughness: 0.3, flatShading: true }));
  const ring = new THREE.Mesh(SHARED.ring, new THREE.MeshStandardMaterial({ color: 0x2bf5c8, emissive: 0x0a4a3c, metalness: 0.8, roughness: 0.2 }));
  ring.rotation.x = Math.PI / 2;
  const core = new THREE.Mesh(SHARED.core, new THREE.MeshBasicMaterial({ color: 0xffcf3b }));
  group.add(body, ring, core);
  const en = { group, body, ring, core, type: null, cfg: null, hp: 1, speed: 1, alive: false, attackCD: 0, bob: 0, shotsLeft: 0 };
  body.userData.enemy = en;
  body.userData.kind = "enemy";
  return en;
}

function spawnEnemy(typeKey, atPos) {
  const cfg = ENEMY_TYPES[typeKey];
  const en = enemyPool.pop() || buildEnemy();
  en.type = typeKey; en.cfg = cfg;
  // 후반 스케일: 일반 적 체력/피해가 웨이브에 따라 상승(5웨이브부터) → 숙련 플레이의 정체 방지
  const ws = 1 + Math.max(0, game.wave - 5) * 0.18;
  const ds = 1 + Math.max(0, game.wave - 5) * 0.06;
  en.hp = cfg.boss ? Math.round(cfg.hp + game.wave * 2.6) : Math.round(cfg.hp * ws);
  en.maxHp = en.hp;
  en.dmg = Math.round(cfg.damage * ds);
  en.projDamage = cfg.projDamage ? Math.round(cfg.projDamage * ds) : 0;
  en.speed = Math.min(cfg.speed + game.wave * 0.12 + Math.random() * 0.4, cfg.speedCap);
  en.alive = true;
  en.attackCD = cfg.fireCD || 0;
  en.shotsLeft = cfg.maxShots || 0;
  en.bob = Math.random() * 6;
  en.body.geometry = SHARED[cfg.geo]; // 종류별 형태
  en.body.material.color.setHex(cfg.color);
  en.body.material.emissive.setHex(cfg.emissive);
  en.body.material.emissiveIntensity = enemyGlow; // 구역별 대비
  en.ring.material.emissiveIntensity = enemyGlow;

  // 엘리트(정예): 더 크고 튼튼, 금색 링, 보상↑ (보스/분열 자식 제외)
  en.elite = !cfg.boss && !atPos && game.wave >= 2 && Math.random() < Math.min(0.05 + game.wave * 0.012, 0.18);
  en.scale = cfg.scale * (en.elite ? 1.35 : 1);
  if (en.elite) {
    en.hp = Math.round(en.hp * 2.5); en.maxHp = en.hp;
    en.speed = Math.min(en.speed * 1.1, cfg.speedCap + 1);
    en.ring.material.color.setHex(0xffd23b); en.ring.material.emissive.setHex(0x5a4000);
  } else {
    en.ring.material.color.setHex(0x2bf5c8); en.ring.material.emissive.setHex(0x0a4a3c);
  }
  en.group.scale.setScalar(en.scale);

  if (atPos) {
    en.group.position.copy(atPos);
  } else {
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.35) * 0.7;
    const radius = 11 + Math.random() * 6;
    en.group.position.set(
      Math.sin(yaw) * Math.cos(pitch) * radius,
      Math.sin(pitch) * radius,
      -Math.cos(yaw) * Math.cos(pitch) * radius
    );
  }
  scene.add(en.group);
  enemies.push(en);
  targets.push(en.body);

  if (cfg.boss) { game.boss = en; showBossBar(); }
  return en;
}

function recycleEnemy(en) {
  en.alive = false;
  scene.remove(en.group);
  const ei = enemies.indexOf(en); if (ei >= 0) enemies.splice(ei, 1);
  const ti = targets.indexOf(en.body); if (ti >= 0) targets.splice(ti, 1);
  enemyPool.push(en);
}

/* =========================================================
   적 탄환 (포탑) — 풀링
   ========================================================= */
const projectiles = [];
const projPool = [];
function buildProjectile() {
  const mesh = new THREE.Mesh(SHARED.proj, new THREE.MeshBasicMaterial({ color: 0xff5cf0 }));
  const p = { mesh, vel: new THREE.Vector3(), damage: 0, alive: false };
  mesh.userData.kind = "proj";
  mesh.userData.proj = p;
  return p;
}
function spawnProjectile(fromPos, damage) {
  const p = projPool.pop() || buildProjectile();
  p.mesh.position.copy(fromPos);
  _dir.copy(playerPos).sub(fromPos).normalize();
  p.vel.copy(_dir).multiplyScalar(6.5);
  p.damage = damage; p.alive = true;
  scene.add(p.mesh);
  projectiles.push(p);
  targets.push(p.mesh);
  sfx.enemyShoot();
}
function recycleProjectile(p) {
  p.alive = false;
  scene.remove(p.mesh);
  const i = projectiles.indexOf(p); if (i >= 0) projectiles.splice(i, 1);
  const ti = targets.indexOf(p.mesh); if (ti >= 0) targets.splice(ti, 1);
  projPool.push(p);
}
// 보스 탄막: 부채꼴로 여러 발
function spawnProjectileSpread(fromPos, damage, count) {
  _dir.copy(playerPos).sub(fromPos).normalize();
  const base = Math.atan2(_dir.x, -_dir.z); // 수평 기준 각도
  const spread = 0.5;
  for (let i = 0; i < count; i++) {
    const a = base + (i - (count - 1) / 2) * spread;
    const p = projPool.pop() || buildProjectile();
    p.mesh.position.copy(fromPos);
    p.vel.set(Math.sin(a), _dir.y, -Math.cos(a)).normalize().multiplyScalar(6.5);
    p.damage = damage; p.alive = true;
    scene.add(p.mesh);
    projectiles.push(p);
    targets.push(p.mesh);
  }
  sfx.enemyShoot();
}

/* =========================================================
   파워업 (체력 / 오버드라이브) — 격추 시 확률 드롭, 자동 회수
   ========================================================= */
const pickups = [];
const pickupPool = [];
let PICKUP_GEO, PICKUP_MAT;
function initPickupAssets() {
  PICKUP_GEO = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  PICKUP_MAT = {
    health: new THREE.MeshStandardMaterial({ color: 0x2bf5c8, emissive: 0x2bf5c8, emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.3 }),
    overdrive: new THREE.MeshStandardMaterial({ color: 0xffcf3b, emissive: 0xffcf3b, emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.3 }),
  };
}
function spawnPickup(pos) {
  const kind = Math.random() < 0.5 ? "health" : "overdrive";
  const pk = pickupPool.pop() || { kind: null, mesh: new THREE.Mesh(PICKUP_GEO, PICKUP_MAT.health), spin: 0 };
  pk.kind = kind; pk.spin = 0;
  pk.mesh.material = PICKUP_MAT[kind];
  pk.mesh.position.copy(pos);
  scene.add(pk.mesh);
  pickups.push(pk);
}
function recyclePickup(pk) {
  scene.remove(pk.mesh);
  const i = pickups.indexOf(pk); if (i >= 0) pickups.splice(i, 1);
  pickupPool.push(pk);
}
function collectPickup(pk) {
  recyclePickup(pk);
  sfx.power(); vibrate(40);
  if (pk.kind === "health") {
    game.health = Math.min(game.maxHealth, game.health + 25);
    updateHealth();
    showPopup("+25 HP", window.innerWidth / 2, window.innerHeight / 2 - 60, "heal");
  } else {
    game.overdrive = 6;
    showPopup("오버드라이브!", window.innerWidth / 2, window.innerHeight / 2 - 60, "");
    updateOverdriveUI();
  }
}

/* =========================================================
   파티클 폭발 (풀링)
   ========================================================= */
const particles = [];
const particlePool = [];
const PARTICLE_COUNT = 16;
function buildParticleSystem() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3));
  const mat = new THREE.PointsMaterial({ size: 0.25, transparent: true, opacity: 1 });
  const pts = new THREE.Points(geo, mat);
  const velocities = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) velocities.push(new THREE.Vector3());
  return { pts, velocities, life: 0.6, age: 0 };
}
function spawnBurst(pos, color) {
  const p = particlePool.pop() || buildParticleSystem();
  p.age = 0; p.life = 0.6;
  p.pts.material.color.setHex(color);
  p.pts.material.opacity = 1;
  const arr = p.pts.geometry.attributes.position.array;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
    p.velocities[i].set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4);
  }
  p.pts.geometry.attributes.position.needsUpdate = true;
  scene.add(p.pts);
  particles.push(p);
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += dt;
    const arr = p.pts.geometry.attributes.position.array;
    for (let j = 0; j < PARTICLE_COUNT; j++) {
      arr[j * 3] += p.velocities[j].x * dt;
      arr[j * 3 + 1] += p.velocities[j].y * dt;
      arr[j * 3 + 2] += p.velocities[j].z * dt;
    }
    p.pts.geometry.attributes.position.needsUpdate = true;
    p.pts.material.opacity = Math.max(0, 1 - p.age / p.life);
    if (p.age >= p.life) {
      scene.remove(p.pts);
      particles.splice(i, 1);
      particlePool.push(p);
    }
  }
}

/* =========================================================
   발사 / 명중
   ========================================================= */
let muzzleLight;
function fire() {
  if (game.state !== State.PLAYING || game.reloading) return;
  if (game.fireCooldown > 0) return;
  if (game.ammo <= 0 && game.overdrive <= 0) { sfx.empty(); ui.ammo.classList.add("empty"); return; }

  if (game.overdrive > 0) {
    game.fireCooldown = Math.min(0.09, game.fireInterval); // 연사
  } else {
    game.ammo--;
    game.fireCooldown = game.fireInterval;
    updateAmmo();
  }
  weaponSound(); vibrate(game.pellets > 1 ? 16 : 8);
  muzzleFlash(); recoil();

  // 펠릿(산탄)·탄퍼짐 적용해 각 탄을 레이캐스트
  const n = game.pellets, sp = game.spread;
  for (let p = 0; p < n; p++) {
    const jx = sp ? (Math.random() * 2 - 1) * sp : 0;
    const jy = sp ? (Math.random() * 2 - 1) * sp : 0;
    castShot(jx, jy);
  }
  if (game.ammo <= 0 && game.overdrive <= 0) reload();
}
// 한 발(탄)의 레이캐스트 + 관통(pierce) 처리. 탄환은 통과하며 요격. 명중률 통계 집계.
function castShot(nx, ny) {
  _aim.set(nx, ny);
  raycaster.setFromCamera(_aim, camera);
  const hits = raycaster.intersectObjects(targets, false);
  let enemiesHit = 0, connected = false;
  for (let h = 0; h < hits.length; h++) {
    const obj = hits[h].object;
    if (obj.userData.kind === "proj") {
      const p = obj.userData.proj;
      if (p && p.alive) { spawnBurst(p.mesh.position, 0xff5cf0); recycleProjectile(p); addScore(20); connected = true; }
    } else if (obj.userData.kind === "enemy") {
      const en = obj.userData.enemy;
      if (en && en.alive) {
        hitEnemy(en, hits[h].point);
        connected = true;
        enemiesHit++;
        if (enemiesHit > game.pierce) break;
      }
    }
  }
  game.shotsFired++;
  if (connected) game.shotsHit++;
}

function hitEnemy(en, hitPoint) {
  // 약점(코어) 명중 = 치명타 (조준 실력 보상). critRadius 강화로 범위 확대
  const crit = !!(hitPoint && hitPoint.distanceTo(en.group.position) < game.critRadius * en.scale);
  // 방패병: 약점 명중이 아니면 피해 차단
  if (en.cfg.shielded && !crit) {
    sfx.block();
    en.body.material.emissiveIntensity = enemyGlow + 0.6;
    const sb = worldToScreen(en.group.position);
    showPopup("방어!", sb.x, sb.y, "");
    return;
  }
  en.hp -= crit ? game.dmg * game.critMult : game.dmg;
  if (crit) sfx.crit(); else sfx.hit();
  if (game.boss === en) updateBossBar();
  const s = worldToScreen(en.group.position);
  if (en.hp > 0) {
    showHitmarker(false);
    if (crit) showPopup("약점!", s.x, s.y, "crit");
    en.body.material.emissiveIntensity = enemyGlow + 1;
  } else {
    destroyEnemy(en, crit, false);
  }
}

function destroyEnemy(en, crit, fromExplosion) {
  const pos = en.group.position;
  const cfg = en.cfg;
  spawnBurst(pos, cfg.color);
  sfx.explode(); vibrate(crit ? 30 : 18); addShake(cfg.boss ? 16 : crit ? 8 : 5);
  showHitmarker(true);

  // 콤보 갱신
  game.combo++;
  if (game.combo > game.maxCombo) game.maxCombo = game.combo;
  game.comboTimer = 2.6;
  const mult = comboMultiplier();
  const eliteMult = en.elite ? 2.5 : 1;
  const gained = Math.round(cfg.score * (crit ? game.critMult : 1) * mult * game.scoreMult * eliteMult);
  addScore(gained);
  updateComboUI();

  const s = worldToScreen(pos);
  showPopup((en.elite ? "정예 " : "") + (crit ? "약점 " : "") + "+" + gained, s.x, s.y, crit || en.elite ? "crit" : "");

  // 흡수 코어 강화: 처치 시 회복
  if (game.lifesteal > 0) { game.health = Math.min(game.maxHealth, game.health + game.lifesteal); updateHealth(); }
  // 궁극기 충전 (폭발 연쇄로 죽은 적은 충전 제외 — 폭주 방지)
  if (!fromExplosion) addUlt(cfg.boss ? game.ultGain * 6 : (en.elite ? game.ultGain * 2.5 : game.ultGain));

  // 폭발탄: 직격 처치 시 주변에 1단계 연쇄 폭발
  if (game.explosive && !fromExplosion) {
    const victims = [];
    for (let i = 0; i < enemies.length; i++) {
      const n = enemies[i];
      if (n.alive && n !== en && n.group.position.distanceTo(pos) < game.explosive) victims.push(n);
    }
    if (victims.length) spawnBurst(pos, 0xffa030);
    victims.forEach((n) => {
      n.hp -= game.explosiveDmg;
      if (game.boss === n) updateBossBar();
      if (n.hp <= 0) destroyEnemy(n, false, true);
      else n.body.material.emissiveIntensity = 2;
    });
  }

  // 분열체: 죽을 때 정찰병 2기로 분열
  if (cfg.splits) {
    const childPos = pos.clone();
    for (let i = 0; i < cfg.splits; i++) {
      const off = new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
      spawnEnemy("scout", childPos.clone().add(off));
    }
  }

  // 보스 처치: 바 숨김 + 보장 드롭
  if (cfg.boss) { game.boss = null; hideBossBar(); spawnPickup(pos.clone()); showCenterText("보스 격파!"); }
  else if (en.elite) spawnPickup(pos.clone());   // 엘리트 확정 드롭
  // 파워업 드롭 (12%)
  else if (Math.random() < 0.12) spawnPickup(pos.clone());

  recycleEnemy(en);
  game.kills++;
  ui.kills.textContent = game.kills;
}

function comboMultiplier() { return 1 + Math.min(game.combo, 20) * 0.1; } // 최대 x3
function addScore(amount) {
  game.score += amount;
  ui.score.textContent = game.score;
  ui.score.classList.remove("bump"); void ui.score.offsetWidth; ui.score.classList.add("bump");
}

/* =========================================================
   데미지 / HUD
   ========================================================= */
function playerHit(dmg) {
  game.health = Math.max(0, game.health - dmg);
  updateHealth();
  sfx.hurt(); vibrate(60); addShake(10);
  // 콤보 끊김
  game.combo = 0; updateComboUI();
  ui.vignette.classList.add("hit");
  setTimeout(() => ui.vignette.classList.remove("hit"), 110);
  ui.lowhp.classList.toggle("active", game.health <= 30 && game.health > 0);
  if (game.health <= 0) gameOver();
}
function updateHealth() {
  ui.health.style.width = (game.health / game.maxHealth * 100) + "%";
  ui.lowhp.classList.toggle("active", game.health <= 30 && game.health > 0);
}
function updateAmmo() {
  if (game.overdrive > 0) { ui.ammo.textContent = "∞"; ui.ammo.classList.remove("empty"); return; }
  ui.ammo.textContent = game.reloading ? "···" : game.ammo;
  ui.ammo.classList.toggle("empty", game.ammo <= 0 && !game.reloading);
}
function showHitmarker(kill) {
  ui.hitmarker.classList.remove("show", "kill");
  void ui.hitmarker.offsetWidth;
  if (kill) ui.hitmarker.classList.add("kill");
  ui.hitmarker.classList.add("show");
}
function updateComboUI() {
  if (game.combo >= 2) {
    ui.combo.classList.remove("hidden");
    ui.comboX.textContent = "x" + comboMultiplier().toFixed(1);
    ui.combo.classList.remove("pop"); void ui.combo.offsetWidth; ui.combo.classList.add("pop");
  } else {
    ui.combo.classList.add("hidden");
  }
}
function updateOverdriveUI() {
  powerupsEl.innerHTML = "";
  ui.fireBtn.classList.toggle("overdrive", game.overdrive > 0);
  if (game.overdrive > 0) {
    const el = document.createElement("div");
    el.className = "pwr";
    el.textContent = "⚡ 오버드라이브 " + Math.ceil(game.overdrive) + "s";
    powerupsEl.appendChild(el);
  }
  updateAmmo();
}
// 보스 HP 바
function showBossBar() { const b = document.getElementById("boss-bar"); if (b) b.classList.remove("hidden"); updateBossBar(); }
function hideBossBar() { const b = document.getElementById("boss-bar"); if (b) b.classList.add("hidden"); }
function updateBossBar() {
  if (!game.boss) return;
  const f = document.getElementById("boss-fill");
  if (f) f.style.width = (Math.max(0, game.boss.hp) / game.boss.maxHp * 100) + "%";
}
// 궁극기: 처치로 충전, 가득 차면 발동해 화면의 적 일소
function addUlt(amount) {
  if (game.ult >= 1) return;
  game.ult = Math.min(1, game.ult + amount);
  updateUltUI();
}
function updateUltUI() {
  const btn = document.getElementById("ult-btn");
  if (!btn) return;
  btn.style.setProperty("--charge", (game.ult * 360) + "deg");
  btn.classList.toggle("ready", game.ult >= 1);
}
function flashScreen() {
  const f = document.getElementById("ult-flash");
  if (!f) return;
  f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
}
function activateUlt() {
  if (game.state !== State.PLAYING || game.ult < 1) return;
  game.ult = 0; updateUltUI();
  sfx.ult(); vibrate([20, 30, 50]); addShake(20); flashScreen();
  enemies.slice().forEach((en) => {
    if (!en.alive) return;
    if (en.cfg.boss) {
      en.hp -= 8; updateBossBar();
      spawnBurst(en.group.position, 0xffffff);
      if (en.hp <= 0) destroyEnemy(en, true, true);
    } else {
      destroyEnemy(en, true, true);
    }
  });
}
function muzzleFlash() {
  if (!muzzleLight) { muzzleLight = new THREE.PointLight(0xffcf3b, 0, 8); scene.add(muzzleLight); }
  muzzleLight.position.copy(camera.position);
  muzzleLight.intensity = 3;
}
function recoil() {
  ui.crosshair.classList.add("recoil");
  setTimeout(() => ui.crosshair.classList.remove("recoil"), 60);
}
function reload() {
  if (game.reloading || game.ammo === game.magSize || game.overdrive > 0 || game.state !== State.PLAYING) return;
  game.reloading = true;
  game.reloadTimer = game.reloadDur / 1000; // 게임시간(초) 기반 — throttle/시뮬에서도 동작
  updateAmmo();
  ui.reloadBar.classList.add("active");
  sfx.reload();
}
function finishReload() {
  game.ammo = game.magSize;
  game.weaponAmmo[game.weapon] = game.ammo;
  game.reloading = false;
  ui.reloadBar.classList.remove("active");
  ui.reloadFill.style.width = "0%";
  updateAmmo();
}

/* =========================================================
   웨이브 진행
   ========================================================= */
function pickEnemyType() {
  const w = game.wave;
  const r = Math.random();
  if (w >= 4 && r < 0.14) return "splitter";
  if (w >= 3 && r < 0.26) return "shield";
  if (w >= 3 && r < 0.40) return "turret";
  if (w >= 2 && r < 0.58) return "brute";
  if (r < 0.78) return "scout";
  return "drone";
}
function startWave(n) {
  game.wave = n;
  ui.wave.textContent = n;
  game.spawnTimer = 0;
  game.betweenWaves = false;
  // 구역(테마) 전환: 3웨이브마다 순환
  const ti = Math.floor((n - 1) / 3) % THEMES.length;
  const zoneChanged = ti !== game.theme;
  if (zoneChanged) applyTheme(ti);
  const isBoss = n % 5 === 0;
  if (isBoss) {
    spawnEnemy("boss");
    game.enemiesToSpawn = 3 + Math.floor(n / 5) * 2; // 보스 + 호위 (보스전 압박 강화)
    sfx.wave();
    showCenterText("⚠ 보스 등장 ⚠");
  } else {
    game.enemiesToSpawn = 3 + n * 2;
    sfx.wave();
    showCenterText(zoneChanged ? ("웨이브 " + n + " · " + THEMES[ti].name) : ("웨이브 " + n));
  }
}
function showCenterText(text) {
  let el = document.getElementById("center-text");
  if (!el) {
    el = document.createElement("div");
    el.id = "center-text";
    el.style.cssText = "position:fixed;top:34%;left:0;right:0;text-align:center;z-index:6;font-size:34px;font-weight:900;letter-spacing:4px;color:#2bf5c8;text-shadow:0 0 20px rgba(43,245,200,.7);pointer-events:none;transition:opacity .5s;";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = "0"; }, 1400);
}
function updateWaves(dt) {
  // 동시 존재 적 수 상한 (후반 화면 도배·불공정 방지)
  const maxAlive = Math.min(4 + Math.floor(game.wave * 1.5), 14);
  if (game.enemiesToSpawn > 0) {
    game.spawnTimer -= dt;
    if (game.spawnTimer <= 0 && enemies.length < maxAlive) {
      spawnEnemy(pickEnemyType());
      game.enemiesToSpawn--;
      game.spawnTimer = Math.max(0.35, 1.3 - game.wave * 0.07);
    }
  } else if (enemies.length === 0) {
    // 웨이브 클리어 → 강화 선택
    addScore(Math.round(50 * game.wave * game.scoreMult));
    showUpgrades();
  }
}

/* =========================================================
   성능 모니터 (적응형 해상도)
   ========================================================= */
const perf = { acc: 0, frames: 0, fps: 60, pr: Math.min(window.devicePixelRatio, window.devicePixelRatio > 1.5 ? 1.5 : 2), lastAdjust: 0 };
function updatePerf(dt) {
  perf.acc += dt; perf.frames++;
  if (perf.acc >= 0.5) {
    perf.fps = Math.round(perf.frames / perf.acc);
    ui.fps.textContent = perf.fps + " FPS";
    perf.acc = 0; perf.frames = 0;
    // 적응형: 30fps 미만이면 해상도 ↓, 안정적이면 ↑
    if (perf.fps < 40 && perf.pr > 1) {
      perf.pr = Math.max(1, perf.pr - 0.25); renderer.setPixelRatio(perf.pr);
    } else if (perf.fps > 56 && perf.pr < Math.min(window.devicePixelRatio, 2)) {
      perf.pr = Math.min(Math.min(window.devicePixelRatio, 2), perf.pr + 0.25); renderer.setPixelRatio(perf.pr);
    }
  }
}

/* =========================================================
   메인 루프
   ========================================================= */
function update(dt) {
  if (muzzleLight && muzzleLight.intensity > 0) muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 30);
  if (game.fireCooldown > 0) game.fireCooldown -= dt;
  updateShake(dt);
  if (ambientMotes) ambientMotes.rotation.y += dt * 0.03; // 부유 파티클 드리프트

  if (game.state === State.PLAYING) {
    updateCameraFromControls();
    updateWaves(dt);
    updatePerf(dt);

    // 오버드라이브 타이머 + 자동연사
    if (game.overdrive > 0) {
      game.overdrive -= dt;
      if (game.overdrive <= 0) { game.overdrive = 0; updateOverdriveUI(); if (game.ammo <= 0) reload(); }
      fire(); // 누르지 않아도 연사 (쿨다운으로 제한)
      // UI 갱신(가벼움)
      const pwr = powerupsEl.firstElementChild;
      if (pwr) pwr.textContent = "⚡ 오버드라이브 " + Math.ceil(game.overdrive) + "s";
    }

    // 자동연사 무기(기관단총): 누르고 있으면 연사 (쿨다운 제한)
    if (game.firing && game.auto) fire();

    // 콤보 타이머
    if (game.combo > 0) {
      game.comboTimer -= dt;
      if (game.comboTimer <= 0) { game.combo = 0; updateComboUI(); }
    }

    // 재장전 타이머 (게임시간 기반)
    if (game.reloading) {
      game.reloadTimer -= dt;
      const total = game.reloadDur / 1000;
      ui.reloadFill.style.width = (Math.max(0, Math.min(1, 1 - game.reloadTimer / total)) * 100) + "%";
      if (game.reloadTimer <= 0) finishReload();
    }

    // 적 갱신
    for (let i = enemies.length - 1; i >= 0; i--) {
      const en = enemies[i];
      if (!en.alive) continue;
      en.bob += dt * 3;
      _dir.copy(playerPos).sub(en.group.position);
      const dist = _dir.length();
      _dir.normalize();

      if (en.cfg.ranged && en.shotsLeft > 0 && dist < en.cfg.range) {
        // 포탑/보스: 사거리에서 사격 (보스는 탄막)
        en.attackCD -= dt;
        if (en.attackCD <= 0) {
          if (en.cfg.boss) spawnProjectileSpread(en.group.position, en.projDamage, en.cfg.pellets || 3);
          else spawnProjectile(en.group.position, en.projDamage);
          en.attackCD = en.cfg.fireCD; en.shotsLeft--;
        }
        en.group.position.y += Math.sin(en.bob) * dt * 0.4; // 부유
      } else {
        // 탄 소진 후엔 포탑도 플레이어를 향해 돌격
        en.group.position.addScaledVector(_dir, en.speed * dt);
        en.group.position.y += Math.sin(en.bob) * dt * 0.3;
      }

      en.ring.rotation.z += dt * 2;
      en.body.rotation.y += dt * 1.5;
      en.body.rotation.x += dt * 0.8;
      if (en.body.material.emissiveIntensity > enemyGlow) en.body.material.emissiveIntensity = Math.max(enemyGlow, en.body.material.emissiveIntensity - dt * 6);
      const pulse = 0.7 + Math.sin(en.bob * (3 - Math.min(2, dist / 4))) * 0.3;
      en.core.scale.setScalar(pulse);

      // 접근 시 자폭 데미지 (포탑도 돌격 단계에서 충돌)
      if (dist < 1.3) {
        spawnBurst(en.group.position, en.cfg.color);
        recycleEnemy(en);
        playerHit(en.dmg);
      }
    }

    // 적 탄환 갱신
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += dt * 6; p.mesh.rotation.y += dt * 5;
      if (p.mesh.position.distanceToSquared(playerPos) < 1.0) {
        recycleProjectile(p);
        playerHit(p.damage);
      } else if (p.mesh.position.lengthSq() > 900) {
        recycleProjectile(p); // 너무 멀어지면 제거
      }
    }

    // 파워업 갱신 (플레이어로 천천히 끌려옴)
    for (let i = pickups.length - 1; i >= 0; i--) {
      const pk = pickups[i];
      pk.spin += dt * 2;
      pk.mesh.rotation.set(pk.spin, pk.spin * 0.7, 0);
      _dir.copy(playerPos).sub(pk.mesh.position);
      const d = _dir.length();
      _dir.normalize();
      pk.mesh.position.addScaledVector(_dir, 2.2 * dt);
      if (d < 1.1) collectPickup(pk);
    }

    // 조준 락온 표시 + 화면 밖 위협 표시기
    raycaster.setFromCamera(centerVec, camera);
    const aim = raycaster.intersectObjects(targets, false);
    ui.crosshair.classList.toggle("locked", aim.length > 0 && aim[0].object.userData.kind === "enemy");
    updateIndicators();
  }

  updateParticles(dt);
}
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  if (renderer) renderer.render(scene, camera);
}

/* =========================================================
   카메라 영상 + 권한
   ========================================================= */
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play().catch(() => {});
    return true;
  } catch (err) {
    permNote.textContent = "카메라를 사용할 수 없어 검은 배경으로 진행합니다. (" + err.name + ")";
    permNote.classList.add("error");
    scene.background = new THREE.Color(0x0a1014);
    return false;
  }
}
// 자이로 권한 요청 + 리스너 등록 (멱등). iOS는 사용자 제스처 안에서 호출해야 함.
function requestGyro() {
  const attach = () => {
    if (controls.gyroListening) return;
    controls.gyroListening = true;
    window.addEventListener("deviceorientation", onDeviceOrientation, true);
    window.addEventListener("deviceorientationabsolute", onDeviceOrientation, true); // 안드로이드 폴백
  };
  if (controls.gyroListening) return Promise.resolve(true);
  if (typeof DeviceOrientationEvent === "undefined") return Promise.resolve(false);
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    return DeviceOrientationEvent.requestPermission()
      .then((res) => { if (res === "granted") { attach(); return true; } return false; })
      .catch(() => false);
  }
  attach();
  return Promise.resolve(true);
}
// 자이로 선택 후 신호 확인 안내 (보이는 화면에 표시)
function gyroHint(msg) {
  if (!startScreen.classList.contains("hidden")) { permNote.classList.remove("error"); permNote.textContent = msg; }
  else showCenterText(msg);
}
function ensureGyro() {
  requestGyro().then((ok) => {
    setTimeout(() => {
      if (controls.preferred !== "gyro") return;
      if (controls.hasOrientation) gyroHint("자이로 활성화 — 기기를 움직여 조준");
      else gyroHint(ok ? "자이로 신호 없음 — 기기를 움직여보세요" : "이 기기는 자이로 사용 불가 — 터치로 진행하세요");
    }, 1500);
  });
}

/* =========================================================
   최고 점수
   ========================================================= */
function loadHighscore() {
  const v = parseInt(localStorage.getItem(HISCORE_KEY) || "0", 10);
  game.highscore = isNaN(v) ? 0 : v;
  ui.hiStart.textContent = game.highscore;
}
function saveHighscore() {
  if (game.score > game.highscore) {
    game.highscore = game.score;
    try { localStorage.setItem(HISCORE_KEY, String(game.highscore)); } catch (e) {}
    return true;
  }
  return false;
}

/* =========================================================
   로컬 랭킹 (Top 10)
   ========================================================= */
function loadScores() {
  try { const a = JSON.parse(localStorage.getItem(SCORES_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function saveScore(name, score, wave) {
  const list = loadScores();
  const entry = { name, score, wave };
  list.push(entry);
  list.sort((a, b) => b.score - a.score);
  const top = list.slice(0, 10);
  try { localStorage.setItem(SCORES_KEY, JSON.stringify(top)); } catch (e) {}
  return top.indexOf(entry); // 새 기록의 순위(없으면 -1)
}
function renderLeaderboard(highlight) {
  const el = document.getElementById("lb-list");
  if (!el) return;
  const list = loadScores();
  if (!list.length) { el.innerHTML = '<li class="lb-empty">아직 기록이 없습니다</li>'; return; }
  el.innerHTML = lbRowsHtml(list, highlight);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function lbRowsHtml(list, highlight) {
  return list.map((s, i) =>
    `<li class="${i === highlight ? "hl" : ""}"><span class="lb-rank">${i + 1}</span><span class="lb-name">${escapeHtml(s.name)}</span><span class="lb-score">${(s.score || 0).toLocaleString()}</span><span class="lb-wave">W${s.wave}</span></li>`
  ).join("");
}
// 로컬 즉시 표시 + 온라인이면 글로벌로 갱신
async function refreshLeaderboards(highlight) {
  renderLeaderboard(highlight);
  const title = document.getElementById("lb-title-main");
  if (title) title.textContent = "🏆 랭킹 Top 10 (" + (ONLINE_LB ? "글로벌" : "로컬") + ")";
  if (ONLINE_LB) {
    const g = await fetchGlobalScores();
    if (g && g.length) { const el = document.getElementById("lb-list"); if (el) el.innerHTML = lbRowsHtml(g, -1); }
  }
}
// 시작 화면 랭킹(Top 5)
function renderStartLeaderboard() {
  const el = document.getElementById("lb-start");
  if (!el) return;
  const list = loadScores().slice(0, 5);
  el.innerHTML = list.length ? lbRowsHtml(list, -1) : '<li class="lb-empty">아직 기록이 없습니다</li>';
}

// 비-AR 아레나 모드 토글
function setArenaMode(v) {
  game.arena = v;
  try { localStorage.setItem(ARENA_KEY, v ? "1" : "0"); } catch (e) {}
  document.querySelectorAll(".bg-seg button").forEach((b) => b.classList.toggle("active", (b.dataset.bg === "arena") === v));
}
function loadArenaMode() { setArenaMode(localStorage.getItem(ARENA_KEY) === "1"); }

/* =========================================================
   로그라이트 강화 (웨이브 사이 선택)
   ========================================================= */
const UPGRADES = [
  { icon: "🔩", name: "고출력 탄", desc: "기본 피해 +1 (모든 무기)", apply: () => { game.dmgBonus += 1; recomputeWeaponStats(); } },
  { icon: "📦", name: "확장 탄창", desc: "탄창 +6 (모든 무기)", apply: () => { game.magBonus += 6; recomputeWeaponStats(); game.ammo = game.magSize; updateAmmo(); } },
  { icon: "♻️", name: "신속 재장전", desc: "재장전 22% 단축", apply: () => { game.reloadMult *= 0.78; recomputeWeaponStats(); } },
  { icon: "⚡", name: "속사 장치", desc: "연사 속도 +18%", apply: () => { game.fireMult *= 0.82; recomputeWeaponStats(); } },
  { icon: "🛡️", name: "강화 장갑", desc: "최대 체력 +25, 즉시 회복", apply: () => { game.maxHealth += 25; game.health = Math.min(game.maxHealth, game.health + 25); updateHealth(); } },
  { icon: "🎯", name: "정밀 조준", desc: "약점(코어) 범위 확대", apply: () => { game.critRadius += 0.14; } },
  { icon: "🩸", name: "흡수 코어", desc: "처치 시 체력 +3", apply: () => { game.lifesteal += 3; } },
  { icon: "💰", name: "현상금", desc: "점수 획득 +25%", apply: () => { game.scoreMult += 0.25; } },
  { icon: "➿", name: "관통탄", desc: "탄환이 적 1체 더 관통", apply: () => { game.pierce += 1; } },
  { icon: "💥", name: "폭발탄", desc: "처치 시 주변 연쇄 폭발", apply: () => { game.explosive = 2.8; game.explosiveDmg += 2; } },
  { icon: "🔋", name: "과충전", desc: "궁극기 충전 +60%", apply: () => { game.ultGain *= 1.6; } },
  { icon: "✨", name: "치명 특화", desc: "치명타 배율 +1 (희귀)", rare: true, apply: () => { game.critMult += 1; } },
  // 무기별 전용 강화 (해당 무기에만 적용, 보유 시 더 강력)
  { icon: "🔫", name: "권총: 정밀 총열", desc: "권총 전용 피해 +2", apply: () => { game.wpMods[0].dmg += 2; recomputeWeaponStats(); } },
  { icon: "💥", name: "산탄총: 이중 약실", desc: "산탄 펠릿 +3", apply: () => { game.wpMods[1].pellets += 3; recomputeWeaponStats(); } },
  { icon: "🔥", name: "기관단총: 안정기", desc: "기관단총 탄퍼짐 -45%·탄창 +10", apply: () => { game.wpMods[2].spreadMult *= 0.55; game.wpMods[2].magBonus += 10; recomputeWeaponStats(); } },
];
function pick3(arr) {
  const pool = arr.slice(), out = [];
  for (let i = 0; i < 3 && pool.length; i++) out.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  return out;
}
function showUpgrades() {
  game.state = State.UPGRADE;
  hideIndicators();
  const wrap = document.getElementById("upgrade-cards");
  wrap.innerHTML = "";
  pick3(UPGRADES).forEach((u) => {
    const card = document.createElement("button");
    card.className = "up-card" + (u.rare ? " rare" : "");
    card.innerHTML = `<div class="up-icon">${u.icon}</div><div class="up-text"><div class="up-name">${u.name}</div><div class="up-desc">${u.desc}</div></div>`;
    card.addEventListener("click", (e) => { e.stopPropagation(); chooseUpgrade(u); });
    wrap.appendChild(card);
  });
  upgradeScreen.classList.remove("hidden");
  sfx.wave();
}
function chooseUpgrade(u) {
  u.apply();
  sfx.power();
  upgradeScreen.classList.add("hidden");
  game.state = State.PLAYING;
  clock.getDelta();
  startWave(game.wave + 1);
}

/* =========================================================
   게임 시작 / 리셋 / 일시정지 / 종료
   ========================================================= */
function resetGame() {
  [...enemies].forEach(recycleEnemy);
  [...projectiles].forEach(recycleProjectile);
  pickups.slice().forEach(recyclePickup);
  particles.slice().forEach((p) => { scene.remove(p.pts); particlePool.push(p); });
  particles.length = 0;
  popupsEl.innerHTML = "";
  hideIndicators();

  // 강화 스탯 초기화
  game.maxHealth = 100; game.critRadius = 0.34; game.lifesteal = 0; game.scoreMult = 1;
  game.critMult = 2; game.pierce = 0; game.explosive = 0; game.explosiveDmg = 0;
  game.ult = 0; game.ultGain = 0.075; updateUltUI();
  // 무기 초기화
  game.weapon = 0; game.weaponAmmo = WEAPONS.map((w) => w.mag); game.firing = false;
  game.dmgBonus = 0; game.magBonus = 0; game.fireMult = 1; game.reloadMult = 1;
  game.wpMods = WEAPONS.map(() => ({ dmg: 0, pellets: 0, spreadMult: 1, fireMult: 1, magBonus: 0 }));
  recomputeWeaponStats(); updateWeaponUI();
  // 통계 초기화
  game.shotsFired = 0; game.shotsHit = 0; game.maxCombo = 0;
  game.boss = null; hideBossBar();
  applyTheme(0); // 매 판 첫 구역으로
  upgradeScreen.classList.add("hidden");

  game.score = 0; game.kills = 0; game.wave = 0;
  game.health = game.maxHealth; game.ammo = game.magSize;
  game.reloading = false; game.reloadTimer = 0; game.betweenWaves = false;
  game.combo = 0; game.comboTimer = 0; game.overdrive = 0; game.fireCooldown = 0;

  ui.score.textContent = "0"; ui.kills.textContent = "0"; ui.wave.textContent = "1";
  ui.combo.classList.add("hidden");
  ui.lowhp.classList.remove("active");
  ui.reloadBar.classList.remove("active");
  updateHealth(); updateAmmo(); updateOverdriveUI();
}
// 전체화면은 권한(카메라/자이로) 흐름과 분리된 별도 제스처로만 토글 — 동시 호출 시 권한 팝업이 막히는 문제 방지
function toggleFullscreen() {
  const el = document.documentElement;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (!fsEl) {
      const fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) { const r = fn.call(el); if (r && r.catch) r.catch(() => {}); }
      else showCenterText("이 브라우저는 전체화면 미지원");
    } else {
      const ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) ex.call(document);
    }
  } catch (e) {}
}
async function startGame() {
  initAudio();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  $("start-btn").disabled = true;
  // 자이로 권한은 사용자 제스처 직후에 먼저 요청해야 iOS에서 활성화가 유지됨 (카메라 await 이전)
  if (controls.preferred === "gyro") await requestGyro();
  if (game.arena) {
    // 아레나 모드: 카메라 미사용 — 기존 비디오 정리
    if (videoEl.srcObject) { videoEl.srcObject.getTracks().forEach((tr) => tr.stop()); videoEl.srcObject = null; }
    permNote.textContent = "";
  } else {
    permNote.textContent = "카메라 준비 중...";
    permNote.classList.remove("error");
    await startCamera();
  }
  resetGame();
  startScreen.classList.add("hidden");
  pauseScreen.classList.add("hidden");
  gameoverScreen.classList.add("hidden");
  hudEl.classList.remove("hidden");
  game.state = State.PLAYING;
  clock.getDelta(); // 누적 dt 리셋
  refreshControlsUI();
  if (controls.preferred === "gyro" && controls.hasOrientation) recalibrate(true); // 시작 시 정면 보정
  startMusic();
  startWave(1);
}
function pauseGame() {
  if (game.state !== State.PLAYING) return;
  game.state = State.PAUSED;
  game.firing = false;
  pauseScreen.classList.remove("hidden");
  hideIndicators();
  stopMusic();
  refreshControlsUI();
}
function resumeGame() {
  if (game.state !== State.PAUSED) return;
  pauseScreen.classList.add("hidden");
  game.state = State.PLAYING;
  clock.getDelta();
  startMusic();
  refreshControlsUI();
}
function quitToMenu() {
  game.state = State.MENU;
  game.firing = false;
  pauseScreen.classList.add("hidden");
  upgradeScreen.classList.add("hidden");
  hudEl.classList.add("hidden");
  stopMusic();
  loadHighscore();
  renderStartLeaderboard();
  startScreen.classList.remove("hidden");
  refreshControlsUI();
}
function gameOver() {
  game.state = State.OVER;
  game.firing = false; game.boss = null; hideBossBar(); stopMusic();
  sfx.over(); vibrate([60, 40, 120]); addShake(16);
  const isRecord = saveHighscore();
  ui.finalScore.textContent = game.score;
  ui.finalWave.textContent = game.wave;
  ui.finalKills.textContent = game.kills;
  ui.finalAcc.textContent = (game.shotsFired ? Math.round(game.shotsHit / game.shotsFired * 100) : 0) + "%";
  ui.finalCombo.textContent = "x" + game.maxCombo;
  ui.hiOver.textContent = game.highscore;
  ui.newRecord.classList.toggle("hidden", !isRecord);
  // 랭킹 등록 UI
  refreshLeaderboards(-1);
  const reg = $("lb-register");
  if (game.score > 0) {
    reg.classList.remove("hidden");
    $("lb-name").value = localStorage.getItem(NAME_KEY) || "";
    $("lb-submit").disabled = false;
  } else {
    reg.classList.add("hidden");
  }
  hudEl.classList.add("hidden");
  gameoverScreen.classList.remove("hidden");
  hideIndicators();
  refreshControlsUI();
}
async function submitScore() {
  const input = $("lb-name");
  const name = (input.value || "PLAYER").trim().slice(0, 8) || "PLAYER";
  try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
  const rank = saveScore(name, game.score, game.wave);
  renderLeaderboard(rank);
  renderStartLeaderboard();
  $("lb-register").classList.add("hidden");
  sfx.power();
  if (ONLINE_LB) { await submitGlobalScore(name, game.score, game.wave); refreshLeaderboards(-1); }
}

// ---------- 바인딩 ----------
function bindUI() {
  const begin = () => startGame().finally(() => { $("start-btn").disabled = false; });
  $("start-btn").addEventListener("click", begin);
  $("restart-btn").addEventListener("click", begin);
  $("lb-submit").addEventListener("click", (e) => { e.stopPropagation(); submitScore(); });
  $("lb-name").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); submitScore(); } });
  $("resume-btn").addEventListener("click", resumeGame);
  $("quit-btn").addEventListener("click", quitToMenu);
  $("pause-btn").addEventListener("click", (e) => { e.stopPropagation(); pauseGame(); });

  const fireBtn = $("fire-btn");
  const startFire = (e) => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); game.firing = true; fire(); };
  const endFire = () => { game.firing = false; };
  fireBtn.addEventListener("mousedown", startFire);
  fireBtn.addEventListener("touchstart", startFire, { passive: false });
  window.addEventListener("mouseup", endFire);
  fireBtn.addEventListener("touchend", endFire);
  fireBtn.addEventListener("touchcancel", endFire);
  $("reload-btn").addEventListener("click", (e) => { e.stopPropagation(); reload(); });
  $("weapon-btn").addEventListener("click", (e) => { e.stopPropagation(); cycleWeapon(); });
  const ultBtn = $("ult-btn");
  ultBtn.addEventListener("click", (e) => { e.stopPropagation(); activateUlt(); });
  ultBtn.addEventListener("touchstart", (e) => { e.stopPropagation(); e.preventDefault(); activateUlt(); }, { passive: false });

  // 조준 방식 토글 (시작/일시정지 화면 모두)
  document.querySelectorAll(".aim-seg button").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setAimMode(b.dataset.mode);
      // 자이로로 바꿨는데 아직 센서가 없으면 (제스처 안에서) 권한 재요청
      if (b.dataset.mode === "gyro" && !controls.hasOrientation) ensureGyro();
    });
  });
  // 정면 보정 버튼 (인게임 + 일시정지)
  document.querySelectorAll(".recalib").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); recalibrate(false); });
  });
  // 음소거 토글 (인게임 + 시작/일시정지 화면)
  document.querySelectorAll(".mute-btn").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); setMute(!game.muted); });
  });
  // 자이로 감도 (시작/일시정지)
  document.querySelectorAll(".gain-seg button").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); setGyroGain(parseFloat(b.dataset.gain)); });
  });
  // 배경 모드 (AR / 아레나)
  document.querySelectorAll(".bg-seg button").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); setArenaMode(b.dataset.bg === "arena"); });
  });
  // 전체화면 토글 (권한과 분리된 별도 버튼)
  document.querySelectorAll(".fs-btn").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleFullscreen(); });
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") { if (game.state === State.PLAYING) pauseGame(); else if (game.state === State.PAUSED) resumeGame(); }
    if (game.state !== State.PLAYING) return;
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat) fire(); game.firing = true; }
    if (e.code === "KeyR") reload();
    if (e.code === "KeyC") recalibrate(false);
    if (e.code === "KeyQ") activateUlt();
    if (e.code === "KeyE") cycleWeapon();
    if (e.code === "Digit1") selectWeapon(0);
    if (e.code === "Digit2") selectWeapon(1);
    if (e.code === "Digit3") selectWeapon(2);
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") game.firing = false; });

  // 탭 전환 시 자동 일시정지
  document.addEventListener("visibilitychange", () => { if (document.hidden) pauseGame(); });
}

// ---------- 부트 ----------
initThree();
initIndicators();
setupPointer();
bindUI();
loadHighscore();
loadAimMode();
loadGyroGain();
loadArenaMode();
loadMute();
renderStartLeaderboard();
animate();
