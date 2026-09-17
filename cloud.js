/* PDF Workbench — cloud library (Supabase).
   Optional add-on: sign in with an email link and keep documents in a private
   Supabase Storage bucket. Needs config.js to define window.PDFWB_CONFIG =
   { supabaseUrl, supabaseAnonKey, bucket }. Without it the Library tab explains
   how to configure it; nothing else in the app depends on this file. */
'use strict';
(function () {
  const cfg = window.PDFWB_CONFIG || {};
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => (b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  const cleanName = (n) => { let s = String(n || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 120); if (!s) s = 'document'; if (!/\.pdf$/i.test(s)) s += '.pdf'; return s; };

  function init() {
    const W = window.PDFWorkbench; if (!W) return;
    const body = $('#library-body'); if (!body) return;
    const cloudBtn = $('#ex-save-cloud');
    const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
    if (!configured) {
      body.innerHTML = '<div class="section-title">Cloud library</div><div class="hint">Not configured. Add a <code>config.js</code> next to the app that sets <code>window.PDFWB_CONFIG = { supabaseUrl, supabaseAnonKey, bucket }</code>. The README explains the storage bucket and policies.</div>';
      return;
    }
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const bucket = cfg.bucket || 'documents';
    const webUrl = cfg.webUrl || '';
    let user = null, files = [], available = true, sentTo = '', loading = false, working = false;

    // The claude.ai artifact sandbox blocks cross-origin requests; detect that once and explain instead of failing silently.
    fetch(cfg.supabaseUrl + '/auth/v1/health', { headers: { apikey: cfg.supabaseAnonKey } })
      .then((r) => { if (!r.ok) throw new Error(); })
      .catch(() => { available = false; render(); });

    const path = (name) => `${user.id}/${name}`;

    async function refresh() {
      if (!user) { files = []; render(); return; }
      loading = true; render();
      try {
        const { data, error } = await sb.storage.from(bucket).list(user.id, { limit: 500, sortBy: { column: 'updated_at', order: 'desc' } });
        if (error) throw error;
        files = (data || []).filter((f) => f.id && f.name !== '.emptyFolderPlaceholder').map((f) => ({ name: f.name, size: (f.metadata && f.metadata.size) || 0, updated: f.updated_at || f.created_at || '' }));
      } catch (e) { W.toast('Could not load your library: ' + (e.message || e), { error: true }); }
      finally { loading = false; render(); }
    }
    async function sendLink(email) {
      email = String(email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { W.toast('Enter a valid email address.', { error: true }); return; }
      working = true; render();
      try {
        const redirect = location.origin + location.pathname;
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
        if (error) throw error;
        sentTo = email; W.toast(`Sign-in link sent to ${email}.`);
      } catch (e) { W.toast('Could not send the link: ' + (e.message || e), { error: true, ms: 8000 }); }
      finally { working = false; render(); }
    }
    async function verifyCode(code) {
      code = String(code || '').replace(/\D/g, '');
      if (!sentTo || code.length < 6) { W.toast('Enter the 6-digit code from the email.', { error: true }); return; }
      working = true; render();
      try { const { error } = await sb.auth.verifyOtp({ email: sentTo, token: code, type: 'email' }); if (error) throw error; }
      catch (e) { W.toast('That code was not accepted: ' + (e.message || e), { error: true, ms: 8000 }); }
      finally { working = false; render(); }
    }
    async function signOut() { try { await sb.auth.signOut(); } catch (e) { /* already signed out */ } user = null; files = []; render(); }

    async function saveCurrent(name, opts = {}) {
      if (!user) { W.toast('Sign in to save to your library.', { error: true }); return false; }
      if (!W.state.pages.length) { W.toast('Nothing to save yet.', { error: true }); return false; }
      name = cleanName(name);
      if (files.some((f) => f.name === name) && !window.confirm(`“${name}” already exists in your library. Replace it?`)) return false;
      W.busy(true); working = true; render();
      try {
        const bytes = await W.buildPdf({ pages: W.state.pages, annots: opts.annots !== false, deco: opts.deco !== false, flatten: opts.flatten !== false });
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const { error } = await sb.storage.from(bucket).upload(path(name), blob, { upsert: true, contentType: 'application/pdf' });
        if (error) throw error;
        W.state.dirty = false;
        W.toast(`Saved “${name}” to your library.`);
        await refresh();
        return true;
      } catch (e) { W.toast('Save failed: ' + (e.message || e), { error: true, ms: 8000 }); return false; }
      finally { W.busy(false); working = false; render(); }
    }
    async function openFile(name, mode) {
      W.busy(true);
      try {
        const { data, error } = await sb.storage.from(bucket).download(path(name));
        if (error) throw error;
        const file = new File([data], name, { type: 'application/pdf' });
        await W.openFiles([file], mode);
        if (window.innerWidth <= 960) $('#rail-left').classList.remove('open');
      } catch (e) { W.toast('Could not open the file: ' + (e.message || e), { error: true }); }
      finally { W.busy(false); }
    }
    async function downloadFile(name) {
      W.busy(true);
      try { const { data, error } = await sb.storage.from(bucket).download(path(name)); if (error) throw error; await W.saveFile(name, data, 'application/pdf'); }
      catch (e) { W.toast('Download failed: ' + (e.message || e), { error: true }); }
      finally { W.busy(false); }
    }
    async function removeFile(name) {
      if (!window.confirm(`Delete “${name}” from your library? This cannot be undone.`)) return;
      try { const { error } = await sb.storage.from(bucket).remove([path(name)]); if (error) throw error; W.toast(`Deleted “${name}”.`); await refresh(); }
      catch (e) { W.toast('Delete failed: ' + (e.message || e), { error: true }); }
    }

    function render() {
      if (cloudBtn) cloudBtn.hidden = !(user && available);
      if (!available) {
        body.innerHTML = `<div class="section-title">Cloud library</div><div class="hint">The cloud library cannot be reached from this embedded view.${webUrl ? ` Open the web version at <a href="${esc(webUrl)}" target="_blank" rel="noopener">${esc(webUrl)}</a> to sign in and use it.` : ''}</div>`;
        return;
      }
      if (!user) {
        body.innerHTML = `
          <div class="section-title">Cloud library</div>
          <p class="hint" style="margin:0">Sign in to keep documents in your private library and open them from any device. No password: you get a link by email.</p>
          <div class="field"><label for="lib-email">Email</label><input class="input" id="lib-email" type="email" autocomplete="email" placeholder="you@example.com" value="${esc(sentTo)}" ${working ? 'disabled' : ''}></div>
          <button class="btn primary" id="lib-send" ${working ? 'disabled' : ''}>${sentTo ? 'Send the link again' : 'Send sign-in link'}</button>
          ${sentTo ? `<div class="hint">Link sent to <strong>${esc(sentTo)}</strong>. Open it in this browser. If the email shows a code instead, enter it here:</div>
          <div class="row"><input class="input mono" id="lib-code" inputmode="numeric" placeholder="6-digit code" maxlength="8" ${working ? 'disabled' : ''}><button class="btn" id="lib-verify" ${working ? 'disabled' : ''}>Verify</button></div>` : ''}`;
        $('#lib-send').onclick = () => sendLink($('#lib-email').value);
        $('#lib-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLink($('#lib-email').value); });
        const v = $('#lib-verify'); if (v) { v.onclick = () => verifyCode($('#lib-code').value); $('#lib-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode($('#lib-code').value); }); }
        return;
      }
      const defaultName = cleanName(W.baseName() === 'merged' ? 'merged' : W.baseName());
      const list = loading ? '<div class="hint">Loading…</div>' : files.length ? files.map((f) => `
        <div class="file-item lib-item" data-name="${esc(f.name)}">
          <div class="name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="meta">${fmtSize(f.size)} · ${esc(fmtDate(f.updated))}</div>
          <div class="actions">
            <button class="btn sm" data-act="open" title="Open (replaces the current document)">Open</button>
            <button class="btn icon sm" data-act="add" title="Add its pages to the current document"><svg><use href="#i-plus"/></svg></button>
            <button class="btn icon sm" data-act="download" title="Download"><svg><use href="#i-download"/></svg></button>
            <button class="btn icon sm danger" data-act="delete" title="Delete from library"><svg><use href="#i-trash"/></svg></button>
          </div>
        </div>`).join('') : '<div class="hint">Your library is empty. Save the current document to add it.</div>';
      body.innerHTML = `
        <div class="section-title"><span>Cloud library</span><button class="btn sm ghost" id="lib-signout" title="${esc(user.email || '')}">Sign out</button></div>
        <div class="hint">Signed in as <strong>${esc(user.email || user.id)}</strong></div>
        <div class="field"><label for="lib-name">Save current document as</label>
          <div class="row"><input class="input" id="lib-name" type="text" value="${esc(defaultName)}" ${working ? 'disabled' : ''}><button class="btn primary" id="lib-save" ${working ? 'disabled' : ''}>Save</button></div></div>
        <div class="section-title" style="margin-top:6px"><span>Documents</span><span class="badge">${files.length}</span></div>
        <div class="file-list lib-list">${list}</div>`;
      $('#lib-signout').onclick = signOut;
      $('#lib-save').onclick = () => saveCurrent($('#lib-name').value);
      $('#lib-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCurrent($('#lib-name').value); });
      body.querySelectorAll('.lib-item').forEach((el) => {
        const name = el.dataset.name;
        el.querySelectorAll('[data-act]').forEach((b) => {
          b.onclick = () => { const act = b.dataset.act; if (act === 'open') openFile(name, 'replace'); else if (act === 'add') openFile(name, 'append'); else if (act === 'download') downloadFile(name); else if (act === 'delete') removeFile(name); };
        });
      });
    }

    // Export dialog: "Save to library" uses the dialog's own options.
    if (cloudBtn) cloudBtn.addEventListener('click', async () => {
      const dlg = $('#dlg-export'); const name = $('#ex-name').value; if (dlg && dlg.open) dlg.close();
      await saveCurrent(name, { annots: $('#ex-annots').checked, deco: $('#ex-deco').checked, flatten: $('#ex-flatten').checked });
    });

    sb.auth.onAuthStateChange((event, session) => {
      const next = session ? session.user : null;
      const changed = (next && next.id) !== (user && user.id);
      user = next;
      if (changed) { if (user) { sentTo = ''; refresh(); W.toast(`Signed in as ${user.email || 'your account'}.`); } else render(); }
    });
    sb.auth.getSession().then(({ data }) => {
      user = data && data.session ? data.session.user : null;
      if (location.hash && /access_token|error_description/.test(location.hash)) {
        const m = /error_description=([^&]+)/.exec(location.hash);
        if (m) W.toast('Sign-in failed: ' + decodeURIComponent(m[1].replace(/\+/g, ' ')), { error: true, ms: 9000 });
        history.replaceState(null, '', location.pathname + location.search);
        if (user || m) W.showTab('rail-left', 'library');
      }
      if (user) refresh(); else render();
    }).catch(() => render());
    render();
  }

  if (window.PDFWorkbench) init(); else document.addEventListener('pdfwb:ready', init, { once: true });
})();
