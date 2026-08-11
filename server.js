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

function publicCustomer(c) {
  return { id: c.id, name: c.name, mobile: c.mobile, zone: c.zone, address: c.address,
    plan_name: c.plan_name, bottles_total: c.bottles_total, bottles_left: c.bottles_left,
    deposit_bottles: c.deposit_bottles, delivery_day: c.delivery_day, payment: c.payment, status: c.status };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AquaOS running on http://localhost:${PORT}`));
