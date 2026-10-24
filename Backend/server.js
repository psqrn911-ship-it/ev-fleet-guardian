// EV Fleet — API + static server. Config comes from Backend/.env (see .env.example).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const express = require('express'), mongoose = require('mongoose'), cors = require('cors');
// Some home/college networks block MongoDB's SRV DNS lookup; use public DNS locally (Vercel has working DNS).
if (!process.env.VERCEL) { try { require('dns').setServers(['8.8.8.8', '1.1.1.1']); } catch {} }

const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
});
// Tolerate common paste mistakes: surrounding quotes/spaces or a leading "MONGO_URI=".
if (process.env.MONGO_URI) process.env.MONGO_URI = process.env.MONGO_URI.trim().replace(/^MONGO_URI\s*=\s*/i, '').replace(/^["']+|["']+$/g, '').trim();
let configError = '';
if (!process.env.MONGO_URI) configError = 'Missing MONGO_URI';
else if (!/^mongodb(\+srv)?:\/\//.test(process.env.MONGO_URI)) configError = 'MONGO_URI must start with mongodb:// or mongodb+srv://';
if (!process.env.JWT_SECRET) {
  if (process.env.VERCEL) configError = configError || 'Missing JWT_SECRET';   // serverless cannot persist a generated secret
  else { process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex'); try { fs.appendFileSync(ENV_FILE, `\nJWT_SECRET=${process.env.JWT_SECRET}\n`); } catch {} }
}
if (configError) { console.error(configError + '. Copy Backend/.env.example to Backend/.env (or set it in Vercel > Settings > Environment Variables).'); if (!process.env.VERCEL) process.exit(1); }
const SECRET = process.env.JWT_SECRET || 'unset', HOST_EMAIL = 'psqrn.911@gmail.com', PORT = process.env.PORT || 3000;

// ── Auth helpers (Node crypto only: scrypt hashing + HMAC-signed tokens) ──
const sign = p => { const b = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const verify = t => {
  const [b, s] = String(t).split('.'); if (!s) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null;
};
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const checkPw = (pw, u) => { const h = crypto.scryptSync(pw, u.salt, 64), s = Buffer.from(u.hash, 'hex'); return s.length === h.length && crypto.timingSafeEqual(h, s); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const normId = s => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
const num = (x, lo, hi) => { if (x === null || x === undefined || x === '') return undefined; x = Number(x); return Number.isFinite(x) && x >= lo && x <= hi ? x : undefined; };
const bad = (res, m, c = 400) => res.status(c).json({ error: m });
const tries = new Map();
const limited = k => { const n = Date.now(), a = (tries.get(k) || []).filter(t => n - t < 9e5); tries.set(k, a); return a.length >= 8; };

// ── Models ──
const { Schema } = mongoose;
const User = mongoose.model('User', new Schema({ name: String, email: { type: String, unique: true, lowercase: true, trim: true }, salt: String, hash: String,
  role: { type: String, default: 'user' }, status: { type: String, default: 'pending' }, createdAt: { type: Date, default: Date.now } }));
const Vehicle = mongoose.model('Vehicle', new Schema({ vehicle_id: { type: String, unique: true }, name: String, plate: String, owner: { type: Schema.Types.ObjectId, ref: 'User' },
  keyHash: String, fence: { enabled: { type: Boolean, default: false }, lat: Number, lng: Number, radiusKm: { type: Number, default: 5 } }, createdAt: { type: Date, default: Date.now } }));
const dataSchema = new Schema({ vehicle_id: String, battery: Number, voltage: Number, current: Number, temp: Number, lat: Number, lon: Number, time: { type: Date, default: Date.now } });
dataSchema.index({ vehicle_id: 1, time: -1 });
const Data = mongoose.model('Data', dataSchema);

// Serverless-safe connection: awaited per request, re-established if the platform dropped it while idle.
let connecting = null, seeded = false;
async function ensureDb() {
  const st = mongoose.connection.readyState;                 // 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
  if (st === 1 && seeded) return;
  if (st === 0 || st === 3) connecting = null;
  if (!connecting) connecting = mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5, bufferCommands: false })
    .then(async () => {
      console.log('MongoDB Connected');
      if (!seeded) {
        if (!(await User.findOne({ email: HOST_EMAIL }))) {
          const pw = process.env.HOST_PASSWORD || crypto.randomBytes(9).toString('base64url');
          await User.create({ name: 'Host', email: HOST_EMAIL, ...hashPw(pw), role: 'host', status: 'approved' }).catch(() => {});
          console.log(`Host account created: ${HOST_EMAIL}${process.env.HOST_PASSWORD ? '' : '  password: ' + pw + '   (shown once — change it in Profile)'}`);
        }
        seeded = true;
      }
    }).catch(e => { connecting = null; console.log('MongoDB connection error:', e.message); throw e; });
  await connecting;
}
if (!configError && !process.env.VERCEL) ensureDb().catch(() => {});

const app = express();
app.use(cors()); app.use(express.json({ limit: '20kb' }));
app.use(async (req, res, next) => {
  if (configError) return bad(res, 'Server is not configured: ' + configError, 500);
  try { await ensureDb(); next(); } catch (e) { bad(res, 'The database is temporarily unavailable. Please try again in a moment.', 503); }
});
const pub = u => ({ id: u._id, name: u.name, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt });
const auth = (host = false) => async (req, res, next) => {
  const p = verify((req.headers.authorization || '').replace(/^Bearer /, '')), u = p && await User.findById(p.id);
  if (!u || u.status !== 'approved') return bad(res, 'Please sign in', 401);
  if (host && u.role !== 'host') return bad(res, 'Host only', 403);
  req.user = u; next();
};

// ── Accounts ──
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {}, em = String(email || '').trim().toLowerCase();
  if (!name || String(name).trim().length < 2) return bad(res, 'Enter your full name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return bad(res, 'Enter a valid email address');
  if (String(password || '').length < 8) return bad(res, 'Password must be at least 8 characters');
  if (em === HOST_EMAIL) return bad(res, 'This email is reserved for the host. Sign in instead.');
  if (await User.findOne({ email: em })) return bad(res, 'An account with this email already exists', 409);
  await User.create({ name: String(name).trim().slice(0, 80), email: em, ...hashPw(String(password)) });
  res.json({ ok: true, message: 'Request sent. The host must approve your account before you can sign in.' });
});
app.post('/api/auth/login', async (req, res) => {
  const em = String((req.body || {}).email || '').trim().toLowerCase(), pw = String((req.body || {}).password || ''), key = req.ip + em;
  if (limited(key)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
  const u = em && await User.findOne({ email: em });
  if (!u || !checkPw(pw, u)) { tries.get(key).push(Date.now()); return bad(res, 'Incorrect email or password', 401); }
  if (u.status === 'pending') return bad(res, 'Your account is waiting for host approval.', 403);
  if (u.status !== 'approved') return bad(res, 'Your access request was not approved or has been suspended. Contact the host.', 403);
  res.json({ token: sign({ id: u._id }), user: pub(u) });
});
app.get('/api/me', auth(), (req, res) => res.json(pub(req.user)));
app.patch('/api/me', auth(), async (req, res) => {
  const { name, currentPassword, newPassword } = req.body || {}, u = req.user;
  if (name !== undefined) { if (String(name).trim().length < 2) return bad(res, 'Enter your full name'); u.name = String(name).trim().slice(0, 80); }
  if (newPassword) {
    if (!checkPw(String(currentPassword || ''), u)) return bad(res, 'Current password is incorrect');
    if (String(newPassword).length < 8) return bad(res, 'New password must be at least 8 characters');
    Object.assign(u, hashPw(String(newPassword)));
  }
  await u.save(); res.json(pub(u));
});

// ── Host: approvals ──
app.get('/api/admin/users', auth(true), async (req, res) => {
  const users = await User.find({ role: { $ne: 'host' } }).sort({ createdAt: -1 }).lean();
  const counts = await Vehicle.aggregate([{ $group: { _id: '$owner', n: { $sum: 1 } } }]);
  res.json(users.map(u => ({ ...pub(u), id: u._id, vehicles: (counts.find(c => String(c._id) === String(u._id)) || {}).n || 0 })));
});
const ACTIONS = { approve: 'approved', reject: 'rejected', suspend: 'suspended', restore: 'approved' };
app.post('/api/admin/users/:id/:action', auth(true), async (req, res) => {
  const u = await User.findById(req.params.id).catch(() => null), st = ACTIONS[req.params.action];
  if (!u || u.role === 'host' || !st) return bad(res, 'User not found', 404);
  u.status = st; await u.save(); res.json(pub(u));
});

// ── Vehicles ──
const vehOut = async (v, owner) => ({ vehicle_id: v.vehicle_id, name: v.name, plate: v.plate, fence: v.fence, owner: owner || undefined, createdAt: v.createdAt,
  latest: await Data.findOne({ vehicle_id: v.vehicle_id }).sort({ time: -1 }).select('-_id -__v').lean() });
const mine = async (req, res) => {
  const v = await Vehicle.findOne({ vehicle_id: normId(req.params.id) });
  if (!v || (req.user.role !== 'host' && !v.owner.equals(req.user._id))) { bad(res, 'Vehicle not found', 404); return null; }
  return v;
};
app.get('/api/vehicles', auth(), async (req, res) => {
  const host = req.user.role === 'host', list = await Vehicle.find(host ? {} : { owner: req.user._id }).populate('owner', 'name email').sort({ createdAt: 1 });
  res.json(await Promise.all(list.map(v => vehOut(v, host && v.owner ? v.owner.name : undefined))));
});
app.post('/api/vehicles', auth(), async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60), plate = String((req.body || {}).plate || '').trim().slice(0, 20), id = normId(plate);
  if (!name || id.length < 4) return bad(res, 'Enter a vehicle name and a plate / vehicle ID (at least 4 letters or digits)');
  if (await Vehicle.findOne({ vehicle_id: id })) return bad(res, 'A vehicle with this ID is already registered', 409);
  const key = crypto.randomBytes(18).toString('hex');
  const v = await Vehicle.create({ vehicle_id: id, name, plate, owner: req.user._id, keyHash: sha(key) });
  res.json({ vehicle: await vehOut(v), deviceKey: key });
});
app.patch('/api/vehicles/:id', auth(), async (req, res) => {
  const v = await mine(req, res); if (!v) return; const b = req.body || {};
  if (b.name !== undefined) { if (!String(b.name).trim()) return bad(res, 'Enter a vehicle name'); v.name = String(b.name).trim().slice(0, 60); }
  if (b.fence) {
    const f = { enabled: !!b.fence.enabled, lat: num(b.fence.lat, -90, 90), lng: num(b.fence.lng, -180, 180), radiusKm: num(b.fence.radiusKm, 0.1, 500) };
    if (f.enabled && (f.lat === undefined || f.lng === undefined || f.radiusKm === undefined)) return bad(res, 'Set a centre point and a radius between 0.1 and 500 km');
    v.fence = f;
  }
  await v.save(); res.json(await vehOut(v));
});
app.post('/api/vehicles/:id/key', auth(), async (req, res) => {
  const v = await mine(req, res); if (!v) return; const key = crypto.randomBytes(18).toString('hex');
  v.keyHash = sha(key); await v.save(); res.json({ deviceKey: key });
});
app.delete('/api/vehicles/:id', auth(), async (req, res) => {
  const v = await mine(req, res); if (!v) return; await Data.deleteMany({ vehicle_id: v.vehicle_id }); await v.deleteOne(); res.json({ ok: true });
});
app.get('/api/vehicles/:id/history', auth(), async (req, res) => {
  const v = await mine(req, res); if (!v) return; const min = Math.min(Number(req.query.minutes) || 60, 1440);
  res.json(await Data.find({ vehicle_id: v.vehicle_id, time: { $gt: new Date(Date.now() - min * 6e4) } }).sort({ time: 1 }).limit(600).select('-_id -__v -vehicle_id').lean());
});

// ── Device ingest (ESP32 etc.): POST /data with vehicle_id + key ──
app.post('/data', async (req, res) => {
  const b = req.body || {}, v = await Vehicle.findOne({ vehicle_id: normId(b.vehicle_id) }), key = req.headers['x-device-key'] || b.key;
  if (!v || !key || sha(key) !== v.keyHash) return bad(res, 'Unknown vehicle or wrong device key', 401);
  const d = { vehicle_id: v.vehicle_id, battery: num(b.battery, 0, 100), voltage: num(b.voltage, 0, 1500), current: num(b.current, -2000, 2000), temp: num(b.temp, -60, 200), lat: num(b.lat, -90, 90), lon: num(b.lon, -180, 180) };
  if (Object.keys(d).every(k => k === 'vehicle_id' || d[k] === undefined)) return bad(res, 'No valid readings in payload');
  await Data.create(d); res.json({ success: true });
});

// ── Nearby EV chargers (OpenStreetMap via Overpass), cached ──
const cache = new Map();
app.get('/api/chargers', auth(), async (req, res) => {
  const lat = num(req.query.lat, -90, 90), lon = num(req.query.lon, -180, 180); if (lat === undefined || lon === undefined) return bad(res, 'lat and lon required');
  const k = lat.toFixed(2) + ',' + lon.toFixed(2), hit = cache.get(k); if (hit && Date.now() - hit.t < 18e5) return res.json(hit.d);
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'EVFleetMonitor/1.0' },
    body: 'data=' + encodeURIComponent(`[out:json][timeout:20];node["amenity"="charging_station"](around:15000,${lat},${lon});out 60;`), signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!r || !r.ok) return bad(res, 'Charger lookup is unavailable right now', 502);
  const R = 6371, rad = x => x * Math.PI / 180;
  const d = (await r.json()).elements.map(e => ({ name: e.tags.name || e.tags.operator || 'EV charging station', operator: e.tags.operator || '', capacity: e.tags.capacity || '', lat: e.lat, lon: e.lon,
    distKm: 2 * R * Math.asin(Math.sqrt(Math.sin(rad(e.lat - lat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(e.lat)) * Math.sin(rad(e.lon - lon) / 2) ** 2)) })).sort((a, b) => a.distKm - b.distKm).slice(0, 10);
  cache.set(k, { t: Date.now(), d }); res.json(d);
});

app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.use(express.static(path.join(__dirname, '../public')));
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.use((e, req, res, next) => { console.error(e); const db = /Mongo|buffering|topology|ECONN|ETIMEDOUT/i.test(String(e && (e.name + e.message))); res.status(db ? 503 : 500).json({ error: db ? 'The database is temporarily unavailable. Please try again in a moment.' : 'Server error' }); });
if (require.main === module) app.listen(PORT, () => console.log(`Server running on port ${PORT} — http://localhost:${PORT}`));
module.exports = app;   // Vercel imports this
