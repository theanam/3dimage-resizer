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
};

let cropper = null;
let suppressCrop = false;
let seq = 0;

const byId = (id) => TARGETS.find(t => t.id === id);
const enabledTargets = () => TARGETS.filter(t => state.enabled.has(t.id));
const sameRatio = (a, b) => a.rw * b.rh === a.rh * b.rw;

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
    const photo = { id: ++seq, name: file.name, file, loading: true, crops: {} };
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
}

/* ---------------- Selection & cropping ---------------- */

function selectPhoto(photo) {
  state.activePhoto = photo;
  if (!state.activeTarget || !state.enabled.has(state.activeTarget)) state.activeTarget = enabledTargets()[0].id;
  renderPhotos();
  renderTabs();

  if (cropper) { cropper.destroy(); cropper = null; }
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

function selectTarget(id) {
  state.activeTarget = id;
  $('variantTabs').querySelectorAll('.vtab').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  const p = state.activePhoto;
  if (!cropper || !p) return;
  const t = byId(id);
  suppressCrop = true;
  cropper.setAspectRatio(t.rw / t.rh);
  cropper.setData(cropFor(p, t));
  suppressCrop = false;
  updateCropColor();
  updateMeta();
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
  const next = state.photos.filter(x => !x.loading)[Math.min(idx, state.photos.length - 1)] || state.photos.find(x => !x.loading);
  state.activePhoto = null;
  if (next) selectPhoto(next);
  else if (!state.photos.length) showDrop();
  renderPhotos();
  renderSummary();
});

/* ---------------- Export ---------------- */

function renderOutput(img, rect, t) {
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
  const pad = String(photos.length).length < 2 ? 2 : String(photos.length).length;
  let done = 0;
  busy(`Rendering 0 / ${total}`);
  try {
    for (const [i, p] of photos.entries()) {
      const base = `${String(i + 1).padStart(pad, '0')}-${baseName(p.name)}`;
      for (const t of targets) {
        const blob = await renderOutput(p.img, cropFor(p, t), t);
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
