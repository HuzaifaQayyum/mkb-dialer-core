# mkb-dialer-core

Fastify + TypeScript telephony core service. Handles outbound call initiation, active call tracking, call logs, and dialer statistics. Fetches SIP settings from `mkb-dialer-backend` at runtime.

---

## Prerequisites

- **Bun 1.0+** (recommended) or **Node.js 18+**
- `mkb-dialer-backend` running at `http://localhost:8000` (for SIP config sync)

---

## 1. Install Dependencies

```bash
# Using bun (recommended)
bun install

# Or using npm
npm install
```

---

## 2. Configure Environment

Create a `.env` file in the project root:

```env
PORT=5000
HOST=0.0.0.0
```

---

## 3. Run in Development

```bash
# Using bun (live reload)
bun run dev:bun

# Using Node.js (tsx watch)
npm run dev
```

Server starts at `http://localhost:5000`.

---

## 4. Run in Production

```bash
# Compile TypeScript
npm run build

# Start compiled server
npm start
```

Or with PM2:

```bash
pm2 start dist/index.js --name mkb-dialer-core
pm2 save
pm2 startup
```
