// AquaOS — API + static server
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, genUniquePin, nextDateFor, today } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COMPANY = process.env.COMPANY_NAME || 'PureWave Water';
const fmtMobile = m => '0' + String(m).replace(/\D/g, '').replace(/^971/, '');

function welcomeMessage(c, baseUrl) {
  const link = `${baseUrl}/customer.html`;
  return (
`Hello ${c.name}, welcome to ${COMPANY}!

Your water deliveries are now managed online — no app to install.

How to log in:
1. Open your portal: ${link}
2. Enter your mobile number: ${fmtMobile(c.mobile)}
3. Enter your 4-digit PIN: ${c.pin}

Your plan: ${c.plan_name} (${c.bottles_total} bottles). First delivery: ${c.delivery_day}.
You can change quantity, skip a week, request extra bottles and see delivery photos anytime.`);
}
function waLink(c, baseUrl) {
  const digits = String(c.mobile).replace(/\D/g, '').replace(/^0/, '');
  const intl = digits.startsWith('971') ? digits : '971' + digits;
  return `https://wa.me/${intl}?text=${encodeURIComponent(welcomeMessage(c, baseUrl))}`;
}
const baseOf = req => `${req.protocol}://${req.get('host')}`;

// ---------------- AUTH ----------------
app.post('/api/customer/login', (req, res) => {
  const mobile = String(req.body.mobile || '').replace(/\D/g, '').replace(/^971/, '').replace(/^0/, '');
  const c = db.prepare('SELECT * FROM customers WHERE mobile LIKE ?').get('%' + mobile);
  if (!c || !mobile) return res.status(404).json({ ok: false, error: 'No account for that mobile number.' });
  if (String(req.body.pin) !== String(c.pin)) return res.status(401).json({ ok: false, error: 'Incorrect PIN.' });
  res.json({ ok: true, customer: publicCustomer(c) });
});
app.post('/api/driver/login', (req, res) => {
  const mobile = String(req.body.mobile || '').replace(/\D/g, '').replace(/^0/, '');
  const d = db.prepare('SELECT * FROM drivers WHERE mobile LIKE ?').get('%' + mobile);
  if (!d) return res.status(404).json({ ok: false, error: 'No driver for that mobile number.' });
  if (String(req.body.pin) !== String(d.pin)) return res.status(401).json({ ok: false, error: 'Incorrect PIN.' });
  res.json({ ok: true, driver: { id: d.id, name: d.name, truck: d.truck, route: d.route, cap_full: d.cap_full, cap_empty: d.cap_empty } });
});

// ---------------- CRM ----------------
app.get('/api/stats', (req, res) => {
  const t = today();
  const g = q => db.prepare(q).get();
  const gt = q => db.prepare(q).get(t);
  res.json({
    customers: g('SELECT COUNT(*) c FROM customers').c,
    active: g("SELECT COUNT(*) c FROM customers WHERE status='active'").c,
    deliveriesToday: gt('SELECT COUNT(*) c FROM deliveries WHERE scheduled_date=?').c,
    completedToday: db.prepare("SELECT COUNT(*) c FROM deliveries WHERE scheduled_date=? AND status='done'").get(t).c,
    bottlesOut: g('SELECT COALESCE(SUM(bottles_left),0) s FROM customers').s,
    deposits: g('SELECT COALESCE(SUM(deposit_bottles),0)*30 s FROM customers').s,
    drivers: g('SELECT COUNT(*) c FROM drivers').c
  });
});
app.get('/api/customers', (req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY id DESC').all().map(publicCustomer));
});
app.get('/api/plans', (req, res) => res.json(db.prepare('SELECT * FROM plans').all()));
app.get('/api/drivers', (req, res) => res.json(db.prepare('SELECT id,name,mobile,truck,route,cap_full,cap_empty,status FROM drivers').all()));

app.post('/api/customers', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.mobile) return res.status(400).json({ ok: false, error: 'Name and mobile are required.' });
  const mobileDigits = String(b.mobile).replace(/\D/g, '').replace(/^0/, '');
  const exists = db.prepare('SELECT id FROM customers WHERE mobile LIKE ?').get('%' + mobileDigits);
  if (exists) return res.status(409).json({ ok: false, error: 'A customer with that mobile already exists.' });
  const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(b.plan_id) || db.prepare('SELECT * FROM plans LIMIT 1').get();
  const pin = genUniquePin();
  const info = db.prepare(`INSERT INTO customers(name,mobile,pin,zone,address,plan_id,plan_name,bottles_total,bottles_left,deposit_bottles,delivery_day,payment,status,created_at)
    VALUES(@name,@mobile,@pin,@zone,@address,@plan_id,@plan_name,@bt,@bl,@dep,@day,@pay,'active',@created)`).run({
      name: b.name, mobile: mobileDigits, pin, zone: b.zone || '', address: b.address || '',
      plan_id: plan.id, plan_name: plan.name, bt: plan.bottles, bl: plan.bottles, dep: 0,
      day: b.delivery_day || 'Wednesday', pay: b.payment || 'online', created: new Date().toISOString()
    });
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid);
  // schedule the first delivery
  const sd = nextDateFor(c.delivery_day);
  const drv = db.prepare('SELECT id FROM drivers WHERE route=? OR 1=1 LIMIT 1').get('Route A');
  const seq = (db.prepare('SELECT COUNT(*) c FROM deliveries WHERE scheduled_date=?').get(sd).c) + 1;
  db.prepare('INSERT INTO deliveries(customer_id,driver_id,scheduled_date,seq,qty_requested,status) VALUES(?,?,?,?,?,?)')
    .run(c.id, drv ? drv.id : null, sd, seq, Math.min(2, c.bottles_total), 'pending');
  db.prepare('INSERT INTO ledger(customer_id,delta,reason,created_at) VALUES(?,?,?,?)')
    .run(c.id, c.bottles_total, `Plan purchased (${c.plan_name})`, new Date().toISOString());
  const base = baseOf(req);
  res.json({ ok: true, customer: publicCustomer(c), pin, welcomeMessage: welcomeMessage(c, base), whatsappLink: waLink(c, base), portalLink: `${base}/customer.html` });
});

// ---------------- CUSTOMER ----------------
app.get('/api/customer/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const next = db.prepare("SELECT * FROM deliveries WHERE customer_id=? AND status='pending' ORDER BY scheduled_date LIMIT 1").get(c.id);
  res.json({ customer: publicCustomer(c), nextDelivery: next || null });
});
app.get('/api/customer/:id/history', (req, res) => {
  res.json(db.prepare("SELECT * FROM deliveries WHERE customer_id=? AND status='done' ORDER BY completed_at DESC").all(req.params.id));
});
app.post('/api/customer/:id/request', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ ok: false });
  const { type, qty, note } = req.body || {};
  db.prepare('INSERT INTO requests(customer_id,type,qty,note,created_at) VALUES(?,?,?,?,?)').run(c.id, type, qty || null, note || '', new Date().toISOString());
  // reflect quantity change onto the next pending delivery
  if (type === 'quantity' && qty != null) {
    const next = db.prepare("SELECT * FROM deliveries WHERE customer_id=? AND status='pending' ORDER BY scheduled_date LIMIT 1").get(c.id);
    if (next) db.prepare('UPDATE deliveries SET qty_requested=? WHERE id=?').run(qty, next.id);
  }
  if (type === 'skip') {
    const next = db.prepare("SELECT * FROM deliveries WHERE customer_id=? AND status='pending' ORDER BY scheduled_date LIMIT 1").get(c.id);
    if (next) db.prepare("UPDATE deliveries SET status='skipped' WHERE id=?").run(next.id);
  }
  res.json({ ok: true });
});

// ---------------- DRIVER ----------------
app.get('/api/driver/:id/stops', (req, res) => {
  const rows = db.prepare(`SELECT d.*, c.name customer, c.address, c.zone, c.bottles_left, c.mobile
    FROM deliveries d JOIN customers c ON c.id=d.customer_id
    WHERE d.driver_id=? AND d.scheduled_date=? ORDER BY d.seq`).all(req.params.id, today());
  res.json(rows);
});
app.post('/api/delivery/:id/complete', (req, res) => {
  const d = db.prepare('SELECT * FROM deliveries WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ ok: false });
  const full = Number(req.body.full ?? d.qty_requested);
  const empties = Number(req.body.empties ?? full);
  const proof = req.body.proof ? 1 : 0;
  db.prepare("UPDATE deliveries SET status='done', qty_delivered=?, empties_collected=?, proof=?, completed_at=? WHERE id=?")
    .run(full, empties, proof, new Date().toISOString(), d.id);
  // entitlement consumed on completion
  db.prepare('UPDATE customers SET bottles_left = MAX(0, bottles_left - ?) WHERE id=?').run(full, d.customer_id);
  db.prepare('INSERT INTO ledger(customer_id,delta,reason,created_at) VALUES(?,?,?,?)')
    .run(d.customer_id, -full, `Delivery completed (${full} bottles)`, new Date().toISOString());
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(d.customer_id);
  res.json({ ok: true, bottles_left: c.bottles_left });
});
app.post('/api/delivery/:id/exception', (req, res) => {
  const d = db.prepare('SELECT * FROM deliveries WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ ok: false });
  db.prepare("UPDATE deliveries SET status='exception', exception=?, completed_at=? WHERE id=?")
    .run(req.body.type || 'exception', new Date().toISOString(), d.id);
  res.json({ ok: true });
});
app.get('/api/exceptions', (req, res) => {
  res.json(db.prepare(`SELECT d.id,d.exception,d.completed_at,c.name customer,c.address FROM deliveries d JOIN customers c ON c.id=d.customer_id WHERE d.status='exception' ORDER BY d.completed_at DESC`).all());
});

// ---------------- PROMOTIONS ----------------
app.get('/api/promotions', (req, res) => res.json(db.prepare('SELECT * FROM promotions ORDER BY id').all()));
app.post('/api/promotions', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ ok: false, error: 'Name required' });
  const info = db.prepare('INSERT INTO promotions(name,ptype,code,reward,ends,applies_to,portal_visible,redemptions) VALUES(?,?,?,?,?,?,?,0)')
    .run(b.name, b.ptype || 'Custom', b.code || '', b.reward || '', b.ends || 'Ongoing', b.applies_to || 'All customers', b.portal_visible ? 1 : 0);
  res.json({ ok: true, promotion: db.prepare('SELECT * FROM promotions WHERE id=?').get(info.lastInsertRowid) });
});
app.post('/api/promotions/:id/toggle', (req, res) => {
  db.prepare('UPDATE promotions SET portal_visible = 1 - portal_visible WHERE id=?').run(req.params.id);
  res.json({ ok: true, promotion: db.prepare('SELECT * FROM promotions WHERE id=?').get(req.params.id) });
});

// ---------------- PRODUCTS ----------------
app.get('/api/products', (req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY id').all()));
app.post('/api/products', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ ok: false, error: 'Name required' });
  const info = db.prepare('INSERT INTO products(name,category,price,cost,stock,sold,in_store,description) VALUES(?,?,?,?,?,0,?,?)')
    .run(b.name, b.category || 'Accessory', Number(b.price) || 0, Number(b.cost) || 0, Number(b.stock) || 0, b.in_store ? 1 : 0, b.description || '');
  res.json({ ok: true, product: db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid) });
});
app.post('/api/products/:id/toggle', (req, res) => {
  db.prepare('UPDATE products SET in_store = 1 - in_store WHERE id=?').run(req.params.id);
  res.json({ ok: true, product: db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id) });
});

// ---------------- INVENTORY ----------------
app.get('/api/inventory', (req, res) => {
  const depots = db.prepare('SELECT * FROM depots').all();
  const pool = depots.reduce((a, d) => a + d.full_ready + d.empty_unwashed + d.in_wash + d.in_truck + d.at_customer + d.damaged, 0);
  const atCust = depots.reduce((a, d) => a + d.at_customer, 0);
  const damaged = depots.reduce((a, d) => a + d.damaged, 0);
  res.json({ depots, pool, atCustomer: atCust, damaged, lossPct: pool ? +(damaged / pool * 100).toFixed(1) : 0 });
});

// ---------------- RECONCILIATION (today, per driver route) ----------------
app.get('/api/reconciliation', (req, res) => {
  const t = today();
  const drivers = db.prepare('SELECT * FROM drivers').all();
  const out = drivers.map(d => {
    const rows = db.prepare('SELECT * FROM deliveries WHERE driver_id=? AND scheduled_date=?').all(d.id, t);
    const loaded = rows.reduce((a, r) => a + (r.qty_requested || 0), 0);
    const delivered = rows.filter(r => r.status === 'done').reduce((a, r) => a + (r.qty_delivered || 0), 0);
    const empties = rows.filter(r => r.status === 'done').reduce((a, r) => a + (r.empties_collected || 0), 0);
    const remaining = Math.max(0, loaded - delivered);
    return { route: d.route, driver: d.name, truck: d.truck, loaded, delivered, empties, remaining, variance: Math.max(0, delivered - empties) };
  });
  res.json(out);
});

// ---------------- BILLING ----------------
app.get('/api/billing', (req, res) => {
  const plans = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM customers c WHERE c.plan_id=p.id) active FROM plans p').all();
  const mrr = plans.reduce((a, p) => a + p.price * p.active, 0);
  const deposits = db.prepare('SELECT COALESCE(SUM(deposit_bottles),0)*30 s FROM customers').get().s;
  const renewalsDue = db.prepare('SELECT COUNT(*) c FROM customers WHERE bottles_left <= 3').get().c;
  const overdue = db.prepare("SELECT COUNT(*) c FROM customers WHERE status='payment due' OR bottles_left=0").get().c;
  res.json({ mrr, deposits, renewalsDue, overdue, plans });
});
app.get('/api/customer/:id/ledger', (req, res) => {
  res.json(db.prepare('SELECT * FROM ledger WHERE customer_id=? ORDER BY id DESC').all(req.params.id));
});

// ---------------- REPORTS ----------------
app.get('/api/reports', (req, res) => {
  const done = db.prepare("SELECT COUNT(*) c FROM deliveries WHERE status='done'").get().c;
  const total = db.prepare('SELECT COUNT(*) c FROM deliveries').get().c;
  const reused = db.prepare("SELECT COALESCE(SUM(empties_collected),0) s FROM deliveries").get().s;
  res.json({ successRate: total ? +(done / total * 100).toFixed(1) : 0, deliveries: total, completed: done, bottlesReused: reused });
});

// ---------------- SCHEDULES ----------------
app.get('/api/schedules', (req, res) => {
  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const rows = db.prepare('SELECT zone, delivery_day, COUNT(*) stops FROM customers GROUP BY zone, delivery_day').all();
  const zones = [...new Set(db.prepare('SELECT zone FROM customers').all().map(r => r.zone || 'Unzoned'))];
  const out = zones.map(z => {
    const days = {};
    DAYS.forEach(d => { const r = rows.find(x => (x.zone || 'Unzoned') === z && x.delivery_day === d); days[d] = r ? r.stops : 0; });
    return { zone: z, days };
  });
  res.json({ days: DAYS, rows: out });
});

// ---------------- ROUTES ----------------
app.get('/api/routes', (req, res) => {
  const t = today();
  const drivers = db.prepare('SELECT * FROM drivers').all();
  const out = drivers.map(d => {
    const stops = db.prepare(`SELECT dl.*, c.name customer, c.address FROM deliveries dl JOIN customers c ON c.id=dl.customer_id WHERE dl.driver_id=? AND dl.scheduled_date=? ORDER BY dl.seq`).all(d.id, t);
    const load = stops.reduce((a, s) => a + (s.qty_requested || 0), 0);
    const done = stops.filter(s => s.status !== 'pending').length;
    return { route: d.route, driver: d.name, truck: d.truck, cap_full: d.cap_full, cap_empty: d.cap_empty, stops, load, done, total: stops.length };
  });
  res.json(out);
});

// ---------------- SETTINGS ----------------
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const obj = {}; rows.forEach(r => obj[r.key] = r.value); res.json(obj);
});
app.put('/api/settings', (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ ok: false });
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  res.json({ ok: true });
});

// ---------------- ROLES ----------------
app.get('/api/roles', (req, res) => res.json(db.prepare('SELECT * FROM roles ORDER BY id').all()));
app.post('/api/roles/:id/toggle', (req, res) => {
  const col = req.body.col; if (!['admin','ops','dispatch','driver'].includes(col)) return res.status(400).json({ ok: false });
  db.prepare(`UPDATE roles SET ${col} = 1 - ${col} WHERE id=?`).run(req.params.id);
  res.json({ ok: true, role: db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id) });
});

// ---------------- TRACEABILITY ----------------
app.get('/api/batches', (req, res) => {
  res.json(db.prepare('SELECT id,code,source,tds,bottled_date,line,units,delivered,lab FROM batches ORDER BY id DESC').all());
});
app.get('/api/batches/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM batches WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });
  b.lineage = JSON.parse(b.lineage || '[]'); res.json(b);
});

// ---------------- EXCEPTION RESOLVE ----------------
app.post('/api/exception/:id/resolve', (req, res) => {
  db.prepare("UPDATE deliveries SET status='resolved' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------------- CUSTOMER ACTIONS (edit / adjust / renew / delete) ----------------
app.patch('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ ok: false });
  const b = req.body || {};
  let plan = null;
  if (b.plan_id) plan = db.prepare('SELECT * FROM plans WHERE id=?').get(b.plan_id);
  db.prepare(`UPDATE customers SET name=?, zone=?, address=?, delivery_day=?, status=?, plan_id=?, plan_name=?, bottles_total=? WHERE id=?`)
    .run(b.name ?? c.name, b.zone ?? c.zone, b.address ?? c.address, b.delivery_day ?? c.delivery_day, b.status ?? c.status,
      plan ? plan.id : c.plan_id, plan ? plan.name : c.plan_name, plan ? plan.bottles : c.bottles_total, c.id);
  res.json({ ok: true, customer: publicCustomer(db.prepare('SELECT * FROM customers WHERE id=?').get(c.id)) });
});
app.post('/api/customers/:id/adjust', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ ok: false });
  const delta = Math.trunc(Number(req.body.delta) || 0);
  db.prepare('UPDATE customers SET bottles_left = MAX(0, bottles_left + ?) WHERE id=?').run(delta, c.id);
  db.prepare('INSERT INTO ledger(customer_id,delta,reason,created_at) VALUES(?,?,?,?)')
    .run(c.id, delta, req.body.reason || 'Manual adjustment', new Date().toISOString());
  res.json({ ok: true, bottles_left: db.prepare('SELECT bottles_left FROM customers WHERE id=?').get(c.id).bottles_left });
});
app.post('/api/customers/:id/renew', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ ok: false });
  db.prepare("UPDATE customers SET bottles_left = bottles_total, status='active' WHERE id=?").run(c.id);
  db.prepare('INSERT INTO ledger(customer_id,delta,reason,created_at) VALUES(?,?,?,?)')
    .run(c.id, c.bottles_total, `Plan renewed (${c.plan_name})`, new Date().toISOString());
  res.json({ ok: true, customer: publicCustomer(db.prepare('SELECT * FROM customers WHERE id=?').get(c.id)) });
});
app.delete('/api/customers/:id', (req, res) => {
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM deliveries WHERE customer_id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------- DRIVERS (create) ----------------
app.post('/api/drivers', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.mobile) return res.status(400).json({ ok: false, error: 'Name and mobile required' });
  const mobile = String(b.mobile).replace(/\D/g, '').replace(/^0/, '');
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  try {
    const info = db.prepare('INSERT INTO drivers(name,mobile,pin,truck,route,cap_full,cap_empty) VALUES(?,?,?,?,?,?,?)')
      .run(b.name, mobile, pin, b.truck || 'Unassigned', b.route || 'Unassigned', Number(b.cap_full) || 100, Number(b.cap_empty) || 110);
    res.json({ ok: true, driver: db.prepare('SELECT * FROM drivers WHERE id=?').get(info.lastInsertRowid), pin });
  } catch (e) { res.status(409).json({ ok: false, error: 'A driver with that mobile already exists.' }); }
});

// ---------------- PLANS (create) ----------------
app.post('/api/plans', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ ok: false, error: 'Name required' });
  const info = db.prepare('INSERT INTO plans(name,bottles,cadence,price,deposit) VALUES(?,?,?,?,?)')
    .run(b.name, Number(b.bottles) || 0, b.cadence || 'Weekly', Number(b.price) || 0, Number(b.deposit) || 30);
  res.json({ ok: true, plan: db.prepare('SELECT * FROM plans WHERE id=?').get(info.lastInsertRowid) });
});

// ---------------- INVENTORY (adjust) ----------------
app.post('/api/inventory/:id/adjust', (req, res) => {
  const d = db.prepare('SELECT * FROM depots WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ ok: false });
  const f = req.body.field, delta = Math.trunc(Number(req.body.delta) || 0);
  if (!['full_ready','empty_unwashed','in_wash','in_truck','at_customer','damaged'].includes(f)) return res.status(400).json({ ok: false });
  db.prepare(`UPDATE depots SET ${f} = MAX(0, ${f} + ?) WHERE id=?`).run(delta, d.id);
  res.json({ ok: true, depot: db.prepare('SELECT * FROM depots WHERE id=?').get(d.id) });
});

// ---------------- ROUTES (dispatch / reorder) ----------------
app.post('/api/routes/dispatch', (req, res) => {
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('last_dispatch', stamp);
  const routes = db.prepare('SELECT COUNT(DISTINCT route) c FROM drivers').get().c;
  res.json({ ok: true, dispatchedRoutes: routes, at: stamp });
});
app.post('/api/routes/reorder', (req, res) => {
  const driverId = req.body.driver_id;
  const stops = db.prepare("SELECT * FROM deliveries WHERE driver_id=? AND scheduled_date=? ORDER BY seq").all(driverId, today());
  // simple "optimise": pending first, then keep order — re-sequence 1..n
  const ordered = [...stops.filter(s => s.status === 'pending'), ...stops.filter(s => s.status !== 'pending')];
  ordered.forEach((s, i) => db.prepare('UPDATE deliveries SET seq=? WHERE id=?').run(i + 1, s.id));
  res.json({ ok: true, stops: ordered.length });
});

// ---------------- RECONCILIATION (approve) ----------------
app.post('/api/reconciliation/approve', (req, res) => {
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('recon_approved_' + (req.body.route || 'all'), stamp);
  res.json({ ok: true, at: stamp });
});

// ---------------- TRACEABILITY (recall) ----------------
app.post('/api/batches/:id/recall', (req, res) => {
  const b = db.prepare('SELECT * FROM batches WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ ok: false });
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('recall_' + b.id, new Date().toISOString());
  const affected = db.prepare("SELECT DISTINCT c.id, c.name, c.address FROM deliveries d JOIN customers c ON c.id=d.customer_id WHERE d.status='done'").all();
  res.json({ ok: true, batch: b.code, affectedCount: affected.length, affected });
});

// ---------------- ROLES (create) ----------------
app.post('/api/roles', (req, res) => {
  if (!req.body.capability) return res.status(400).json({ ok: false });
  const info = db.prepare('INSERT INTO roles(capability,admin,ops,dispatch,driver) VALUES(?,1,0,0,0)').run(req.body.capability);
  res.json({ ok: true, role: db.prepare('SELECT * FROM roles WHERE id=?').get(info.lastInsertRowid) });
});

// ---------------- PROMO / PRODUCT delete ----------------
app.delete('/api/promotions/:id', (req, res) => { db.prepare('DELETE FROM promotions WHERE id=?').run(req.params.id); res.json({ ok: true }); });
app.delete('/api/products/:id', (req, res) => { db.prepare('DELETE FROM products WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------------- CUSTOMER STORE & ORDERS ----------------
app.get('/api/store/products', (req, res) => res.json(db.prepare('SELECT * FROM products WHERE in_store=1 ORDER BY id').all()));
app.get('/api/store/promotions', (req, res) => res.json(db.prepare('SELECT * FROM promotions WHERE portal_visible=1 ORDER BY id').all()));
app.post('/api/customer/:id/order', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ ok: false });
  const items = req.body.items || [];
  const total = items.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
  const info = db.prepare('INSERT INTO orders(customer_id,items,total,created_at) VALUES(?,?,?,?)')
    .run(c.id, JSON.stringify(items), total, new Date().toISOString());
  // decrement product stock
  items.forEach(i => { if (i.id) db.prepare('UPDATE products SET stock=MAX(0,stock-?), sold=sold+? WHERE id=?').run(i.qty || 1, i.qty || 1, i.id); });
  res.json({ ok: true, orderId: info.lastInsertRowid, total });
});
app.get('/api/orders', (req, res) => {
  res.json(db.prepare('SELECT o.*, c.name customer FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC').all().map(o => ({ ...o, items: JSON.parse(o.items || '[]') })));
});

function publicCustomer(c) {
  return { id: c.id, name: c.name, mobile: c.mobile, zone: c.zone, address: c.address,
    plan_name: c.plan_name, bottles_total: c.bottles_total, bottles_left: c.bottles_left,
    deposit_bottles: c.deposit_bottles, delivery_day: c.delivery_day, payment: c.payment, status: c.status };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AquaOS running on http://localhost:${PORT}`));
