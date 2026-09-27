/* PDF Workbench — a client-side PDF viewer, page manager, annotator and signer.
   Rendering: pdf.js · Editing/export: pdf-lib · Files never leave the browser.

   Coordinate model: every annotation is stored in the PDF user space of its source
   page (points, y-up, unrotated). The viewer maps user space to pixels through the
   pdf.js viewport transform, and pdf-lib draws in user space directly, so the same
   numbers drive the screen and the exported file. */
'use strict';
(async function main() {
  const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  const THUMB_W = 132;
  const MAX_HISTORY = 60;

  // ---------- Small utilities ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mod = (n, m) => ((n % m) + m) % m;
  const rad = (d) => (d * Math.PI) / 180;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => (b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const readAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Image could not be decoded')); i.src = src; });
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  const toastsEl = $('#toasts');
  function toast(msg, { error = false, action = null, ms = 3800 } = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (error ? ' error' : '');
    el.append(document.createTextNode(msg));
    if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.onclick = () => { el.remove(); action.fn(); }; el.append(b); }
    toastsEl.append(el);
    setTimeout(() => el.remove(), ms);
    return el;
  }
  function fatal(msg) { toast(msg, { error: true, ms: 120000 }); $('#status-doc').textContent = msg; }
  const busyBar = $('#busy-bar'); let busyCount = 0;
  function busy(on) { busyCount = Math.max(0, busyCount + (on ? 1 : -1)); busyBar.classList.toggle('show', busyCount > 0); }
  function setHint(t) { $('#status-hint').textContent = t || ''; }

  // ---------- Libraries ----------
  let pdfjsLib;
  try {
    pdfjsLib = await import(PDFJS_URL);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  } catch (e) {
    console.error(e);
    fatal('The PDF renderer (pdf.js) could not be loaded. Check your connection and reload.');
    return;
  }
  const PDFLib = window.PDFLib;
  if (!PDFLib) { fatal('pdf-lib could not be loaded. Check your connection and reload.'); return; }
  const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, PDFName } = PDFLib;

  // Published-page runtime: file saves go through the viewer's downloads capability when present.
  const capDownloads = (window.claude && typeof window.claude.use === 'function')
    ? window.claude.use('downloads').catch(() => null)
    : Promise.resolve(null);

  // ---------- State ----------
  const state = {
    sources: new Map(),          // id → { id, name, bytes, pdf, pages[], pageCount, lib, libError, hasForm, metadata, size, textCache }
    pages: [],                   // [{ uid, srcId, srcPage, rotation, annots[] }]
    assets: new Map(),           // id → { id, dataUrl, img, w, h }
    selection: new Set(),        // page uids selected in the grid
    anchorUid: null,
    current: 0,
    zoom: 1,
    zoomMode: 'fit-width',
    tool: 'select',
    selected: null,              // { uid, id } selected annotation
    pending: null,               // { assetId, kind } waiting to be placed
    props: {
      textColor: '#111111', font: 'Helvetica', fontSize: 14,
      inkColor: '#1A237E', inkWidth: 2, inkOpacity: 1,
      highlight: '#FFE234', highlightOpacity: 0.45,
      color: '#D93025', strokeWidth: 2, fill: '#FFD7D4', fillOn: false, opacity: 1, arrowWidth: 2,
    },
    watermark: { enabled: false, text: 'CONFIDENTIAL', size: 64, opacity: 0.15, angle: 45, color: '#B3261E' },
    pageNumbers: { enabled: false, format: '{n} / {total}', position: 'bottom-center', size: 10, margin: 28, start: 1 },
    metadata: { title: '', author: '', subject: '', keywords: '' },
    history: [], future: [], editSnap: null, dirty: false,
    search: { query: '', results: [], index: -1 },
  };

  // ---------- Sources (loaded files) ----------
  async function loadSource(bytes, name) {
    const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true });
    task.onPassword = (update, reason) => {
      const msg = reason === 2 ? `Incorrect password for “${name}”. Try again:` : `“${name}” is password protected. Enter the password:`;
      const pw = window.prompt(msg);
      if (pw === null || pw === '') update(new Error('Password entry cancelled'));
      else update(pw);
    };
    const pdf = await task.promise;
    const pageCount = pdf.numPages;
    const pages = await Promise.all(Array.from({ length: pageCount }, (_, i) => pdf.getPage(i + 1)));
    let lib = null, libError = null;
    try { lib = await PDFDocument.load(bytes, { updateMetadata: false }); } catch (e) { libError = e; }
    let fields = [];
    if (lib) { try { fields = lib.getForm().getFields(); } catch { fields = []; } }
    let metadata = {};
    try { metadata = (await pdf.getMetadata()).info || {}; } catch { /* no metadata */ }
    const src = { id: uid(), name, bytes, pdf, pages, pageCount, lib, libError, hasForm: fields.length > 0, metadata, size: bytes.byteLength, textCache: new Map() };
    state.sources.set(src.id, src);
    return src;
  }

  async function convertToPng(dataUrl) {
    const img = await loadImage(dataUrl);
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  }

  async function imageToPdfBytes(file) {
    const dataUrl = await readAsDataURL(file);
    const doc = await PDFDocument.create();
    let img;
    if (/png$/i.test(file.type)) img = await doc.embedPng(dataUrl);
    else if (/jpe?g$/i.test(file.type)) img = await doc.embedJpg(dataUrl);
    else img = await doc.embedPng(await convertToPng(dataUrl));
    let { width, height } = img;
    const s = Math.min(1, 842 / Math.max(width, height));
    width *= s; height *= s;
    const page = doc.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
    return doc.save();
  }

  const makePage = (srcId, srcPage) => ({ uid: uid(), srcId, srcPage, rotation: 0, annots: [] });

  // Opens files. mode: 'replace' (new document), 'append', or a numeric insert index.
  async function openFiles(fileList, mode = 'append') {
    const files = Array.from(fileList || []).filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name) || /^image\/(png|jpeg|webp)$/.test(f.type));
    if (!files.length) { toast('No PDF or image files found in the selection.', { error: true }); return; }
    busy(true);
    const added = [];
    const failures = [];
    try {
      for (const f of files) {
        try {
          const isImage = /^image\//.test(f.type);
          const bytes = isImage ? await imageToPdfBytes(f) : new Uint8Array(await f.arrayBuffer());
          const src = await loadSource(bytes, f.name);
          added.push(src);
        } catch (e) {
          console.warn('open failed', f.name, e);
          failures.push(f.name + (e && e.message ? ` (${e.message})` : ''));
        }
      }
    } finally { busy(false); }
    if (added.length) {
      commit();
      let at = mode === 'append' ? state.pages.length : mode === 'replace' ? 0 : mode;
      if (mode === 'replace') { state.pages = []; state.selection.clear(); state.selected = null; }
      for (const src of added) {
        const ps = Array.from({ length: src.pageCount }, (_, i) => makePage(src.id, i));
        state.pages.splice(at, 0, ...ps); at += ps.length;
      }
      if (mode === 'replace') {
        const md = added[0].metadata || {};
        state.metadata = { title: md.Title || '', author: md.Author || '', subject: md.Subject || '', keywords: md.Keywords || '' };
        syncDocPanel();
        state.current = 0;
      }
      if (mode === 'replace') expandedFiles.clear();
      rebuild();
      showTab('rail-left', 'files');
      if (mode === 'replace') { viewer.scrollTop = 0; state.dirty = false; }
      const n = added.reduce((s, x) => s + x.pageCount, 0);
      toast(`${mode === 'replace' ? 'Opened' : 'Added'} ${added.length} file${added.length > 1 ? 's' : ''} · ${n} page${n !== 1 ? 's' : ''}`);
      const raster = added.filter((s) => s.libError);
      if (raster.length) toast(`${raster.map((s) => s.name).join(', ')}: this file could not be parsed for editing (encrypted or damaged). Its pages will be exported as images.`, { ms: 8000 });
    }
    if (failures.length) toast('Could not open: ' + failures.join(', '), { error: true, ms: 8000 });
  }

  // ---------- History (undo / redo) ----------
  function snapshot() {
    return { pages: structuredClone(state.pages), watermark: { ...state.watermark }, pageNumbers: { ...state.pageNumbers }, metadata: { ...state.metadata } };
  }
  function pushHistory(snap) {
    state.history.push(snap);
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.future.length = 0;
    state.dirty = true;
    updateUndoUI();
  }
  // Call commit() BEFORE a discrete mutation.
  function commit() { pushHistory(snapshot()); }
  // For continuous edits (drags, sliders): beginEdit() before the first change, endEdit() when done.
  function beginEdit() { if (!state.editSnap) state.editSnap = snapshot(); }
  function endEdit() { if (state.editSnap) { const s = state.editSnap; state.editSnap = null; pushHistory(s); } }
  function cancelEdit() { state.editSnap = null; }
  function restore(snap) {
    commitTextEditor();
    state.pages = structuredClone(snap.pages);
    Object.assign(state.watermark, snap.watermark);
    Object.assign(state.pageNumbers, snap.pageNumbers);
    Object.assign(state.metadata, snap.metadata);
    const uids = new Set(state.pages.map((p) => p.uid));
    state.selection = new Set([...state.selection].filter((u) => uids.has(u)));
    if (state.selected && !(pageByUid(state.selected.uid) || {}).annots?.some((a) => a.id === state.selected.id)) state.selected = null;
    state.current = clamp(state.current, 0, Math.max(0, state.pages.length - 1));
    syncDocPanel();
    rebuild();
    refreshProps();
  }
  function undo() { if (!state.history.length) return; state.future.push(snapshot()); restore(state.history.pop()); updateUndoUI(); }
  function redo() { if (!state.future.length) return; state.history.push(snapshot()); restore(state.future.pop()); updateUndoUI(); }
  function updateUndoUI() { $('#btn-undo').disabled = !state.history.length; $('#btn-redo').disabled = !state.future.length; }

  // ---------- Page model helpers ----------
  const pageByUid = (u) => state.pages.find((p) => p.uid === u);
  const indexOfUid = (u) => state.pages.findIndex((p) => p.uid === u);
  const srcOf = (p) => state.sources.get(p.srcId);
  const pdfPageOf = (p) => srcOf(p).pages[p.srcPage];
  const totalRot = (p) => mod((pdfPageOf(p).rotate || 0) + p.rotation, 360);
  const pageKey = (p) => `${p.srcId}:${p.srcPage}:${p.rotation}`;
  const vpFor = (p, scale) => pdfPageOf(p).getViewport({ scale, rotation: totalRot(p) });
  const currentPage = () => state.pages[clamp(state.current, 0, state.pages.length - 1)] || null;
  const orderedSelection = () => state.pages.filter((p) => state.selection.has(p.uid)).map((p) => p.uid);
  const targetUids = () => { const sel = orderedSelection(); if (sel.length) return sel; const c = currentPage(); return c ? [c.uid] : []; };
  function getSelectedAnnot() { if (!state.selected) return null; const p = pageByUid(state.selected.uid); return p ? p.annots.find((a) => a.id === state.selected.id) || null : null; }

  const PAPER = [['Letter', 612, 792], ['Legal', 612, 1008], ['Tabloid', 792, 1224], ['A3', 842, 1191], ['A4', 595, 842], ['A5', 420, 595], ['B5', 499, 709], ['Executive', 522, 756]];
  function paperName(w, h) {
    for (const [n, pw, ph] of PAPER) {
      if (Math.abs(w - pw) < 3 && Math.abs(h - ph) < 3) return n;
      if (Math.abs(h - pw) < 3 && Math.abs(w - ph) < 3) return n + ' landscape';
    }
    return 'Custom';
  }
  const ptToMm = (v) => Math.round(v * 0.352778);

  // =====================================================================
  //  Viewer
  // =====================================================================
  const viewer = $('#viewer'), viewerInner = $('#viewer-inner');
  const pageEls = new Map(); // uid → element
  const measureCtx = document.createElement('canvas').getContext('2d');
  const accentColor = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0E7C86';

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
  const MAX_CANVAS_PX = isMobile ? 5e6 : 14e6;
  function outputScale(vp) {
    const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 2 : 3);
    const px = vp.width * vp.height * dpr * dpr;
    return px > MAX_CANVAS_PX ? Math.sqrt(MAX_CANVAS_PX / (vp.width * vp.height)) : dpr;
  }

  function computeZoom() {
    if (typeof state.zoomMode === 'number') return state.zoomMode;
    if (!state.pages.length) return 1;
    const availW = Math.max(120, viewer.clientWidth - 34);
    const availH = Math.max(120, viewer.clientHeight - 46);
    if (state.zoomMode === 'fit-page') {
      const v = vpFor(currentPage(), 1);
      return clamp(Math.min(availW / v.width, availH / v.height), 0.1, 8);
    }
    let maxW = 0;
    for (const p of state.pages) maxW = Math.max(maxW, vpFor(p, 1).width);
    return clamp(availW / maxW, 0.1, 8);
  }

  function layout() {
    const prevZoom = state.zoom;
    const cur = currentPage();
    const curEl = cur && pageEls.get(cur.uid);
    const offsetInPage = curEl ? viewer.scrollTop - curEl.offsetTop : 0;
    state.zoom = computeZoom();
    const z = state.zoom;
    for (const p of state.pages) {
      const el = pageEls.get(p.uid); if (!el) continue;
      const vp = vpFor(p, z);
      el.style.width = vp.width + 'px'; el.style.height = vp.height + 'px';
      el.style.setProperty('--scale-factor', String(z));
      if (el._st.scale !== z) el._st.rendered = false;
    }
    if (curEl && prevZoom !== z) viewer.scrollTop = curEl.offsetTop + offsetInPage * (z / prevZoom);
    updateZoomUI();
    renderVisible();
  }
  function setZoom(mode) { state.zoomMode = mode; layout(); }
  function zoomBy(f) { setZoom(clamp(state.zoom * f, 0.1, 8)); }
  function updateZoomUI() {
    const sel = $('#zoom-select');
    let custom = sel.querySelector('option[data-custom]');
    if (typeof state.zoomMode === 'number') {
      const pct = Math.round(state.zoomMode * 100) + '%';
      const match = [...sel.options].find((o) => !o.dataset.custom && Math.abs(parseFloat(o.value) - state.zoomMode) < 0.001);
      if (match) { sel.value = match.value; if (custom) custom.remove(); }
      else { if (!custom) { custom = document.createElement('option'); custom.dataset.custom = '1'; sel.append(custom); } custom.value = String(state.zoomMode); custom.textContent = pct; sel.value = custom.value; }
    } else { sel.value = state.zoomMode; if (custom) custom.remove(); }
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      e.target._st.visible = e.isIntersecting;
      if (e.isIntersecting) renderPage(e.target); else releasePage(e.target);
    }
  }, { root: viewer, rootMargin: '500px 0px' });

  function createPageEl(p) {
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.uid = p.uid; el.dataset.key = pageKey(p);
    el.innerHTML = '<canvas class="pg-canvas"></canvas><div class="textLayer"></div><canvas class="pg-hl"></canvas><canvas class="pg-overlay"></canvas><div class="pg-label"></div>';
    el._st = { rendered: false, task: null, scale: 0, visible: false, textLayer: null };
    bindOverlay(el);
    io.observe(el);
    return el;
  }
  function destroyPageEl(el) {
    io.unobserve(el);
    if (el._st.task) { try { el._st.task.cancel(); } catch { /* ignore */ } }
    if (el._st.textLayer) { try { el._st.textLayer.cancel(); } catch { /* ignore */ } }
    el.remove();
  }
  function releasePage(el) {
    const st = el._st;
    if (st.task) { try { st.task.cancel(); } catch { /* ignore */ } st.task = null; }
    if (st.textLayer) { try { st.textLayer.cancel(); } catch { /* ignore */ } st.textLayer = null; }
    const c = el.querySelector('.pg-canvas'); c.width = 0; c.height = 0;
    el.querySelector('.textLayer').replaceChildren();
    st.rendered = false;
  }

  function rebuild() {
    commitTextEditor();
    const keep = new Set();
    const frag = document.createDocumentFragment();
    state.pages.forEach((p, i) => {
      let el = pageEls.get(p.uid);
      if (!el || el.dataset.key !== pageKey(p)) { if (el) destroyPageEl(el); el = createPageEl(p); pageEls.set(p.uid, el); }
      el.dataset.index = i;
      el.querySelector('.pg-label').textContent = i + 1;
      keep.add(p.uid);
      frag.appendChild(el);
    });
    for (const [u, el] of pageEls) if (!keep.has(u)) { destroyPageEl(el); pageEls.delete(u); }
    viewerInner.replaceChildren(frag);
    $('#empty-desk').hidden = state.pages.length > 0;
    state.current = clamp(state.current, 0, Math.max(0, state.pages.length - 1));
    layout();
    for (const el of pageEls.values()) if (el._st.visible) drawOverlay(el);
    refreshFiles();
    rebuildThumbs();
    refreshForms();
    updatePageUI();
    updateCounts();
  }

  function renderVisible() { for (const el of pageEls.values()) if (el._st.visible) renderPage(el); }

  async function renderPage(el) {
    const p = pageByUid(el.dataset.uid); if (!p) return;
    const st = el._st; const z = state.zoom;
    if (st.rendered && st.scale === z) { drawOverlay(el); return; }
    if (st.task) { try { st.task.cancel(); } catch { /* ignore */ } st.task = null; }
    const pg = pdfPageOf(p);
    const vp = pg.getViewport({ scale: z, rotation: totalRot(p) });
    const dpr = outputScale(vp);
    const canvas = el.querySelector('.pg-canvas');
    canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    el.classList.add('busy');
    const task = pg.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null, annotationMode: pdfjsLib.AnnotationMode.ENABLE });
    st.task = task; st.scale = z;
    drawOverlay(el);
    try { await task.promise; st.rendered = true; }
    catch (e) { if (!(e && e.name === 'RenderingCancelledException')) console.warn('render failed', e); return; }
    finally { if (st.task === task) { st.task = null; el.classList.remove('busy'); } }
    renderTextLayer(el, pg, vp);
  }

  function renderTextLayer(el, pg, vp) {
    const div = el.querySelector('.textLayer');
    if (el._st.textLayer) { try { el._st.textLayer.cancel(); } catch { /* ignore */ } }
    div.replaceChildren();
    try {
      const tl = new pdfjsLib.TextLayer({ textContentSource: pg.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: div, viewport: vp });
      el._st.textLayer = tl;
      tl.render().catch(() => { /* cancelled */ });
    } catch (e) { /* text layer is optional */ }
  }

  // ---------- Overlay painting ----------
  function sizeCanvas(c, vp, dpr) {
    const W = Math.floor(vp.width * dpr), H = Math.floor(vp.height * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    c.style.width = vp.width + 'px'; c.style.height = vp.height + 'px';
  }
  function drawOverlay(el) {
    const p = pageByUid(el.dataset.uid); if (!p) return;
    const vp = vpFor(p, state.zoom); const dpr = outputScale(vp);
    const hl = el.querySelector('.pg-hl'), ov = el.querySelector('.pg-overlay');
    sizeCanvas(hl, vp, dpr); sizeCanvas(ov, vp, dpr);
    const hctx = hl.getContext('2d'); hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.clearRect(0, 0, hl.width, hl.height);
    paintAnnots(hctx, p, vp, dpr, { onlyHighlights: true });
    paintSearch(hctx, p, vp, dpr);
    const ctx = ov.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ov.width, ov.height);
    paintAnnots(ctx, p, vp, dpr, { skipHighlights: true });
    paintDecorations(ctx, p, indexOfUid(p.uid), vp, dpr);
    paintSelection(ctx, p, vp, dpr);
  }
  function redrawPage(u) { const el = pageEls.get(u); if (el && el._st.visible) drawOverlay(el); refreshThumb(u); }
  function redrawAll() { for (const el of pageEls.values()) if (el._st.visible) drawOverlay(el); for (const p of state.pages) refreshThumb(p.uid); }

  const setUserSpace = (ctx, vp, dpr) => { const T = vp.transform; ctx.setTransform(dpr * T[0], dpr * T[1], dpr * T[2], dpr * T[3], dpr * T[4], dpr * T[5]); };

  function paintAnnots(ctx, p, vp, dpr, { onlyHighlights = false, skipHighlights = false } = {}) {
    for (const a of p.annots) {
      if (a._editing) continue;
      if (onlyHighlights && a.type !== 'highlight') continue;
      if (skipHighlights && a.type === 'highlight') continue;
      setUserSpace(ctx, vp, dpr);
      drawAnnot(ctx, a);
    }
  }

  const FONT_CSS = { Helvetica: 'Helvetica, Arial, sans-serif', HelveticaBold: 'Helvetica, Arial, sans-serif', TimesRoman: '"Times New Roman", Times, serif', TimesRomanBold: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace', CourierBold: '"Courier New", Courier, monospace' };
  const fontFamily = (f) => FONT_CSS[f] || FONT_CSS.Helvetica;
  const fontCss = (a) => `${/Bold/.test(a.font) ? 'bold ' : ''}${a.size}px ${fontFamily(a.font)}`;

  function arrowHead(a) {
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const L = Math.max(9, a.width * 4.5), W = Math.max(4, a.width * 2.2);
    const bx = a.x2 - Math.cos(ang) * L, by = a.y2 - Math.sin(ang) * L;
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    return { tip: [a.x2, a.y2], base: [bx, by], left: [bx + nx * W, by + ny * W], right: [bx - nx * W, by - ny * W] };
  }

  function drawAnnot(ctx, a) {
    ctx.save();
    ctx.globalAlpha = a.opacity ?? 1;
    switch (a.type) {
      case 'rect': {
        const r = normRect(a);
        if (a.fill) { ctx.fillStyle = a.fill; ctx.fillRect(r.x, r.y, r.w, r.h); }
        if (a.stroke && a.strokeWidth > 0) { ctx.strokeStyle = a.stroke; ctx.lineWidth = a.strokeWidth; ctx.strokeRect(r.x, r.y, r.w, r.h); }
        break;
      }
      case 'ellipse': {
        const r = normRect(a);
        ctx.beginPath(); ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.1, r.w / 2), Math.max(0.1, r.h / 2), 0, 0, Math.PI * 2);
        if (a.fill) { ctx.fillStyle = a.fill; ctx.fill(); }
        if (a.stroke && a.strokeWidth > 0) { ctx.strokeStyle = a.stroke; ctx.lineWidth = a.strokeWidth; ctx.stroke(); }
        break;
      }
      case 'highlight': {
        const r = normRect(a);
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = a.color; ctx.fillRect(r.x, r.y, r.w, r.h);
        break;
      }
      case 'whiteout': {
        const r = normRect(a);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(r.x, r.y, r.w, r.h);
        break;
      }
      case 'ink': {
        ctx.strokeStyle = a.color; ctx.lineWidth = a.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const s of a.strokes) {
          if (!s.length) continue;
          ctx.beginPath(); ctx.moveTo(s[0][0], s[0][1]);
          if (s.length === 1) ctx.lineTo(s[0][0], s[0][1]);
          for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
          ctx.stroke();
        }
        break;
      }
      case 'arrow': {
        const h = arrowHead(a);
        ctx.strokeStyle = a.color; ctx.fillStyle = a.color; ctx.lineWidth = a.width; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(h.base[0], h.base[1]); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(h.tip[0], h.tip[1]); ctx.lineTo(h.left[0], h.left[1]); ctx.lineTo(h.right[0], h.right[1]); ctx.closePath(); ctx.fill();
        break;
      }
      case 'text': {
        ctx.translate(a.x, a.y); ctx.rotate(rad(a.rot || 0)); ctx.scale(1, -1);
        ctx.font = fontCss(a); ctx.fillStyle = a.color; ctx.textBaseline = 'alphabetic';
        const lines = a.text.split('\n');
        lines.forEach((ln, i) => ctx.fillText(ln, 0, i * a.size * 1.2));
        break;
      }
      case 'image': {
        const as = state.assets.get(a.assetId);
        if (as && as.img) { ctx.translate(a.x, a.y); ctx.rotate(rad(a.rot || 0)); ctx.scale(1, -1); ctx.drawImage(as.img, 0, -a.h, a.w, a.h); }
        break;
      }
      default: break;
    }
    ctx.restore();
  }

  // Watermark and page numbers are document-level settings, drawn per page at view and export time.
  function pageNumberPlacement(p, index, vp1, measure) {
    const pn = state.pageNumbers;
    const total = state.pages.length;
    const text = pn.format.replace('{n}', String(index + Number(pn.start))).replace('{total}', String(total + Number(pn.start) - 1));
    const tw = measure(text, pn.size);
    const [v, h] = pn.position.split('-');
    const m = Number(pn.margin);
    const dy = v === 'top' ? m + pn.size * 0.78 : vp1.height - m;
    const dx = h === 'center' ? vp1.width / 2 - tw / 2 : h === 'right' ? vp1.width - m - tw : m;
    const [ux, uy] = vp1.convertToPdfPoint(dx, dy);
    return { text, ux, uy };
  }
  function watermarkPlacement(p, vp1, tw) {
    const wm = state.watermark; const rot = totalRot(p);
    const th = wm.size * 0.7;
    const [cx, cy] = vp1.convertToPdfPoint(vp1.width / 2, vp1.height / 2);
    const t = rad(Number(wm.angle) + rot);
    return { ax: cx - (Math.cos(t) * tw / 2 - Math.sin(t) * th / 2), ay: cy - (Math.sin(t) * tw / 2 + Math.cos(t) * th / 2), angle: Number(wm.angle) + rot };
  }
  function paintDecorations(ctx, p, index, vp, dpr) {
    const vp1 = vpFor(p, 1); const rot = totalRot(p);
    const wm = state.watermark;
    if (wm.enabled && wm.text) {
      ctx.save(); setUserSpace(ctx, vp, dpr);
      ctx.font = `bold ${wm.size}px Helvetica, Arial, sans-serif`;
      const tw = ctx.measureText(wm.text).width;
      const w = watermarkPlacement(p, vp1, tw);
      ctx.translate(w.ax, w.ay); ctx.rotate(rad(w.angle)); ctx.scale(1, -1);
      ctx.globalAlpha = Number(wm.opacity); ctx.fillStyle = wm.color; ctx.textBaseline = 'alphabetic';
      ctx.fillText(wm.text, 0, 0); ctx.restore();
    }
    const pn = state.pageNumbers;
    if (pn.enabled) {
      ctx.save(); setUserSpace(ctx, vp, dpr);
      const font = `${pn.size}px Helvetica, Arial, sans-serif`;
      const pl = pageNumberPlacement(p, index, vp1, (t) => { ctx.font = font; return ctx.measureText(t).width; });
      ctx.translate(pl.ux, pl.uy); ctx.rotate(rad(rot)); ctx.scale(1, -1);
      ctx.font = font; ctx.fillStyle = '#222222'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(pl.text, 0, 0); ctx.restore();
    }
  }

  function paintSearch(ctx, p, vp, dpr) {
    const s = state.search; if (!s.results.length) return;
    setUserSpace(ctx, vp, dpr);
    s.results.forEach((r, i) => {
      if (r.uid !== p.uid) return;
      ctx.fillStyle = i === s.index ? 'rgba(255,140,0,0.75)' : 'rgba(255,226,52,0.75)';
      for (const rc of r.rects) ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
    });
  }

  function paintSelection(ctx, p, vp, dpr) {
    const sel = state.selected; if (!sel || sel.uid !== p.uid) return;
    const a = p.annots.find((x) => x.id === sel.id); if (!a || a._editing) return;
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = annotOutline(a).map(([x, y]) => vp.convertToViewportPoint(x, y));
    ctx.strokeStyle = accentColor(); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    for (const h of handlesFor(a)) {
      const [x, y] = vp.convertToViewportPoint(h.x, h.y);
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = accentColor(); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(x - 4.5, y - 4.5, 9, 9); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- Annotation geometry ----------
  function normRect(a) { return { x: Math.min(a.x, a.x + a.w), y: Math.min(a.y, a.y + a.h), w: Math.abs(a.w), h: Math.abs(a.h) }; }
  function localToUser(a, lx, ly) { const t = rad(a.rot || 0); const c = Math.cos(t), s = Math.sin(t); return [a.x + c * lx - s * ly, a.y + s * lx + c * ly]; }
  function userToLocal(a, ux, uy) { const t = rad(a.rot || 0); const c = Math.cos(t), s = Math.sin(t); const dx = ux - a.x, dy = uy - a.y; return [c * dx + s * dy, -s * dx + c * dy]; }
  function textMetrics(a) {
    measureCtx.font = fontCss(a);
    const lines = a.text.split('\n');
    const w = Math.max(4, ...lines.map((l) => measureCtx.measureText(l || ' ').width));
    const lh = a.size * 1.2, asc = a.size * 0.78, desc = a.size * 0.22;
    return { w, lines, lh, asc, desc, top: asc, bottom: -((lines.length - 1) * lh + desc) };
  }
  function localRect(a) { if (a.type === 'text') { const m = textMetrics(a); return [0, m.bottom, m.w, m.top]; } return [0, 0, a.w, a.h]; }
  function annotOutline(a) {
    if (a.type === 'text' || a.type === 'image') {
      const [x0, y0, x1, y1] = localRect(a);
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => localToUser(a, x, y));
    }
    const b = annotBox(a);
    return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
  }
  function annotBox(a) {
    switch (a.type) {
      case 'rect': case 'ellipse': case 'highlight': case 'whiteout': { const r = normRect(a); return { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }; }
      case 'ink': {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const s of a.strokes) for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        const pad = a.width / 2 + 1; return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
      }
      case 'arrow': { const pad = a.width + 2; return { x0: Math.min(a.x1, a.x2) - pad, y0: Math.min(a.y1, a.y2) - pad, x1: Math.max(a.x1, a.x2) + pad, y1: Math.max(a.y1, a.y2) + pad }; }
      default: { const pts = annotOutline(a); const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]); return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; }
    }
  }
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function hitTest(p, ux, uy, tol) {
    for (let i = p.annots.length - 1; i >= 0; i--) {
      const a = p.annots[i]; if (a._draft || a._editing) continue;
      if (a.type === 'text' || a.type === 'image') {
        const [lx, ly] = userToLocal(a, ux, uy); const [x0, y0, x1, y1] = localRect(a);
        if (lx >= x0 - tol && lx <= x1 + tol && ly >= y0 - tol && ly <= y1 + tol) return a;
        continue;
      }
      if (a.type === 'ink') {
        for (const s of a.strokes) for (let k = 0; k < s.length; k++) { const q = s[k], r = s[Math.min(k + 1, s.length - 1)]; if (distToSeg(ux, uy, q[0], q[1], r[0], r[1]) <= a.width / 2 + tol) return a; }
        continue;
      }
      if (a.type === 'arrow') { if (distToSeg(ux, uy, a.x1, a.y1, a.x2, a.y2) <= a.width / 2 + tol * 1.5) return a; continue; }
      const b = annotBox(a);
      if (ux >= b.x0 - tol && ux <= b.x1 + tol && uy >= b.y0 - tol && uy <= b.y1 + tol) {
        if ((a.type === 'rect' || a.type === 'ellipse') && !a.fill) {
          const inner = tol + a.strokeWidth;
          if (ux <= b.x0 + inner || ux >= b.x1 - inner || uy <= b.y0 + inner || uy >= b.y1 - inner) return a;
          continue;
        }
        return a;
      }
    }
    return null;
  }
  function handlesFor(a) {
    switch (a.type) {
      case 'rect': case 'ellipse': case 'highlight': case 'whiteout': { const b = annotBox(a); return [{ n: 'tl', x: b.x0, y: b.y1 }, { n: 'tr', x: b.x1, y: b.y1 }, { n: 'br', x: b.x1, y: b.y0 }, { n: 'bl', x: b.x0, y: b.y0 }]; }
      case 'arrow': return [{ n: 'p1', x: a.x1, y: a.y1 }, { n: 'p2', x: a.x2, y: a.y2 }];
      case 'text': case 'image': { const [, y0, x1] = localRect(a); const [x, y] = localToUser(a, x1, y0); return [{ n: 'scale', x, y }]; }
      default: return [];
    }
  }
  function handleAt(a, vp, vx, vy) {
    for (const h of handlesFor(a)) { const [x, y] = vp.convertToViewportPoint(h.x, h.y); if (Math.abs(vx - x) <= 7 && Math.abs(vy - y) <= 7) return h; }
    return null;
  }
  function moveAnnot(a, dx, dy) {
    if (a.type === 'ink') { for (const s of a.strokes) for (const pt of s) { pt[0] += dx; pt[1] += dy; } }
    else if (a.type === 'arrow') { a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy; }
    else { a.x += dx; a.y += dy; }
  }
  function applyResize(a, name, ux, uy, start) {
    if (name === 'p1') { a.x1 = ux; a.y1 = uy; return; }
    if (name === 'p2') { a.x2 = ux; a.y2 = uy; return; }
    if (name === 'scale') {
      const [lx] = userToLocal(a, ux, uy);
      if (a.type === 'image') { const f = clamp(lx / start.w, 0.05, 60); a.w = start.w * f; a.h = start.h * f; }
      else { const f = clamp(lx / start.tw, 0.1, 40); a.size = clamp(Math.round(start.size * f * 2) / 2, 4, 400); }
      return;
    }
    let { x0, y0, x1, y1 } = start.box;
    if (name.includes('l')) x0 = ux; if (name.includes('r')) x1 = ux;
    if (name.includes('t')) y1 = uy; if (name.includes('b')) y0 = uy;
    a.x = Math.min(x0, x1); a.y = Math.min(y0, y1); a.w = Math.abs(x1 - x0); a.h = Math.abs(y1 - y0);
  }
  function resizeStart(a) {
    const s = { box: annotBox(a), w: a.w, h: a.h, size: a.size };
    if (a.type === 'text') s.tw = textMetrics(a).w;
    return s;
  }
  function newShape(tool, x, y) {
    const P = state.props; const base = { id: uid(), x, y, w: 0, h: 0 };
    switch (tool) {
      case 'rect': case 'ellipse': return { ...base, type: tool, stroke: P.color, strokeWidth: Number(P.strokeWidth), fill: P.fillOn ? P.fill : '', opacity: Number(P.opacity) };
      case 'highlight': return { ...base, type: 'highlight', color: P.highlight, opacity: Number(P.highlightOpacity) };
      case 'whiteout': return { ...base, type: 'whiteout', opacity: 1 };
      case 'arrow': return { id: uid(), type: 'arrow', x1: x, y1: y, x2: x, y2: y, color: P.color, width: Number(P.arrowWidth), opacity: Number(P.opacity) };
      default: return null;
    }
  }
  function normalizeShape(a) { if (a.type === 'arrow') return; const r = normRect(a); a.x = r.x; a.y = r.y; a.w = r.w; a.h = r.h; }

  // ---------- Selection of annotations ----------
  function selectAnnot(u, id) {
    const prev = state.selected;
    state.selected = u && id ? { uid: u, id } : null;
    if (prev) { const el = pageEls.get(prev.uid); if (el && el._st.visible) drawOverlay(el); }
    if (state.selected) { const el = pageEls.get(u); if (el && el._st.visible) drawOverlay(el); }
    refreshProps();
  }
  function deleteSelectedAnnot() {
    const a = getSelectedAnnot(); if (!a) return;
    const p = pageByUid(state.selected.uid);
    commit();
    p.annots.splice(p.annots.indexOf(a), 1);
    state.selected = null;
    redrawPage(p.uid); refreshProps();
  }

  // ---------- Pointer interaction on pages ----------
  function bindOverlay(el) {
    const ov = el.querySelector('.pg-overlay');
    let drag = null;
    const toUser = (e) => {
      const p = pageByUid(el.dataset.uid); const vp = vpFor(p, state.zoom);
      const r = ov.getBoundingClientRect();
      const vx = (e.clientX - r.left) * (vp.width / Math.max(1, r.width)), vy = (e.clientY - r.top) * (vp.height / Math.max(1, r.height));
      const [ux, uy] = vp.convertToPdfPoint(vx, vy);
      return { p, vp, vx, vy, ux, uy };
    };
    ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      commitTextEditor();
      const { p, vp, vx, vy, ux, uy } = toUser(e);
      const tool = state.tool; const tol = 6 / state.zoom;
      const idx = indexOfUid(p.uid); if (idx !== state.current) { state.current = idx; updatePageUI(); }
      if (tool === 'select') {
        if (state.selected && state.selected.uid === p.uid) {
          const a = getSelectedAnnot(); const h = a && handleAt(a, vp, vx, vy);
          if (h) { beginEdit(); drag = { kind: 'resize', a, p, h: h.n, start: resizeStart(a), moved: false }; ov.setPointerCapture(e.pointerId); return; }
        }
        const a = hitTest(p, ux, uy, tol);
        if (a) { selectAnnot(p.uid, a.id); beginEdit(); drag = { kind: 'move', a, p, lx: ux, ly: uy, moved: false }; ov.setPointerCapture(e.pointerId); }
        else selectAnnot(null);
        return;
      }
      if (tool === 'place') { placePending(p, ux, uy); return; }
      if (tool === 'text') { createText(p, ux, uy, el); return; }
      if (tool === 'ink') {
        beginEdit();
        const a = { id: uid(), type: 'ink', strokes: [[[ux, uy]]], color: state.props.inkColor, width: Number(state.props.inkWidth), opacity: Number(state.props.inkOpacity), _draft: true };
        p.annots.push(a); drag = { kind: 'ink', a, p, last: [ux, uy] }; ov.setPointerCapture(e.pointerId); drawOverlay(el); return;
      }
      if (['rect', 'ellipse', 'highlight', 'whiteout', 'arrow'].includes(tool)) {
        beginEdit();
        const a = newShape(tool, ux, uy); a._draft = true;
        p.annots.push(a); drag = { kind: 'shape', a, p, sx: ux, sy: uy }; ov.setPointerCapture(e.pointerId); return;
      }
    });
    ov.addEventListener('pointermove', (e) => {
      if (!drag) {
        if (state.tool === 'select' && e.pointerType !== 'touch') {
          const { p, vp, vx, vy, ux, uy } = toUser(e);
          const a = getSelectedAnnot();
          const h = a && state.selected.uid === p.uid ? handleAt(a, vp, vx, vy) : null;
          ov.classList.toggle('over-handle', !!h);
          ov.classList.toggle('over-annot', !h && !!hitTest(p, ux, uy, 6 / state.zoom));
        }
        return;
      }
      const { ux, uy } = toUser(e); const a = drag.a;
      switch (drag.kind) {
        case 'move': { const dx = ux - drag.lx, dy = uy - drag.ly; if (!dx && !dy) return; moveAnnot(a, dx, dy); drag.lx = ux; drag.ly = uy; drag.moved = true; break; }
        case 'resize': applyResize(a, drag.h, ux, uy, drag.start); drag.moved = true; break;
        case 'ink': { const [lx, ly] = drag.last; if (Math.hypot(ux - lx, uy - ly) < 0.6 / state.zoom) return; a.strokes[0].push([ux, uy]); drag.last = [ux, uy]; break; }
        case 'shape': {
          if (a.type === 'arrow') { a.x2 = ux; a.y2 = uy; }
          else {
            let w = ux - drag.sx, h = uy - drag.sy;
            if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = (w < 0 ? -1 : 1) * m; h = (h < 0 ? -1 : 1) * m; }
            a.w = w; a.h = h;
          }
          break;
        }
        default: break;
      }
      drawOverlay(el);
    });
    const finish = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      try { ov.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      const a = d.a, p = d.p;
      if (d.kind === 'move' || d.kind === 'resize') { if (d.moved) endEdit(); else cancelEdit(); redrawPage(p.uid); refreshProps(); return; }
      if (d.kind === 'ink') { delete a._draft; if (a.strokes[0].length < 2) a.strokes[0].push([...a.strokes[0][0]]); endEdit(); redrawPage(p.uid); return; }
      if (d.kind === 'shape') {
        delete a._draft;
        const tooSmall = a.type === 'arrow' ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3 : Math.abs(a.w) < 3 || Math.abs(a.h) < 3;
        if (tooSmall) { p.annots.splice(p.annots.indexOf(a), 1); cancelEdit(); redrawPage(p.uid); return; }
        normalizeShape(a); endEdit(); redrawPage(p.uid);
      }
    };
    ov.addEventListener('pointerup', finish);
    ov.addEventListener('pointercancel', finish);
    ov.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
    ov.addEventListener('dblclick', (e) => {
      if (state.tool !== 'select') return;
      const { p, ux, uy } = toUser(e);
      const a = hitTest(p, ux, uy, 6 / state.zoom);
      if (a && a.type === 'text') { selectAnnot(p.uid, a.id); openTextEditor(p, a, el, false); }
    });
  }

  function placePending(p, ux, uy) {
    const pend = state.pending;
    if (!pend) { setTool('select'); return; }
    const as = state.assets.get(pend.assetId); const vp1 = vpFor(p, 1); const rot = totalRot(p);
    const w = Math.min(pend.kind === 'signature' ? 160 : 260, vp1.width * 0.6), h = w * as.h / as.w;
    commit();
    const a = { id: uid(), type: 'image', assetId: pend.assetId, kind: pend.kind, x: 0, y: 0, w, h, rot, opacity: 1 };
    const t = rad(rot);
    a.x = ux - (Math.cos(t) * w / 2 - Math.sin(t) * h / 2);
    a.y = uy - (Math.sin(t) * w / 2 + Math.cos(t) * h / 2);
    p.annots.push(a);
    state.pending = null;
    setTool('select');
    selectAnnot(p.uid, a.id);
    redrawPage(p.uid);
  }

  // ---------- Text annotations and the inline editor ----------
  let textEditor = null;
  function createText(p, ux, uy, el) {
    beginEdit();
    const P = state.props;
    const a = { id: uid(), type: 'text', text: '', size: Number(P.fontSize), font: P.font, color: P.textColor, opacity: 1, rot: totalRot(p), x: 0, y: 0 };
    const asc = a.size * 0.78; const t = rad(a.rot);
    a.x = ux + Math.sin(t) * asc; a.y = uy - Math.cos(t) * asc;
    p.annots.push(a);
    state.selected = { uid: p.uid, id: a.id };
    openTextEditor(p, a, el, true);
  }
  function openTextEditor(p, a, el, isNew) {
    commitTextEditor();
    if (!isNew) beginEdit();
    const ta = document.createElement('textarea');
    ta.className = 'text-editor'; ta.value = a.text; ta.spellcheck = false; ta.rows = 1; ta.setAttribute('aria-label', 'Text annotation');
    el.appendChild(ta);
    textEditor = { ta, uid: p.uid, id: a.id, isNew, before: a.text };
    a._editing = true;
    drawOverlay(el);
    positionTextEditor();
    requestAnimationFrame(() => { if (textEditor && textEditor.ta === ta) { ta.focus(); if (!isNew) ta.select(); } });
    ta.addEventListener('input', () => { a.text = ta.value; autosizeEditor(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); commitTextEditor(); }
    });
    ta.addEventListener('blur', () => commitTextEditor());
  }
  function positionTextEditor() {
    if (!textEditor) return;
    const { ta, uid: u, id } = textEditor; const p = pageByUid(u); if (!p) return;
    const a = p.annots.find((x) => x.id === id); if (!a) return;
    const vp = vpFor(p, state.zoom); const z = state.zoom; const m = textMetrics(a);
    const [ux, uy] = localToUser(a, -2 / z, m.top + 0.12 * a.size);
    const [vx, vy] = vp.convertToViewportPoint(ux, uy);
    ta.style.left = vx + 'px'; ta.style.top = vy + 'px';
    ta.style.transform = `rotate(${mod(totalRot(p) - (a.rot || 0), 360)}deg)`;
    ta.style.fontSize = a.size * z + 'px'; ta.style.fontFamily = fontFamily(a.font);
    ta.style.fontWeight = /Bold/.test(a.font) ? '700' : '400'; ta.style.color = a.color;
    autosizeEditor();
  }
  function autosizeEditor() {
    if (!textEditor) return;
    const { ta, uid: u, id } = textEditor; const p = pageByUid(u); const a = p && p.annots.find((x) => x.id === id); if (!a) return;
    const m = textMetrics(a); const z = state.zoom;
    ta.style.width = Math.max(60, (m.w + 14) * z) + 'px';
    ta.style.height = (m.lines.length * a.size * 1.2 * z + 4) + 'px';
  }
  function commitTextEditor() {
    if (!textEditor) return;
    const te = textEditor; textEditor = null;
    te.ta.remove();
    const p = pageByUid(te.uid); const a = p && p.annots.find((x) => x.id === te.id);
    if (!a) { cancelEdit(); return; }
    delete a._editing;
    a.text = te.ta.value.replace(/\r/g, '');
    if (!a.text.trim()) {
      p.annots.splice(p.annots.indexOf(a), 1);
      if (state.selected && state.selected.id === a.id) state.selected = null;
      cancelEdit();
    } else if (te.isNew || a.text !== te.before) endEdit();
    else cancelEdit();
    redrawPage(p.uid); refreshProps();
  }

  // ---------- Tools ----------
  const HINTS = {
    select: 'Click an annotation to select it · drag to move · double-click text to edit · ⌫ deletes',
    textsel: 'Drag across page text to select it, then copy with ' + (isMac ? '⌘C' : 'Ctrl+C'),
    text: 'Click on a page to add text · Enter finishes · Shift+Enter starts a new line',
    ink: 'Draw on a page · each stroke can be selected and deleted on its own',
    highlight: 'Drag across the area to highlight',
    rect: 'Drag to draw a box · hold ⇧ for a square',
    ellipse: 'Drag to draw an ellipse · hold ⇧ for a circle',
    arrow: 'Drag from the tail to the head',
    whiteout: 'Drag to cover an area with white. The text underneath stays in the file — this is not redaction.',
    image: 'Choose an image, then click on a page to place it',
    place: 'Click on a page to place it',
  };
  function setTool(tool) {
    commitTextEditor();
    if (tool !== 'place') state.pending = null;
    state.tool = tool;
    viewer.dataset.tool = tool;
    for (const b of $$('#tool-grid .tool-btn')) b.classList.toggle('active', b.dataset.tool === tool || (tool === 'place' && state.pending && state.pending.kind === 'image' && b.dataset.tool === 'image'));
    if (tool !== 'select') selectAnnot(null);
    const toolButton = $('#btn-rail-right');
    toolButton.querySelector('.mobile-only').textContent = tool === 'select' ? 'Tools' : tool === 'place' ? 'Place' : ($('#tool-grid .tool-btn.active')?.textContent.trim() || 'Tools');
    toolButton.classList.toggle('active', tool !== 'select');
    setHint(HINTS[tool] || '');
    refreshProps();
  }

  // ---------- Properties panel ----------
  const FONT_OPTIONS = [['Helvetica', 'Helvetica'], ['HelveticaBold', 'Helvetica Bold'], ['TimesRoman', 'Times'], ['TimesRomanBold', 'Times Bold'], ['Courier', 'Courier'], ['CourierBold', 'Courier Bold']];
  function refreshProps() {
    const a = getSelectedAnnot();
    const kind = a ? a.type : state.tool;
    const body = $('#props-body'); const title = $('#props-title');
    $('#annot-delete').hidden = !a;
    const P = state.props; const rows = [];
    const color = (label, key, val) => rows.push(`<div class="row"><span class="label" style="flex:1">${label}</span><input type="color" class="input sm" id="prop-${key}" data-prop="${key}" value="${val}" aria-label="${label}"></div>`);
    const num = (label, key, val, min, max, step = 1) => rows.push(`<div class="row"><span class="label" style="flex:1">${label}</span><input type="number" class="input sm mono" style="width:76px" id="prop-${key}" data-prop="${key}" value="${val}" min="${min}" max="${max}" step="${step}" aria-label="${label}"></div>`);
    const range = (label, key, val) => rows.push(`<div class="field"><label for="prop-${key}">${label} <span class="mono" data-val-for="${key}">${Math.round(val * 100)}%</span></label><input type="range" id="prop-${key}" data-prop="${key}" min="0.05" max="1" step="0.05" value="${val}"></div>`);
    const note = (t) => rows.push(`<div class="annot-info">${t}</div>`);
    const v = (key, def) => (a ? a[key] : def);
    switch (kind) {
      case 'text':
        title.textContent = a ? 'Text' : 'Text defaults';
        color('Color', 'color', v('color', P.textColor));
        rows.push(`<div class="row"><span class="label" style="flex:1">Font</span><select class="input sm" style="width:140px" id="prop-font" data-prop="font" aria-label="Font">${FONT_OPTIONS.map(([k, l]) => `<option value="${k}" ${v('font', P.font) === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`);
        num('Size (pt)', 'size', v('size', P.fontSize), 4, 400, 1);
        if (a) range('Opacity', 'opacity', a.opacity ?? 1);
        if (!a) note('Standard PDF fonts (Latin characters). Press Enter to finish, Shift+Enter for a new line.');
        break;
      case 'ink':
        title.textContent = a ? 'Drawing' : 'Pen';
        color('Color', 'color', v('color', P.inkColor));
        num('Width (pt)', 'width', v('width', P.inkWidth), 0.5, 40, 0.5);
        range('Opacity', 'opacity', v('opacity', P.inkOpacity));
        break;
      case 'highlight':
        title.textContent = 'Highlight';
        color('Color', 'color', v('color', P.highlight));
        range('Opacity', 'opacity', v('opacity', P.highlightOpacity));
        break;
      case 'rect': case 'ellipse':
        title.textContent = kind === 'rect' ? 'Box' : 'Ellipse';
        color('Line color', 'stroke', v('stroke', P.color));
        num('Line width (pt)', 'strokeWidth', v('strokeWidth', P.strokeWidth), 0, 40, 0.5);
        rows.push(`<div class="row"><label class="check" style="flex:1"><input type="checkbox" id="prop-fillOn" data-prop="fillOn" ${(a ? !!a.fill : P.fillOn) ? 'checked' : ''}> Fill</label><input type="color" class="input sm" id="prop-fill" data-prop="fill" value="${a ? (a.fill || P.fill) : P.fill}" aria-label="Fill color"></div>`);
        range('Opacity', 'opacity', v('opacity', P.opacity));
        break;
      case 'arrow':
        title.textContent = 'Arrow';
        color('Color', 'color', v('color', P.color));
        num('Width (pt)', 'width', v('width', P.arrowWidth), 0.5, 30, 0.5);
        range('Opacity', 'opacity', v('opacity', P.opacity));
        break;
      case 'whiteout':
        title.textContent = 'Cover';
        note('Paints an opaque white box over the area. It hides content visually but does not remove the underlying text or image from the file, so it is not a redaction.');
        break;
      case 'image':
        title.textContent = a && a.kind === 'signature' ? 'Signature' : 'Image';
        if (a) { range('Opacity', 'opacity', a.opacity ?? 1); note(`${Math.round(a.w)} × ${Math.round(a.h)} pt · drag the corner handle to resize`); }
        else note('Choose an image file, then click on a page to place it.');
        break;
      case 'textsel':
        title.textContent = 'Copy text'; note('Select text on the page with the cursor and copy it. Use Document → Export page text to save everything as .txt.');
        break;
      case 'place':
        title.textContent = 'Place'; note('Click on a page to place it. Press Esc to cancel.');
        break;
      default:
        title.textContent = 'Style'; note('Pick a tool above, or click an annotation on the page to edit its style.');
    }
    body.innerHTML = rows.join('');
  }
  $('#props-body').addEventListener('input', (e) => onPropInput(e, false));
  $('#props-body').addEventListener('change', (e) => onPropInput(e, true));
  function onPropInput(e, final) {
    const inp = e.target; const key = inp.dataset.prop; if (!key) return;
    const val = inp.type === 'checkbox' ? inp.checked : inp.value;
    const a = getSelectedAnnot(); const P = state.props;
    const valEl = $(`[data-val-for="${key}"]`); if (valEl) valEl.textContent = Math.round(Number(val) * 100) + '%';
    if (a) {
      beginEdit();
      if (key === 'fillOn') a.fill = val ? ($('#prop-fill') ? $('#prop-fill').value : P.fill) : '';
      else if (key === 'fill') { a.fill = val; const on = $('#prop-fillOn'); if (on && !on.checked) on.checked = true; }
      else if (['size', 'width', 'strokeWidth', 'opacity'].includes(key)) a[key] = Number(val);
      else a[key] = val;
      if (final) endEdit();
      redrawPage(state.selected.uid);
      if (textEditor) positionTextEditor();
    }
    // Remember as the default for new annotations of this kind.
    const kind = a ? a.type : state.tool;
    const map = {
      text: { color: 'textColor', font: 'font', size: 'fontSize' },
      ink: { color: 'inkColor', width: 'inkWidth', opacity: 'inkOpacity' },
      highlight: { color: 'highlight', opacity: 'highlightOpacity' },
      rect: { stroke: 'color', strokeWidth: 'strokeWidth', fill: 'fill', fillOn: 'fillOn', opacity: 'opacity' },
      ellipse: { stroke: 'color', strokeWidth: 'strokeWidth', fill: 'fill', fillOn: 'fillOn', opacity: 'opacity' },
      arrow: { color: 'color', width: 'arrowWidth', opacity: 'opacity' },
    }[kind];
    if (map && map[key]) P[map[key]] = val;
    if (a && key === 'fill' && map) P.fillOn = true;
  }
  $('#annot-delete').addEventListener('click', deleteSelectedAnnot);

  // =====================================================================
  //  Page thumbnails, selection, drag-to-reorder and page operations
  // =====================================================================
  const thumbGrid = $('#thumb-grid'), thumbScroll = $('#thumb-scroll'), fileScroll = $('#file-scroll');
  const thumbEls = new Map(); const thumbCache = new Map();
  const expandedFiles = new Set();
  const fileGrids = new Map();
  let dragUids = [], dragFileId = null, dragBadge = null;
  let pointerDrag = null, suppressOrganizerClick = false;
  const inFilesTab = () => $('#rail-left .tab.active').dataset.tab === 'files';
  const thumbIO = new IntersectionObserver((entries) => {
    for (const e of entries) { e.target._visible = e.isIntersecting; if (e.isIntersecting) queueThumb(e.target); }
  }, { root: $('#rail-left'), rootMargin: '400px 0px' });

  function scrollDuringDrag(e) {
    const scroll = inFilesTab() ? fileScroll : thumbScroll;
    const r = scroll.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    if (e.clientY < r.top + 48) scroll.scrollTop -= 18;
    else if (e.clientY > r.bottom - 48) scroll.scrollTop += 18;
  }
  function endOrganizerDrag() {
    dragUids = []; dragFileId = null;
    dragBadge?.remove(); dragBadge = null;
    $$('.dragging', $('#rail-left')).forEach((el) => el.classList.remove('dragging'));
    clearDropMarks();
  }
  function canDropPages(p) {
    return dragUids.length && (!inFilesTab() || dragUids.every((u) => pageByUid(u)?.srcId === p.srcId));
  }

  function createThumb(p) {
    const t = document.createElement('div');
    t.className = 'thumb'; t.draggable = true; t.dataset.uid = p.uid; t.tabIndex = 0;
    t.setAttribute('role', 'option');
    t.innerHTML = '<canvas></canvas><div class="thumb-num"></div><span class="thumb-rot" hidden></span>';
    thumbIO.observe(t);
    t.addEventListener('click', (e) => onThumbClick(p.uid, e));
    t.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onThumbClick(p.uid, e); }
    });
    t.addEventListener('dragstart', (e) => {
      if (pointerDrag) { e.preventDefault(); return; }
      e.stopPropagation();
      // Shift-drag must extend the range before the browser starts dragging.
      if (e.shiftKey) onThumbClick(p.uid, e);
      if (!state.selection.has(p.uid)) { state.selection = new Set([p.uid]); state.anchorUid = p.uid; syncSelectionUI(); }
      if (inFilesTab() && orderedSelection().some((u) => pageByUid(u).srcId !== pageByUid(p.uid).srcId)) {
        e.preventDefault(); toast('Use All pages to move a selection from different files.'); return;
      }
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-pdfwb-page', p.uid);
      dragUids = orderedSelection();
      for (const u of dragUids) thumbEls.get(u)?.classList.add('dragging');
      if (dragUids.length > 1) {
        dragBadge = document.createElement('div'); dragBadge.className = 'drag-count';
        dragBadge.textContent = `${dragUids.length} pages`; document.body.append(dragBadge);
        e.dataTransfer.setDragImage(dragBadge, 20, 20);
      }
    });
    t.addEventListener('dragend', endOrganizerDrag);
    t.addEventListener('dragover', (e) => {
      if (!canDropPages(pageByUid(p.uid))) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
      const r = t.getBoundingClientRect(); const before = e.clientX - r.left < r.width / 2;
      clearDropMarks(); t.classList.add(before ? 'drop-before' : 'drop-after');
      scrollDuringDrag(e);
    });
    t.addEventListener('drop', (e) => {
      if (!canDropPages(pageByUid(p.uid))) return; e.preventDefault(); e.stopPropagation();
      const r = t.getBoundingClientRect(); const before = e.clientX - r.left < r.width / 2;
      const idx = indexOfUid(p.uid) + (before ? 0 : 1);
      const moving = [...dragUids]; endOrganizerDrag(); movePages(moving, idx);
    });
    return t;
  }
  thumbGrid.addEventListener('dragover', (e) => { if (dragUids.length) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; scrollDuringDrag(e); } });
  thumbGrid.addEventListener('drop', (e) => { if (!dragUids.length) return; e.preventDefault(); const moving = [...dragUids]; endOrganizerDrag(); movePages(moving, state.pages.length); });
  function clearDropMarks() { $$('.drop-before, .drop-after', $('#rail-left')).forEach((el) => el.classList.remove('drop-before', 'drop-after')); }

  function onThumbClick(u, e) {
    if (e.shiftKey && state.anchorUid && pageByUid(state.anchorUid)) {
      const a = indexOfUid(state.anchorUid), b = indexOfUid(u); const [s, t] = a < b ? [a, b] : [b, a];
      const srcId = pageByUid(u).srcId;
      state.selection = new Set(state.pages.slice(s, t + 1).filter((p) => !inFilesTab() || p.srcId === srcId).map((p) => p.uid));
    } else if (e.metaKey || e.ctrlKey) {
      if (state.selection.has(u)) state.selection.delete(u); else state.selection.add(u);
      state.anchorUid = u;
    } else {
      state.selection = new Set([u]); state.anchorUid = u; goToPage(indexOfUid(u));
    }
    syncSelectionUI();
  }
  function syncSelectionUI() {
    for (const [u, t] of thumbEls) { t.classList.toggle('selected', state.selection.has(u)); t.setAttribute('aria-selected', String(state.selection.has(u))); }
    const n = state.selection.size;
    const modifier = isMac ? '⌘' : 'Ctrl';
    const selectedHint = `${n} page${n === 1 ? '' : 's'} selected · drag the selection or use the arrows above`;
    $('#pages-hint').textContent = n ? selectedHint : `Click to select · Shift/${modifier} for multiple · drag to reorder`;
    $('#files-hint').textContent = n ? selectedHint : 'Drag files to reorder. Expand a file to arrange its pages.';
    const tab = $('#rail-left .tab.active').dataset.tab;
    const hasExpandedFile = [...expandedFiles].some((id) => fileGrids.has(id));
    $('#page-tools').hidden = tab !== 'pages' && !(tab === 'files' && (n || hasExpandedFile));
    $$('.file-card').forEach((card) => {
      const pages = state.pages.filter((p) => p.srcId === card.dataset.srcId);
      card.classList.toggle('selected', pages.length > 0 && pages.every((p) => state.selection.has(p.uid)));
    });
    $('#ex-count-sel').textContent = n;
  }

  function rebuildThumbs() {
    const keep = new Set(); const frag = document.createDocumentFragment();
    const grouped = inFilesTab();
    for (const grid of fileGrids.values()) grid.replaceChildren();
    thumbGrid.replaceChildren();
    thumbGrid.setAttribute('role', 'listbox'); thumbGrid.setAttribute('aria-label', 'All pages'); thumbGrid.setAttribute('aria-multiselectable', 'true');
    state.pages.forEach((p, i) => {
      let t = thumbEls.get(p.uid);
      if (!t) { t = createThumb(p); thumbEls.set(p.uid, t); }
      t.dataset.index = i;
      t.querySelector('.thumb-num').innerHTML = `${i + 1}${grouped ? '' : `<span class="thumb-source">${esc(srcOf(p).name)}</span>`}`;
      t.setAttribute('aria-label', `Page ${i + 1}, ${srcOf(p).name}, original page ${p.srcPage + 1}`);
      t.title = `${srcOf(p).name} · original page ${p.srcPage + 1}`;
      t.classList.toggle('current', i === state.current);
      const rotEl = t.querySelector('.thumb-rot'); rotEl.hidden = !p.rotation; rotEl.textContent = p.rotation + '°';
      if (t.dataset.key !== pageKey(p)) { t.dataset.key = pageKey(p); t._dirty = true; }
      keep.add(p.uid); (grouped ? fileGrids.get(p.srcId) : frag).appendChild(t);
    });
    for (const [u, t] of thumbEls) if (!keep.has(u)) { thumbIO.unobserve(t); t.remove(); thumbEls.delete(u); }
    thumbGrid.replaceChildren(frag);
    if (!state.pages.length) thumbGrid.innerHTML = '<div class="thumb-empty">No pages yet.<br>Open a PDF to begin.</div>';
    syncSelectionUI();
    for (const t of thumbEls.values()) if (t._visible) queueThumb(t);
  }

  let thumbChain = Promise.resolve(); const thumbPending = new Set();
  function queueThumb(t) {
    if (thumbPending.has(t)) return;
    if (!t._dirty && t._renderedKey === t.dataset.key) return;
    thumbPending.add(t);
    thumbChain = thumbChain.then(() => renderThumb(t)).catch((e) => console.warn('thumb', e)).finally(() => thumbPending.delete(t));
  }
  async function renderThumb(t) {
    const p = pageByUid(t.dataset.uid); if (!p || !t.isConnected) return;
    const key = pageKey(p); let base = thumbCache.get(key);
    if (!base) {
      const pg = pdfPageOf(p); const rot = totalRot(p);
      const v0 = pg.getViewport({ scale: 1, rotation: rot });
      const vp = pg.getViewport({ scale: THUMB_W / v0.width, rotation: rot });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width * dpr); c.height = Math.ceil(vp.height * dpr);
      const ctx = c.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0], annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      base = { canvas: c, vp, dpr }; thumbCache.set(key, base);
      if (thumbCache.size > 400) thumbCache.delete(thumbCache.keys().next().value);
    }
    compositeThumb(t, p, base); t._dirty = false; t._renderedKey = key;
  }
  function compositeThumb(t, p, base) {
    const c = t.querySelector('canvas');
    if (c.width !== base.canvas.width || c.height !== base.canvas.height) { c.width = base.canvas.width; c.height = base.canvas.height; }
    const ctx = c.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(base.canvas, 0, 0);
    paintAnnots(ctx, p, base.vp, base.dpr, {});
    paintDecorations(ctx, p, indexOfUid(p.uid), base.vp, base.dpr);
  }
  function refreshThumb(u) {
    const t = thumbEls.get(u); const p = pageByUid(u); if (!t || !p) return;
    const base = thumbCache.get(pageKey(p));
    if (base) compositeThumb(t, p, base); else { t._dirty = true; if (t._visible) queueThumb(t); }
  }

  // ---------- Page operations ----------
  function movePages(uids, toIndex) {
    const set = new Set(uids); const moving = state.pages.filter((p) => set.has(p.uid)); if (!moving.length) return;
    const rest = state.pages.filter((p) => !set.has(p.uid));
    const before = state.pages.slice(0, toIndex).filter((p) => !set.has(p.uid)).length;
    const next = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
    if (next.every((p, i) => p === state.pages[i])) return;
    const currentUid = currentPage()?.uid;
    commit(); state.pages = next;
    state.current = Math.max(0, indexOfUid(currentUid));
    rebuild(); goToPage(state.current);
  }
  function rotatePages(uids, delta) {
    if (!uids.length) return; commit();
    for (const p of state.pages) if (uids.includes(p.uid)) p.rotation = mod(p.rotation + delta, 360);
    rebuild();
  }
  function deletePages(uids) {
    if (!uids.length) return;
    if (uids.length >= state.pages.length && state.pages.length > 1 && !window.confirm(`Delete all ${state.pages.length} pages?`)) return;
    commit();
    state.pages = state.pages.filter((p) => !uids.includes(p.uid));
    state.selection.clear();
    if (state.selected && uids.includes(state.selected.uid)) state.selected = null;
    rebuild(); refreshProps();
    toast(`Deleted ${uids.length} page${uids.length > 1 ? 's' : ''}`, { action: { label: 'Undo', fn: undo } });
  }
  function duplicatePages(uids) {
    if (!uids.length) return; commit();
    const out = [];
    for (const p of state.pages) {
      out.push(p);
      if (uids.includes(p.uid)) { const c = structuredClone(p); c.uid = uid(); c.annots.forEach((a) => { a.id = uid(); }); out.push(c); }
    }
    state.pages = out; rebuild();
  }
  async function insertBlankAfter(uidRef) {
    const ref = pageByUid(uidRef);
    const v = ref ? vpFor(ref, 1) : { width: 612, height: 792 };
    const doc = await PDFDocument.create(); doc.addPage([v.width, v.height]);
    const src = await loadSource(await doc.save(), 'Blank page');
    commit();
    const at = ref ? indexOfUid(ref.uid) + 1 : state.pages.length;
    state.pages.splice(at, 0, makePage(src.id, 0));
    rebuild();
  }
  function reversePages() { if (state.pages.length < 2) return; commit(); state.pages.reverse(); rebuild(); }
  function moveSelectionBy(dir) {
    const uids = targetUids(); if (!uids.length) return;
    const idxs = uids.map(indexOfUid); const first = Math.min(...idxs), last = Math.max(...idxs);
    if (dir < 0 && first === 0) return; if (dir > 0 && last === state.pages.length - 1) return;
    movePages(uids, dir < 0 ? first - 1 : last + 2);
  }
  function pageRangeLabel(uids) {
    const idx = uids.map(indexOfUid).sort((a, b) => a - b).map((i) => i + 1);
    const parts = []; let s = idx[0], e = idx[0];
    for (let i = 1; i <= idx.length; i++) { if (idx[i] === e + 1) { e = idx[i]; continue; } parts.push(s === e ? `${s}` : `${s}-${e}`); s = e = idx[i]; }
    return parts.join(',');
  }

  // ---------- Navigation ----------
  function goToPage(i) {
    if (!state.pages.length) return;
    i = clamp(i, 0, state.pages.length - 1);
    const el = pageEls.get(state.pages[i].uid);
    if (el) viewer.scrollTop = el.offsetTop - 14;
    state.current = i; updatePageUI();
  }
  let scrollRaf = 0;
  viewer.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrentFromScroll(); });
  });
  function updateCurrentFromScroll() {
    if (!state.pages.length) return;
    const mid = viewer.scrollTop + viewer.clientHeight * 0.4; let best = 0;
    for (let i = 0; i < state.pages.length; i++) { const el = pageEls.get(state.pages[i].uid); if (!el) continue; if (el.offsetTop <= mid) best = i; else break; }
    if (best !== state.current) { state.current = best; updatePageUI(); }
  }
  function updatePageUI() {
    const n = state.pages.length; const i = state.current;
    $('#page-input').value = n ? String(i + 1) : '0';
    for (const [u, t] of thumbEls) t.classList.toggle('current', indexOfUid(u) === i);
    const p = currentPage();
    if (p) {
      const t = thumbEls.get(p.uid);
      if (t && t.isConnected && t.getClientRects().length && !dragUids.length && !dragFileId) {
        const scroll = inFilesTab() ? fileScroll : thumbScroll;
        const r = t.getBoundingClientRect(), bounds = scroll.getBoundingClientRect();
        if (r.top < bounds.top) scroll.scrollTop += r.top - bounds.top;
        else if (r.bottom > bounds.bottom) scroll.scrollTop += r.bottom - bounds.bottom;
      }
      const v = vpFor(p, 1);
      $('#status-page').textContent = `${paperName(v.width, v.height)} · ${Math.round(v.width)} × ${Math.round(v.height)} pt · ${ptToMm(v.width)} × ${ptToMm(v.height)} mm`;
    } else $('#status-page').textContent = '';
    if (state.zoomMode === 'fit-page') { const z = computeZoom(); if (Math.abs(z - state.zoom) > 0.001) layout(); }
  }
  function updateCounts() {
    const n = state.pages.length; $('#page-total').textContent = n;
    const srcIds = new Set(state.pages.map((p) => p.srcId));
    const names = [...srcIds].map((id) => state.sources.get(id).name);
    $('#status-doc').textContent = n ? (names.length === 1 ? names[0] : `${names.length} files`) + ` · ${n} page${n !== 1 ? 's' : ''}` : 'No document';
    $('#ex-count-all').textContent = n;
  }

  // ---------- Files panel ----------
  function filePages(id) { return state.pages.filter((p) => p.srcId === id); }
  function fileOrder() { return [...new Set(state.pages.map((p) => p.srcId))]; }
  function moveFile(id, targetId, after = false) {
    if (id === targetId) return;
    const moving = filePages(id).map((p) => p.uid);
    const target = filePages(targetId);
    const at = target.length ? indexOfUid(target[after ? target.length - 1 : 0].uid) + (after ? 1 : 0) : state.pages.length;
    movePages(moving, at);
  }
  function moveFileBy(id, dir) {
    const ids = fileOrder(), at = ids.indexOf(id), target = ids[at + dir];
    if (target) {
      moveFile(id, target, dir > 0);
      $(`.file-card[data-src-id="${id}"] [data-move="${dir}"]`)?.focus({ preventScroll: true });
    }
  }
  function refreshFiles() {
    const list = $('#file-list'); list.replaceChildren(); fileGrids.clear();
    const ids = fileOrder();
    $('#files-count').textContent = `${ids.length} file${ids.length === 1 ? '' : 's'} · ${state.pages.length} pages`;
    if (!ids.length) { list.innerHTML = '<div class="thumb-empty">No files yet.<br>Add PDFs to arrange them here.</div>'; return; }
    ids.forEach((id, order) => {
      const s = state.sources.get(id);
      const pages = filePages(id), uids = pages.map((p) => p.uid), n = pages.length;
      const ranges = pageRangeLabel(uids);
      const scattered = indexOfUid(uids[n - 1]) - indexOfUid(uids[0]) + 1 !== n;
      const expanded = expandedFiles.has(id);
      const el = document.createElement('section'); el.className = 'file-card'; el.dataset.srcId = id;
      el.setAttribute('aria-label', s.name);
      el.innerHTML = `<div class="file-head" draggable="true" title="Drag to move all ${n} pages in ${esc(s.name)}">
          <span class="file-grip" aria-hidden="true"></span><span class="file-order">${order + 1}</span>
          <div class="file-title"><div class="file-name" title="${esc(s.name)}">${esc(s.name)}</div>
          <div class="file-meta">${n} page${n === 1 ? '' : 's'} · ${fmtSize(s.size)}${s.hasForm ? ' <span class="badge ok">FORM</span>' : ''}${s.libError ? ' <span class="badge warn">RASTER</span>' : ''}</div></div>
        </div>
        <div class="file-actions">
          <button class="btn ghost sm file-toggle" aria-expanded="${expanded}" aria-controls="file-pages-${id}" aria-label="${expanded ? 'Hide' : 'Show'} pages in ${esc(s.name)}"><svg><use href="#i-down"/></svg><span>${expanded ? 'Hide' : 'Show'} pages</span></button>
          <button class="btn icon sm" data-move="-1" ${order === 0 ? 'disabled' : ''} title="Move file up" aria-label="Move ${esc(s.name)} up"><svg><use href="#i-up"/></svg></button>
          <button class="btn icon sm" data-move="1" ${order === ids.length - 1 ? 'disabled' : ''} title="Move file down" aria-label="Move ${esc(s.name)} down"><svg><use href="#i-down"/></svg></button>
          <button class="btn icon sm danger file-remove" title="Remove file" aria-label="Remove ${esc(s.name)}"><svg><use href="#i-trash"/></svg></button>
        </div>
        ${scattered ? '<div class="file-note">Pages are mixed with other files. Moving this file brings its pages together.</div>' : ''}
        <div class="file-pages" id="file-pages-${id}" ${expanded ? '' : 'hidden'}>
          <div class="file-pages-bar"><span class="hint" title="Pages in the combined PDF">Page${n === 1 ? '' : 's'} ${ranges}</span><button class="btn ghost sm file-select" aria-label="Select all pages in ${esc(s.name)}">Select all</button></div>
          <div class="thumb-grid" role="listbox" aria-label="Pages in ${esc(s.name)}" aria-multiselectable="true"></div>
        </div>`;
      const toggle = el.querySelector('.file-toggle'), contents = el.querySelector('.file-pages');
      toggle.onclick = () => {
        const open = !expandedFiles.has(id);
        if (open) expandedFiles.add(id); else expandedFiles.delete(id);
        contents.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} pages in ${s.name}`);
        toggle.querySelector('span').textContent = `${open ? 'Hide' : 'Show'} pages`;
        syncSelectionUI();
      };
      el.querySelector('.file-select').onclick = () => {
        state.selection = new Set(filePages(id).map((p) => p.uid)); state.anchorUid = filePages(id)[0]?.uid;
        syncSelectionUI();
      };
      el.querySelectorAll('[data-move]').forEach((b) => { b.onclick = () => moveFileBy(id, Number(b.dataset.move)); });
      el.querySelector('.file-remove').onclick = () => deletePages(filePages(id).map((p) => p.uid));
      const head = el.querySelector('.file-head');
      head.addEventListener('dragstart', (e) => {
        if (pointerDrag) { e.preventDefault(); return; }
        dragFileId = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-pdfwb-file', id);
        el.classList.add('dragging');
      });
      head.addEventListener('dragend', endOrganizerDrag);
      el.addEventListener('dragover', (e) => {
        if (!dragFileId || dragFileId === id) return;
        e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
        const r = head.getBoundingClientRect(); clearDropMarks();
        el.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
        scrollDuringDrag(e);
      });
      el.addEventListener('drop', (e) => {
        if (!dragFileId) return; e.preventDefault(); e.stopPropagation();
        const moving = dragFileId, r = head.getBoundingClientRect(), after = e.clientY >= r.top + r.height / 2;
        endOrganizerDrag(); moveFile(moving, id, after);
      });
      const grid = el.querySelector('.thumb-grid'); fileGrids.set(id, grid);
      grid.addEventListener('dragover', (e) => {
        if (!canDropPages(pages[0])) return; e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = 'move'; scrollDuringDrag(e);
      });
      grid.addEventListener('drop', (e) => {
        if (!canDropPages(pages[0])) return; e.preventDefault(); e.stopPropagation();
        const moving = [...dragUids], last = filePages(id).at(-1);
        endOrganizerDrag(); movePages(moving, indexOfUid(last.uid) + 1);
      });
      list.append(el);
    });
  }
  $('#file-list').addEventListener('dragover', (e) => {
    if (!dragFileId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; scrollDuringDrag(e);
  });
  $('#file-list').addEventListener('drop', (e) => {
    if (!dragFileId) return; e.preventDefault();
    const moving = dragFileId; endOrganizerDrag(); moveFile(moving, null);
  });

  // Mouse/pen reordering uses pointer capture so selections survive the whole
  // gesture. Touch keeps native scrolling; the same moves are available via arrows.
  const organizer = $('#rail-left');
  function updatePointerDrop() {
    if (!pointerDrag?.active) return;
    const { clientX, clientY } = pointerDrag.position;
    const hit = document.elementFromPoint(clientX, clientY);
    pointerDrag.drop = null; clearDropMarks();
    if (!hit || !organizer.contains(hit)) return;
    if (dragFileId) {
      const card = hit.closest('.file-card');
      if (card && card.dataset.srcId !== dragFileId) {
        const r = card.querySelector('.file-head').getBoundingClientRect(), after = clientY >= r.top + r.height / 2;
        card.classList.add(after ? 'drop-after' : 'drop-before');
        pointerDrag.drop = { id: card.dataset.srcId, after };
      } else if (!card && hit.closest('#file-list, #file-scroll')) pointerDrag.drop = { id: null, after: true };
    } else {
      const thumb = hit.closest('.thumb');
      if (thumb && canDropPages(pageByUid(thumb.dataset.uid))) {
        const r = thumb.getBoundingClientRect(), after = clientX >= r.left + r.width / 2;
        thumb.classList.add(after ? 'drop-after' : 'drop-before');
        pointerDrag.drop = { index: indexOfUid(thumb.dataset.uid) + (after ? 1 : 0) };
      } else if (!thumb && hit.closest('.thumb-grid')) {
        const card = hit.closest('.file-card'), last = card ? filePages(card.dataset.srcId).at(-1) : state.pages.at(-1);
        if (last && canDropPages(last)) pointerDrag.drop = { index: indexOfUid(last.uid) + 1 };
      }
    }
    if (dragBadge) { dragBadge.style.left = clientX + 14 + 'px'; dragBadge.style.top = clientY + 14 + 'px'; }
  }
  function finishPointerDrag(apply = false) {
    const drag = pointerDrag; if (!drag) return;
    pointerDrag = null; cancelAnimationFrame(drag.raf);
    const moving = [...dragUids], fileId = dragFileId;
    endOrganizerDrag();
    if (organizer.hasPointerCapture(drag.pointerId)) organizer.releasePointerCapture(drag.pointerId);
    if (!drag.active) return;
    suppressOrganizerClick = true; setTimeout(() => { suppressOrganizerClick = false; }, 0);
    if (!apply || !drag.drop) return;
    if (fileId) moveFile(fileId, drag.drop.id, drag.drop.after);
    else movePages(moving, drag.drop.index);
  }
  organizer.addEventListener('click', (e) => {
    if (suppressOrganizerClick) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  organizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || e.target.closest('button')) return;
    const item = e.target.closest('.thumb, .file-head'); if (!item) return;
    e.preventDefault(); item.focus({ preventScroll: true });
    pointerDrag = { item, pointerId: e.pointerId, x: e.clientX, y: e.clientY, position: e, modifiers: { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey }, active: false, drop: null };
    organizer.setPointerCapture(e.pointerId);
  });
  organizer.addEventListener('pointermove', (e) => {
    const drag = pointerDrag; if (!drag || drag.pointerId !== e.pointerId) return;
    drag.position = e;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      if (drag.item.classList.contains('file-head')) {
        dragFileId = drag.item.closest('.file-card').dataset.srcId; drag.item.closest('.file-card').classList.add('dragging');
      } else {
        const u = drag.item.dataset.uid;
        if (drag.modifiers.shiftKey || !state.selection.has(u)) onThumbClick(u, drag.modifiers);
        dragUids = orderedSelection();
        if (!canDropPages(pageByUid(u))) { finishPointerDrag(); toast('Use All pages to move a selection from different files.'); return; }
        for (const uid of dragUids) thumbEls.get(uid)?.classList.add('dragging');
      }
      drag.active = true;
      dragBadge = document.createElement('div'); dragBadge.className = 'drag-count';
      const count = dragFileId ? filePages(dragFileId).length : dragUids.length;
      dragBadge.textContent = dragFileId ? `1 file · ${count} pages` : `${count} page${count === 1 ? '' : 's'}`;
      document.body.append(dragBadge);
      const tick = () => { if (pointerDrag !== drag) return; scrollDuringDrag(drag.position); updatePointerDrop(); drag.raf = requestAnimationFrame(tick); };
      drag.raf = requestAnimationFrame(tick);
    }
    e.preventDefault(); updatePointerDrop();
  });
  organizer.addEventListener('pointerup', (e) => {
    if (pointerDrag?.pointerId !== e.pointerId) return;
    if (!pointerDrag.active && pointerDrag.item.classList.contains('thumb')) {
      onThumbClick(pointerDrag.item.dataset.uid, pointerDrag.modifiers);
      suppressOrganizerClick = true; setTimeout(() => { suppressOrganizerClick = false; }, 0);
    }
    finishPointerDrag(true);
  });
  organizer.addEventListener('pointercancel', () => finishPointerDrag());
  organizer.addEventListener('lostpointercapture', () => finishPointerDrag());
  organizer.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pointerDrag) { finishPointerDrag(); e.preventDefault(); } });

  // ---------- Search ----------
  async function pageTextInfo(p) {
    const src = srcOf(p);
    if (src.textCache.has(p.srcPage)) return src.textCache.get(p.srcPage);
    const tc = await pdfPageOf(p).getTextContent();
    let text = ''; const spans = [];
    for (let i = 0; i < tc.items.length; i++) {
      const it = tc.items[i]; if (typeof it.str !== 'string') continue;
      spans.push({ i, start: text.length, end: text.length + it.str.length });
      text += it.str; if (it.hasEOL) text += '\n';
    }
    const info = { text, lower: text.toLowerCase(), spans, items: tc.items };
    src.textCache.set(p.srcPage, info); return info;
  }
  function matchRects(info, s, e) {
    const rects = [];
    for (const sp of info.spans) {
      if (sp.end <= s || sp.start >= e) continue;
      const it = info.items[sp.i]; const len = Math.max(1, it.str.length);
      const a = Math.max(s, sp.start) - sp.start, b = Math.min(e, sp.end) - sp.start;
      const h = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      const w = it.width || 0; const ex = it.transform[4], ey = it.transform[5];
      rects.push({ x: ex + w * (a / len), y: ey - h * 0.22, w: w * ((b - a) / len), h: h * 1.05 });
    }
    return rects;
  }
  const snippetOf = (text, at, len) => ({
    pre: (at > 30 ? '…' : '') + text.slice(Math.max(0, at - 30), at).replace(/\n/g, ' '),
    match: text.slice(at, at + len),
    post: text.slice(at + len, at + len + 40).replace(/\n/g, ' '),
  });
  async function runSearch(q) {
    const S = state.search; S.query = q; S.results = []; S.index = -1;
    if (!q.trim()) { renderResults(); redrawAll(); return; }
    busy(true);
    try {
      const lq = q.toLowerCase();
      for (const p of state.pages) {
        const info = await pageTextInfo(p); let from = 0;
        for (;;) {
          const at = info.lower.indexOf(lq, from); if (at < 0) break;
          S.results.push({ uid: p.uid, start: at, snippet: snippetOf(info.text, at, lq.length), rects: matchRects(info, at, at + lq.length) });
          from = at + Math.max(1, lq.length);
          if (S.results.length > 3000) break;
        }
        if (S.results.length > 3000) break;
      }
    } catch (e) { console.warn(e); toast('Search failed on one of the pages.', { error: true }); }
    finally { busy(false); }
    renderResults();
    if (S.results.length) gotoResult(0); else redrawAll();
    showTab('rail-left', 'search');
  }
  function renderResults() {
    const S = state.search; const list = $('#result-list'); list.replaceChildren();
    $('#search-count').textContent = S.query ? (S.results.length ? `${S.index + 1}/${S.results.length}` : '0') : '';
    $('#search-hint').textContent = !S.query ? 'Type in the search box and press Enter.' : S.results.length ? `${S.results.length} match${S.results.length !== 1 ? 'es' : ''} for “${S.query}”` : `No matches for “${S.query}”.`;
    S.results.forEach((r, i) => {
      const el = document.createElement('div'); el.className = 'result' + (i === S.index ? ' active' : '');
      el.innerHTML = `<span class="pg">p.${indexOfUid(r.uid) + 1}</span><span class="snip">${esc(r.snippet.pre)}<mark>${esc(r.snippet.match)}</mark>${esc(r.snippet.post)}</span>`;
      el.onclick = () => gotoResult(i); list.append(el);
    });
  }
  function gotoResult(i) {
    const S = state.search; if (!S.results.length) return;
    const prev = S.index >= 0 ? S.results[S.index] : null;
    S.index = mod(i, S.results.length);
    const r = S.results[S.index]; const idx = indexOfUid(r.uid); if (idx < 0) return;
    const p = state.pages[idx]; const el = pageEls.get(p.uid);
    if (el && r.rects.length) { const vp = vpFor(p, state.zoom); const [, vy] = vp.convertToViewportPoint(r.rects[0].x, r.rects[0].y + r.rects[0].h); viewer.scrollTop = el.offsetTop + vy - viewer.clientHeight * 0.35; }
    else goToPage(idx);
    state.current = idx; updatePageUI();
    if (prev) redrawPage(prev.uid); redrawPage(r.uid);
    $('#search-count').textContent = `${S.index + 1}/${S.results.length}`;
    $$('#result-list .result').forEach((e, k) => e.classList.toggle('active', k === S.index));
    const act = $('#result-list .result.active');
    if (act) {
      const scroller = act.closest('.panel-scroll');
      const rect = act.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      if (rect.top < bounds.top) scroller.scrollTop -= bounds.top - rect.top;
      else if (rect.bottom > bounds.bottom) scroller.scrollTop += rect.bottom - bounds.bottom;
    }
  }

  // ---------- Forms ----------
  function fieldPageIndexer(src) {
    const pages = src.lib.getPages();
    return (field) => {
      const out = new Set();
      let widgets = []; try { widgets = field.acroField.getWidgets(); } catch { widgets = []; }
      for (const w of widgets) {
        const pRef = w.dict.get(PDFName.of('P'));
        let i = pRef ? pages.findIndex((pg) => pg.ref === pRef) : -1;
        if (i < 0) i = pages.findIndex((pg) => { const annots = pg.node.Annots(); return annots ? annots.asArray().some((r) => src.lib.context.lookup(r) === w.dict) : false; });
        if (i >= 0) out.add(i);
      }
      return [...out].sort((a, b) => a - b);
    };
  }
  function refreshForms() {
    const body = $('#forms-body'); body.replaceChildren();
    const srcIds = [...new Set(state.pages.map((p) => p.srcId))]; let any = false;
    for (const id of srcIds) {
      const s = state.sources.get(id); if (!s.lib || !s.hasForm) continue;
      let fields = []; try { fields = s.lib.getForm().getFields(); } catch { continue; }
      if (!fields.length) continue; any = true;
      const pageIdx = fieldPageIndexer(s);
      const group = document.createElement('div'); group.className = 'stack';
      group.innerHTML = `<div class="form-group-title">${esc(s.name)}</div>`;
      for (const f of fields) {
        const name = f.getName(); const pgs = pageIdx(f);
        const wrap = document.createElement('div'); wrap.className = 'form-field';
        const lab = document.createElement('div'); lab.className = 'name';
        lab.innerHTML = `<span>${esc(name)}</span><span class="pg">${pgs.length ? 'p. ' + pgs.map((i) => i + 1).join(', ') : ''}</span>`;
        wrap.append(lab);
        let ctl = null;
        try {
          if (f instanceof PDFLib.PDFTextField) {
            const multi = f.isMultiline();
            ctl = document.createElement(multi ? 'textarea' : 'input'); ctl.className = 'input sm'; ctl.value = f.getText() || ''; if (multi) ctl.rows = 3;
          } else if (f instanceof PDFLib.PDFCheckBox) {
            const l = document.createElement('label'); l.className = 'check';
            ctl = document.createElement('input'); ctl.type = 'checkbox'; ctl.checked = f.isChecked();
            l.append(ctl, document.createTextNode(' Checked')); wrap.append(l);
          } else if (f instanceof PDFLib.PDFRadioGroup || f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList) {
            const multi = f instanceof PDFLib.PDFOptionList;
            const cur = f instanceof PDFLib.PDFRadioGroup ? [f.getSelected()].filter(Boolean) : f.getSelected();
            ctl = document.createElement('select'); ctl.className = 'input sm'; if (multi) { ctl.multiple = true; ctl.size = Math.min(5, f.getOptions().length); ctl.style.height = 'auto'; }
            ctl.innerHTML = (multi ? '' : '<option value="">—</option>') + f.getOptions().map((o) => `<option value="${esc(o)}" ${cur.includes(o) ? 'selected' : ''}>${esc(o)}</option>`).join('');
          } else {
            const n = document.createElement('div'); n.className = 'hint';
            n.textContent = f instanceof PDFLib.PDFSignature ? 'Signature field — place a visual signature from the Annotate tab instead.' : 'Button (not editable)';
            wrap.append(n);
          }
        } catch (e) { const n = document.createElement('div'); n.className = 'hint'; n.textContent = 'Could not read this field.'; wrap.append(n); }
        if (ctl) { ctl.dataset.field = name; ctl.id = 'ff-' + name.replace(/[^\w-]/g, '_'); if (!ctl.parentElement) wrap.append(ctl); }
        group.append(wrap);
      }
      const apply = document.createElement('button'); apply.className = 'btn primary'; apply.type = 'button'; apply.textContent = 'Apply to document';
      apply.onclick = () => applyForm(s, group);
      group.append(apply);
      const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Values are written into the file and shown on the pages. Export flattens the fields.';
      group.append(hint);
      body.append(group);
    }
    if (!any) body.innerHTML = '<div class="hint">No fillable form fields in the open files. Text fields, checkboxes, radio buttons and dropdowns appear here when a PDF has them.</div>';
  }
  async function applyForm(src, group) {
    const values = new Map();
    for (const ctl of $$('[data-field]', group)) {
      if (ctl.type === 'checkbox') values.set(ctl.dataset.field, ctl.checked);
      else if (ctl.multiple) values.set(ctl.dataset.field, [...ctl.selectedOptions].map((o) => o.value));
      else values.set(ctl.dataset.field, ctl.value);
    }
    busy(true);
    try {
      const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
      const form = doc.getForm(); const problems = [];
      for (const f of form.getFields()) {
        const name = f.getName(); if (!values.has(name)) continue; const v = values.get(name);
        try {
          if (f instanceof PDFLib.PDFTextField) f.setText(v || '');
          else if (f instanceof PDFLib.PDFCheckBox) { if (v) f.check(); else f.uncheck(); }
          else if (f instanceof PDFLib.PDFRadioGroup) { if (v) f.select(v); else f.clear(); }
          else if (f instanceof PDFLib.PDFDropdown) { if (v) f.select(v); else f.clear(); }
          else if (f instanceof PDFLib.PDFOptionList) { if (Array.isArray(v) && v.length) f.select(v); else f.clear(); }
        } catch (e) { problems.push(name); }
      }
      try { form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)); } catch (e) { console.warn('appearances', e); }
      const bytes = await doc.save({ useObjectStreams: false });
      const nsrc = await loadSource(bytes, src.name);
      commit();
      for (const p of state.pages) if (p.srcId === src.id) p.srcId = nsrc.id;
      rebuild();
      toast(problems.length ? `Applied. Some fields could not be set: ${problems.join(', ')}` : 'Form values applied to the document.', { ms: problems.length ? 8000 : 3000 });
    } catch (e) {
      console.error(e); toast('The form could not be updated: ' + (e.message || e), { error: true, ms: 8000 });
    } finally { busy(false); }
  }

  // ---------- Document panel (metadata, watermark, page numbers) ----------
  function syncDocPanel() {
    const M = state.metadata, W = state.watermark, N = state.pageNumbers;
    $('#md-title').value = M.title || ''; $('#md-author').value = M.author || ''; $('#md-subject').value = M.subject || ''; $('#md-keywords').value = M.keywords || '';
    $('#wm-on').checked = W.enabled; $('#wm-text').value = W.text; $('#wm-size').value = W.size; $('#wm-angle').value = W.angle; $('#wm-color').value = W.color; $('#wm-opacity').value = Math.round(W.opacity * 100); $('#wm-opacity-val').textContent = Math.round(W.opacity * 100) + '%';
    $('#pn-on').checked = N.enabled; $('#pn-format').value = N.format; $('#pn-position').value = N.position; $('#pn-size').value = N.size; $('#pn-margin').value = N.margin; $('#pn-start').value = N.start;
  }
  function readDocPanel() {
    const M = state.metadata, W = state.watermark, N = state.pageNumbers;
    M.title = $('#md-title').value; M.author = $('#md-author').value; M.subject = $('#md-subject').value; M.keywords = $('#md-keywords').value;
    W.enabled = $('#wm-on').checked; W.text = $('#wm-text').value; W.size = clamp(Number($('#wm-size').value) || 64, 4, 600); W.angle = Number($('#wm-angle').value) || 0; W.color = $('#wm-color').value; W.opacity = clamp(Number($('#wm-opacity').value) / 100, 0.02, 1);
    $('#wm-opacity-val').textContent = Math.round(W.opacity * 100) + '%';
    N.enabled = $('#pn-on').checked; N.format = $('#pn-format').value; N.position = $('#pn-position').value; N.size = clamp(Number($('#pn-size').value) || 10, 4, 100); N.margin = clamp(Number($('#pn-margin').value) || 0, 0, 400); N.start = Number($('#pn-start').value) || 1;
  }
  const docPanel = $('[data-panel="document"]');
  docPanel.addEventListener('input', (e) => { if (!e.target.matches('input, select')) return; beginEdit(); readDocPanel(); redrawAll(); });
  docPanel.addEventListener('change', (e) => { if (!e.target.matches('input, select')) return; beginEdit(); readDocPanel(); endEdit(); redrawAll(); });

  // ---------- Signatures ----------
  let sigs = [];
  try { sigs = JSON.parse(localStorage.getItem('pdfwb.signatures') || '[]'); if (!Array.isArray(sigs)) sigs = []; } catch { sigs = []; }
  function saveSigs() { try { localStorage.setItem('pdfwb.signatures', JSON.stringify(sigs.slice(-12))); } catch { /* storage unavailable */ } }
  function renderSigList() {
    const list = $('#sig-list'); list.replaceChildren();
    for (const s of sigs) {
      const d = document.createElement('div'); d.className = 'sig-item'; d.title = 'Click, then click on a page to place';
      const img = document.createElement('img'); img.alt = 'Saved signature'; img.src = s.dataUrl;
      const del = document.createElement('button'); del.className = 'del'; del.type = 'button'; del.title = 'Remove'; del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); sigs = sigs.filter((x) => x.id !== s.id); saveSigs(); renderSigList(); };
      d.append(img, del);
      d.onclick = () => startPlacement(s.dataUrl, 'signature');
      list.append(d);
    }
    $('#sig-hint').textContent = sigs.length ? 'Click a signature, then click on the page to place it. Drag the corner handle to resize.' : 'Create a signature by drawing, typing or uploading an image, then place it on any page.';
  }
  async function addAsset(dataUrl) {
    for (const a of state.assets.values()) if (a.dataUrl === dataUrl) return a;
    const img = await loadImage(dataUrl);
    const as = { id: uid(), dataUrl, img, w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
    state.assets.set(as.id, as); return as;
  }
  async function startPlacement(dataUrl, kind) {
    if (!state.pages.length) { toast('Open a PDF first.', { error: true }); return; }
    try {
      const as = await addAsset(dataUrl);
      state.pending = { assetId: as.id, kind };
      setTool('place');
      setHint(kind === 'signature' ? 'Click on a page to place the signature · Esc cancels' : 'Click on a page to place the image · Esc cancels');
      if (narrow()) closeMobilePanels();
    } catch (e) { toast('The image could not be used: ' + (e.message || e), { error: true }); }
  }
  function trimCanvas(c, pad = 6) {
    const ctx = c.getContext('2d'); const { width: w, height: h } = c; if (!w || !h) return c;
    const d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (d[(y * w + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    if (x1 < 0) return null;
    const out = document.createElement('canvas'); out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
    out.getContext('2d').drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
    return out;
  }

  const sigDlg = $('#dlg-sign'); const sigPad = $('#sig-pad'); const sigPreview = $('#sig-preview'); const sigUpPreview = $('#sig-upload-preview');
  let sigTab = 'draw', sigStrokes = [], sigColor = '#1A237E', sigUploadCanvas = null;
  function padSetup() {
    const dpr = Math.min(2, window.devicePixelRatio || 1); const r = sigPad.getBoundingClientRect();
    const w = Math.max(200, r.width), h = Math.max(100, r.height);
    sigPad.width = Math.round(w * dpr); sigPad.height = Math.round(h * dpr);
    sigPad._scale = dpr; padRedraw();
  }
  function padRedraw() {
    const ctx = sigPad.getContext('2d'); const s = sigPad._scale || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sigPad.width, sigPad.height);
    ctx.setTransform(s, 0, 0, s, 0, 0); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const st of sigStrokes) drawSmooth(ctx, st.pts, st.color, st.width);
  }
  function drawSmooth(ctx, pts, color, width) {
    if (!pts.length) return; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length < 3) { ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); ctx.stroke(); return; }
    for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); ctx.stroke();
  }
  let padDrawing = null;
  const padPoint = (e) => { const r = sigPad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  sigPad.addEventListener('pointerdown', (e) => { e.preventDefault(); sigPad.setPointerCapture(e.pointerId); padDrawing = { pts: [padPoint(e)], color: sigColor, width: 2.6 }; sigStrokes.push(padDrawing); padRedraw(); });
  sigPad.addEventListener('pointermove', (e) => { if (!padDrawing) return; const p = padPoint(e); const l = padDrawing.pts[padDrawing.pts.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) < 1.2) return; padDrawing.pts.push(p); padRedraw(); });
  const padUp = () => { padDrawing = null; };
  sigPad.addEventListener('pointerup', padUp); sigPad.addEventListener('pointercancel', padUp);
  $('#sig-clear').addEventListener('click', () => { sigStrokes = []; padRedraw(); });
  $('#sig-colors').addEventListener('click', (e) => {
    const b = e.target.closest('.swatch'); if (!b) return;
    sigColor = b.dataset.color; $$('#sig-colors .swatch').forEach((s) => s.classList.toggle('active', s === b));
    if (sigTab === 'type') typePreview();
  });
  $$('[data-sigtab]').forEach((b) => b.addEventListener('click', () => {
    sigTab = b.dataset.sigtab;
    $$('[data-sigtab]').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-sigpane]').forEach((x) => x.classList.toggle('active', x.dataset.sigpane === sigTab));
    if (sigTab === 'draw') padSetup(); if (sigTab === 'type') typePreview();
  }));
  async function typePreview() {
    const text = $('#sig-text').value.trim() || 'Your name'; const font = $('#sig-font').value;
    try { await document.fonts.load(`48px "${font}"`); } catch { /* fallback font */ }
    const ctx = sigPreview.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sigPreview.width, sigPreview.height);
    ctx.fillStyle = sigColor; ctx.font = `56px "${font}", cursive`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(text, sigPreview.width / 2, sigPreview.height / 2);
  }
  $('#sig-text').addEventListener('input', typePreview); $('#sig-font').addEventListener('change', typePreview);
  async function uploadPreview() {
    const f = $('#sig-file').files && $('#sig-file').files[0]; sigUploadCanvas = null;
    const ctx = sigUpPreview.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sigUpPreview.width, sigUpPreview.height);
    if (!f) return;
    try {
      const img = await loadImage(await readAsDataURL(f));
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      if ($('#sig-transparent').checked) {
        const id = cx.getImageData(0, 0, c.width, c.height); const d = id.data;
        for (let i = 0; i < d.length; i += 4) { const lum = (d[i] + d[i + 1] + d[i + 2]) / 3; if (lum > 235) d[i + 3] = 0; else if (lum > 190) d[i + 3] = Math.round(d[i + 3] * (235 - lum) / 45); }
        cx.putImageData(id, 0, 0);
      }
      sigUploadCanvas = trimCanvas(c, 4) || c;
      const s = Math.min(sigUpPreview.width / sigUploadCanvas.width, sigUpPreview.height / sigUploadCanvas.height, 1);
      ctx.drawImage(sigUploadCanvas, (sigUpPreview.width - sigUploadCanvas.width * s) / 2, (sigUpPreview.height - sigUploadCanvas.height * s) / 2, sigUploadCanvas.width * s, sigUploadCanvas.height * s);
    } catch (e) { toast('That image could not be read.', { error: true }); }
  }
  $('#sig-file').addEventListener('change', uploadPreview); $('#sig-transparent').addEventListener('change', uploadPreview);
  $('#sig-new').addEventListener('click', () => { sigStrokes = []; sigDlg.showModal(); requestAnimationFrame(() => { padSetup(); typePreview(); }); });
  $('#sig-save').addEventListener('click', async () => {
    let out = null;
    if (sigTab === 'draw') {
      if (!sigStrokes.length) { toast('Draw your signature first.', { error: true }); return; }
      const s = 3; const c = document.createElement('canvas'); c.width = Math.round(sigPad.width / (sigPad._scale || 1) * s); c.height = Math.round(sigPad.height / (sigPad._scale || 1) * s);
      const ctx = c.getContext('2d'); ctx.setTransform(s, 0, 0, s, 0, 0); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const st of sigStrokes) drawSmooth(ctx, st.pts, st.color, st.width);
      out = trimCanvas(c, 8);
    } else if (sigTab === 'type') {
      const text = $('#sig-text').value.trim(); if (!text) { toast('Type your name first.', { error: true }); return; }
      const font = $('#sig-font').value; try { await document.fonts.load(`160px "${font}"`); } catch { /* fallback */ }
      const m = document.createElement('canvas').getContext('2d'); m.font = `160px "${font}", cursive`;
      const tw = Math.ceil(m.measureText(text).width) + 80;
      const c = document.createElement('canvas'); c.width = tw; c.height = 260;
      const ctx = c.getContext('2d'); ctx.fillStyle = sigColor; ctx.font = m.font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(text, tw / 2, 130);
      out = trimCanvas(c, 8);
    } else {
      if (!sigUploadCanvas) { toast('Choose an image first.', { error: true }); return; }
      out = sigUploadCanvas;
    }
    if (!out) { toast('The signature is empty.', { error: true }); return; }
    const dataUrl = out.toDataURL('image/png');
    sigs.push({ id: uid(), dataUrl }); saveSigs(); renderSigList();
    sigDlg.close();
    startPlacement(dataUrl, 'signature');
  });

  // =====================================================================
  //  Export (pdf-lib)
  // =====================================================================
  const fx = (n) => Math.round(n * 100) / 100;
  const hexRgb = (hex) => {
    let h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };
  // Standard PDF fonts only cover WinAnsi; unsupported characters become '?' instead of failing the export.
  function sanitizeText(font, text) {
    try { font.encodeText(text.replace(/\n/g, ' ')); return text; }
    catch {
      return Array.from(text).map((ch) => { if (ch === '\n') return ch; try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
    }
  }

  async function drawAnnotPdf(page, a, ctx) {
    const { off } = ctx; const X = (v) => v + off.x, Y = (v) => v + off.y; const op = a.opacity ?? 1;
    switch (a.type) {
      case 'rect': {
        const r = normRect(a); const stroked = !!a.stroke && a.strokeWidth > 0;
        page.drawRectangle({ x: X(r.x), y: Y(r.y), width: r.w, height: r.h, color: a.fill ? hexRgb(a.fill) : undefined, borderColor: stroked ? hexRgb(a.stroke) : undefined, borderWidth: stroked ? a.strokeWidth : 0, opacity: op, borderOpacity: op });
        break;
      }
      case 'ellipse': {
        const r = normRect(a); const stroked = !!a.stroke && a.strokeWidth > 0;
        page.drawEllipse({ x: X(r.x + r.w / 2), y: Y(r.y + r.h / 2), xScale: r.w / 2, yScale: r.h / 2, color: a.fill ? hexRgb(a.fill) : undefined, borderColor: stroked ? hexRgb(a.stroke) : undefined, borderWidth: stroked ? a.strokeWidth : 0, opacity: op, borderOpacity: op });
        break;
      }
      case 'highlight': {
        const r = normRect(a);
        page.drawRectangle({ x: X(r.x), y: Y(r.y), width: r.w, height: r.h, color: hexRgb(a.color), borderWidth: 0, opacity: op, blendMode: BlendMode.Multiply });
        break;
      }
      case 'whiteout': {
        const r = normRect(a);
        page.drawRectangle({ x: X(r.x), y: Y(r.y), width: r.w, height: r.h, color: rgb(1, 1, 1), borderWidth: 0 });
        break;
      }
      case 'ink': {
        for (const s of a.strokes) {
          if (!s.length) continue;
          const pts = s.length === 1 ? [s[0], s[0]] : s;
          const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${fx(x)} ${fx(-y)}`).join(' ');
          page.drawSvgPath(d, { x: off.x, y: off.y, borderColor: hexRgb(a.color), borderWidth: a.width, borderOpacity: op, borderLineCap: LineCapStyle.Round });
        }
        break;
      }
      case 'arrow': {
        const h = arrowHead(a);
        page.drawLine({ start: { x: X(a.x1), y: Y(a.y1) }, end: { x: X(h.base[0]), y: Y(h.base[1]) }, thickness: a.width, color: hexRgb(a.color), opacity: op, lineCap: LineCapStyle.Round });
        const tri = [h.tip, h.left, h.right].map(([x, y]) => `${fx(x)} ${fx(-y)}`);
        page.drawSvgPath(`M${tri[0]} L${tri[1]} L${tri[2]} Z`, { x: off.x, y: off.y, color: hexRgb(a.color), opacity: op, borderWidth: 0 });
        break;
      }
      case 'text': {
        const font = await ctx.getFont(a.font || 'Helvetica');
        page.drawText(sanitizeText(font, a.text), { x: X(a.x), y: Y(a.y), size: a.size, font, color: hexRgb(a.color), opacity: op, rotate: degrees(a.rot || 0), lineHeight: a.size * 1.2 });
        break;
      }
      case 'image': {
        const img = await ctx.getImage(a.assetId);
        if (img) page.drawImage(img, { x: X(a.x), y: Y(a.y), width: a.w, height: a.h, rotate: degrees(a.rot || 0), opacity: op });
        break;
      }
      default: break;
    }
  }

  async function drawDecorationsPdf(page, p, index, ctx) {
    const { off } = ctx; const vp1 = vpFor(p, 1); const rot = totalRot(p);
    const wm = state.watermark;
    if (wm.enabled && wm.text) {
      const font = await ctx.getFont('HelveticaBold'); const text = sanitizeText(font, wm.text);
      const tw = font.widthOfTextAtSize(text, wm.size); const w = watermarkPlacement(p, vp1, tw);
      page.drawText(text, { x: w.ax + off.x, y: w.ay + off.y, size: wm.size, font, color: hexRgb(wm.color), opacity: Number(wm.opacity), rotate: degrees(w.angle) });
    }
    const pn = state.pageNumbers;
    if (pn.enabled) {
      const font = await ctx.getFont('Helvetica');
      const pl = pageNumberPlacement(p, index, vp1, (t, s) => font.widthOfTextAtSize(sanitizeText(font, t), s));
      page.drawText(sanitizeText(font, pl.text), { x: pl.ux + off.x, y: pl.uy + off.y, size: pn.size, font, color: rgb(0.13, 0.13, 0.13), rotate: degrees(rot) });
    }
  }

  async function buildPdf({ pages, annots = true, deco = true, flatten = true }) {
    const out = await PDFDocument.create();
    const fontCache = new Map();
    const getFont = async (name) => {
      const key = StandardFonts[name] ? name : 'Helvetica';
      if (!fontCache.has(key)) fontCache.set(key, await out.embedFont(StandardFonts[key]));
      return fontCache.get(key);
    };
    const imgCache = new Map();
    const getImage = async (assetId) => {
      if (imgCache.has(assetId)) return imgCache.get(assetId);
      const as = state.assets.get(assetId); let img = null;
      if (as) { try { img = as.dataUrl.startsWith('data:image/jpeg') ? await out.embedJpg(as.dataUrl) : await out.embedPng(as.dataUrl); } catch (e) { console.warn('embed image', e); } }
      imgCache.set(assetId, img); return img;
    };
    // Load a fresh pdf-lib document per source so the in-memory originals stay untouched; flatten forms when asked.
    const libDocs = new Map();
    for (const srcId of new Set(pages.map((p) => p.srcId))) {
      const src = state.sources.get(srcId); let doc = null;
      if (src.lib) {
        try {
          doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
          if (flatten && src.hasForm) { try { const form = doc.getForm(); if (form.getFields().length) form.flatten(); } catch (e) { console.warn('flatten failed', e); } }
        } catch (e) { console.warn('reload failed', e); doc = null; }
      }
      libDocs.set(srcId, doc);
    }
    // Copy pages: one copyPages call per source keeps shared resources (fonts, images) deduplicated.
    const copied = new Map();
    for (const [srcId, doc] of libDocs) {
      if (!doc) continue;
      const list = pages.filter((p) => p.srcId === srcId); const first = new Map(); const dups = [];
      for (const p of list) { if (!first.has(p.srcPage)) first.set(p.srcPage, p.uid); else dups.push(p); }
      const idx = [...first.keys()];
      const cps = await out.copyPages(doc, idx);
      idx.forEach((pi, i) => copied.set(first.get(pi), cps[i]));
      for (const p of dups) { const [cp] = await out.copyPages(doc, [p.srcPage]); copied.set(p.uid, cp); }
    }
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]; const pg = pdfPageOf(p); let page; let off = { x: 0, y: 0 };
      if (copied.has(p.uid)) page = out.addPage(copied.get(p.uid));
      else {
        // Fallback for files pdf-lib cannot parse: rasterize the page with pdf.js and embed it as an image.
        const vp0 = pg.getViewport({ scale: 1, rotation: 0 });
        const scale = Math.min(2.5, 3000 / Math.max(vp0.width, vp0.height));
        const vp = pg.getViewport({ scale, rotation: 0 });
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const cx = c.getContext('2d', { alpha: false }); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: cx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
        const jpg = await out.embedJpg(c.toDataURL('image/jpeg', 0.92));
        page = out.addPage([vp0.width, vp0.height]);
        page.drawImage(jpg, { x: 0, y: 0, width: vp0.width, height: vp0.height });
        off = { x: -vp0.viewBox[0], y: -vp0.viewBox[1] };
      }
      page.setRotation(degrees(totalRot(p)));
      const ctx = { getFont, getImage, off };
      if (annots) for (const a of p.annots) { if (a._draft) continue; try { await drawAnnotPdf(page, a, ctx); } catch (e) { console.warn('annotation export', e); } }
      if (deco) await drawDecorationsPdf(page, p, indexOfUid(p.uid), ctx);
    }
    const M = state.metadata;
    if (M.title) out.setTitle(M.title); if (M.author) out.setAuthor(M.author); if (M.subject) out.setSubject(M.subject);
    if (M.keywords) out.setKeywords(M.keywords.split(',').map((k) => k.trim()).filter(Boolean));
    out.setProducer('PDF Workbench'); out.setCreator('PDF Workbench'); out.setModificationDate(new Date());
    return out.save({ useObjectStreams: true });
  }

  async function saveFile(filename, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const dl = await capDownloads;
    if (dl) {
      try { await dl.save({ filename, data: blob }); toast(`Saved ${filename}`); return true; }
      catch (e) {
        const code = e && e.code;
        if (code === 'declined') { toast('Save cancelled.'); return false; }
        if (code === 'rate_limited') { toast('A save prompt is already open. Try again in a moment.', { error: true }); return false; }
        if (code === 'too_large') { toast('The file is too large for this destination.', { error: true }); return false; }
        if (code === 'rejected_extension' || code === 'extension_not_enabled') { toast('This file type cannot be saved here.', { error: true }); return false; }
        console.warn('downloads.save', e);
        if (!['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(code)) { toast('Could not save: ' + (e.message || code), { error: true }); return false; }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Downloading ${filename}`);
    return true;
  }

  const exDlg = $('#dlg-export');
  function baseName() {
    const ids = [...new Set(state.pages.map((p) => p.srcId))];
    if (!ids.length) return 'document';
    if (ids.length === 1) return state.sources.get(ids[0]).name.replace(/\.pdf$/i, '');
    return 'merged';
  }
  function openExport() {
    if (!state.pages.length) { toast('Nothing to export yet. Open a PDF first.', { error: true }); return; }
    commitTextEditor();
    $('#ex-name').value = (baseName() === 'merged' ? 'merged' : baseName() + ' (edited)') + '.pdf';
    $('#ex-count-all').textContent = state.pages.length; $('#ex-count-sel').textContent = state.selection.size;
    $('#ex-scope-sel').disabled = !state.selection.size; if (!state.selection.size) $('#ex-scope-all').checked = true;
    const hasForms = [...new Set(state.pages.map((p) => p.srcId))].some((id) => state.sources.get(id).hasForm);
    $('#ex-flatten').disabled = !hasForms;
    const raster = state.pages.filter((p) => srcOf(p).libError).length;
    $('#ex-note').textContent = raster ? `${raster} page${raster > 1 ? 's' : ''} come from a file that could not be parsed for editing and will be exported as images.` : '';
    exDlg.showModal();
  }
  async function doExport({ uids = null, filename, annots = true, deco = true, flatten = true }) {
    busy(true);
    try {
      const pages = uids ? state.pages.filter((p) => uids.includes(p.uid)) : state.pages;
      const bytes = await buildPdf({ pages, annots, deco, flatten });
      const ok = await saveFile(filename, bytes, 'application/pdf');
      if (ok && !uids) state.dirty = false;
    } catch (e) { console.error(e); toast('Export failed: ' + (e.message || e), { error: true, ms: 9000 }); }
    finally { busy(false); }
  }
  $('#ex-go').addEventListener('click', async () => {
    const name = ($('#ex-name').value.trim() || 'document').replace(/\.pdf$/i, '') + '.pdf';
    const uids = $('#ex-scope-sel').checked ? orderedSelection() : null;
    exDlg.close();
    await doExport({ uids, filename: name, annots: $('#ex-annots').checked, deco: $('#ex-deco').checked, flatten: $('#ex-flatten').checked });
  });
  $('#ex-png').addEventListener('click', async () => { exDlg.close(); await exportPng(); });

  async function renderComposite(p, scale) {
    const pg = pdfPageOf(p); const vp = vpFor(p, scale);
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    paintAnnots(ctx, p, vp, 1, {}); paintDecorations(ctx, p, indexOfUid(p.uid), vp, 1);
    return c;
  }
  async function exportPng() {
    const p = currentPage(); if (!p) return;
    busy(true);
    try {
      const c = await renderComposite(p, 2);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      await saveFile(`${baseName()} page ${state.current + 1}.png`, blob, 'image/png');
    } catch (e) { toast('PNG export failed: ' + (e.message || e), { error: true }); }
    finally { busy(false); }
  }
  async function exportText() {
    if (!state.pages.length) { toast('Open a PDF first.', { error: true }); return; }
    busy(true);
    try {
      const parts = [];
      for (let i = 0; i < state.pages.length; i++) { const info = await pageTextInfo(state.pages[i]); parts.push(`--- Page ${i + 1} ---\n${info.text.trim()}\n`); }
      await saveFile(`${baseName()}.txt`, parts.join('\n'), 'text/plain');
    } catch (e) { toast('Text export failed: ' + (e.message || e), { error: true }); }
    finally { busy(false); }
  }
  function extractPages(uids) {
    if (!uids.length) return;
    doExport({ uids, filename: `${baseName()} pages ${pageRangeLabel(uids)}.pdf` });
  }

  // =====================================================================
  //  Wiring
  // =====================================================================
  const app = $('#app');
  const fileInput = $('#file-input'), imageInput = $('#image-input'); let fileMode = 'append';
  function pickFiles(mode) { fileMode = mode; fileInput.value = ''; fileInput.click(); }
  fileInput.addEventListener('change', () => { if (fileInput.files.length) openFiles(fileInput.files, fileMode); });
  $('#btn-open').addEventListener('click', () => pickFiles('replace'));
  $('#empty-open').addEventListener('click', () => pickFiles('replace'));
  $('#btn-add').addEventListener('click', () => pickFiles('append'));
  $('#files-add').addEventListener('click', () => pickFiles('append'));
  $('#pg-insert').addEventListener('click', () => { const uids = targetUids(); pickFiles(uids.length ? Math.max(...uids.map(indexOfUid)) + 1 : state.pages.length); });
  imageInput.addEventListener('change', async () => {
    const f = imageInput.files[0]; if (!f) return;
    try { let dataUrl = await readAsDataURL(f); if (!/^data:image\/(png|jpeg)/.test(dataUrl)) dataUrl = await convertToPng(dataUrl); startPlacement(dataUrl, 'image'); }
    catch (e) { toast('The image could not be read.', { error: true }); }
    imageInput.value = '';
  });

  $('#tool-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.tool-btn'); if (!b) return;
    const t = b.dataset.tool;
    if (t === 'image') { if (!state.pages.length) { toast('Open a PDF first.', { error: true }); return; } imageInput.value = ''; imageInput.click(); return; }
    setTool(t);
  });

  $('#btn-undo').addEventListener('click', undo); $('#btn-redo').addEventListener('click', redo);
  $('#btn-zoom-in').addEventListener('click', () => zoomBy(1.25)); $('#btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
  $('#zoom-select').addEventListener('change', (e) => { const v = e.target.value; setZoom(v === 'fit-width' || v === 'fit-page' ? v : Number(v)); });
  $('#btn-prev-page').addEventListener('click', () => goToPage(state.current - 1));
  $('#btn-next-page').addEventListener('click', () => goToPage(state.current + 1));
  $('#page-input').addEventListener('change', (e) => { const n = parseInt(e.target.value, 10); if (n >= 1) goToPage(n - 1); else updatePageUI(); e.target.blur(); });
  $('#page-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#btn-export').addEventListener('click', openExport); $('#btn-export-2').addEventListener('click', openExport);
  $('#btn-export-text').addEventListener('click', exportText);

  const searchInput = $('#search-input');
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = searchInput.value;
      if (q === state.search.query && state.search.results.length) gotoResult(state.search.index + (e.shiftKey ? -1 : 1));
      else runSearch(q);
    }
  });
  searchInput.addEventListener('input', () => { if (!searchInput.value && state.search.query) runSearch(''); });
  $('#search-next').addEventListener('click', () => (state.search.results.length ? gotoResult(state.search.index + 1) : runSearch(searchInput.value)));
  $('#search-prev').addEventListener('click', () => (state.search.results.length ? gotoResult(state.search.index - 1) : runSearch(searchInput.value)));

  $('#pg-rot-l').addEventListener('click', () => rotatePages(targetUids(), -90));
  $('#pg-rot-r').addEventListener('click', () => rotatePages(targetUids(), 90));
  $('#pg-up').addEventListener('click', () => moveSelectionBy(-1));
  $('#pg-down').addEventListener('click', () => moveSelectionBy(1));
  $('#pg-dup').addEventListener('click', () => duplicatePages(targetUids()));
  $('#pg-blank').addEventListener('click', () => { const u = targetUids(); insertBlankAfter(u.length ? u[u.length - 1] : null); });
  $('#pg-extract').addEventListener('click', () => extractPages(targetUids()));
  $('#pg-reverse').addEventListener('click', reversePages);
  $('#pg-all').addEventListener('click', () => { state.selection = new Set(state.pages.map((p) => p.uid)); syncSelectionUI(); });
  $('#pg-del').addEventListener('click', () => deletePages(targetUids()));

  function showTab(railId, tab) {
    const rail = document.getElementById(railId);
    $$('.tabs .tab', rail).forEach((t) => { t.classList.toggle('active', t.dataset.tab === tab); t.setAttribute('aria-selected', String(t.dataset.tab === tab)); });
    $$('.panel', rail).forEach((pn) => pn.classList.toggle('active', pn.dataset.panel === tab));
    if (railId === 'rail-left') { if (tab === 'files' || tab === 'pages') rebuildThumbs(); syncSelectionUI(); }
  }
  $$('.rail .tabs .tab').forEach((t) => t.addEventListener('click', () => showTab(t.closest('.rail').id, t.dataset.tab)));
  const mobileLayout = window.matchMedia('(max-width: 960px)');
  const narrow = () => mobileLayout.matches;
  const toolbarOptions = $('#toolbar-options');
  let panelOpener = null;
  function syncMobilePanels() {
    const mobile = narrow();
    const optionsOpen = mobile && toolbarOptions.classList.contains('open');
    toolbarOptions.inert = mobile && !optionsOpen;
    $('#btn-more').setAttribute('aria-expanded', String(optionsOpen));
    let anyOpen = optionsOpen;
    for (const side of ['left', 'right']) {
      const rail = $(`#rail-${side}`);
      const open = mobile ? rail.classList.contains('open') : !app.classList.contains(`no-${side}`);
      rail.inert = !open;
      $(`#btn-rail-${side}`).setAttribute('aria-expanded', String(open));
      anyOpen ||= mobile && open;
    }
    $('#panel-backdrop').hidden = !anyOpen;
  }
  function closeMobilePanels(restoreFocus = false) {
    toolbarOptions.classList.remove('open');
    $('#rail-left').classList.remove('open');
    $('#rail-right').classList.remove('open');
    if (restoreFocus && panelOpener) panelOpener.focus({ preventScroll: true });
    syncMobilePanels();
  }
  function toggleRail(side) {
    const rail = $(`#rail-${side}`);
    if (narrow()) {
      const open = rail.classList.contains('open');
      closeMobilePanels();
      panelOpener = $(`#btn-rail-${side}`);
      rail.classList.toggle('open', !open);
    } else app.classList.toggle(`no-${side}`);
    syncMobilePanels();
  }
  function openDocumentControls() {
    if (narrow()) {
      closeMobilePanels();
      panelOpener = $('#btn-more');
      toolbarOptions.classList.add('open');
      syncMobilePanels();
    }
  }
  $('#btn-rail-left').addEventListener('click', () => toggleRail('left'));
  $('#btn-rail-right').addEventListener('click', () => toggleRail('right'));
  $('#btn-more').addEventListener('click', () => {
    if (toolbarOptions.classList.contains('open')) closeMobilePanels(true);
    else openDocumentControls();
  });
  $('#btn-options-close').addEventListener('click', () => closeMobilePanels(true));
  $('#panel-backdrop').addEventListener('click', () => closeMobilePanels(true));
  $$('[data-close-panel]').forEach((b) => b.addEventListener('click', () => closeMobilePanels(true)));
  mobileLayout.addEventListener('change', () => closeMobilePanels());
  syncMobilePanels();

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const t = e.target; const typing = t && (t.matches('input, textarea, select') || t.isContentEditable);
    const meta = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      if (narrow() && !$('#panel-backdrop').hidden) { closeMobilePanels(true); return; }
      commitTextEditor();
      if (state.tool !== 'select') setTool('select'); else selectAnnot(null);
      if (typing) t.blur();
      return;
    }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (meta && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (meta && k === 'y') { e.preventDefault(); redo(); return; }
    if (meta && k === 'o') { e.preventDefault(); pickFiles('replace'); return; }
    if (meta && k === 's') { e.preventDefault(); openExport(); return; }
    if (meta && k === 'f') { e.preventDefault(); openDocumentControls(); searchInput.focus(); searchInput.select(); return; }
    if (meta && k === 'a' && (thumbScroll.contains(document.activeElement) || fileScroll.contains(document.activeElement))) {
      e.preventDefault();
      const card = document.activeElement.closest('.file-card');
      const pages = card ? filePages(card.dataset.srcId) : state.pages;
      state.selection = new Set(pages.map((p) => p.uid)); state.anchorUid = pages[0]?.uid; syncSelectionUI(); return;
    }
    if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.25); return; }
    if (meta && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.25); return; }
    if (meta && e.key === '0') { e.preventDefault(); setZoom('fit-width'); return; }
    if (meta || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (getSelectedAnnot()) { e.preventDefault(); deleteSelectedAnnot(); }
      else if ((thumbScroll.contains(document.activeElement) || fileScroll.contains(document.activeElement)) && state.selection.size) { e.preventDefault(); deletePages(orderedSelection()); }
      return;
    }
    const keys = { v: 'select', c: 'textsel', t: 'text', p: 'ink', h: 'highlight', r: 'rect', e: 'ellipse', a: 'arrow', w: 'whiteout' };
    if (keys[k]) { setTool(keys[k]); return; }
    if (k === 'i') $('#tool-grid [data-tool="image"]').click();
  });

  // Drag and drop files anywhere
  let dragDepth = 0; const dropOv = $('#drop-overlay');
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; dropOv.classList.add('show'); });
  document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOv.classList.remove('show'); });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; dropOv.classList.remove('show');
    openFiles(e.dataTransfer.files, state.pages.length ? 'append' : 'replace');
  });

  // Pinch to zoom the document on touch screens: scale the sheet while the fingers move, re-render on release.
  const pinch = { pts: new Map(), active: false, d0: 1, z0: 1, scale: 1 };
  const pinchTools = new Set(['select', 'textsel', 'text', 'place']);
  viewer.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !pinchTools.has(state.tool)) return;
    pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.pts.size === 2 && !pinch.active) {
      const [a, b] = [...pinch.pts.values()];
      pinch.active = true; pinch.d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1; pinch.z0 = state.zoom; pinch.scale = 1;
      const r = viewer.getBoundingClientRect();
      viewerInner.style.transformOrigin = `${(a.x + b.x) / 2 - r.left + viewer.scrollLeft}px ${(a.y + b.y) / 2 - r.top + viewer.scrollTop}px`;
      viewerInner.classList.add('pinching');
      selectAnnot(null);
    }
  }, true);
  viewer.addEventListener('pointermove', (e) => {
    if (!pinch.active || !pinch.pts.has(e.pointerId)) return;
    pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pinch.pts.values()];
    pinch.scale = clamp((Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinch.d0, 0.1 / pinch.z0, 8 / pinch.z0);
    viewerInner.style.transform = `scale(${pinch.scale})`;
  }, true);
  const pinchEnd = (e) => {
    if (e.pointerType !== 'touch') return;
    pinch.pts.delete(e.pointerId);
    if (pinch.active && pinch.pts.size < 2) {
      pinch.active = false; pinch.pts.clear();
      viewerInner.style.transform = ''; viewerInner.style.transformOrigin = ''; viewerInner.classList.remove('pinching');
      if (Math.abs(pinch.scale - 1) > 0.02) setZoom(clamp(pinch.z0 * pinch.scale, 0.1, 8));
    }
  };
  viewer.addEventListener('pointerup', pinchEnd, true);
  viewer.addEventListener('pointercancel', pinchEnd, true);
  viewer.addEventListener('touchmove', (e) => { if (pinch.active) e.preventDefault(); }, { passive: false });

  // Zoom with ctrl/cmd + wheel, relayout on resize
  viewer.addEventListener('wheel', (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });
  let resizeRaf = 0;
  new ResizeObserver(() => { if (resizeRaf) return; resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; if (typeof state.zoomMode !== 'number') layout(); else renderVisible(); if (textEditor) positionTextEditor(); }); }).observe(viewer);
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // Debug handle (read-only use): window.PDFWorkbench.state, .buildPdf(), .pdfjsLib
  window.PDFWorkbench = { state, buildPdf, openFiles, saveFile, toast, busy, baseName, showTab, pdfjsLib, version: '1.3.3' };
  document.dispatchEvent(new CustomEvent('pdfwb:ready'));

  // ---------- Start ----------
  // Render the current state. An empty workspace offers Open PDF; loaded
  // documents are never replaced by generated example content.
  syncDocPanel(); renderSigList(); updateUndoUI(); setTool('select');
  rebuild();
})();
