'use strict';

const { ObjectId } = require('mongodb');
const { getDb, withTransaction } = require('../db/client');

const LEASE_MS = 30_000;
const GATEWAY_TIMEOUT_MS = 8_000;
const RECON_BACKOFF_MS = 30_000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Gateway call timed out after ${ms}ms`);
      err.isTerminal = false;
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Claims one PENDING withdrawal atomically using a time-bounded lease,
 * dispatches it to the payment gateway with the deterministic `gatewayReference`,
 * and handles success / definite failure / ambiguous timeout safely.
 */
async function processNextWithdrawal(gateway) {
  const db = getDb();
  const withdrawals = db.collection('withdrawals');
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);

  // Atomic claim backed by partial index `{ status: 1, nextAttemptAt: 1 }`
  const job = await withdrawals.findOneAndUpdate(
    {
      status: 'PENDING',
      nextAttemptAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    {
      $set: {
        status: 'DISPATCHING',
        lockedUntil: leaseUntil,
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { nextAttemptAt: 1 },
      returnDocument: 'after',
    }
  );

  if (!job) return null;

  try {
    const pgRes = await withTimeout(
      gateway.createPayout({
        reference: job.gatewayReference, // Deterministic idempotency key at gateway
        beneficiaryId: job.bankAccountSnapshot.beneficiaryId,
        amountPaise: job.amountPaise,
      }),
      GATEWAY_TIMEOUT_MS
    );

    // Gateway accepted the payout; wait for webhook or reconciliation poller for final settlement
    await withdrawals.updateOne(
      { _id: job._id, status: 'DISPATCHING' },
      {
        $set: {
          status: 'PROCESSING',
          gatewayPayoutId: pgRes.gatewayPayoutId,
          lockedUntil: null,
          updatedAt: new Date(),
        },
      }
    );

    return { withdrawalId: job._id.toHexString(), status: 'PROCESSING', gatewayPayoutId: pgRes.gatewayPayoutId };
  } catch (err) {
    if (err && err.isTerminal) {
      // Guaranteed NOT executed by gateway -> safe to reverse hold & refund wallet
      await finalizeWithdrawalFailed(job._id, err.code || err.message);
      return { withdrawalId: job._id.toHexString(), status: 'FAILED', reason: err.code || err.message };
    }

    // Ambiguous failure (network timeout / 5xx):
    // CRITICAL: NEVER blindly refund! Gateway may have accepted the payout.
    // Move to UNKNOWN_PENDING_RECON so reconciliation checks gateway status first.
    await withdrawals.updateOne(
      { _id: job._id, status: 'DISPATCHING' },
      {
        $set: {
          status: 'UNKNOWN_PENDING_RECON',
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + RECON_BACKOFF_MS),
          lastError: err ? err.message : 'Unknown gateway error',
          updatedAt: new Date(),
        },
      }
    );

    return { withdrawalId: job._id.toHexString(), status: 'UNKNOWN_PENDING_RECON' };
  }
}

/**
 * Reconciles withdrawals stuck in UNKNOWN_PENDING_RECON (or expired DISPATCHING leases)
 * by querying the gateway by deterministic `gatewayReference`.
 */
async function reconcileWithdrawal(withdrawalId, gateway) {
  const db = getDb();
  const withdrawals = db.collection('withdrawals');
  const id = typeof withdrawalId === 'string' ? new ObjectId(withdrawalId) : withdrawalId;

  const job = await withdrawals.findOne({ _id: id });
  if (!job || job.status === 'COMPLETED' || job.status === 'FAILED') {
    return { status: job ? job.status : 'NOT_FOUND', action: 'NOOP' };
  }

  const pgStatus = await withTimeout(
    gateway.getPayoutByReference(job.gatewayReference),
    GATEWAY_TIMEOUT_MS
  );

  if (!pgStatus) {
    // Confirmed never reached gateway -> safe to fail & refund (or re-queue if transient)
    await finalizeWithdrawalFailed(id, 'CONFIRMED_NOT_FOUND_AT_GATEWAY');
    return { status: 'FAILED', action: 'REFUNDED_NOT_FOUND' };
  }

  if (pgStatus.status === 'COMPLETED') {
    await finalizeWithdrawalCompleted(id, pgStatus.gatewayPayoutId);
    return { status: 'COMPLETED', action: 'SETTLED' };
  }

  if (pgStatus.status === 'FAILED') {
    await finalizeWithdrawalFailed(id, 'GATEWAY_FAILED');
    return { status: 'FAILED', action: 'REFUNDED_GATEWAY_FAILED' };
  }

  // Still PROCESSING at bank
  await withdrawals.updateOne(
    { _id: id, status: { $in: ['DISPATCHING', 'UNKNOWN_PENDING_RECON'] } },
    {
      $set: {
        status: 'PROCESSING',
        gatewayPayoutId: pgStatus.gatewayPayoutId,
        nextAttemptAt: new Date(Date.now() + RECON_BACKOFF_MS),
        updatedAt: new Date(),
      },
    }
  );
  return { status: 'PROCESSING', action: 'STILL_PROCESSING' };
}

/**
 * Idempotent finalizer called by payment gateway webhook (or reconciliation job)
 * when bank transfer succeeds. Releases `heldPaise`.
 */
async function finalizeWithdrawalCompleted(withdrawalId, gatewayPayoutId = null) {
  const db = getDb();
  const withdrawals = db.collection('withdrawals');
  const wallets = db.collection('wallets');
  const id = typeof withdrawalId === 'string' ? new ObjectId(withdrawalId) : withdrawalId;
  const now = new Date();

  return withTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};

    // Guarded state transition: duplicate COMPLETED webhooks become safe no-ops!
    const updated = await withdrawals.findOneAndUpdate(
      {
        _id: id,
        status: { $in: ['DISPATCHING', 'PROCESSING', 'UNKNOWN_PENDING_RECON'] },
      },
      {
        $set: {
          status: 'COMPLETED',
          ...(gatewayPayoutId ? { gatewayPayoutId } : {}),
          completedAt: now,
          lockedUntil: null,
          updatedAt: now,
        },
      },
      { ...sessionOpt, returnDocument: 'after' }
    );

    if (!updated) {
      return { applied: false, reason: 'ALREADY_FINALIZED_OR_INVALID_STATE' };
    }

    await wallets.updateOne(
      { userId: updated.userId, heldPaise: { $gte: updated.amountPaise } },
      {
        $inc: { heldPaise: -updated.amountPaise },
        $set: { updatedAt: now },
      },
      sessionOpt
    );

    return { applied: true, status: 'COMPLETED' };
  });
}

/**
 * Idempotent finalizer called ONLY after confirmed gateway failure or confirmed non-existence.
 * Moves `heldPaise` back to `availablePaise` and appends a `WITHDRAWAL_REVERSAL` credit ledger entry.
 * Duplicate failure webhooks can NEVER double-refund because of the guarded state transition!
 */
async function finalizeWithdrawalFailed(withdrawalId, failureReason) {
  const db = getDb();
  const withdrawals = db.collection('withdrawals');
  const wallets = db.collection('wallets');
  const ledger = db.collection('ledger');
  const id = typeof withdrawalId === 'string' ? new ObjectId(withdrawalId) : withdrawalId;
  const now = new Date();

  return withTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};

    // Guarded transition guarantees refund happens AT MOST ONCE
    const updated = await withdrawals.findOneAndUpdate(
      {
        _id: id,
        status: { $in: ['DISPATCHING', 'PROCESSING', 'UNKNOWN_PENDING_RECON'] },
      },
      {
        $set: {
          status: 'FAILED',
          failureReason,
          failedAt: now,
          lockedUntil: null,
          updatedAt: now,
        },
      },
      { ...sessionOpt, returnDocument: 'after' }
    );

    if (!updated) {
      return { applied: false, reason: 'ALREADY_FINALIZED_OR_INVALID_STATE' };
    }

    const updatedWallet = await wallets.findOneAndUpdate(
      { userId: updated.userId, heldPaise: { $gte: updated.amountPaise } },
      {
        $inc: {
          heldPaise: -updated.amountPaise,
          availablePaise: updated.amountPaise,
        },
        $set: { updatedAt: now },
      },
      { ...sessionOpt, returnDocument: 'after' }
    );

    await ledger.insertOne(
      {
        _id: new ObjectId(),
        userId: updated.userId,
        type: 'WITHDRAWAL_REVERSAL',
        direction: 'CREDIT',
        amountPaise: updated.amountPaise,
        balanceAfterPaise: updatedWallet ? updatedWallet.availablePaise : null,
        referenceId: updated._id,
        idempotencyKey: `WD_REV_${updated._id.toHexString()}`,
        reason: failureReason,
        createdAt: now,
      },
      sessionOpt
    );

    return { applied: true, status: 'FAILED', refundedPaise: updated.amountPaise };
  });
}

module.exports = {
  processNextWithdrawal,
  reconcileWithdrawal,
  finalizeWithdrawalCompleted,
  finalizeWithdrawalFailed,
};
