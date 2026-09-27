'use strict';

/*
 * Output targets. All three sites display gallery images at 4:3; MakerWorld
 * additionally uses a 3:4 portrait cover in its mobile app. 1600px on the long
 * edge keeps detail on retina/zoom views while staying a few hundred KB as JPEG.
 */
const TARGETS = [
  { id: 'thingiverse', site: 'Thingiverse', label: 'Gallery',   rw: 4, rh: 3, max: 1600, color: 'var(--tv)', folder: 'thingiverse', suffix: 'thingiverse' },
  { id: 'printables',  site: 'Printables',  label: 'Gallery',   rw: 4, rh: 3, max: 1600, color: 'var(--pr)', folder: 'printables',  suffix: 'printables' },
  { id: 'mw-cover',    site: 'MakerWorld',  label: 'Cover',     rw: 4, rh: 3, max: 1600, color: 'var(--mw)', folder: 'makerworld',  suffix: 'makerworld-cover' },
  { id: 'mw-app',      site: 'MakerWorld',  label: 'App cover', rw: 3, rh: 4, max: 1600, color: 'var(--mw)', folder: 'makerworld',  suffix: 'makerworld-app' },
];
const JPEG_QUALITY = 0.88;
const PREVIEW_MAX = 900;
const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';

const GENERIC_FONTS = ['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive'];
const COMMON_FONTS = [
  'Arial', 'Arial Black', 'Helvetica', 'Helvetica Neue', 'Inter', 'Roboto', 'Open Sans', 'Segoe UI', 'Ubuntu',
  'Noto Sans', 'DejaVu Sans', 'Cantarell', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Lucida Grande', 'Calibri',
  'Candara', 'Franklin Gothic Medium', 'Gill Sans', 'Futura', 'Avenir', 'Avenir Next', 'Optima', 'Century Gothic',
  'SF Pro Display', 'SF Pro Rounded', 'Georgia', 'Times New Roman', 'Palatino', 'Book Antiqua', 'Garamond',
  'Baskerville', 'Didot', 'Bodoni 72', 'Cambria', 'Rockwell', 'Copperplate', 'American Typewriter', 'Courier New',
  'Menlo', 'Monaco', 'Consolas', 'Impact', 'Haettenschweiler', 'Bebas Neue', 'Comic Sans MS', 'Marker Felt',
  'Chalkboard', 'Chalkduster', 'Noteworthy', 'Bradley Hand', 'Brush Script MT', 'Snell Roundhand', 'Papyrus',
  'Herculanum', 'Luminari', 'Trattatello', 'Phosphate', 'Stencil', 'Jazz LET', 'Segoe Print', 'Segoe Script',
];

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

const state = {
  photos: [],
  activePhoto: null,
  activeTarget: null,
  enabled: new Set(store.get('enabled', TARGETS.map(t => t.id))),
  link: store.get('link', true),
  mode: 'crop',
  sel: null,
  fonts: null,
};

let cropper = null;
let suppressCrop = false;
let seq = 0;

const byId = (id) => TARGETS.find(t => t.id === id);
const enabledTargets = () => TARGETS.filter(t => state.enabled.has(t.id));
const sameRatio = (a, b) => a.rw * b.rh === a.rh * b.rw;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------- Theme ---------------- */

function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
$('themeBtn').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) {}
});

/* ---------------- Help ---------------- */

$('specRows').innerHTML = TARGETS.map(t => {
  const [w, h] = t.rw >= t.rh ? [t.max, Math.round(t.max * t.rh / t.rw)] : [Math.round(t.max * t.rw / t.rh), t.max];
  return `<tr><td><i class="dot" style="--c:${t.color}"></i>${t.site} ${t.label.toLowerCase()}</td><td>${t.rw}:${t.rh}</td><td>${w}×${h}</td></tr>`;
}).join('');
$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
$('helpDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ---------------- UI helpers ---------------- */

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Loading images ---------------- */

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
}

let heicLibPromise;
function loadHeicLib() {
  if (!heicLibPromise) {
    heicLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HEIC_LIB;
      s.onload = () => resolve(window.heic2any);
      s.onerror = () => { heicLibPromise = null; reject(new Error('Could not load HEIC decoder')); };
      document.head.appendChild(s);
    });
  }
  return heicLibPromise;
}

async function decodeFile(file) {
  // Try native decoding first (Safari handles HEIC natively).
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return { img, url };
  } catch (e) {
    URL.revokeObjectURL(url);
    if (!isHeic(file)) throw e;
  }
  const heic2any = await loadHeicLib();
  let out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
  if (Array.isArray(out)) out = out[0];
  const jpgUrl = URL.createObjectURL(out);
  const img = await loadImage(jpgUrl);
  return { img, url: jpgUrl };
}

function makePreview(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, PREVIEW_MAX / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.round(iw * s);
  c.height = Math.round(ih * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { canvas: c, scale: s };
}

/* ---------------- Straighten ---------------- */
/*
 * A straightened photo is the original rotated by p.angle and trimmed to the
 * largest upright rectangle inside it, so there are never blank corners. That
 * copy replaces p.img/w/h/preview/url, so cropping, overlays, collages and
 * export all work on it unchanged; the original is kept in p.orig.
 */
const MAX_CANVAS_AREA = 16e6; // stays under iOS Safari's canvas size limit

function inscribedRect(w, h, a) {
  const sin = Math.abs(Math.sin(a)), cos = Math.abs(Math.cos(a));
  if (sin < 1e-9) return [w, h];
  const long = Math.max(w, h), short = Math.min(w, h);
  if (short <= 2 * sin * cos * long || Math.abs(sin - cos) < 1e-10) {
    const x = short / 2;
    return w >= h ? [x / sin, x / cos] : [x / cos, x / sin];
  }
  const cos2 = cos * cos - sin * sin;
  return [(w * cos - h * sin) / cos2, (h * cos - w * sin) / cos2];
}

// Crops survive a re-straighten by keeping their centre and relative width.
function relativeCrops(p) {
  return Object.entries(p.crops).map(([id, r]) => ({ id, cx: (r.x + r.width / 2) / p.w, cy: (r.y + r.height / 2) / p.h, fw: r.width / p.w }));
}

function restoreCrops(p, rel) {
  p.crops = {};
  for (const { id, cx, cy, fw } of rel) {
    const t = byId(id);
    let w = fw * p.w, h = w * t.rh / t.rw;
    if (h > p.h) { h = p.h; w = h * t.rw / t.rh; }
    if (w > p.w) { w = p.w; h = w * t.rh / t.rw; }
    p.crops[id] = { x: clamp(cx * p.w - w / 2, 0, p.w - w), y: clamp(cy * p.h - h / 2, 0, p.h - h), width: w, height: h };
  }
}

async function applyAngle(p, angle) {
  if (!p.orig) p.orig = { img: p.img, w: p.w, h: p.h, preview: p.preview, url: p.url };
  const o = p.orig;
  const rel = relativeCrops(p);
  if (p.url && p.url !== o.url) URL.revokeObjectURL(p.url);
  if (Math.abs(angle) < 0.05) {
    Object.assign(p, { angle: 0, img: o.img, w: o.w, h: o.h, preview: o.preview, url: o.url });
  } else {
    const a = angle * Math.PI / 180;
    const [rw, rh] = inscribedRect(o.w, o.h, a);
    const k = Math.min(1, Math.sqrt(MAX_CANVAS_AREA / (rw * rh)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(rw * k));
    c.height = Math.max(1, Math.floor(rh * k));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(a);
    ctx.scale(k, k);
    ctx.drawImage(o.img, -o.w / 2, -o.h / 2);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
    Object.assign(p, { angle, img: c, w: c.width, h: c.height, preview: makePreview(c), url: URL.createObjectURL(blob) });
  }
  p.thumb = p.preview.canvas.toDataURL('image/jpeg', 0.7);
  restoreCrops(p, rel);
  for (const c of state.photos) if (c.kind === 'collage' && c.sources.includes(p)) updateCollageThumb(c);
}

// Live preview while dragging: the whole rotated photo, with the part that
// will be trimmed dimmed and a grid to line up against.
function drawStraightenPreview(p, angle) {
  const cv = $('straightenPreview');
  const stage = $('stage');
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(stage.clientWidth * dpr), H = Math.round(stage.clientHeight * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  cv.hidden = false;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const o = p.orig || p;
  const a = angle * Math.PI / 180;
  const sin = Math.abs(Math.sin(a)), cos = Math.abs(Math.cos(a));
  const k = Math.min(W / (o.w * cos + o.h * sin), H / (o.w * sin + o.h * cos)) * 0.92;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(a);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(o.preview.canvas, -o.w * k / 2, -o.h * k / 2, o.w * k, o.h * k);
  ctx.restore();
  const [rw, rh] = inscribedRect(o.w, o.h, a);
  const cw = rw * k, ch = rh * k, x0 = (W - cw) / 2, y0 = (H - ch) / 2;
  ctx.fillStyle = 'rgba(0, 0, 0, .6)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(x0, y0, cw, ch);
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(255, 255, 255, .4)';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  for (let i = 1; i < 8; i++) {
    ctx.moveTo(x0 + cw * i / 8, y0); ctx.lineTo(x0 + cw * i / 8, y0 + ch);
    ctx.moveTo(x0, y0 + ch * i / 8); ctx.lineTo(x0 + cw, y0 + ch * i / 8);
  }
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeRect(x0, y0, cw, ch);
}

const angleInput = $('angleInput');
function syncAngleUI() {
  const a = state.activePhoto?.angle || 0;
  angleInput.value = a;
  $('angleVal').textContent = `${a.toFixed(1)}°`;
  $('straighten').classList.toggle('changed', a !== 0);
}

let angleQueue = Promise.resolve();
function commitAngle(angle) {
  const p = state.activePhoto;
  if (!p || p.loading || p.kind === 'collage') return;
  angleQueue = angleQueue.then(async () => {
    if ((p.angle || 0) !== angle) await applyAngle(p, angle);
    if (state.activePhoto !== p) return;
    $('straightenPreview').hidden = true;
    syncAngleUI();
    renderPhotos();
    renderTabs();
    mountCropper();
    updateMeta();
  });
}

angleInput.addEventListener('input', () => {
  const p = state.activePhoto;
  if (!p || p.loading || p.kind === 'collage') return;
  const a = parseFloat(angleInput.value);
  $('angleVal').textContent = `${a.toFixed(1)}°`;
  drawStraightenPreview(p, a);
});
angleInput.addEventListener('change', () => commitAngle(parseFloat(angleInput.value)));
$('straighten').addEventListener('dblclick', () => { angleInput.value = 0; commitAngle(0); });

function autoCrop(photo, t) {
  const W = photo.w, H = photo.h;
  let w = W, h = W * t.rh / t.rw;
  if (h > H) { h = H; w = H * t.rw / t.rh; }
  return { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h };
}

function cropFor(photo, t) {
  if (!photo.crops[t.id]) photo.crops[t.id] = autoCrop(photo, t);
  return photo.crops[t.id];
}

/* ---------------- Collages ---------------- */
/*
 * A collage is an item in the photo list like any other, but its base image is
 * composed from 2–4 source photos. Cells are defined in frame fractions; each
 * cell keeps a focus point and zoom that are shared by every output size, so
 * the same framing adapts to 4:3 and 3:4.
 */
const evenSplit = (n, dir) => Array.from({ length: n }, (_, i) => dir === 'cols' ? [i / n, 0, 1 / n, 1] : [0, i / n, 1, 1 / n]);
const COLLAGE_LAYOUTS = {
  2: { auto: null, cols: evenSplit(2, 'cols'), rows: evenSplit(2, 'rows') },
  3: {
    auto: null,
    'big-left': [[0, 0, .5, 1], [.5, 0, .5, .5], [.5, .5, .5, .5]],
    'big-right': [[.5, 0, .5, 1], [0, 0, .5, .5], [0, .5, .5, .5]],
    'big-top': [[0, 0, 1, .5], [0, .5, .5, .5], [.5, .5, .5, .5]],
    'big-bottom': [[0, .5, 1, .5], [0, 0, .5, .5], [.5, 0, .5, .5]],
    cols: evenSplit(3, 'cols'), rows: evenSplit(3, 'rows'),
  },
  4: {
    auto: null,
    grid: [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]],
    'big-left': [[0, 0, 2 / 3, 1], [2 / 3, 0, 1 / 3, 1 / 3], [2 / 3, 1 / 3, 1 / 3, 1 / 3], [2 / 3, 2 / 3, 1 / 3, 1 / 3]],
    'big-top': [[0, 0, 1, 2 / 3], [0, 2 / 3, 1 / 3, 1 / 3], [1 / 3, 2 / 3, 1 / 3, 1 / 3], [2 / 3, 2 / 3, 1 / 3, 1 / 3]],
    cols: evenSplit(4, 'cols'), rows: evenSplit(4, 'rows'),
  },
};
const LAYOUT_NAMES = {
  auto: 'Auto: adapts to each size', cols: 'Side by side', rows: 'Stacked', grid: 'Grid',
  'big-left': 'Big photo left', 'big-right': 'Big photo right', 'big-top': 'Big photo top', 'big-bottom': 'Big photo bottom',
};
let collageSeq = 0;

function resolveLayout(p, W, H) {
  const n = p.sources.length, land = W >= H;
  if (p.layout !== 'auto') return p.layout;
  return n === 2 ? (land ? 'cols' : 'rows') : n === 3 ? (land ? 'big-left' : 'big-top') : 'grid';
}

function collageRects(p, W, H) {
  const rects = COLLAGE_LAYOUTS[p.sources.length][resolveLayout(p, W, H)];
  const g = p.gap * Math.min(W, H);
  const iw = W - 2 * g, ih = H - 2 * g;
  return rects.map(([x, y, w, h]) => {
    const x0 = g + x * iw + (x > 0.001 ? g / 2 : 0);
    const x1 = g + (x + w) * iw - (x + w < 0.999 ? g / 2 : 0);
    const y0 = g + y * ih + (y > 0.001 ? g / 2 : 0);
    const y1 = g + (y + h) * ih - (y + h < 0.999 ? g / 2 : 0);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  });
}

function cellView(src, cell, cw, ch) {
  const scale = Math.max(cw / src.w, ch / src.h) * cell.zoom;
  const sw = cw / scale, sh = ch / scale;
  return { scale, sw, sh, sx: clamp(cell.fx * src.w - sw / 2, 0, src.w - sw), sy: clamp(cell.fy * src.h - sh / 2, 0, src.h - sh) };
}

function drawCollage(ctx, p, W, H, hi) {
  ctx.fillStyle = p.gapColor;
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  const radius = p.radius * Math.min(W, H);
  collageRects(p, W, H).forEach((c, i) => {
    const src = p.sources[i];
    const v = cellView(src, p.cells[i], c.w, c.h);
    const img = hi ? src.img : src.preview.canvas;
    const k = hi ? 1 : src.preview.scale;
    ctx.save();
    if (radius > 0) { roundRect(ctx, c.x, c.y, c.w, c.h, radius); ctx.clip(); }
    ctx.drawImage(img, v.sx * k, v.sy * k, v.sw * k, v.sh * k, c.x, c.y, c.w, c.h);
    ctx.restore();
  });
}

// Draws the item's base image (crop or collage) for target t into a W×H canvas.
function renderBase(ctx, p, t, W, H, hi) {
  ctx.imageSmoothingQuality = 'high';
  if (p.kind === 'collage') { drawCollage(ctx, p, W, H, hi); return; }
  const r = cropFor(p, t);
  if (hi) ctx.drawImage(p.img, r.x, r.y, r.width, r.height, 0, 0, W, H);
  else {
    const s = p.preview.scale;
    ctx.drawImage(p.preview.canvas, r.x * s, r.y * s, r.width * s, r.height * s, 0, 0, W, H);
  }
}

function updateCollageThumb(c) {
  const cv = document.createElement('canvas');
  cv.width = 240;
  cv.height = 180;
  drawCollage(cv.getContext('2d'), c, 240, 180, false);
  c.thumb = cv.toDataURL('image/jpeg', 0.75);
}

function createCollage(sources) {
  const c = {
    id: ++seq, kind: 'collage', name: `collage-${++collageSeq}`, sources,
    layout: 'auto', gap: 0.015, radius: 0, gapColor: '#ffffff',
    cells: sources.map(() => ({ fx: 0.5, fy: 0.5, zoom: 1 })),
    crops: {}, layers: [],
  };
  updateCollageThumb(c);
  state.photos.push(c);
  renderSummary();
  selectPhoto(c);
}

async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('image/') || isHeic(f));
  if (!files.length) { toast('No images found'); return; }

  showWork();
  const pending = files.map(file => {
    const photo = { id: ++seq, name: file.name, file, loading: true, crops: {}, layers: [] };
    state.photos.push(photo);
    return photo;
  });
  renderPhotos();
  renderSummary();

  let failed = 0;
  for (const photo of pending) {
    try {
      const { img, url } = await decodeFile(photo.file);
      photo.img = img;
      photo.url = url;
      photo.w = img.naturalWidth;
      photo.h = img.naturalHeight;
      photo.preview = makePreview(img);
      photo.thumb = photo.preview.canvas.toDataURL('image/jpeg', 0.7);
      photo.loading = false;
      photo.file = null;
      if (!state.activePhoto) selectPhoto(photo);
    } catch (e) {
      console.error(e);
      failed++;
      state.photos = state.photos.filter(p => p !== photo);
    }
    renderPhotos();
    renderSummary();
  }
  if (failed) toast(`${failed} file${failed > 1 ? 's' : ''} couldn't be opened`);
  if (!state.photos.length) showDrop();
}

/* ---------------- Views ---------------- */

function showWork() {
  $('dropView').hidden = true;
  $('workView').hidden = false;
}
function showDrop() {
  if (cropper) { cropper.destroy(); cropper = null; }
  state.activePhoto = null;
  state.sel = null;
  $('workView').hidden = true;
  $('dropView').hidden = false;
}

/* ---------------- Target chips ---------------- */

function renderTargets() {
  $('targets').innerHTML = '';
  for (const t of TARGETS) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.enabled.has(t.id) ? ' on' : '');
    b.style.setProperty('--c', t.color);
    b.innerHTML = `<span class="check"><svg viewBox="0 0 16 16" width="11" height="11"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      ${t.site}${t.site === 'MakerWorld' ? ` <span style="color:var(--muted);font-weight:500">${t.label}</span>` : ''}
      <span class="ratio">${t.rw}:${t.rh}</span>`;
    b.addEventListener('click', () => {
      if (state.enabled.has(t.id)) {
        if (state.enabled.size === 1) { toast('Pick at least one'); return; }
        state.enabled.delete(t.id);
      } else {
        state.enabled.add(t.id);
      }
      store.set('enabled', [...state.enabled]);
      renderTargets();
      if (!state.enabled.has(state.activeTarget)) state.activeTarget = null;
      renderTabs();
      if (state.activePhoto) selectTarget(state.activeTarget || enabledTargets()[0].id);
      renderSummary();
    });
    $('targets').appendChild(b);
  }
}

$('linkToggle').checked = state.link;
$('linkToggle').addEventListener('change', (e) => {
  state.link = e.target.checked;
  store.set('link', state.link);
});

/* ---------------- Photo list ---------------- */

function renderPhotos() {
  const list = $('photoList');
  list.innerHTML = '';
  for (const p of state.photos) {
    const item = document.createElement('div');
    item.className = 'thumb-item';
    const b = document.createElement('button');
    b.className = 'thumb-btn' + (p === state.activePhoto ? ' active' : '');
    b.title = p.name;
    item.appendChild(b);
    if (p.loading) {
      b.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      b.disabled = true;
    } else {
      const del = document.createElement('button');
      del.className = 'thumb-del';
      del.title = p.kind === 'collage' ? 'Delete collage' : 'Delete photo';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
      del.addEventListener('click', () => removeItem(p));
      item.appendChild(del);
      const img = document.createElement('img');
      img.src = p.thumb;
      img.alt = p.name;
      b.appendChild(img);
      if (p.kind === 'collage') {
        b.title = `Collage of ${p.sources.length}`;
        b.insertAdjacentHTML('beforeend', `<span class="badge">${ICONS.collage}</span>`);
      }
      b.addEventListener('click', () => selectPhoto(p));
    }
    list.appendChild(item);
  }
}

function renderSummary() {
  const ready = state.photos.filter(p => !p.loading).length;
  const n = enabledTargets().length;
  $('summary').textContent = `${ready} photo${ready === 1 ? '' : 's'} × ${n} size${n === 1 ? '' : 's'} = ${ready * n} images`;
  $('doneBtn').disabled = !ready || state.photos.some(p => p.loading);
}

/* ---------------- Variant tabs ---------------- */

function renderTabs() {
  const wrap = $('variantTabs');
  wrap.innerHTML = '';
  const p = state.activePhoto;
  for (const t of enabledTargets()) {
    const b = document.createElement('button');
    b.className = 'vtab' + (t.id === state.activeTarget ? ' active' : '');
    b.dataset.id = t.id;
    b.style.setProperty('--c', t.color);
    const c = document.createElement('canvas');
    const ph = 40 * (window.devicePixelRatio || 1);
    c.height = ph;
    c.width = Math.round(ph * t.rw / t.rh);
    c.style.width = Math.round(40 * t.rw / t.rh) + 'px';
    b.appendChild(c);
    const txt = document.createElement('span');
    txt.className = 'vt-text';
    txt.innerHTML = `<span class="vt-site"><i class="dot" style="--c:${t.color}"></i>${t.site}</span><span class="vt-sub">${t.label} · ${t.rw}:${t.rh}</span>`;
    b.appendChild(txt);
    b.title = `${t.site} ${t.label.toLowerCase()} · ${t.rw}:${t.rh}`;
    b.addEventListener('click', () => selectTarget(t.id));
    wrap.appendChild(b);
    if (p && !p.loading) drawTabPreview(p, t, c);
  }
}

function drawTabPreview(p, t, canvas) {
  canvas = canvas || $('variantTabs').querySelector(`[data-id="${t.id}"] canvas`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  renderBase(ctx, p, t, canvas.width, canvas.height, false);
  drawLayers(ctx, p.layers, canvas.width, canvas.height, t.id);
}

let tabsPending = false;
function scheduleTabPreviews() {
  if (tabsPending) return;
  tabsPending = true;
  requestAnimationFrame(() => {
    tabsPending = false;
    const p = state.activePhoto;
    if (p && !p.loading) for (const t of enabledTargets()) drawTabPreview(p, t);
  });
}

/* ---------------- Selection & modes ---------------- */

const isCollageCrop = () => state.mode === 'crop' && state.activePhoto?.kind === 'collage';

// Crop mode shows Cropper for photos and the cell editor for collages;
// overlay mode always uses the canvas frame.
function applyView() {
  const overlay = state.mode === 'overlay', collage = isCollageCrop();
  $('stage').hidden = overlay || collage;
  $('overlayStage').hidden = !(overlay || collage);
  $('panel').hidden = !overlay;
  $('collagePanel').hidden = !collage;
  $('resetBtn').hidden = overlay;
  $('straighten').hidden = overlay || collage;
  $('straightenPreview').hidden = true;
  $('overlayStage').classList.toggle('collage-edit', collage);
}

function showCurrent() {
  if (cropper && (state.mode !== 'crop' || state.activePhoto?.kind === 'collage')) { cropper.destroy(); cropper = null; }
  applyView();
  if (state.mode === 'overlay') { ensureFonts(); layoutFrame(); renderPanel(); }
  else if (isCollageCrop()) { layoutFrame(); renderCollagePanel(); }
  else mountCropper();
}

function selectPhoto(photo) {
  state.activePhoto = photo;
  state.sel = null;
  state.cell = 0;
  if (!state.activeTarget || !state.enabled.has(state.activeTarget)) state.activeTarget = enabledTargets()[0].id;
  renderPhotos();
  renderTabs();
  showCurrent();
  syncAngleUI();
  updateMeta();
}

function selectTarget(id) {
  state.activeTarget = id;
  $('variantTabs').querySelectorAll('.vtab').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  const p = state.activePhoto;
  if (!p) return;
  const t = byId(id);
  if (state.mode === 'overlay' || isCollageCrop()) {
    layoutFrame();
    syncSizeSlider();
  } else if (cropper) {
    suppressCrop = true;
    cropper.setAspectRatio(t.rw / t.rh);
    cropper.setData(cropFor(p, t));
    suppressCrop = false;
    updateCropColor();
    drawCropOverlay();
  }
  updateMeta();
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  $('modeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  if (mode === 'crop') state.sel = null;
  showCurrent();
}
$('modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

/* ---------------- Cropping ---------------- */

function mountCropper() {
  const photo = state.activePhoto;
  if (cropper) { cropper.destroy(); cropper = null; }
  if (!photo || photo.loading || photo.kind === 'collage') return;
  const img = $('cropImg');
  img.src = photo.url;
  const t = byId(state.activeTarget);
  suppressCrop = true;
  cropper = new Cropper(img, {
    viewMode: 1,
    dragMode: 'none',
    aspectRatio: t.rw / t.rh,
    data: cropFor(photo, t),
    autoCropArea: 1,
    checkOrientation: false,
    zoomable: false,
    rotatable: false,
    scalable: false,
    movable: false,
    background: false,
    toggleDragModeOnDblclick: false,
    minContainerHeight: 100,
    minContainerWidth: 100,
    ready() {
      cropper.setData(cropFor(photo, byId(state.activeTarget)));
      suppressCrop = false;
      mountCropOverlay();
      updateCropColor();
      updateMeta();
    },
    crop: onCrop,
  });
}

/*
 * Read-only preview of the overlays inside the crop box, so the crop can be
 * framed around them. It sits under Cropper's drag surface and ignores input.
 */
let cropOverlay = null;
function mountCropOverlay() {
  const box = $('stage').querySelector('.cropper-crop-box');
  if (!box) return;
  cropOverlay = document.createElement('canvas');
  cropOverlay.className = 'crop-overlay';
  box.querySelector('.cropper-view-box').after(cropOverlay);
  drawCropOverlay();
}

function drawCropOverlay() {
  const p = state.activePhoto;
  if (!cropper || !cropOverlay || !cropOverlay.isConnected || !p) return;
  const { width, height } = cropper.getCropBoxData();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(width * dpr)), H = Math.max(1, Math.round(height * dpr));
  if (cropOverlay.width !== W || cropOverlay.height !== H) { cropOverlay.width = W; cropOverlay.height = H; }
  const ctx = cropOverlay.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  drawLayers(ctx, p.layers, W, H, state.activeTarget);
}

function updateCropColor() {
  const t = byId(state.activeTarget);
  $('stage').style.setProperty('--crop', t ? t.color : '');
}

let rafPending = false;
function onCrop() {
  if (suppressCrop) return;
  const p = state.activePhoto;
  const t = byId(state.activeTarget);
  if (!p || !t) return;
  const d = cropper.getData();
  const rect = { x: d.x, y: d.y, width: d.width, height: d.height };
  p.crops[t.id] = rect;
  const linked = state.link ? enabledTargets().filter(o => o !== t && sameRatio(o, t)) : [];
  for (const o of linked) p.crops[o.id] = { ...rect };
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      drawTabPreview(p, t);
      for (const o of linked) drawTabPreview(p, o);
      drawCropOverlay();
      updateMeta();
    });
  }
}

function outputSize(rect, t) {
  const longIn = Math.max(rect.width, rect.height);
  const s = Math.min(1, t.max / longIn);
  if (t.rw >= t.rh) {
    const w = Math.max(1, Math.round(rect.width * s));
    return { w, h: Math.max(1, Math.round(w * t.rh / t.rw)) };
  }
  const h = Math.max(1, Math.round(rect.height * s));
  return { w: Math.max(1, Math.round(h * t.rw / t.rh)), h };
}

function updateMeta() {
  const p = state.activePhoto, t = byId(state.activeTarget);
  if (!p || !t || p.loading) { $('meta').textContent = ''; return; }
  if (p.kind === 'collage') {
    const o = fullSize(t);
    $('meta').textContent = `Collage of ${p.sources.length} → ${o.w}×${o.h} JPG`;
    return;
  }
  const o = outputSize(cropFor(p, t), t);
  $('meta').textContent = `${p.w}×${p.h} → ${o.w}×${o.h} JPG`;
}

function fullSize(t) {
  return t.rw >= t.rh
    ? { w: t.max, h: Math.round(t.max * t.rh / t.rw) }
    : { w: Math.round(t.max * t.rw / t.rh), h: t.max };
}

$('resetBtn').addEventListener('click', () => {
  const p = state.activePhoto, t = byId(state.activeTarget);
  if (p?.kind === 'collage') {
    p.cells = p.cells.map(() => ({ fx: 0.5, fy: 0.5, zoom: 1 }));
    collageChanged(true);
    renderCollagePanel();
    return;
  }
  if (!p || !t || !cropper) return;
  cropper.setData(autoCrop(p, t));
});

$('removeBtn').addEventListener('click', () => { if (state.activePhoto) removeItem(state.activePhoto); });

// Collages hold direct references to their source photos, so deleting a
// source from the list leaves the collage intact. A photo's object URL is only
// released once nothing (list or collage) uses it any more.
function inUse(photo) {
  return state.photos.includes(photo) || state.photos.some(c => c.kind === 'collage' && c.sources.includes(photo));
}

function releaseImages(p) {
  for (const x of p.kind === 'collage' ? p.sources : [p]) {
    if (inUse(x)) continue;
    if (x.url) URL.revokeObjectURL(x.url);
    if (x.orig?.url && x.orig.url !== x.url) URL.revokeObjectURL(x.orig.url);
    x.url = null;
  }
}

function removeItem(p) {
  const idx = state.photos.indexOf(p);
  if (idx < 0) return;
  state.photos.splice(idx, 1);
  releaseImages(p);
  if (state.activePhoto === p) {
    const ready = state.photos.filter(x => !x.loading);
    const next = ready[Math.min(idx, ready.length - 1)];
    state.activePhoto = null;
    if (next) selectPhoto(next);
    else if (!state.photos.length) showDrop();
  }
  renderPhotos();
  renderSummary();
}

/* ---------------- Layer rendering (shared by preview and export) ---------------- */
/*
 * Layer geometry is resolution independent: x/y are the layer centre as a
 * fraction of the frame, size is a fraction of the frame width (font size for
 * text, drawn width for images). Effect sizes are fractions of the font size
 * (or of 1/5 of an image's width), so the preview and every export match.
 */

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

function fontCss(name) {
  return GENERIC_FONTS.includes(name) ? name : `"${name.replace(/"/g, '')}", sans-serif`;
}

function textGeom(ctx, l, pl, W, H) {
  const fs = Math.max(1, pl.size * W);
  const font = `${l.italic ? 'italic ' : ''}${l.bold ? 700 : 400} ${fs}px ${fontCss(l.font)}`;
  ctx.font = font;
  const lines = (l.text || ' ').split('\n');
  const widths = lines.map(s => ctx.measureText(s).width);
  const maxW = Math.max(fs * 0.3, ...widths);
  const m = ctx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent ?? fs * 0.8;
  const desc = m.fontBoundingBoxDescent ?? fs * 0.2;
  const lh = fs * 1.2;
  const cx = pl.x * W, cy = pl.y * H;
  const h = lines.length * lh;
  const top = cy - h / 2;
  return { fs, font, lines, maxW, lh, asc, desc, cx, cy, top, unit: fs, box: { x: cx - maxW / 2, y: top, w: maxW, h } };
}

function imageGeom(l, pl, W, H) {
  const w = Math.max(1, pl.size * W);
  const h = w * l.aspect;
  const x = pl.x * W - w / 2, y = pl.y * H - h / 2;
  return { w, h, x, y, unit: w / 5, box: { x, y, w, h } };
}

/*
 * Placement (x, y, size) is shared by every output size while a layer is
 * linked. Unlinked layers keep a per-target override in l.pos, falling back to
 * the shared placement for targets that haven't been adjusted yet.
 */
function place(l, tid) {
  return (!l.linked && l.pos && l.pos[tid]) || l;
}

function setPlace(l, tid, changes) {
  if (l.linked) { Object.assign(l, changes); return; }
  const cur = place(l, tid);
  l.pos = { ...l.pos, [tid]: { x: cur.x, y: cur.y, size: cur.size, ...changes } };
}

function layerGeom(ctx, l, W, H, tid) {
  const pl = place(l, tid);
  return l.type === 'text' ? textGeom(ctx, l, pl, W, H) : imageGeom(l, pl, W, H);
}

function drawTextLines(ctx, g, l, dx, dy, fill, stroke) {
  ctx.font = g.font;
  ctx.textAlign = l.align;
  ctx.textBaseline = 'alphabetic';
  const ax = l.align === 'left' ? g.cx - g.maxW / 2 : l.align === 'right' ? g.cx + g.maxW / 2 : g.cx;
  g.lines.forEach((line, i) => {
    const y = g.top + i * g.lh + (g.lh - (g.asc + g.desc)) / 2 + g.asc + dy;
    if (stroke) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = stroke.width;
      ctx.strokeStyle = stroke.color;
      ctx.strokeText(line, ax + dx, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, ax + dx, y);
  });
}

const tintCache = new WeakMap();
function silhouette(img, color) {
  let byColor = tintCache.get(img);
  if (!byColor) { byColor = new Map(); tintCache.set(img, byColor); }
  let c = byColor.get(color);
  if (!c) {
    const iw = img.naturalWidth || 300, ih = img.naturalHeight || 300;
    const s = Math.min(1, 1024 / Math.max(iw, ih));
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(iw * s));
    c.height = Math.max(1, Math.round(ih * s));
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, c.width, c.height);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    byColor.set(color, c);
  }
  return c;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

let scratch = null;
function getScratch(W, H) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== W || scratch.height !== H) { scratch.width = W; scratch.height = H; }
  const ctx = scratch.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return ctx;
}

function drawLayer(ctx, l, W, H, tid) {
  const g = layerGeom(ctx, l, W, H, tid);
  const u = g.unit;

  // Background box sits under the text, unaffected by the other effects.
  if (l.type === 'text' && l.box) {
    const pad = l.boxPad * u;
    ctx.save();
    ctx.globalAlpha = l.opacity * l.boxAlpha;
    ctx.fillStyle = l.boxColor;
    roundRect(ctx, g.box.x - pad, g.box.y - pad * 0.6, g.box.w + pad * 2, g.box.h + pad * 1.2, l.boxRadius * u);
    ctx.fill();
    ctx.restore();
  }

  // Compose the layer (extrusion + outline + body) on a scratch canvas so the
  // drop shadow is cast by the whole shape at once.
  const sc = getScratch(W, H);
  sc.imageSmoothingQuality = 'high';
  const outline = l.outline ? { width: 2 * l.outlineWidth * u, color: l.outlineColor } : null;

  if (l.d3 && l.d3Depth > 0) {
    const depth = l.d3Depth * u;
    const n = clamp(Math.ceil(depth), 1, 300);
    const a = l.d3Angle * Math.PI / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    const sil = l.type === 'image' ? silhouette(l.img, l.d3Color) : null;
    for (let i = n; i >= 1; i--) {
      const d = depth * i / n;
      if (sil) sc.drawImage(sil, g.x + ux * d, g.y + uy * d, g.w, g.h);
      else drawTextLines(sc, g, l, ux * d, uy * d, l.d3Color, outline && { width: outline.width, color: l.d3Color });
    }
  }

  if (l.type === 'text') {
    drawTextLines(sc, g, l, 0, 0, l.color, outline);
  } else {
    if (outline) {
      const sil = silhouette(l.img, l.outlineColor);
      const r = l.outlineWidth * u;
      for (const rr of [r, r * 0.5]) {
        for (let k = 0; k < 16; k++) {
          const a = k * Math.PI / 8;
          sc.drawImage(sil, g.x + Math.cos(a) * rr, g.y + Math.sin(a) * rr, g.w, g.h);
        }
      }
    }
    sc.drawImage(l.img, g.x, g.y, g.w, g.h);
  }

  ctx.save();
  ctx.globalAlpha = l.opacity;
  if (l.shadow) {
    const a = l.shadowAngle * Math.PI / 180;
    ctx.shadowColor = hexA(l.shadowColor, l.shadowAlpha);
    ctx.shadowBlur = l.shadowBlur * u;
    ctx.shadowOffsetX = Math.cos(a) * l.shadowDist * u;
    ctx.shadowOffsetY = Math.sin(a) * l.shadowDist * u;
  }
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

function drawLayers(ctx, layers, W, H, tid) {
  for (const l of layers) {
    if (l.type === 'image' && !l.img) continue;
    drawLayer(ctx, l, W, H, tid);
  }
}

/* ---------------- Layer model ---------------- */

const EFFECT_DEFAULTS = {
  outline: false, outlineColor: '#000000', outlineWidth: 0.06,
  shadow: false, shadowColor: '#000000', shadowAlpha: 0.5, shadowBlur: 0.15, shadowDist: 0.06, shadowAngle: 90,
  d3: false, d3Color: '#1b1a18', d3Depth: 0.08, d3Angle: 135,
  box: false, boxColor: '#000000', boxAlpha: 0.6, boxPad: 0.35, boxRadius: 0.25,
};

const PRESETS = [
  { name: 'Plain (no effects)', css: 'color:#fff', set: { outline: false, shadow: false, d3: false, box: false } },
  { name: 'Outline style', css: 'color:#fff;-webkit-text-stroke:3px #000;paint-order:stroke fill',
    set: { color: '#ffffff', outline: true, outlineColor: '#000000', outlineWidth: 0.08, shadow: false, d3: false, box: false } },
  { name: 'Soft shadow', css: 'color:#fff;text-shadow:0 2px 5px rgba(0,0,0,.7)',
    set: { outline: false, shadow: true, shadowColor: '#000000', shadowAlpha: 0.6, shadowBlur: 0.18, shadowDist: 0.06, shadowAngle: 90, d3: false, box: false } },
  { name: '3D extrude', css: 'color:#fff;text-shadow:1px 1px 0 #00ae42,2px 2px 0 #00ae42,3px 3px 0 #00ae42,4px 4px 0 #00ae42',
    set: { color: '#ffffff', outline: false, d3: true, d3Color: '#00ae42', d3Depth: 0.09, d3Angle: 45, shadow: true, shadowColor: '#000000', shadowAlpha: 0.35, shadowBlur: 0.2, shadowDist: 0.08, shadowAngle: 60, box: false } },
  { name: 'Neon glow', css: 'color:#fff;text-shadow:0 0 4px #ff3df0,0 0 10px #ff3df0',
    set: { color: '#ffffff', outline: true, outlineColor: '#ff3df0', outlineWidth: 0.025, shadow: true, shadowColor: '#ff3df0', shadowAlpha: 1, shadowBlur: 0.45, shadowDist: 0, d3: false, box: false } },
  { name: 'Background box', css: 'color:#fff;background:#000;border-radius:5px;padding:2px 6px;font-size:13px',
    set: { outline: false, shadow: false, d3: false, box: true, boxColor: '#000000', boxAlpha: 0.65 } },
];

const TEXT_STYLE_KEYS = ['font', 'color', 'bold', 'italic', 'align', ...Object.keys(EFFECT_DEFAULTS)];

function newTextLayer() {
  const saved = store.get('textStyle', {});
  const l = {
    id: ++seq, type: 'text', text: 'Your text', x: 0.5, y: 0.82, size: 0.09, opacity: 1, linked: true, pos: {},
    font: 'system-ui', color: '#ffffff', bold: true, italic: false, align: 'center',
    ...EFFECT_DEFAULTS, shadow: true,
  };
  for (const k of TEXT_STYLE_KEYS) if (k in saved) l[k] = saved[k];
  return l;
}

function rememberTextStyle(l) {
  if (l.type !== 'text') return;
  const s = {};
  for (const k of TEXT_STYLE_KEYS) s[k] = l[k];
  store.set('textStyle', s);
}

function cloneLayer(l) {
  const pos = {};
  for (const [k, v] of Object.entries(l.pos || {})) pos[k] = { ...v };
  return { ...l, id: ++seq, pos };
}

$('addTextBtn').addEventListener('click', () => {
  const p = state.activePhoto;
  if (!p) return;
  const l = newTextLayer();
  p.layers.push(l);
  state.sel = l;
  renderPanel();
  scheduleRedraw();
  const ta = $('props').querySelector('textarea');
  if (ta) { ta.focus(); ta.select(); }
});

$('overlayInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const p = state.activePhoto;
  if (!file || !p) return;
  try {
    const { img, url } = await decodeFile(file);
    const iw = img.naturalWidth || 300, ih = img.naturalHeight || 300;
    const l = {
      id: ++seq, type: 'image', name: file.name, img, url, aspect: ih / iw,
      x: 0.8, y: 0.8, size: 0.25, opacity: 1, linked: true, pos: {}, ...EFFECT_DEFAULTS,
    };
    p.layers.push(l);
    state.sel = l;
    renderPanel();
    scheduleRedraw();
  } catch (err) {
    console.error(err);
    toast("Couldn't open that image");
  }
});

$('copyAllBtn').addEventListener('click', () => {
  const p = state.activePhoto;
  if (!p) return;
  const others = state.photos.filter(x => x !== p);
  if (!others.length) { toast('Only one photo'); return; }
  for (const o of others) o.layers = p.layers.map(cloneLayer);
  toast(`Copied to ${others.length} photo${others.length > 1 ? 's' : ''}`);
});

function removeLayer(l) {
  const p = state.activePhoto;
  p.layers = p.layers.filter(x => x !== l);
  if (state.sel === l) state.sel = null;
  renderPanel();
  scheduleRedraw();
}

function moveLayer(l, dir) {
  const arr = state.activePhoto.layers;
  const i = arr.indexOf(l), j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderPanel();
  scheduleRedraw();
}

/* ---------------- Overlay canvas editor ---------------- */

const frame = $('frame');
const frameCanvas = $('frameCanvas');
let bgCanvas = null;
let frameCss = { w: 0, h: 0 };

function layoutFrame() {
  const p = state.activePhoto, t = byId(state.activeTarget);
  const stage = $('overlayStage');
  if (!p || p.loading || !t || stage.hidden) return;
  const pad = 40;
  const aw = Math.max(50, stage.clientWidth - pad), ah = Math.max(50, stage.clientHeight - pad);
  let w = aw, h = aw * t.rh / t.rw;
  if (h > ah) { h = ah; w = ah * t.rw / t.rh; }
  w = Math.floor(w); h = Math.floor(h);
  frameCss = { w, h };
  frame.style.width = w + 'px';
  frame.style.height = h + 'px';
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  frameCanvas.width = W;
  frameCanvas.height = H;
  buildBg(true);
  redraw();
}

function buildBg(hi) {
  const p = state.activePhoto, t = byId(state.activeTarget);
  const W = frameCanvas.width, H = frameCanvas.height;
  if (!p || !t || !W) return;
  if (!bgCanvas) bgCanvas = document.createElement('canvas');
  if (bgCanvas.width !== W || bgCanvas.height !== H) { bgCanvas.width = W; bgCanvas.height = H; }
  const bx = bgCanvas.getContext('2d');
  bx.clearRect(0, 0, W, H);
  renderBase(bx, p, t, W, H, hi);
}

new ResizeObserver(() => { if (!$('overlayStage').hidden) layoutFrame(); }).observe($('overlayStage'));

let redrawPending = false;
function scheduleRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => { redrawPending = false; redraw(); });
  scheduleTabPreviews();
}

function redraw() {
  const p = state.activePhoto;
  if (!p || !bgCanvas || $('overlayStage').hidden) return;
  const ctx = frameCanvas.getContext('2d');
  const W = frameCanvas.width, H = frameCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bgCanvas, 0, 0);
  drawLayers(ctx, p.layers, W, H, state.activeTarget);
  updateSelBox();
  updateCellBox();
}

function updateSelBox() {
  const box = $('selBox');
  const l = state.sel;
  if (state.mode !== 'overlay' || !l || !state.activePhoto.layers.includes(l)) { box.hidden = true; return; }
  const ctx = frameCanvas.getContext('2d');
  const W = frameCanvas.width, H = frameCanvas.height;
  const b = layerGeom(ctx, l, W, H, state.activeTarget).box;
  const k = frameCss.w / W;
  box.hidden = false;
  box.style.left = b.x * k + 'px';
  box.style.top = b.y * k + 'px';
  box.style.width = b.w * k + 'px';
  box.style.height = b.h * k + 'px';
}

function hitTest(px, py) {
  const p = state.activePhoto;
  const ctx = frameCanvas.getContext('2d');
  const W = frameCanvas.width, H = frameCanvas.height;
  const k = W / frameCss.w;
  const x = px * k, y = py * k, slop = 6 * k;
  for (let i = p.layers.length - 1; i >= 0; i--) {
    const l = p.layers[i];
    if (l.type === 'image' && !l.img) continue;
    const b = layerGeom(ctx, l, W, H, state.activeTarget).box;
    if (x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop) return l;
  }
  return null;
}

let drag = null;
frame.addEventListener('pointerdown', (e) => {
  const p = state.activePhoto;
  if (!p) return;
  const rect = frame.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;

  if (isCollageCrop()) {
    const rs = collageRects(p, frameCss.w, frameCss.h);
    const i = cellAt(rs, px, py);
    if (i < 0) return;
    if (state.cell !== i) { state.cell = i; renderCollagePanel(); }
    const r = rs[i], cell = p.cells[i];
    drag = { type: 'pan', i, px, py, fx0: cell.fx, fy0: cell.fy, r, scale: cellView(p.sources[i], cell, r.w, r.h).scale };
    frame.setPointerCapture(e.pointerId);
    frame.style.cursor = 'grabbing';
    updateCellBox();
    e.preventDefault();
    return;
  }

  if (e.target === $('selHandle') && state.sel) {
    const l = state.sel;
    const pl = place(l, state.activeTarget);
    const cx = pl.x * rect.width, cy = pl.y * rect.height;
    drag = { type: 'resize', l, cx, cy, d0: Math.hypot(px - cx, py - cy) || 1, s0: pl.size };
  } else {
    const l = hitTest(px, py);
    if (l !== state.sel) { state.sel = l; renderPanel(); }
    if (!l) { redraw(); return; }
    const pl = place(l, state.activeTarget);
    drag = { type: 'move', l, px, py, x0: pl.x, y0: pl.y, w: rect.width, h: rect.height };
    redraw();
  }
  frame.setPointerCapture(e.pointerId);
  e.preventDefault();
});

frame.addEventListener('pointermove', (e) => {
  const rect = frame.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  if (isCollageCrop()) {
    const p = state.activePhoto;
    if (!drag) {
      frame.style.cursor = cellAt(collageRects(p, frameCss.w, frameCss.h), px, py) >= 0 ? 'grab' : 'default';
      return;
    }
    const src = p.sources[drag.i], cell = p.cells[drag.i];
    const hx = Math.min(0.5, drag.r.w / drag.scale / 2 / src.w);
    const hy = Math.min(0.5, drag.r.h / drag.scale / 2 / src.h);
    cell.fx = clamp(drag.fx0 - (px - drag.px) / (drag.scale * src.w), hx, 1 - hx);
    cell.fy = clamp(drag.fy0 - (py - drag.py) / (drag.scale * src.h), hy, 1 - hy);
    collageChanged();
    return;
  }
  if (!drag) {
    frame.style.cursor = e.target === $('selHandle') ? 'nwse-resize' : hitTest(px, py) ? 'move' : 'default';
    return;
  }
  const l = drag.l;
  if (drag.type === 'move') {
    let x = clamp(drag.x0 + (px - drag.px) / drag.w, 0, 1);
    let y = clamp(drag.y0 + (py - drag.py) / drag.h, 0, 1);
    const snapX = Math.abs(x - 0.5) * drag.w < 6, snapY = Math.abs(y - 0.5) * drag.h < 6;
    if (snapX) x = 0.5;
    if (snapY) y = 0.5;
    $('guideV').hidden = !snapX;
    $('guideH').hidden = !snapY;
    setPlace(l, state.activeTarget, { x, y });
  } else {
    const d = Math.hypot(px - drag.cx, py - drag.cy);
    setPlace(l, state.activeTarget, { size: clamp(drag.s0 * d / drag.d0, 0.01, 1.5) });
    syncSizeSlider();
  }
  scheduleRedraw();
});

function endDrag() {
  if (drag?.type === 'pan') frame.style.cursor = 'grab';
  drag = null;
  $('guideV').hidden = true;
  $('guideH').hidden = true;
}
frame.addEventListener('pointerup', endDrag);
frame.addEventListener('pointercancel', endDrag);
frame.addEventListener('dblclick', () => {
  if (state.sel?.type === 'text') {
    const ta = $('props').querySelector('textarea');
    if (ta) { ta.focus(); ta.select(); }
  }
});

function cellAt(rects, px, py) {
  return rects.findIndex(r => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
}

function updateCellBox() {
  const box = $('cellBox');
  const p = state.activePhoto;
  if (!isCollageCrop() || !p) { box.hidden = true; return; }
  const r = collageRects(p, frameCss.w, frameCss.h)[state.cell];
  if (!r) { box.hidden = true; return; }
  box.hidden = false;
  box.style.left = r.x + 'px';
  box.style.top = r.y + 'px';
  box.style.width = r.w + 'px';
  box.style.height = r.h + 'px';
}

// Live edits redraw from the fast previews; full resolution follows once idle.
let collageRaf = false, collageIdle;
function collageChanged(now) {
  const p = state.activePhoto;
  if (!collageRaf) {
    collageRaf = true;
    requestAnimationFrame(() => {
      collageRaf = false;
      buildBg(false);
      redraw();
      scheduleTabPreviews();
    });
  }
  clearTimeout(collageIdle);
  collageIdle = setTimeout(() => {
    if (state.activePhoto !== p) return;
    buildBg(true);
    redraw();
    updateCollageThumb(p);
    renderPhotos();
  }, now ? 0 : 250);
}

frame.addEventListener('wheel', (e) => {
  if (!isCollageCrop()) return;
  const p = state.activePhoto;
  const rect = frame.getBoundingClientRect();
  const i = cellAt(collageRects(p, frameCss.w, frameCss.h), e.clientX - rect.left, e.clientY - rect.top);
  if (i < 0) return;
  e.preventDefault();
  p.cells[i].zoom = clamp(p.cells[i].zoom * Math.exp(-e.deltaY * 0.0015), 1, 6);
  if (state.cell !== i) { state.cell = i; renderCollagePanel(); }
  else { const z = $('collageBody').querySelector('input[data-key="zoom"]'); if (z) z.value = p.cells[i].zoom; }
  collageChanged();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (state.mode !== 'overlay' || !state.sel || $('workView').hidden) return;
  if (e.target.closest('input, textarea, select, dialog')) return;
  const l = state.sel;
  const step = e.shiftKey ? 0.02 : 0.004;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (e.key === 'Delete' || e.key === 'Backspace') {
    removeLayer(l);
    e.preventDefault();
  } else if (moves[e.key]) {
    const pl = place(l, state.activeTarget);
    setPlace(l, state.activeTarget, { x: clamp(pl.x + moves[e.key][0], 0, 1), y: clamp(pl.y + moves[e.key][1], 0, 1) });
    scheduleRedraw();
    e.preventDefault();
  }
});

/* ---------------- Fonts ---------------- */

function detectFonts() {
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlliWW@#0Qg';
  const bases = ['monospace', 'serif', 'sans-serif'];
  const baseW = {};
  for (const b of bases) { ctx.font = `48px ${b}`; baseW[b] = ctx.measureText(sample).width; }
  return COMMON_FONTS.filter(f => bases.some(b => {
    ctx.font = `48px "${f}", ${b}`;
    return ctx.measureText(sample).width !== baseW[b];
  }));
}

function ensureFonts() {
  if (!state.fonts) state.fonts = [...GENERIC_FONTS, ...detectFonts()];
}

async function loadAllFonts() {
  try {
    const list = await window.queryLocalFonts();
    const families = [...new Set(list.map(f => f.family))].sort((a, b) => a.localeCompare(b));
    if (!families.length) { toast('No fonts shared'); return; }
    state.fonts = [...GENERIC_FONTS, ...families];
    renderPanel();
    toast(`${families.length} fonts loaded`);
  } catch (e) {
    console.error(e);
    toast('Font access was blocked');
  }
}

const GENERIC_LABELS = { 'system-ui': 'System UI', 'sans-serif': 'Sans-serif', serif: 'Serif', monospace: 'Monospace', cursive: 'Cursive' };

/* ---------------- Panel ---------------- */

const ICONS = {
  collage: '<svg viewBox="0 0 24 24" width="12" height="12"><rect x="3" y="3" width="8" height="18" rx="1.5" fill="currentColor"/><rect x="13" y="3" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  left: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="m15 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alignL: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 6h16M4 10h10M4 14h16M4 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  alignC: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 6h16M7 10h10M4 14h16M7 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  alignR: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 6h16M10 10h10M4 14h16M10 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  fonts: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 19 9.5 5h1L16 19M6 14h8M17 11v8M14 15h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function layerLabel(l) {
  return l.type === 'text' ? (l.text.split('\n')[0].trim() || 'Text') : l.name;
}

function renderPanel() {
  const p = state.activePhoto;
  if (!p || state.mode !== 'overlay') return;
  const list = $('layerList');
  list.innerHTML = '';
  [...p.layers].reverse().forEach(l => {
    const row = document.createElement('div');
    row.className = 'layer-row' + (l === state.sel ? ' on' : '');
    row.title = (l.type === 'text' ? 'Text: ' : 'Image: ') + layerLabel(l);
    const icon = l.type === 'text'
      ? `<span class="lr-icon" style="font-family:${esc(fontCss(l.font))}">T</span>`
      : `<span class="lr-icon"><img src="${l.url}" alt=""></span>`;
    row.innerHTML = `${icon}<span class="lr-name">${esc(layerLabel(l))}</span>
      <button class="mini" data-a="up" title="Bring forward">${ICONS.up}</button>
      <button class="mini" data-a="down" title="Send backward">${ICONS.down}</button>
      <button class="mini del" data-a="del" title="Delete">${ICONS.del}</button>`;
    row.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'up') moveLayer(l, 1);
      else if (a === 'down') moveLayer(l, -1);
      else if (a === 'del') removeLayer(l);
      else { state.sel = l; renderPanel(); redraw(); }
    });
    list.appendChild(row);
  });
  // Rebuilding the props wipes their scroll position (and briefly the page
  // height on mobile); keep both when the same layer is re-rendered.
  const props = $('props');
  const sameLayer = props.dataset.layer === String(state.sel?.id);
  const scrollTop = props.scrollTop, winY = window.scrollY;
  props.style.minHeight = sameLayer ? props.offsetHeight + 'px' : '';
  renderProps();
  props.dataset.layer = String(state.sel?.id);
  props.style.minHeight = '';
  if (sameLayer) {
    props.scrollTop = scrollTop;
    if (window.scrollY !== winY) window.scrollTo(0, winY);
  }
  $('copyAllBtn').disabled = !p.layers.length;
}

function onLayerChange(l, rerender) {
  rememberTextStyle(l);
  scheduleRedraw();
  if (rerender) renderPanel();
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}

function slider(l, key, label, min, max, step) {
  const input = el('input', { type: 'range', min, max, step });
  const isPlace = key === 'size';
  input.value = isPlace ? place(l, state.activeTarget)[key] : l[key];
  input.dataset.key = key;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (isPlace) setPlace(l, state.activeTarget, { [key]: v });
    else l[key] = v;
    onLayerChange(l);
  });
  return el('label', { class: 'slider', title: label }, [el('span', {}, label), input]);
}

function linkRow(l) {
  const input = el('input', { type: 'checkbox' });
  input.checked = l.linked;
  input.addEventListener('change', () => {
    if (input.checked) {
      // Re-linking adopts the placement of the size currently on screen.
      const pl = place(l, state.activeTarget);
      Object.assign(l, { x: pl.x, y: pl.y, size: pl.size, linked: true, pos: {} });
    } else {
      l.linked = false;
    }
    onLayerChange(l);
  });
  return el('label', { class: 'switch link-row', title: 'Off: move and resize separately for each size' }, [
    input, el('span', { class: 'track', html: '<span class="thumb"></span>' }), el('span', {}, 'Same position on all sizes'),
  ]);
}

function colorInput(l, key, title) {
  const input = el('input', { type: 'color', class: 'swatch', title });
  input.value = l[key];
  input.addEventListener('input', () => { l[key] = input.value; onLayerChange(l); });
  return input;
}

function toggleBtn(l, key, html, title) {
  return el('button', {
    class: 'tbtn' + (l[key] ? ' on' : ''), title, html,
    onclick: () => { l[key] = !l[key]; onLayerChange(l, true); },
  });
}

function fxSection(l, key, label, colorKey, sliders, tip) {
  const sw = el('label', { class: 'switch', title: tip }, [
    el('input', { type: 'checkbox', onchange: (e) => { l[key] = e.target.checked; onLayerChange(l, true); } }),
    el('span', { class: 'track', html: '<span class="thumb"></span>' }),
  ]);
  sw.querySelector('input').checked = !!l[key];
  return el('div', { class: 'fx' + (l[key] ? ' on' : '') }, [
    el('div', { class: 'fx-head' }, [el('span', { class: 'grow', title: tip }, label), colorInput(l, colorKey, label + ' color'), sw]),
    el('div', { class: 'fx-body' }, sliders),
  ]);
}

function syncSizeSlider() {
  const s = $('props').querySelector('input[data-key="size"]');
  if (s && state.sel) s.value = place(state.sel, state.activeTarget).size;
}

function renderProps() {
  const props = $('props');
  props.innerHTML = '';
  const l = state.sel;
  if (!l) {
    props.append(el('div', { class: 'empty' }, state.activePhoto.layers.length ? 'Select a layer' : 'Add text or an image'));
    return;
  }

  if (l.type === 'text') {
    const ta = el('textarea', { rows: 2, spellcheck: 'false', title: 'Text (Enter for a new line)' });
    ta.value = l.text;
    ta.addEventListener('input', () => {
      l.text = ta.value;
      const row = $('layerList').querySelector('.layer-row.on .lr-name');
      if (row) row.textContent = layerLabel(l);
      onLayerChange(l);
    });
    props.append(ta);

    ensureFonts();
    const fonts = state.fonts.includes(l.font) ? state.fonts : [l.font, ...state.fonts];
    const sel = el('select', { title: 'Font' });
    for (const f of fonts) {
      const o = el('option', { value: f }, GENERIC_LABELS[f] || f);
      o.style.fontFamily = fontCss(f);
      sel.append(o);
    }
    sel.value = l.font;
    sel.style.fontFamily = fontCss(l.font);
    sel.addEventListener('change', () => {
      l.font = sel.value;
      sel.style.fontFamily = fontCss(l.font);
      onLayerChange(l);
      const icon = $('layerList').querySelector('.layer-row.on .lr-icon');
      if (icon) icon.style.fontFamily = fontCss(l.font);
    });
    const fontRow = el('div', { class: 'prow' }, [sel]);
    if ('queryLocalFonts' in window && state.fonts.length <= GENERIC_FONTS.length + COMMON_FONTS.length) {
      fontRow.append(el('button', { class: 'tbtn', title: 'Load all installed fonts', html: ICONS.fonts, style: 'border:1px solid var(--line);border-radius:9px', onclick: loadAllFonts }));
    }
    props.append(fontRow);

    const alignGroup = el('span', { class: 'tgroup' }, [['left', ICONS.alignL], ['center', ICONS.alignC], ['right', ICONS.alignR]].map(([a, icon]) =>
      el('button', { class: 'tbtn' + (l.align === a ? ' on' : ''), title: 'Align ' + a, html: icon, onclick: () => { l.align = a; onLayerChange(l, true); } })));
    props.append(el('div', { class: 'prow' }, [
      el('span', { class: 'tgroup' }, [toggleBtn(l, 'bold', '<b>B</b>', 'Bold'), toggleBtn(l, 'italic', '<i style="font-family:serif">I</i>', 'Italic')]),
      alignGroup,
      el('span', { style: 'flex:1' }),
      colorInput(l, 'color', 'Text color'),
    ]));

    props.append(linkRow(l));
    props.append(slider(l, 'size', 'Size', 0.01, 0.4, 0.001));
    props.append(slider(l, 'opacity', 'Opacity', 0.05, 1, 0.01));

    props.append(el('div', { class: 'presets' }, PRESETS.map(pr =>
      el('button', { class: 'preset', title: pr.name, html: `<span style="${pr.css}">Aa</span>`, onclick: () => { Object.assign(l, pr.set); onLayerChange(l, true); } }))));
  } else {
    props.append(linkRow(l));
    props.append(slider(l, 'size', 'Size', 0.02, 1.2, 0.001));
    props.append(slider(l, 'opacity', 'Opacity', 0.05, 1, 0.01));
  }

  props.append(fxSection(l, 'outline', 'Outline', 'outlineColor', [
    slider(l, 'outlineWidth', 'Width', 0.005, 0.25, 0.001),
  ], 'Border around the edges'));
  props.append(fxSection(l, 'shadow', 'Shadow', 'shadowColor', [
    slider(l, 'shadowAlpha', 'Opacity', 0, 1, 0.01),
    slider(l, 'shadowBlur', 'Blur', 0, 1, 0.005),
    slider(l, 'shadowDist', 'Distance', 0, 0.6, 0.005),
    slider(l, 'shadowAngle', 'Angle', 0, 360, 1),
  ], 'Drop shadow. Blur 0 = hard shadow, distance 0 = glow'));
  props.append(fxSection(l, 'd3', '3D', 'd3Color', [
    slider(l, 'd3Depth', 'Depth', 0.005, 0.5, 0.001),
    slider(l, 'd3Angle', 'Angle', 0, 360, 1),
  ], 'Solid 3D extrusion'));
  if (l.type === 'text') {
    props.append(fxSection(l, 'box', 'Background', 'boxColor', [
      slider(l, 'boxAlpha', 'Opacity', 0.05, 1, 0.01),
      slider(l, 'boxPad', 'Padding', 0, 1.5, 0.01),
      slider(l, 'boxRadius', 'Radius', 0, 1, 0.01),
    ], 'Filled box behind the text'));
  }
}

/* ---------------- Collage panel & picker ---------------- */

function layoutIcon(key, n) {
  if (key === 'auto') return '<span class="auto-lbl">Auto</span>';
  const rects = COLLAGE_LAYOUTS[n][key];
  const W = 36, H = 27, g = 1.5;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${rects.map(([x, y, w, h]) =>
    `<rect x="${x * W + g / 2}" y="${y * H + g / 2}" width="${w * W - g}" height="${h * H - g}" rx="2" fill="currentColor"/>`).join('')}</svg>`;
}

function plainSlider(obj, key, label, min, max, step, onChange) {
  const input = el('input', { type: 'range', min, max, step });
  input.value = obj[key];
  input.dataset.key = key;
  input.addEventListener('input', () => { obj[key] = parseFloat(input.value); onChange(); });
  return el('label', { class: 'slider', title: label }, [el('span', {}, label), input]);
}

function renderCollagePanel() {
  const p = state.activePhoto;
  const body = $('collageBody');
  if (!p || p.kind !== 'collage') return;
  body.innerHTML = '';
  const n = p.sources.length;

  body.append(el('div', { class: 'sec-label' }, 'Layout'));
  body.append(el('div', { class: 'layout-grid' }, Object.keys(COLLAGE_LAYOUTS[n]).map(key =>
    el('button', {
      class: 'layout-btn' + (p.layout === key ? ' on' : ''), title: LAYOUT_NAMES[key], html: layoutIcon(key, n),
      onclick: () => { p.layout = key; collageChanged(true); renderCollagePanel(); },
    }))));

  const color = el('input', { type: 'color', class: 'swatch', title: 'Gap color' });
  color.value = p.gapColor;
  color.addEventListener('input', () => { p.gapColor = color.value; collageChanged(); });
  body.append(el('div', { class: 'prow' }, [
    el('div', { style: 'flex:1;display:flex;flex-direction:column;gap:6px' }, [
      plainSlider(p, 'gap', 'Gap', 0, 0.08, 0.001, () => { collageChanged(); updateCellBox(); }),
      plainSlider(p, 'radius', 'Corners', 0, 0.08, 0.001, () => collageChanged()),
    ]),
    color,
  ]));

  const i = clamp(state.cell || 0, 0, n - 1);
  const src = p.sources[i], cell = p.cells[i];
  const swap = (dir) => {
    const j = i + dir;
    if (j < 0 || j >= n) return;
    [p.sources[i], p.sources[j]] = [p.sources[j], p.sources[i]];
    [p.cells[i], p.cells[j]] = [p.cells[j], p.cells[i]];
    state.cell = j;
    collageChanged(true);
    renderCollagePanel();
  };
  body.append(el('div', { class: 'sec-label' }, `Photo ${i + 1} of ${n}`));
  body.append(el('div', { class: 'cell-row' }, [
    el('img', { src: src.thumb, alt: '', class: 'cell-thumb' }),
    el('div', { style: 'flex:1;min-width:0' }, [plainSlider(cell, 'zoom', 'Zoom', 1, 6, 0.01, () => collageChanged())]),
  ]));
  body.append(el('div', { class: 'prow' }, [
    el('button', { class: 'btn ghost sm', title: 'Swap with the previous photo', onclick: () => swap(-1), html: `${ICONS.left} Move`, ...(i === 0 ? { disabled: '' } : {}) }),
    el('button', { class: 'btn ghost sm', title: 'Swap with the next photo', onclick: () => swap(1), html: `Move ${ICONS.right}`, ...(i === n - 1 ? { disabled: '' } : {}) }),
  ]));
  body.append(el('p', { class: 'muted hint' }, 'Drag a photo to reposition it, scroll to zoom.'));
}

const pickState = [];
function renderPicker() {
  const grid = $('pickGrid');
  grid.innerHTML = '';
  for (const p of state.photos.filter(x => !x.loading && x.kind !== 'collage')) {
    const idx = pickState.indexOf(p);
    const b = el('button', { type: 'button', class: 'pick' + (idx >= 0 ? ' on' : ''), title: p.name }, [
      el('img', { src: p.thumb, alt: '' }),
      el('span', { class: 'num' }, idx >= 0 ? String(idx + 1) : ''),
    ]);
    b.addEventListener('click', () => {
      const k = pickState.indexOf(p);
      if (k >= 0) pickState.splice(k, 1);
      else if (pickState.length >= 4) { toast('Up to 4 photos'); return; }
      else pickState.push(p);
      renderPicker();
    });
    grid.append(b);
  }
  $('collageCreate').disabled = pickState.length < 2;
}

$('collageBtn').addEventListener('click', () => {
  const photos = state.photos.filter(x => !x.loading && x.kind !== 'collage');
  if (photos.length < 2) { toast('Add at least 2 photos'); return; }
  pickState.length = 0;
  // Preselect the current photo and the ones after it, up to 3 total.
  const start = Math.max(0, photos.indexOf(state.activePhoto));
  pickState.push(...photos.slice(start, start + 3));
  if (pickState.length < 2) pickState.unshift(...photos.slice(Math.max(0, start - (2 - pickState.length)), start));
  renderPicker();
  $('collageDialog').showModal();
});
$('collageCreate').addEventListener('click', () => {
  if (pickState.length < 2) return;
  $('collageDialog').close();
  if (state.mode !== 'crop') setMode('crop');
  createCollage([...pickState]);
});
$('collageDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ---------------- Export ---------------- */

function renderOutput(p, t) {
  if (p.kind === 'collage') {
    const { w, h } = fullSize(t);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    drawCollage(ctx, p, w, h, true);
    drawLayers(ctx, p.layers, w, h, t.id);
    return new Promise((resolve, reject) =>
      out.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), 'image/jpeg', JPEG_QUALITY));
  }
  const img = p.img, rect = cropFor(p, t);
  const { w, h } = outputSize(rect, t);
  let src = img, sx = rect.x, sy = rect.y, sw = rect.width, sh = rect.height;

  // Step down by halves for large reductions: noticeably sharper than a single pass.
  while (sw / 2 > w * 1.05 && sh / 2 > h * 1.05) {
    const c = document.createElement('canvas');
    c.width = Math.round(sw / 2);
    c.height = Math.round(sh / 2);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    src = c; sx = 0; sy = 0; sw = c.width; sh = c.height;
  }

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  drawLayers(ctx, p.layers, w, h, t.id);
  return new Promise((resolve, reject) =>
    out.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), 'image/jpeg', JPEG_QUALITY));
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'photo';
}

$('doneBtn').addEventListener('click', async () => {
  const photos = state.photos.filter(p => !p.loading);
  const targets = enabledTargets();
  if (!photos.length) return;
  const total = photos.length * targets.length;
  const zip = new JSZip();
  const pad = Math.max(2, String(photos.length).length);
  let done = 0;
  busy(`Rendering 0 / ${total}`);
  try {
    for (const [i, p] of photos.entries()) {
      const base = `${String(i + 1).padStart(pad, '0')}-${baseName(p.name)}`;
      for (const t of targets) {
        const blob = await renderOutput(p, t);
        zip.file(`${t.folder}/${base}_${t.suffix}.jpg`, blob);
        busy(`Rendering ${++done} / ${total}`);
      }
    }
    busy('Zipping…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `model-photos-${stamp}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`${total} images saved`);
  } catch (e) {
    console.error(e);
    toast('Something went wrong while exporting');
  } finally {
    busy(null);
  }
});

/* ---------------- File inputs & drag-drop ---------------- */

for (const id of ['fileInput', 'fileInput2']) {
  $(id).addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('dropzone').classList.add('over');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropzone').classList.remove('over');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').classList.remove('over');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* ---------------- Tooltips ---------------- */
/*
 * Native title tooltips are slow and easy to miss, so any element with a
 * title gets a quick custom one instead (the title moves to data-tip to
 * avoid showing both).
 */
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.appendChild(tip);
let tipTimer, tipEl = null;

function hideTip() {
  clearTimeout(tipTimer);
  tip.hidden = true;
  tipEl = null;
}

document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const t = e.target.closest?.('[title], [data-tip]');
  if (t === tipEl) return;
  hideTip();
  if (!t || t.tagName === 'HTML') return;
  if (t.hasAttribute('title')) {
    t.dataset.tip = t.getAttribute('title');
    if (!t.hasAttribute('aria-label')) t.setAttribute('aria-label', t.dataset.tip);
    t.removeAttribute('title');
  }
  if (!t.dataset.tip) return;
  tipEl = t;
  tipTimer = setTimeout(() => {
    if (!t.isConnected) return;
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const r = t.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = clamp(r.left + r.width / 2 - tw / 2, 8, innerWidth - tw - 8);
    let y = r.top - th - 8;
    if (y < 8) y = r.bottom + 8;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }, 250);
});
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('scroll', hideTip, true);

renderTargets();
