# Funngro Backend Engineering Assessment — Pankaj Mahajan

All written answers (Assumptions & Questions, Part 1, Part 2, Part 3, and Part 4 Walkthrough Speaking Notes) are in **[`pankaj.md`](./pankaj.md)**.

## Project Structure

```text
├── pankaj.md                         # Complete assessment answers + Part 4 speaking notes
├── src/
│   ├── db/
│   │   ├── client.js                 # MongoDB client (mongodb://localhost:27017/, db: funngro) + ACID txn helper
│   │   └── indexes.js                # Creates all Part 1 & Part 2 MongoDB indexes
│   ├── part1/
│   │   ├── withdrawHandler.js        # Rewritten POST /api/wallet/withdraw + paginated GET /api/wallet/ledger
│   │   ├── payoutWorker.js           # Async outbox worker + reconciliation + idempotent webhook finalizers
│   │   └── mockGateway.js            # Mock payment gateway (success, terminal failure, timeout-after-accept)
│   ├── part2/
│   │   ├── rewardPointsService.js    # Earn points, atomic concurrent-safe conversion, overdue expiry job
│   │   └── monthlyFinanceReport.js   # Monthly finance aggregation pipeline (per-user & cohort summary)
│   ├── server.js                     # Express API exposing Part 1 & Part 2 endpoints
│   └── scripts/
│       └── verify.js                 # End-to-end verification suite against local MongoDB
```

## Quick Start

Default connection: `MONGODB_URI=mongodb://localhost:27017/` and `DB_NAME=funngro` (see `.env.example`).

```bash
# 1. Install dependencies
npm install

# 2. Create all Part 1 & Part 2 MongoDB indexes
npm run setup-indexes

# 3. Run end-to-end verification tests (concurrency double-spend, idempotent retries,
#    gateway timeout reconciliation, duplicate webhook guard, reward points conversion & finance report)
npm run verify

# 4. (Optional) Start the Express API server
npm start
```

> **Note on MongoDB Transactions:** Production (MongoDB Atlas) runs on a replica set and uses full multi-document ACID transactions (`readConcern: 'snapshot'`, `writeConcern: 'majority'`). If your local Windows `mongod` is running as a standalone instance without `rs.initiate()`, `npm run verify` enables `ALLOW_STANDALONE_DEV_FALLBACK=true` automatically so you can test locally while still exercising all single-document atomic guards.
