'use strict';

const { connectDb, closeDb } = require('./client');

/**
 * Creates all indexes required for Part 1 (Wallet & Payouts) and Part 2 (Reward Points).
 * Safe to run repeatedly (idempotent).
 */
async function ensureIndexes(db) {
  // ---------------- PART 1: Wallets, Withdrawals, Cash Ledger ----------------

  // 1. wallets: O(1) lookup and atomic conditional debit by userId (fixes 2M-doc COLLSCAN)
  await db.collection('wallets').createIndex(
    { userId: 1 },
    { unique: true, name: 'uniq_wallets_userId' }
  );

  // 2. withdrawals: Enforces idempotency per user so mobile timeout retries cannot double-debit
  await db.collection('withdrawals').createIndex(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, name: 'uniq_withdrawals_user_idempotency' }
  );

  // 3. withdrawals: Unique deterministic gateway reference for webhook / reconciliation lookups
  await db.collection('withdrawals').createIndex(
    { gatewayReference: 1 },
    { unique: true, name: 'uniq_withdrawals_gateway_ref' }
  );

  // 4. withdrawals: Partial index for outbox worker & reconciliation sweeper (tiny index: only active payouts!)
  await db.collection('withdrawals').createIndex(
    { status: 1, nextAttemptAt: 1 },
    {
      name: 'idx_withdrawals_active_queue',
      partialFilterExpression: {
        status: { $in: ['PENDING', 'DISPATCHING', 'UNKNOWN_PENDING_RECON'] },
      },
    }
  );

  // 5. withdrawals: User's withdrawal history screen
  await db.collection('withdrawals').createIndex(
    { userId: 1, createdAt: -1 },
    { name: 'idx_withdrawals_user_createdAt' }
  );

  // 6. ledger: Paginated user transaction history (fixes 40M-doc COLLSCAN + in-memory sort!)
  await db.collection('ledger').createIndex(
    { userId: 1, createdAt: -1 },
    { name: 'idx_ledger_user_createdAt' }
  );

  // 7. ledger: Prevents duplicate ledger rows for the same withdrawal / conversion event
  await db.collection('ledger').createIndex(
    { idempotencyKey: 1 },
    { unique: true, name: 'uniq_ledger_idempotency' }
  );

  // ---------------- PART 2: Reward Points & Monthly Finance Report ----------------

  // 8. point_wallets: O(1) lookup and atomic conditional points debit
  await db.collection('point_wallets').createIndex(
    { userId: 1 },
    { unique: true, name: 'uniq_point_wallets_userId' }
  );

  // 9. point_grants: FIFO lot consumption on conversion (only unexpired/non-empty grants indexed)
  await db.collection('point_grants').createIndex(
    { userId: 1, expiresAt: 1 },
    {
      name: 'idx_point_grants_user_fifo',
      partialFilterExpression: { remainingPoints: { $gt: 0 } },
    }
  );

  // 10. point_grants: Scheduled expiry job scanning only non-empty grants whose expiresAt <= now
  await db.collection('point_grants').createIndex(
    { expiresAt: 1 },
    {
      name: 'idx_point_grants_expiry_scan',
      partialFilterExpression: { remainingPoints: { $gt: 0 } },
    }
  );

  // 11. point_ledger: User's paginated points activity feed
  await db.collection('point_ledger').createIndex(
    { userId: 1, createdAt: -1 },
    { name: 'idx_point_ledger_user_createdAt' }
  );

  // 12. point_ledger: Serves monthly finance report (covered index for date-range aggregation!)
  await db.collection('point_ledger').createIndex(
    { createdAt: 1, userCohort: 1, userId: 1, type: 1, points: 1 },
    { name: 'idx_point_ledger_monthly_finance_covered' }
  );

  // 13. point_ledger: Idempotency guard so duplicate project/promo grants or expiry runs cannot double-post
  await db.collection('point_ledger').createIndex(
    { idempotencyKey: 1 },
    { unique: true, name: 'uniq_point_ledger_idempotency' }
  );

  // 14. conversion_rates: Fetch active conversion rate for a given timestamp
  await db.collection('conversion_rates').createIndex(
    { effectiveFrom: -1, effectiveTo: 1 },
    { name: 'idx_conversion_rates_effective_window' }
  );

  // 15. point_conversions: Idempotency gate for concurrent/retried point conversions
  await db.collection('point_conversions').createIndex(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, name: 'uniq_point_conversions_user_idempotency' }
  );

  // 16. point_conversions: User conversion audit history
  await db.collection('point_conversions').createIndex(
    { userId: 1, createdAt: -1 },
    { name: 'idx_point_conversions_user_createdAt' }
  );
}

if (require.main === module) {
  (async () => {
    try {
      const { db } = await connectDb();
      await ensureIndexes(db);
      console.log('All Funngro indexes created successfully in database:', db.databaseName);
    } catch (err) {
      console.error('Failed to create indexes:', err);
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
  })();
}

module.exports = { ensureIndexes };
