// EV Fleet Monitor — frontend. All data comes from the API; nothing here is simulated.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TABS = { overview: 'Overview', battery: 'Battery', maps: 'Map & geofence' };
const OFFLINE_MS = 120000, LOW_SOC = 20, HOT_C = 45;
let token = localStorage.getItem('ev_token'), me = null, vehicles = [], selId = null, lastId = null, filter = 'all', query = '', mode = 'login', tick = 0, pollTimer = null, curTab = 'fleet', pendingUsers = [], breached = new Set();

async function api(path, opt = {}) {
  const r = await fetch(path, { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  if (r.status === 401 && token) { logout(true); throw new Error('Session expired. Please sign in again.'); }
  if (!r.ok) throw new Error(d.error || 'Request failed (' + r.status + ')');
  return d;
}
function showNotif(icon, msg) { $('notif-icon').textContent = icon; $('notif-msg').textContent = msg; $('notif').classList.add('show'); clearTimeout(showNotif.t); showNotif.t = setTimeout(() => $('notif').classList.remove('show'), 3800); }
function setMsg(id, text, ok) { const e = $(id); e.textContent = text || ''; e.className = 'form-msg' + (ok ? ' ok' : ''); }
const curV = () => vehicles.find(v => v.vehicle_id === selId);
const fmt = x => x === null || x === undefined ? '—' : Math.round(x);
const timeOf = v => v.latest ? new Date(v.latest.time).getTime() : 0;
const ago = t => { if (!t) return 'No readings yet'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return 'Updated ' + (s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd') + ' ago'; };
function haversine(a, b, c, d) { const R = 6371, r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); }

// ── Sign in / request access ──
function setMode(m) {
  mode = m; const reg = m === 'register';
  $('f-name').hidden = !reg; $('auth-title').textContent = reg ? 'Request access' : 'Sign in';
  $('auth-sub').textContent = reg ? 'The host reviews every request before you can sign in.' : 'Monitor your electric vehicles in real time.';
  $('auth-btn').textContent = reg ? 'Send request' : 'Sign in'; $('sw-text').textContent = reg ? 'Already approved?' : 'New here?'; $('sw-link').textContent = reg ? 'Sign in' : 'Request access'; setMsg('auth-msg', '');
}
$('sw-link').addEventListener('click', e => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); });
$('auth-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), btn = $('auth-btn'); btn.disabled = true; setMsg('auth-msg', '');
  try {
    if (mode === 'register') { const r = await api('/api/auth/register', { method: 'POST', body: f }); setMode('login'); e.target.reset(); setMsg('auth-msg', r.message, true); }
    else { const r = await api('/api/auth/login', { method: 'POST', body: { email: f.email, password: f.password } }); token = r.token; localStorage.setItem('ev_token', token); me = r.user; e.target.reset(); startApp(); }
  } catch (err) { setMsg('auth-msg', err.message); } finally { btn.disabled = false; }
});
function logout(expired) {
  token = null; me = null; vehicles = []; selId = null; localStorage.removeItem('ev_token'); clearInterval(pollTimer);
  $('fleet-grid').innerHTML = ''; document.body.dataset.view = 'auth'; $('menu').hidden = true; location.hash = '#/'; setMode('login');
  if (expired) setMsg('auth-msg', 'Your session expired. Please sign in again.');
}
$('logout-btn').addEventListener('click', () => logout(false));
$('profile-btn').addEventListener('click', e => { e.stopPropagation(); const m = $('menu'); m.hidden = !m.hidden; $('profile-btn').setAttribute('aria-expanded', !m.hidden); });
document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) $('menu').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('menu').hidden = true; closeModal(); } });

function startApp() {
  const initials = me.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  $('profile-btn').textContent = initials; $('m-name').textContent = me.name; $('m-email').textContent = me.email; $('m-role').textContent = me.role === 'host' ? 'Host' : 'Member';
  $('nav-admin').hidden = me.role !== 'host'; document.body.dataset.view = 'fleet';
  clearInterval(pollTimer); tick = 0; poll(); pollTimer = setInterval(poll, 5000); route();
}

// ── Polling real data ──
async function poll() {
  try {
    vehicles = await api('/api/vehicles'); $('conn-dot').classList.remove('disconnected'); $('conn-label').textContent = 'Live data connected';
    $('topnav-updated').textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) { if (!token) return; $('conn-dot').classList.add('disconnected'); $('conn-label').textContent = 'Server unreachable'; return; }
  renderFleet();
  if (selId) {
    const v = curV(); if (!v) { location.hash = '#/'; return; }
    paintDetail(v); if (curTab === 'maps') updateMap(false); if (curTab === 'battery' && tick % 3 === 0) loadHistory();
  }
  if (me.role === 'host' && tick % 6 === 0) refreshPending();
  tick++;
}
function statusOf(v) {
  const l = v.latest; if (!l) return { k: 'wait', t: 'Awaiting data' };
  if (Date.now() - timeOf(v) > OFFLINE_MS) return { k: 'offline', t: 'Offline' };
  if (l.current != null && l.current < 0) return { k: 'charging', t: 'Charging' };
  if (l.battery != null && l.battery < LOW_SOC) return { k: 'low', t: 'Low battery' };
  return { k: 'online', t: 'Online' };
}
function geoOf(v) {
  const f = v.fence, l = v.latest; if (!f || !f.enabled || f.lat == null || !l || l.lat == null) return 'none';
  const d = haversine(l.lat, l.lon, f.lat, f.lng); return d > f.radiusKm ? 'breach' : (f.radiusKm - d < Math.max(.5, f.radiusKm * .1) ? 'warn' : 'ok');
}
const GEO_TXT = { none: 'No geofence', ok: 'Inside geofence', warn: 'Near boundary', breach: 'Outside geofence' };

// ── Fleet home ──
function blockHTML(v) {
  return `<a class="veh-block" href="#/vehicle/${v.vehicle_id}" data-id="${v.vehicle_id}" data-lvl="none">
    <div class="vb-top"><div><div class="vb-name">${esc(v.name)}</div><div class="vb-plate">${esc(v.plate || v.vehicle_id)}</div>${v.owner ? `<div class="vb-owner">${esc(v.owner)}</div>` : ''}</div><span class="status-chip" data-k="status"></span></div>
    <div class="vb-soc"><div class="vb-pct"><span data-k="soc">—</span><small>%</small></div><div class="batt" role="img" aria-label="Charge level"><div class="batt-fill" data-k="fill"></div></div></div>
    <dl class="vb-metrics"><div><dt>Voltage</dt><dd><span data-k="voltage">—</span> V</dd></div><div><dt>Current</dt><dd><span data-k="current">—</span> A</dd></div><div><dt>Temperature</dt><dd><span data-k="temp">—</span> °C</dd></div></dl>
    <div class="vb-foot"><span data-k="seen"></span><span data-k="geo"></span></div></a>`;
}
function renderFleet() {
  const grid = $('fleet-grid'); let online = 0, charging = 0, alerts = 0, sum = 0, n = 0, shown = 0; const ids = new Set(vehicles.map(v => v.vehicle_id)), nowBreached = new Set();
  grid.querySelectorAll('.veh-block').forEach(el => { if (!ids.has(el.dataset.id)) el.remove(); });
  vehicles.forEach(v => {
    let el = grid.querySelector(`[data-id="${v.vehicle_id}"]`); if (!el) { grid.insertAdjacentHTML('beforeend', blockHTML(v)); el = grid.lastElementChild; }
    const l = v.latest || {}, st = statusOf(v), geo = geoOf(v), q = k => el.querySelector(`[data-k="${k}"]`), live = st.k !== 'wait' && st.k !== 'offline';
    q('status').textContent = st.t; q('status').className = 'status-chip st-' + st.k; q('soc').textContent = fmt(l.battery); q('voltage').textContent = fmt(l.voltage);
    q('current').textContent = l.current == null ? '—' : Math.abs(Math.round(l.current)); q('temp').textContent = fmt(l.temp); q('fill').style.width = (l.battery ?? 0) + '%';
    q('seen').textContent = ago(timeOf(v)); q('geo').textContent = geo === 'none' ? '' : GEO_TXT[geo];
    el.dataset.lvl = l.battery == null ? 'none' : l.battery < LOW_SOC ? 'low' : l.battery < 50 ? 'mid' : 'ok'; el.dataset.hot = l.temp != null && l.temp >= HOT_C; el.dataset.geo = geo;
    const show = (filter === 'all' || (filter === 'online' && live) || (filter === 'charging' && st.k === 'charging') || (filter === 'low' && l.battery != null && l.battery < LOW_SOC) || (filter === 'offline' && !live)) &&
      (!query || (v.name + ' ' + (v.plate || '')).toLowerCase().includes(query));
    el.hidden = !show; if (show) shown++; if (live) online++; if (st.k === 'charging') charging++; if (l.battery != null) { sum += l.battery; n++; }
    if ((l.battery != null && l.battery < LOW_SOC) || el.dataset.hot === 'true' || geo === 'breach') alerts++; if (geo === 'breach') nowBreached.add(v.vehicle_id);
  });
  $('fleet-total').textContent = vehicles.length; $('fleet-online').textContent = online; $('fleet-charging').textContent = charging; $('fleet-alerts').textContent = alerts; $('fleet-soc').textContent = n ? Math.round(sum / n) + '%' : '—';
  const em = $('fleet-empty'); em.hidden = shown > 0;
  em.innerHTML = vehicles.length ? 'No vehicles match. Clear the search or pick All.' : 'No vehicles yet. Add your first vehicle to start receiving live data.<br><button class="btn primary" onclick="openAdd()" style="margin-top:14px">Add vehicle</button>';
  nowBreached.forEach(id => { if (!breached.has(id)) { const v = vehicles.find(x => x.vehicle_id === id); showNotif('🚨', (v.plate || v.name) + ' left its geofence'); } }); breached = nowBreached;
  const bar = $('geo-alert-bar'), list = vehicles.filter(v => geoOf(v) === 'breach');
  if (list.length) { bar.className = 'geo-alert-bar show breach'; $('geo-alert-msg').textContent = 'Geofence breach: ' + list.map(v => v.plate || v.name).join(', '); $('geo-alert-dist').textContent = list.length + (list.length > 1 ? ' vehicles' : ' vehicle'); } else bar.className = 'geo-alert-bar';
}
$('fleet-search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderFleet(); });
$('filters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; document.querySelectorAll('#filters .chip').forEach(c => c.classList.toggle('on', c === b)); renderFleet(); });

// ── Routing ──
function showSection(id) {
  curTab = id; document.querySelectorAll('.section').forEach(s => s.classList.remove('active')); $('sec-' + id).classList.add('active');
  document.body.dataset.view = id === 'fleet' ? 'fleet' : TABS[id] ? 'vehicle' : 'page';
  document.querySelectorAll('.tab').forEach(t => { const on = t.dataset.go === id; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.go === (id === 'overview' ? 'fleet' : id)));
  const v = curV(); $('page-crumb').textContent = TABS[id] && v ? v.name + ' · ' + TABS[id] : ({ fleet: 'Fleet overview', profile: 'Profile', admin: 'Access requests' }[id] || '');
}
function goTo(t) {
  if (t === 'fleet') { location.hash = '#/'; return; } if (t === 'admin') { location.hash = '#/admin'; return; }
  const v = curV() || vehicles.find(x => x.vehicle_id === lastId) || vehicles[0];
  if (!v) { showNotif('ℹ', 'Add a vehicle first'); location.hash = '#/'; return; } location.hash = `#/vehicle/${v.vehicle_id}/${t}`;
}
document.addEventListener('click', e => { const a = e.target.closest('[data-go]'); if (a) { e.preventDefault(); goTo(a.dataset.go); } });
function route() {
  if (!me) return; const h = location.hash, m = h.match(/^#\/vehicle\/([A-Z0-9]+)(?:\/(\w+))?/i);
  if (h === '#/profile') { selId = null; fillProfile(); showSection('profile'); }
  else if (h === '#/admin' && me.role === 'host') { selId = null; showSection('admin'); loadAdmin(); }
  else if (m) { selId = m[1].toUpperCase(); lastId = selId; const tab = TABS[m[2]] ? m[2] : 'overview'; showSection(tab); const v = curV(); if (v) paintDetail(v);
    if (tab === 'battery') loadHistory(); if (tab === 'maps') setTimeout(() => updateMap(true), 60); }
  else { selId = null; showSection('fleet'); renderFleet(); }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ── Vehicle detail ──
function paintDetail(v) {
  const l = v.latest || {}, st = statusOf(v), geo = geoOf(v), set = (id, t) => { $(id).textContent = t; };
  set('vh-name', v.name); set('vh-plate', v.plate || v.vehicle_id); $('vh-status').textContent = st.t; $('vh-status').className = 'status-chip st-' + st.k;
  set('kpi-soc', fmt(l.battery)); $('soc-bar').style.width = (l.battery ?? 0) + '%'; set('kpi-voltage', fmt(l.voltage)); set('kpi-current', l.current == null ? '—' : Math.abs(Math.round(l.current))); set('kpi-temp', fmt(l.temp));
  const cb = $('c-badge'); cb.textContent = l.current == null ? '' : l.current < 0 ? 'Charging' : 'Discharging'; cb.className = 'card-badge ' + (l.current < 0 ? 'badge-ok' : ''); cb.style.cssText = l.current >= 0 ? 'background:var(--surface3);color:var(--text2)' : '';
  set('ov-pos', l.lat == null ? 'No GPS fix yet' : l.lat.toFixed(5) + ', ' + l.lon.toFixed(5)); set('ov-geo', GEO_TXT[geo]);
  const gb = $('ov-geo-badge'); gb.textContent = geo === 'none' ? '' : GEO_TXT[geo]; gb.className = 'card-badge ' + ({ ok: 'badge-ok', warn: 'badge-warn', breach: 'badge-crit' }[geo] || '');
  set('d-id', v.vehicle_id); set('d-seen', ago(timeOf(v))); $('d-owner-row').hidden = !v.owner; set('d-owner', v.owner || '');
}
$('rename-btn').addEventListener('click', async () => { const v = curV(), n = prompt('Vehicle name', v.name); if (!n || !n.trim()) return; try { const u = await api('/api/vehicles/' + v.vehicle_id, { method: 'PATCH', body: { name: n } }); Object.assign(v, u); paintDetail(v); renderFleet(); showSection(curTab); showNotif('✅', 'Renamed'); } catch (e) { showNotif('⚠', e.message); } });
$('del-btn').addEventListener('click', async () => { const v = curV(); if (!confirm(`Remove ${v.name}? Its stored readings will be deleted.`)) return; try { await api('/api/vehicles/' + v.vehicle_id, { method: 'DELETE' }); vehicles = vehicles.filter(x => x !== v); selId = null; location.hash = '#/'; showNotif('✅', 'Vehicle removed'); } catch (e) { showNotif('⚠', e.message); } });
$('key-btn').addEventListener('click', async () => { const v = curV(); if (!confirm('Create a new device key? The current key stops working immediately.')) return; try { const r = await api(`/api/vehicles/${v.vehicle_id}/key`, { method: 'POST' }); showKey(v.vehicle_id, r.deviceKey, 'New device key'); } catch (e) { showNotif('⚠', e.message); } });

// ── Add vehicle / device key ──
function modal(title, html) { $('modal-title').textContent = title; $('modal-body').innerHTML = html; $('modal').hidden = false; const i = $('modal-body').querySelector('input,button'); if (i) i.focus(); }
function closeModal() { $('modal').hidden = true; }
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
function openAdd() {
  modal('Add vehicle', `<form id="add-form" class="stack"><label>Vehicle name<input name="name" placeholder="Tata Nexon EV"/></label><label>Plate or vehicle ID<input name="plate" placeholder="KA 01 EV 2341"/></label><div class="form-msg" id="add-msg" role="alert"></div><div class="btn-row"><button class="btn primary" type="submit">Add vehicle</button><button class="btn" type="button" onclick="closeModal()">Cancel</button></div></form>`);
  $('add-form').addEventListener('submit', async e => { e.preventDefault(); try { const r = await api('/api/vehicles', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); vehicles.push(r.vehicle); renderFleet(); showKey(r.vehicle.vehicle_id, r.deviceKey, 'Vehicle added'); } catch (err) { setMsg('add-msg', err.message); } });
}
function showKey(id, key, title) {
  modal(title, `<p class="hint">Put this device key in your microcontroller now. It is shown only once.</p><pre class="code" id="key-val">${esc(key)}</pre><p class="hint">Send readings to <b>POST ${esc(location.origin)}/data</b> as JSON. Example payload format:</p><pre class="code">{ "vehicle_id": "${esc(id)}", "key": "…", "battery": 0-100, "voltage": V, "current": A, "temp": °C, "lat": …, "lon": … }</pre><div class="btn-row"><button class="btn primary" id="copy-key">Copy key</button><button class="btn" onclick="closeModal()">Done</button></div>`);
  $('copy-key').addEventListener('click', () => navigator.clipboard.writeText(key).then(() => showNotif('✅', 'Key copied'), () => showNotif('⚠', 'Copy failed — select the key and copy it')));
}

// ── Battery history (real readings) ──
const charts = {};
async function loadHistory() {
  const v = curV(); if (!v || typeof Chart === 'undefined') return; let h; try { h = await api(`/api/vehicles/${v.vehicle_id}/history?minutes=60`); } catch { return; }
  $('hist-empty').hidden = h.length > 0; const dark = document.body.dataset.theme === 'dark', grid = dark ? '#2a3048' : '#dde3ec', txt = dark ? '#9aa3be' : '#8a92a8';
  const labels = h.map(r => new Date(r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
  [['soc', 'ch-soc', 'battery', '#00c48c'], ['volt', 'ch-volt', 'voltage', '#0084ff'], ['curr', 'ch-curr', 'current', '#ff7b54'], ['temp', 'ch-temp', 'temp', '#e84646']].forEach(([k, id, f, c]) => {
    const data = h.map(r => r[f] ?? null); if (charts[k] && charts[k].vid !== v.vehicle_id) { charts[k].destroy(); charts[k] = null; }
    if (charts[k]) { charts[k].data.labels = labels; charts[k].data.datasets[0].data = data; charts[k].update('none'); return; }
    charts[k] = new Chart($(id), { type: 'line', data: { labels, datasets: [{ data, borderColor: c, borderWidth: 2, pointRadius: 0, tension: .3, spanGaps: true }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: grid }, ticks: { color: txt, font: { size: 10 }, maxTicksLimit: 6 } }, y: { grid: { color: grid }, ticks: { color: txt, font: { size: 10 } } } } } });
    charts[k].vid = v.vehicle_id;
  });
}

// ── Map, geofence, nearby chargers ──
let map, vMark, fCircle, chgLayer, editing = false, mapFor = null, chgFor = null, draft = { enabled: false, lat: null, lng: null, radiusKm: 5 };
function ensureMap() {
  if (typeof L === 'undefined') { $('map-sub').textContent = 'The map library could not load. Check your internet connection.'; return false; }
  if (map) { map.invalidateSize(); return true; }
  map = L.map('leaflet-map').setView([20.59, 78.96], 5);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd', attribution: '© OpenStreetMap contributors © CARTO' }).addTo(map);
  chgLayer = L.layerGroup().addTo(map);
  map.on('click', e => { if (!editing) return; draft.lat = e.latlng.lat; draft.lng = e.latlng.lng; setEditing(false); drawFence(true); syncFenceUI(); }); return true;
}
function setEditing(on) { editing = on; $('fence-place').textContent = on ? 'Click the map…' : 'Pick centre on map'; $('leaflet-map').style.cursor = on ? 'crosshair' : ''; }
function drawFence(fit) {
  if (!map || draft.lat == null) { if (fCircle) { fCircle.remove(); fCircle = null; } return; }
  const o = { color: draft.enabled ? '#00c48c' : '#8a92a8', fillColor: draft.enabled ? '#00c48c' : '#8a92a8', fillOpacity: .08, weight: 2, dashArray: '8 5' };
  if (!fCircle) fCircle = L.circle([draft.lat, draft.lng], { ...o, radius: draft.radiusKm * 1000 }).addTo(map); else { fCircle.setLatLng([draft.lat, draft.lng]); fCircle.setRadius(draft.radiusKm * 1000); fCircle.setStyle(o); }
  if (fit) map.fitBounds(fCircle.getBounds(), { padding: [30, 30] });
}
function syncFenceUI() {
  $('fence-on').checked = draft.enabled; $('fence-radius').value = draft.radiusKm; $('fence-centre').textContent = draft.lat == null ? 'Not set' : draft.lat.toFixed(5) + ', ' + draft.lng.toFixed(5);
  const l = (curV() || {}).latest; $('fence-dist').textContent = draft.lat != null && l && l.lat != null ? haversine(l.lat, l.lon, draft.lat, draft.lng).toFixed(2) + ' km' : '—';
}
function updateMap(first) {
  const v = curV(); if (!v || !ensureMap()) return;
  if (mapFor !== v.vehicle_id) { mapFor = v.vehicle_id; first = true; const f = v.fence || {}; draft = { enabled: !!f.enabled, lat: f.lat ?? null, lng: f.lng ?? null, radiusKm: f.radiusKm || 5 }; setEditing(false); if (fCircle) { fCircle.remove(); fCircle = null; } }
  syncFenceUI(); const l = v.latest;
  if (l && l.lat != null) {
    const p = [l.lat, l.lon], icon = L.divIcon({ className: '', html: '<div class="veh-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
    if (!vMark) vMark = L.marker(p, { icon }).addTo(map); else vMark.setLatLng(p); vMark.bindPopup(esc(v.name) + '<br>' + p.map(x => x.toFixed(5)).join(', '));
    if (first) map.setView(p, 14); $('map-sub').textContent = `${l.lat.toFixed(5)}, ${l.lon.toFixed(5)} · ${ago(timeOf(v))}`;
  } else { if (vMark) { vMark.remove(); vMark = null; } $('map-sub').textContent = 'No GPS fix yet — the map shows the vehicle once it reports a position.'; }
  drawFence(first && !(l && l.lat != null) && draft.lat != null);
  const geo = geoOf(v), gb = $('geo-status-badge'); gb.textContent = GEO_TXT[geo]; gb.className = 'card-badge ' + ({ ok: 'badge-ok', warn: 'badge-warn', breach: 'badge-crit' }[geo] || '');
  loadChargers(v);
}
$('fence-on').addEventListener('change', e => { draft.enabled = e.target.checked; drawFence(); });
$('fence-radius').addEventListener('input', e => { const r = parseFloat(e.target.value); if (r > 0) { draft.radiusKm = r; drawFence(); syncFenceUI(); } });
$('fence-place').addEventListener('click', () => { setEditing(!editing); if (editing) showNotif('📍', 'Click the map to set the geofence centre'); });
$('fence-here').addEventListener('click', () => { const l = (curV() || {}).latest; if (!l || l.lat == null) { showNotif('ℹ', 'The vehicle has not reported a GPS position yet'); return; } draft.lat = l.lat; draft.lng = l.lon; drawFence(true); syncFenceUI(); });
$('fence-save').addEventListener('click', async () => {
  const v = curV(); if (draft.enabled && draft.lat == null) { showNotif('⚠', 'Pick a centre on the map first'); return; }
  try { const u = await api('/api/vehicles/' + v.vehicle_id, { method: 'PATCH', body: { fence: draft } }); v.fence = u.fence; showNotif('✅', draft.enabled ? 'Geofence saved' : 'Geofence turned off'); updateMap(false); renderFleet(); } catch (e) { showNotif('⚠', e.message); }
});
async function loadChargers(v) {
  const list = $('chg-list'), l = v.latest;
  if (!l || l.lat == null) { list.innerHTML = '<div class="fleet-empty" style="padding:20px 0">Nearby chargers appear once the vehicle reports a GPS position.</div>'; chgLayer.clearLayers(); chgFor = null; return; }
  if (chgFor && chgFor.id === v.vehicle_id && haversine(chgFor.lat, chgFor.lon, l.lat, l.lon) < 1) return;
  chgFor = { id: v.vehicle_id, lat: l.lat, lon: l.lon }; list.innerHTML = '<div class="fleet-empty" style="padding:20px 0">Looking up chargers near the vehicle…</div>'; chgLayer.clearLayers();
  try {
    const d = await api(`/api/chargers?lat=${l.lat}&lon=${l.lon}`);
    if (!d.length) { list.innerHTML = '<div class="fleet-empty" style="padding:20px 0">No charging stations found within 15 km of the vehicle.</div>'; return; }
    list.innerHTML = d.map((c, i) => `<div class="cs-item" data-i="${i}"><span class="cs-dot cs-avail"></span><span class="cs-name">${esc(c.name)}</span><span class="cs-dist">${c.distKm.toFixed(1)} km</span>${c.capacity ? `<span class="cs-type">${esc(c.capacity)} points</span>` : ''}</div>`).join('');
    d.forEach((c, i) => L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: '<div class="chg-pin">⚡</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(chgLayer).bindPopup(esc(c.name) + (c.operator ? '<br>' + esc(c.operator) : '') + '<br>' + c.distKm.toFixed(1) + ' km away'));
    list.onclick = e => { const it = e.target.closest('[data-i]'); if (it) map.setView([d[it.dataset.i].lat, d[it.dataset.i].lon], 16); };
  } catch (e) { list.innerHTML = `<div class="fleet-empty" style="padding:20px 0">${esc(e.message)}<br><button class="btn" style="margin-top:12px" onclick="chgFor=null;updateMap(false)">Try again</button></div>`; }
}

// ── Profile ──
function fillProfile() {
  const f = $('prof-form'); f.name.value = me.name; $('prof-email').value = me.email; $('prof-role').textContent = me.role === 'host' ? 'Host' : 'Member'; $('prof-since').textContent = new Date(me.createdAt).toLocaleDateString('en-IN', { dateStyle: 'long' }); setMsg('prof-msg', ''); setMsg('pw-msg', '');
}
$('prof-form').addEventListener('submit', async e => { e.preventDefault(); try { me = await api('/api/me', { method: 'PATCH', body: { name: e.target.name.value } }); $('m-name').textContent = me.name; $('profile-btn').textContent = me.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); setMsg('prof-msg', 'Name saved', true); } catch (err) { setMsg('prof-msg', err.message); } });
$('pw-form').addEventListener('submit', async e => { e.preventDefault(); const f = e.target; try { await api('/api/me', { method: 'PATCH', body: { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value } }); f.reset(); setMsg('pw-msg', 'Password updated', true); } catch (err) { setMsg('pw-msg', err.message); } });

// ── Host: approvals ──
async function refreshPending() { try { pendingUsers = (await api('/api/admin/users')).filter(u => u.status === 'pending'); const b = $('req-count'); b.hidden = !pendingUsers.length; b.textContent = pendingUsers.length; } catch {} }
async function loadAdmin() {
  let us; try { us = await api('/api/admin/users'); } catch (e) { $('pending-list').textContent = e.message; return; }
  pendingUsers = us.filter(u => u.status === 'pending'); const b = $('req-count'); b.hidden = !pendingUsers.length; b.textContent = pendingUsers.length;
  const when = d => new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' }), btn = (u, a, t, c = '') => `<button class="btn ${c}" data-act="${a}" data-id="${u.id}">${t}</button>`;
  const row = (u, acts) => `<div class="urow"><div><b>${esc(u.name)}</b><span>${esc(u.email)} · requested ${when(u.createdAt)}${u.status !== 'pending' ? ' · ' + u.vehicles + ' vehicle' + (u.vehicles === 1 ? '' : 's') : ''}</span></div><div class="btn-row">${acts}</div></div>`;
  $('pending-list').innerHTML = pendingUsers.length ? pendingUsers.map(u => row(u, btn(u, 'approve', 'Approve', 'primary') + btn(u, 'reject', 'Reject'))).join('') : '<div class="fleet-empty" style="padding:24px 0">No requests are waiting.</div>';
  const rest = us.filter(u => u.status !== 'pending');
  $('user-list').innerHTML = rest.length ? rest.map(u => row(u, `<span class="status-chip st-${u.status === 'approved' ? 'online' : u.status === 'suspended' ? 'low' : 'offline'}">${u.status[0].toUpperCase() + u.status.slice(1)}</span>` +
    (u.status === 'approved' ? btn(u, 'suspend', 'Suspend') : btn(u, 'restore', u.status === 'rejected' ? 'Approve' : 'Restore')))).join('') : '<div class="fleet-empty" style="padding:24px 0">No other users yet.</div>';
}
$('sec-admin').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return; b.disabled = true;
  try { await api(`/api/admin/users/${b.dataset.id}/${b.dataset.act}`, { method: 'POST' }); await loadAdmin(); showNotif('✅', 'Updated'); } catch (err) { showNotif('⚠', err.message); b.disabled = false; }
});

// ── Theme ──
function toggleTheme() {
  const d = document.body.dataset.theme !== 'dark'; document.body.dataset.theme = d ? 'dark' : 'light'; localStorage.setItem('ev_theme', d ? 'dark' : 'light');
  Object.keys(charts).forEach(k => { if (charts[k]) charts[k].destroy(); charts[k] = null; }); if (curTab === 'battery') loadHistory();
}
if (localStorage.getItem('ev_theme') === 'dark') document.body.dataset.theme = 'dark';

// ── Boot ──
setMode('login');
if (token) api('/api/me').then(u => { me = u; startApp(); }).catch(() => { token = null; localStorage.removeItem('ev_token'); document.body.dataset.view = 'auth'; });
