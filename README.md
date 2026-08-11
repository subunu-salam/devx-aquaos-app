# DevX AquaOS — Functional App

A real full-stack app: **Node + Express + SQLite** backend with a REST API, serving three connected front ends.

- `/` — launcher
- `/crm.html` — Operations CRM (create customer → **unique 4-digit PIN** + WhatsApp welcome link; live dashboard, drivers, deliveries, exceptions)
- `/driver.html` — Driver app (mobile+PIN login → today's real stops → complete delivery updates the database)
- `/customer.html` — Customer portal (mobile+PIN login → live balance, next delivery, change quantity, skip, history)

## What's real
- SQLite database with customers, drivers, deliveries, ledger, requests.
- Unique random 4-digit PIN generated per customer (never duplicated).
- Welcome message + click-to-send **WhatsApp** link generated on creation.
- Passwordless login (mobile + PIN) for customers and drivers.
- Completing a delivery decrements the customer's bottle balance and writes the ledger — visible live in the CRM and customer portal.

## What still needs your accounts (later)
- **Auto-sending** WhatsApp (official WhatsApp Business API — approval + cost). For now the CRM opens WhatsApp pre-filled so staff tap send.
- **Online payments** (a UAE gateway) for the renew button.

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```
Demo logins — Customer: `050 123 4567` PIN `4921` · Driver: `055 210 7788` PIN `7306`.

## Deploy to Render
1. Push this folder to a Git repo.
2. Render → **New → Blueprint** → pick the repo → **Apply** (it reads `render.yaml`, runs `npm install`, starts `node server.js`).
3. Live at `https://devx-aquaos.onrender.com`.

> Note: on Render's **free** plan the database file resets on each redeploy (fine for a pilot). For permanent data, upgrade the instance and enable the disk block in `render.yaml`, or switch to Render Postgres.

_DevX Technologies · AquaOS._
