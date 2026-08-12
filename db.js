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
CREATE TABLE IF NOT EXISTS promotions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, ptype TEXT, code TEXT, reward TEXT, ends TEXT, applies_to TEXT,
  portal_visible INTEGER DEFAULT 1, redemptions INTEGER DEFAULT 0, status TEXT DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, category TEXT, price INTEGER, cost INTEGER, stock INTEGER,
  sold INTEGER DEFAULT 0, in_store INTEGER DEFAULT 1, description TEXT
);
CREATE TABLE IF NOT EXISTS depots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, full_ready INTEGER, empty_unwashed INTEGER, in_wash INTEGER, in_truck INTEGER, at_customer INTEGER, damaged INTEGER, capacity INTEGER
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS batches(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT, source TEXT, tds TEXT, bottled_date TEXT, line TEXT, units INTEGER, delivered INTEGER, lab TEXT, lineage TEXT
);
CREATE TABLE IF NOT EXISTS roles(
  id INTEGER PRIMARY KEY AUTOINCREMENT, capability TEXT, admin INTEGER, ops INTEGER, dispatch INTEGER, driver INTEGER
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

  const promo = db.prepare('INSERT INTO promotions(name,ptype,code,reward,ends,applies_to,portal_visible,redemptions) VALUES(?,?,?,?,?,?,?,?)');
  promo.run('Renew Now → 2 Free Bottles','Renewal offer','RENEW2FREE','2 free bottles','31 Aug 2026','All weekly plans',1,142);
  promo.run('Spend AED 300, Save AED 40','Spend threshold','SAVE40','AED 40 off','Ongoing','All customers',1,96);
  promo.run('Refer a Friend — AED 20 Each','Referral','FRIEND20','AED 20 credit','Ongoing','All customers',0,88);
  promo.run('Plan + Electric Dispenser 15% Off','Bundle','COOLBUNDLE','15% off dispenser','15 Sep 2026','New sign-ups',0,54);
  promo.run('Ramadan Family Pack','Seasonal','RAMADAN26','Discounted family plan','18 Feb 2027','Family plan',0,0);

  const prod = db.prepare('INSERT INTO products(name,category,price,cost,stock,sold,in_store,description) VALUES(?,?,?,?,?,?,?,?)');
  prod.run('Manual Pressure Dispenser','Dispenser — manual / pressure',25,14,340,128,1,'Hand-pump / push-type dispenser. No electricity — presses water straight from the 5-gal bottle.');
  prod.run('Electric Water Dispenser','Dispenser — electric / motor',60,38,120,74,1,'Electric motor pump on a stand — automatic dispensing at the press of a button.');
  prod.run('Hot & Cold Dispenser','Dispenser — hot & cold',899,610,28,12,1,'Floor-standing unit with hot, cold and room-temperature taps. Child-lock on hot tap.');
  prod.run('Bottle Stand (steel)','Accessory',45,22,90,16,1,'Raised metal stand to mount a 5-gal bottle with a manual dispenser at counter height.');
  prod.run('Hygiene Caps (12-pack)','Accessory',15,6,500,4,1,'Single-use sanitary seals for the bottle neck.');
  prod.run('Dispenser Cleaning Kit','Accessory',30,12,60,2,0,'Brush + food-safe sanitiser sachets for periodic cleaning.');

  const dep = db.prepare('INSERT INTO depots(name,full_ready,empty_unwashed,in_wash,in_truck,at_customer,damaged,capacity) VALUES(?,?,?,?,?,?,?,?)');
  dep.run('Al Quoz',1842,760,320,410,3980,84,2560);
  dep.run('Deira',640,512,210,288,2640,66,2050);
  dep.run('Ras Al Khor',1320,430,180,360,2500,62,2000);

  const setq = db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
  [['company','PureWave Water'],['proof_required','on'],['qr_verification','on'],['online_payments','on'],['whatsapp_notifications','on'],['pin_login','on'],['cash_cod','off'],['bilingual','on'],['cutoff_time','20:00'],['deposit_per_bottle','30']].forEach(([k,v])=>setq.run(k,v));

  const rq = db.prepare('INSERT INTO roles(capability,admin,ops,dispatch,driver) VALUES(?,?,?,?,?)');
  rq.run('View customers',1,1,1,0); rq.run('Edit plans & billing',1,1,0,0); rq.run('Dispatch routes',1,1,1,0);
  rq.run('Complete deliveries',1,0,0,1); rq.run('Approve reconciliation',1,1,0,0); rq.run('Manage tenant config',1,0,0,0);

  const lineage = JSON.stringify([
    {t:'Source intake · Hatta Spring', s:'07 Aug 04:10 · TDS & microbio check passed'},
    {t:'Bottled · Line 2', s:'08 Aug 06:22 · seal & fill weight verified'},
    {t:'Depot stock · Al Quoz', s:'08 Aug 09:40 · QA released to ready stock'},
    {t:'Loaded · Truck DXB-07 · Route A', s:'10 Aug 07:12 · Karim S.'},
    {t:'Delivered · Villa 24, Jumeirah', s:'10 Aug 09:04 · proof photo · entitlement consumed'},
    {t:'Empty returned · wash cycle', s:'Awaiting next visit · asset in-field'}
  ]);
  db.prepare('INSERT INTO batches(code,source,tds,bottled_date,line,units,delivered,lab,lineage) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('B-2608-14','Hatta Spring','110 ppm','08 Aug 2026','Al Quoz line 2',1200,940,'Passed · Dubai Municipality',lineage);
  db.prepare('INSERT INTO batches(code,source,tds,bottled_date,line,units,delivered,lab,lineage) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('B-2608-15','Hatta Spring','108 ppm','09 Aug 2026','Al Quoz line 1',1200,610,'Passed · Dubai Municipality',lineage);

  console.log('Seeded demo data. Customer PIN example Fatima 050 123 4567 / 4921 · Driver Karim 055 210 7788 / 7306');
}
