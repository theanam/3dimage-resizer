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
  const s = Math.min(1, PREVIEW_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { canvas: c, scale: s };
}

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
    const b = document.createElement('button');
    b.className = 'thumb-btn' + (p === state.activePhoto ? ' active' : '');
    b.title = p.name;
    if (p.loading) {
      b.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      b.disabled = true;
    } else {
      const img = document.createElement('img');
      img.src = p.thumb;
      img.alt = p.name;
      b.appendChild(img);
      b.addEventListener('click', () => selectPhoto(p));
    }
    list.appendChild(b);
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
    b.addEventListener('click', () => selectTarget(t.id));
    wrap.appendChild(b);
    if (p && !p.loading) drawTabPreview(p, t, c);
  }
}

function drawTabPreview(p, t, canvas) {
  canvas = canvas || $('variantTabs').querySelector(`[data-id="${t.id}"] canvas`);
  if (!canvas) return;
  const r = cropFor(p, t);
  const s = p.preview.scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(p.preview.canvas, r.x * s, r.y * s, r.width * s, r.height * s, 0, 0, canvas.width, canvas.height);
  drawLayers(ctx, p.layers, canvas.width, canvas.height);
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

function selectPhoto(photo) {
  state.activePhoto = photo;
  state.sel = null;
  if (!state.activeTarget || !state.enabled.has(state.activeTarget)) state.activeTarget = enabledTargets()[0].id;
  renderPhotos();
  renderTabs();
  if (state.mode === 'crop') mountCropper();
  else { layoutFrame(); renderPanel(); }
  updateMeta();
}

function selectTarget(id) {
  state.activeTarget = id;
  $('variantTabs').querySelectorAll('.vtab').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  const p = state.activePhoto;
  if (!p) return;
  const t = byId(id);
  if (state.mode === 'overlay') {
    layoutFrame();
  } else if (cropper) {
    suppressCrop = true;
    cropper.setAspectRatio(t.rw / t.rh);
    cropper.setData(cropFor(p, t));
    suppressCrop = false;
    updateCropColor();
  }
  updateMeta();
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  $('modeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  const overlay = mode === 'overlay';
  $('stage').hidden = overlay;
  $('overlayStage').hidden = !overlay;
  $('panel').hidden = !overlay;
  $('resetBtn').hidden = overlay;
  if (overlay) {
    if (cropper) { cropper.destroy(); cropper = null; }
    ensureFonts();
    layoutFrame();
    renderPanel();
  } else {
    state.sel = null;
    mountCropper();
  }
}
$('modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

/* ---------------- Cropping ---------------- */

function mountCropper() {
  const photo = state.activePhoto;
  if (cropper) { cropper.destroy(); cropper = null; }
  if (!photo || photo.loading) return;
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
      updateCropColor();
      updateMeta();
    },
    crop: onCrop,
  });
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
  const o = outputSize(cropFor(p, t), t);
  $('meta').textContent = `${p.w}×${p.h} → ${o.w}×${o.h} JPG`;
}

$('resetBtn').addEventListener('click', () => {
  const p = state.activePhoto, t = byId(state.activeTarget);
  if (!p || !t || !cropper) return;
  cropper.setData(autoCrop(p, t));
});

$('removeBtn').addEventListener('click', () => {
  const p = state.activePhoto;
  if (!p) return;
  const idx = state.photos.indexOf(p);
  state.photos.splice(idx, 1);
  if (p.url) URL.revokeObjectURL(p.url);
  const ready = state.photos.filter(x => !x.loading);
  const next = ready[Math.min(idx, ready.length - 1)];
  state.activePhoto = null;
  if (next) selectPhoto(next);
  else if (!state.photos.length) showDrop();
  renderPhotos();
  renderSummary();
});

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

function textGeom(ctx, l, W, H) {
  const fs = Math.max(1, l.size * W);
  const font = `${l.italic ? 'italic ' : ''}${l.bold ? 700 : 400} ${fs}px ${fontCss(l.font)}`;
  ctx.font = font;
  const lines = (l.text || ' ').split('\n');
  const widths = lines.map(s => ctx.measureText(s).width);
  const maxW = Math.max(fs * 0.3, ...widths);
  const m = ctx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent ?? fs * 0.8;
  const desc = m.fontBoundingBoxDescent ?? fs * 0.2;
  const lh = fs * 1.2;
  const cx = l.x * W, cy = l.y * H;
  const h = lines.length * lh;
  const top = cy - h / 2;
  return { fs, font, lines, maxW, lh, asc, desc, cx, cy, top, unit: fs, box: { x: cx - maxW / 2, y: top, w: maxW, h } };
}

function imageGeom(l, W, H) {
  const w = Math.max(1, l.size * W);
  const h = w * l.aspect;
  return { w, h, x: l.x * W - w / 2, y: l.y * H - h / 2, unit: w / 5, box: { x: l.x * W - w / 2, y: l.y * H - h / 2, w, h } };
}

function layerGeom(ctx, l, W, H) {
  return l.type === 'text' ? textGeom(ctx, l, W, H) : imageGeom(l, W, H);
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

function drawLayer(ctx, l, W, H) {
  const g = layerGeom(ctx, l, W, H);
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

function drawLayers(ctx, layers, W, H) {
  for (const l of layers) {
    if (l.type === 'image' && !l.img) continue;
    drawLayer(ctx, l, W, H);
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
  { name: 'Plain', css: 'color:#fff', set: { outline: false, shadow: false, d3: false, box: false } },
  { name: 'Outline', css: 'color:#fff;-webkit-text-stroke:3px #000;paint-order:stroke fill',
    set: { color: '#ffffff', outline: true, outlineColor: '#000000', outlineWidth: 0.08, shadow: false, d3: false, box: false } },
  { name: 'Shadow', css: 'color:#fff;text-shadow:0 2px 5px rgba(0,0,0,.7)',
    set: { outline: false, shadow: true, shadowColor: '#000000', shadowAlpha: 0.6, shadowBlur: 0.18, shadowDist: 0.06, shadowAngle: 90, d3: false, box: false } },
  { name: '3D', css: 'color:#fff;text-shadow:1px 1px 0 #00ae42,2px 2px 0 #00ae42,3px 3px 0 #00ae42,4px 4px 0 #00ae42',
    set: { color: '#ffffff', outline: false, d3: true, d3Color: '#00ae42', d3Depth: 0.09, d3Angle: 45, shadow: true, shadowColor: '#000000', shadowAlpha: 0.35, shadowBlur: 0.2, shadowDist: 0.08, shadowAngle: 60, box: false } },
  { name: 'Neon', css: 'color:#fff;text-shadow:0 0 4px #ff3df0,0 0 10px #ff3df0',
    set: { color: '#ffffff', outline: true, outlineColor: '#ff3df0', outlineWidth: 0.025, shadow: true, shadowColor: '#ff3df0', shadowAlpha: 1, shadowBlur: 0.45, shadowDist: 0, d3: false, box: false } },
  { name: 'Box', css: 'color:#fff;background:#000;border-radius:5px;padding:2px 6px;font-size:13px',
    set: { outline: false, shadow: false, d3: false, box: true, boxColor: '#000000', boxAlpha: 0.65 } },
];

const TEXT_STYLE_KEYS = ['font', 'color', 'bold', 'italic', 'align', ...Object.keys(EFFECT_DEFAULTS)];

function newTextLayer() {
  const saved = store.get('textStyle', {});
  const l = {
    id: ++seq, type: 'text', text: 'Your text', x: 0.5, y: 0.82, size: 0.09, opacity: 1,
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
  return { ...l, id: ++seq };
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
      x: 0.8, y: 0.8, size: 0.25, opacity: 1, ...EFFECT_DEFAULTS,
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

  bgCanvas = document.createElement('canvas');
  bgCanvas.width = W;
  bgCanvas.height = H;
  const bx = bgCanvas.getContext('2d');
  bx.imageSmoothingQuality = 'high';
  const r = cropFor(p, t);
  bx.drawImage(p.img, r.x, r.y, r.width, r.height, 0, 0, W, H);
  redraw();
}

new ResizeObserver(() => { if (state.mode === 'overlay') layoutFrame(); }).observe($('overlayStage'));

let redrawPending = false;
function scheduleRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => { redrawPending = false; redraw(); });
  scheduleTabPreviews();
}

function redraw() {
  const p = state.activePhoto;
  if (!p || !bgCanvas || state.mode !== 'overlay') return;
  const ctx = frameCanvas.getContext('2d');
  const W = frameCanvas.width, H = frameCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bgCanvas, 0, 0);
  drawLayers(ctx, p.layers, W, H);
  updateSelBox();
}

function updateSelBox() {
  const box = $('selBox');
  const l = state.sel;
  if (!l || !state.activePhoto.layers.includes(l)) { box.hidden = true; return; }
  const ctx = frameCanvas.getContext('2d');
  const W = frameCanvas.width, H = frameCanvas.height;
  const b = layerGeom(ctx, l, W, H).box;
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
    const b = layerGeom(ctx, l, W, H).box;
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

  if (e.target === $('selHandle') && state.sel) {
    const l = state.sel;
    const cx = l.x * rect.width, cy = l.y * rect.height;
    drag = { type: 'resize', l, cx, cy, d0: Math.hypot(px - cx, py - cy) || 1, s0: l.size };
  } else {
    const l = hitTest(px, py);
    if (l !== state.sel) { state.sel = l; renderPanel(); }
    if (!l) { redraw(); return; }
    drag = { type: 'move', l, px, py, x0: l.x, y0: l.y, w: rect.width, h: rect.height };
    redraw();
  }
  frame.setPointerCapture(e.pointerId);
  e.preventDefault();
});

frame.addEventListener('pointermove', (e) => {
  const rect = frame.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
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
    l.x = x; l.y = y;
  } else {
    const d = Math.hypot(px - drag.cx, py - drag.cy);
    l.size = clamp(drag.s0 * d / drag.d0, 0.01, 1.5);
    syncSizeSlider();
  }
  scheduleRedraw();
});

function endDrag() {
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
    l.x = clamp(l.x + moves[e.key][0], 0, 1);
    l.y = clamp(l.y + moves[e.key][1], 0, 1);
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
  renderProps();
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
  input.value = l[key];
  input.dataset.key = key;
  input.addEventListener('input', () => { l[key] = parseFloat(input.value); onLayerChange(l); });
  return el('label', { class: 'slider' }, [el('span', {}, label), input]);
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

function fxSection(l, key, label, colorKey, sliders) {
  const sw = el('label', { class: 'switch' }, [
    el('input', { type: 'checkbox', onchange: (e) => { l[key] = e.target.checked; onLayerChange(l, true); } }),
    el('span', { class: 'track', html: '<span class="thumb"></span>' }),
  ]);
  sw.querySelector('input').checked = !!l[key];
  return el('div', { class: 'fx' + (l[key] ? ' on' : '') }, [
    el('div', { class: 'fx-head' }, [el('span', { class: 'grow' }, label), colorInput(l, colorKey, label + ' color'), sw]),
    el('div', { class: 'fx-body' }, sliders),
  ]);
}

function syncSizeSlider() {
  const s = $('props').querySelector('input[data-key="size"]');
  if (s && state.sel) s.value = state.sel.size;
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
    const ta = el('textarea', { rows: 2, spellcheck: 'false' });
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

    props.append(slider(l, 'size', 'Size', 0.01, 0.4, 0.001));
    props.append(slider(l, 'opacity', 'Opacity', 0.05, 1, 0.01));

    props.append(el('div', { class: 'presets' }, PRESETS.map(pr =>
      el('button', { class: 'preset', title: pr.name, html: `<span style="${pr.css}">Aa</span>`, onclick: () => { Object.assign(l, pr.set); onLayerChange(l, true); } }))));
  } else {
    props.append(slider(l, 'size', 'Size', 0.02, 1.2, 0.001));
    props.append(slider(l, 'opacity', 'Opacity', 0.05, 1, 0.01));
  }

  props.append(fxSection(l, 'outline', 'Outline', 'outlineColor', [
    slider(l, 'outlineWidth', 'Width', 0.005, 0.25, 0.001),
  ]));
  props.append(fxSection(l, 'shadow', 'Shadow', 'shadowColor', [
    slider(l, 'shadowAlpha', 'Opacity', 0, 1, 0.01),
    slider(l, 'shadowBlur', 'Blur', 0, 1, 0.005),
    slider(l, 'shadowDist', 'Distance', 0, 0.6, 0.005),
    slider(l, 'shadowAngle', 'Angle', 0, 360, 1),
  ]));
  props.append(fxSection(l, 'd3', '3D', 'd3Color', [
    slider(l, 'd3Depth', 'Depth', 0.005, 0.5, 0.001),
    slider(l, 'd3Angle', 'Angle', 0, 360, 1),
  ]));
  if (l.type === 'text') {
    props.append(fxSection(l, 'box', 'Background', 'boxColor', [
      slider(l, 'boxAlpha', 'Opacity', 0.05, 1, 0.01),
      slider(l, 'boxPad', 'Padding', 0, 1.5, 0.01),
      slider(l, 'boxRadius', 'Radius', 0, 1, 0.01),
    ]));
  }
}

/* ---------------- Export ---------------- */

function renderOutput(p, t) {
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
  drawLayers(ctx, p.layers, w, h);
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

renderTargets();
