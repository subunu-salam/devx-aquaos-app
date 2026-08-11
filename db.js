// AquaOS — database layer (SQLite via better-sqlite3)
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './aquaos.db';
export const db = new Database(DB_PATH);
try { db.pragma('journal_mode = WAL'); } catch (e) { /* some filesystems disallow WAL; default mode is fine */ }

db.exec(`
CREATE TABLE IF NOT EXISTS plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, bottles INTEGER, cadence TEXT, price INTEGER, deposit INTEGER
);
CREATE TABLE IF NOT EXISTS drivers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, mobile TEXT UNIQUE, pin TEXT, truck TEXT, route TEXT,
  cap_full INTEGER DEFAULT 120, cap_empty INTEGER DEFAULT 130, status TEXT DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, mobile TEXT UNIQUE, pin TEXT,
  zone TEXT, address TEXT,
  plan_id INTEGER, plan_name TEXT,
  bottles_total INTEGER, bottles_left INTEGER, deposit_bottles INTEGER DEFAULT 0,
  delivery_day TEXT, payment TEXT DEFAULT 'online', status TEXT DEFAULT 'active',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS deliveries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER, driver_id INTEGER,
  scheduled_date TEXT, seq INTEGER,
  qty_requested INTEGER, qty_delivered INTEGER DEFAULT 0, empties_collected INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', proof INTEGER DEFAULT 0, exception TEXT,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER, delta INTEGER, reason TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER, type TEXT, qty INTEGER, note TEXT,
  status TEXT DEFAULT 'open', created_at TEXT
);
`);

// ---------- helpers ----------
export function genUniquePin() {
  const used = new Set(db.prepare('SELECT pin FROM customers').all().map(r => r.pin));
  let pin;
  do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(pin));
  return pin;
}
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export function nextDateFor(day) {
  const target = DAYS.indexOf(day);
  const now = new Date();
  let d = new Date(now);
  for (let i = 1; i <= 7; i++) { d = new Date(now); d.setDate(now.getDate() + i); if (d.getDay() === target) break; }
  return d.toISOString().slice(0, 10);
}
export const today = () => new Date().toISOString().slice(0, 10);

// ---------- seed (only if empty) ----------
if (db.prepare('SELECT COUNT(*) c FROM customers').get().c === 0) {
  const now = new Date().toISOString();
  const plan = db.prepare('INSERT INTO plans(name,bottles,cadence,price,deposit) VALUES(?,?,?,?,?)');
  const pStarter = plan.run('Starter', 11, 'Weekly', 80, 30).lastInsertRowid;
  const pFamily  = plan.run('Family', 22, 'Weekly', 150, 30).lastInsertRowid;
  const pOffice  = plan.run('Office', 44, '2x/week', 290, 30).lastInsertRowid;

  const drv = db.prepare('INSERT INTO drivers(name,mobile,pin,truck,route,cap_full,cap_empty) VALUES(?,?,?,?,?,?,?)');
  const karim = drv.run('Karim Saleh', '552107788', '7306', 'DXB-07', 'Route A', 120, 130).lastInsertRowid;
  const yusuf = drv.run('Yusuf Malik', '551234000', '1122', 'DXB-02', 'Route B', 100, 110).lastInsertRowid;

  const cust = db.prepare(`INSERT INTO customers(name,mobile,pin,zone,address,plan_id,plan_name,bottles_total,bottles_left,deposit_bottles,delivery_day,payment,status,created_at)
    VALUES(@name,@mobile,@pin,@zone,@address,@plan_id,@plan_name,@bottles_total,@bottles_left,@deposit_bottles,@delivery_day,@payment,'active',@created_at)`);
  const fatima = cust.run({name:'Fatima Hassan',mobile:'501234567',pin:'4921',zone:'Marina',address:'Villa 24, Jumeirah',plan_id:pStarter,plan_name:'Starter',bottles_total:11,bottles_left:8,deposit_bottles:2,delivery_day:'Wednesday',payment:'online',created_at:now}).lastInsertRowid;
  const sara   = cust.run({name:'Sara Khalil',mobile:'504445555',pin:'5567',zone:'Marina',address:'Apt 1203, Marina Gate',plan_id:pStarter,plan_name:'Starter',bottles_total:11,bottles_left:2,deposit_bottles:1,delivery_day:'Wednesday',payment:'online',created_at:now}).lastInsertRowid;
  const ahmed  = cust.run({name:'Ahmed Rahman',mobile:'502223333',pin:'3810',zone:'Bay',address:'Office 5F, Business Bay',plan_id:pOffice,plan_name:'Office',bottles_total:44,bottles_left:17,deposit_bottles:4,delivery_day:'Tuesday',payment:'cash',created_at:now}).lastInsertRowid;

  const t = today();
  const del = db.prepare(`INSERT INTO deliveries(customer_id,driver_id,scheduled_date,seq,qty_requested,status) VALUES(?,?,?,?,?,?)`);
  del.run(fatima, karim, t, 1, 2, 'pending');
  del.run(sara,   karim, t, 2, 2, 'pending');
  del.run(ahmed,  yusuf, t, 1, 3, 'pending');

  // a past completed delivery for history
  const past = '2026-08-04';
  const doneId = db.prepare(`INSERT INTO deliveries(customer_id,driver_id,scheduled_date,seq,qty_requested,qty_delivered,empties_collected,status,proof,completed_at) VALUES(?,?,?,?,?,?,?, 'done',1,?)`)
    .run(fatima, karim, past, 1, 2, 2, 2, past + 'T09:04:00').lastInsertRowid;
  db.prepare('INSERT INTO ledger(customer_id,delta,reason,created_at) VALUES(?,?,?,?)').run(fatima, -2, 'Delivery completed (2 bottles)', past + 'T09:04:00');

  console.log('Seeded demo data. Customer PIN example Fatima 050 123 4567 / 4921 · Driver Karim 055 210 7788 / 7306');
}
