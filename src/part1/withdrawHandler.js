"use strict";

const { ObjectId } = require("mongodb");
const { getDb, withTransaction, AppError } = require("../db/client");

// Limits in integer paise (₹1 = 100 paise) — never use floating point for money
const MIN_WITHDRAWAL_PAISE = 10000; // ₹100.00
const MAX_WITHDRAWAL_PAISE = 5000000; // ₹50,000.00 per withdrawal
const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Core money-safety withdrawal initiation logic.
 *
 * Design guarantees:
 * 1. User identity comes strictly from authenticated session (`authenticatedUserId`), never `req.body`.
 * 2. Strict integer paise validation blocks negative-amount credit exploits, floats, NaN, and NoSQL injection.
 * 3. Client `Idempotency-Key` + unique index `{ userId, idempotencyKey }` makes mobile timeout retries safe.
 * 4. Single MongoDB ACID transaction atomically:
 *      - inserts `withdrawals` record (transactional outbox, status = PENDING)
 *      - conditionally debits `wallets.availablePaise` and moves funds into `heldPaise` (prevents double-spend)
 *      - inserts immutable `ledger` debit entry with exact post-debit `balanceAfterPaise`
 * 5. Never calls payment gateway synchronously inside the HTTP handler or scans 40M-doc `ledger`.
 */
async function initiateWithdrawal({
  authenticatedUserId,
  amountPaise,
  idempotencyKey,
  enqueuePayout = null, // optional best-effort queue nudge (Redis/SQS); DB sweeper is durable fallback
}) {
  // 1. Validate inputs strictly before touching the database
  if (!authenticatedUserId || !ObjectId.isValid(authenticatedUserId)) {
    throw new AppError(
      401,
      "UNAUTHORIZED",
      "Valid authenticated user is required",
    );
  }
  const userId = new ObjectId(authenticatedUserId);

  if (
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)
  ) {
    throw new AppError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key header is required (8-128 alphanumeric/hyphen/underscore chars)",
    );
  }

  if (
    typeof amountPaise !== "number" ||
    !Number.isSafeInteger(amountPaise) ||
    amountPaise < MIN_WITHDRAWAL_PAISE ||
    amountPaise > MAX_WITHDRAWAL_PAISE
  ) {
    throw new AppError(
      400,
      "INVALID_AMOUNT",
      `amountPaise must be an integer between ${MIN_WITHDRAWAL_PAISE} and ${MAX_WITHDRAWAL_PAISE}`,
    );
  }

  const db = getDb();
  const users = db.collection("users");
  const wallets = db.collection("wallets");
  const withdrawals = db.collection("withdrawals");
  const ledger = db.collection("ledger");

  // 2. Fast-path idempotency check (handles most mobile timeout retries without starting a txn)
  const existing = await withdrawals.findOne({ userId, idempotencyKey });
  if (existing) {
    return buildIdempotentReplayResponse(existing, amountPaise, wallets);
  }

  // 3. Verify user eligibility, KYC, and verified bank account
  const user = await users.findOne(
    { _id: userId },
    { projection: { status: 1, kycStatus: 1, bankAccount: 1 } },
  );
  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }
  if (user.status !== "ACTIVE") {
    throw new AppError(
      403,
      "USER_SUSPENDED",
      "User account is not eligible for withdrawals",
    );
  }
  if (user.kycStatus !== "VERIFIED") {
    throw new AppError(
      403,
      "KYC_REQUIRED",
      "KYC verification is required before withdrawing",
    );
  }
  if (
    !user.bankAccount ||
    !user.bankAccount.verified ||
    !user.bankAccount.beneficiaryId ||
    !user.bankAccount.accountNumber ||
    !user.bankAccount.ifsc
  ) {
    throw new AppError(
      400,
      "BANK_ACCOUNT_UNVERIFIED",
      "A verified bank account is required",
    );
  }

  // 4. Atomic money-safety commit inside a MongoDB ACID transaction
  const now = new Date();
  const withdrawalId = new ObjectId();
  const gatewayReference = `WD_${withdrawalId.toHexString()}`;

  let result;
  try {
    result = await withTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      // 4a. Claim idempotency key + create durable transactional outbox record
      await withdrawals.insertOne(
        {
          _id: withdrawalId,
          userId,
          idempotencyKey,
          amountPaise,
          gatewayReference,
          bankAccountSnapshot: {
            beneficiaryId: user.bankAccount.beneficiaryId,
            accountLast4: String(user.bankAccount.accountNumber).slice(-4),
            ifsc: user.bankAccount.ifsc,
          },
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: now,
          lockedUntil: null,
          gatewayPayoutId: null,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
        },
        sessionOpt,
      );

      // 4b. Atomic conditional debit: move availablePaise -> heldPaise
      // Never read-check-set! Filter enforces sufficient balance under document write lock.
      const updatedWallet = await wallets.findOneAndUpdate(
        {
          userId,
          status: "ACTIVE",
          availablePaise: { $gte: amountPaise },
        },
        {
          $inc: {
            availablePaise: -amountPaise,
            heldPaise: amountPaise,
          },
          $set: { updatedAt: now },
        },
        { ...sessionOpt, returnDocument: "after" },
      );

      if (!updatedWallet) {
        // In replica-set transactions, throwing aborts the withdrawal insert automatically.
        // Only clean up explicitly if running in local standalone dev fallback.
        if (!session) {
          await withdrawals.deleteOne({ _id: withdrawalId });
        }

        const currentWallet = await wallets.findOne({ userId }, sessionOpt);
        if (!currentWallet) {
          throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found");
        }
        if (currentWallet.status !== "ACTIVE") {
          throw new AppError(403, "WALLET_FROZEN", "Wallet is frozen");
        }
        throw new AppError(
          400,
          "INSUFFICIENT_BALANCE",
          "Insufficient available balance",
        );
      }

      // 4c. Append immutable ledger entry with the true post-debit balance
      await ledger.insertOne(
        {
          _id: new ObjectId(),
          userId,
          type: "WITHDRAWAL_HOLD",
          direction: "DEBIT",
          amountPaise,
          balanceAfterPaise: updatedWallet.availablePaise,
          referenceId: withdrawalId,
          idempotencyKey: `WD_HOLD_${withdrawalId.toHexString()}`,
          createdAt: now,
        },
        sessionOpt,
      );

      return {
        statusCode: 202,
        body: {
          ok: true,
          idempotentReplay: false,
          withdrawalId: withdrawalId.toHexString(),
          gatewayReference,
          status: "PENDING",
          amountPaise,
          availablePaise: updatedWallet.availablePaise,
          heldPaise: updatedWallet.heldPaise,
        },
      };
    });
  } catch (err) {
    // Handle race where two identical requests with the SAME Idempotency-Key slipped past step 2
    if (err && err.code === 11000) {
      const winner = await withdrawals.findOne({ userId, idempotencyKey });
      if (winner) {
        return buildIdempotentReplayResponse(winner, amountPaise, wallets);
      }
    }
    throw err;
  }

  // 5. Best-effort async nudge to worker queue (durable fallback: worker polls PENDING docs)
  if (typeof enqueuePayout === "function") {
    Promise.resolve(enqueuePayout(withdrawalId.toHexString())).catch(
      (queueErr) => {
        console.error(
          JSON.stringify({
            level: "warn",
            event: "payout_queue_nudge_failed",
            withdrawalId: withdrawalId.toHexString(),
            error: queueErr.message,
          }),
        );
      },
    );
  }

  return result;
}

async function buildIdempotentReplayResponse(
  existing,
  requestedAmountPaise,
  wallets,
) {
  if (existing.amountPaise !== requestedAmountPaise) {
    throw new AppError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used with a different withdrawal amount",
    );
  }

  const wallet = await wallets.findOne(
    { userId: existing.userId },
    { projection: { availablePaise: 1, heldPaise: 1 } },
  );

  const isTerminal =
    existing.status === "COMPLETED" || existing.status === "FAILED";
  return {
    statusCode: isTerminal ? 200 : 202,
    body: {
      ok: true,
      idempotentReplay: true,
      withdrawalId: existing._id.toHexString(),
      gatewayReference: existing.gatewayReference,
      status: existing.status,
      amountPaise: existing.amountPaise,
      availablePaise: wallet ? wallet.availablePaise : null,
      heldPaise: wallet ? wallet.heldPaise : null,
    },
  };
}

/**
 * Express route handler: POST /api/wallet/withdraw
 * Expects auth middleware to set `req.user = { id: '...' }`.
 */
function createWithdrawRouteHandler({ enqueuePayout = null } = {}) {
  return async function withdrawHandler(req, res, next) {
    try {
      const authenticatedUserId = req.user && req.user.id;
      const idempotencyKey = req.get("Idempotency-Key");
      const { amountPaise } = req.body || {};

      const { statusCode, body } = await initiateWithdrawal({
        authenticatedUserId,
        amountPaise,
        idempotencyKey,
        enqueuePayout,
      });

      return res.status(statusCode).json(body);
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Separate paginated ledger endpoint: GET /api/wallet/ledger?limit=20&before=<ISO>
 * Backed by compound index `{ userId: 1, createdAt: -1 }`.
 */
async function getWalletLedgerHandler(req, res, next) {
  try {
    const authenticatedUserId = req.user && req.user.id;
    if (!authenticatedUserId || !ObjectId.isValid(authenticatedUserId)) {
      throw new AppError(
        401,
        "UNAUTHORIZED",
        "Valid authenticated user is required",
      );
    }

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      100,
    );
    const query = { userId: new ObjectId(authenticatedUserId) };

    if (req.query.before) {
      const beforeDate = new Date(req.query.before);
      if (Number.isNaN(beforeDate.getTime())) {
        throw new AppError(
          400,
          "INVALID_CURSOR",
          "before must be a valid ISO timestamp",
        );
      }
      query.createdAt = { $lt: beforeDate };
    }

    const items = await getDb()
      .collection("ledger")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    const nextCursor =
      items.length === limit
        ? items[items.length - 1].createdAt.toISOString()
        : null;
    return res.json({ ok: true, items, nextCursor });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  MIN_WITHDRAWAL_PAISE,
  MAX_WITHDRAWAL_PAISE,
  initiateWithdrawal,
  createWithdrawRouteHandler,
  getWalletLedgerHandler,
};
