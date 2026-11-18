"use strict";

const { ObjectId } = require("mongodb");
const { getDb, withTransaction, AppError } = require("../db/client");

const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Credits reward points from a completed project or promotional event.
 * Writes an immutable `point_ledger` row, creates a FIFO `point_grants` lot (for expiry),
 * and atomically increments `point_wallets`.
 */
async function earnPoints({
  userId: rawUserId,
  userCohort,
  points,
  source, // 'PROJECT_COMPLETION' | 'PROMO_EVENT'
  sourceRefId,
  expiresAt = null,
  idempotencyKey,
  createdAt = new Date(),
}) {
  if (!ObjectId.isValid(rawUserId)) {
    throw new AppError(400, "INVALID_USER_ID", "Valid userId is required");
  }
  if (!Number.isSafeInteger(points) || points <= 0) {
    throw new AppError(
      400,
      "INVALID_POINTS",
      "points must be a positive integer",
    );
  }
  if (!["PROJECT_COMPLETION", "PROMO_EVENT"].includes(source)) {
    throw new AppError(
      400,
      "INVALID_SOURCE",
      "source must be PROJECT_COMPLETION or PROMO_EVENT",
    );
  }
  if (
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)
  ) {
    throw new AppError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Valid idempotencyKey is required",
    );
  }

  const userId = new ObjectId(rawUserId);
  const db = getDb();
  const pointWallets = db.collection("point_wallets");
  const pointGrants = db.collection("point_grants");
  const pointLedger = db.collection("point_ledger");

  try {
    return await withTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const ledgerId = new ObjectId();

      // Upsert point wallet and increment balance atomically
      const updatedWallet = await pointWallets.findOneAndUpdate(
        { userId },
        {
          $inc: {
            availablePoints: points,
            lifetimeEarned: points,
            version: 1,
          },
          $set: { updatedAt: createdAt },
          $setOnInsert: {
            lifetimeConverted: 0,
            lifetimeExpired: 0,
            createdAt,
          },
        },
        { ...sessionOpt, upsert: true, returnDocument: "after" },
      );

      // Immutable append-only ledger entry
      await pointLedger.insertOne(
        {
          _id: ledgerId,
          userId,
          userCohort,
          type: "EARN",
          source,
          sourceRefId: String(sourceRefId),
          points, // positive int
          balanceAfter: updatedWallet.availablePoints,
          idempotencyKey,
          createdAt,
        },
        sessionOpt,
      );

      // FIFO lot for accurate expiry tracking without mutating point_ledger
      const grantId = new ObjectId();
      await pointGrants.insertOne(
        {
          _id: grantId,
          userId,
          userCohort,
          ledgerId,
          source,
          sourceRefId: String(sourceRefId),
          originalPoints: points,
          remainingPoints: points,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          createdAt,
          updatedAt: createdAt,
        },
        sessionOpt,
      );

      return {
        ok: true,
        ledgerId: ledgerId.toHexString(),
        grantId: grantId.toHexString(),
        availablePoints: updatedWallet.availablePoints,
      };
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await pointLedger.findOne({ idempotencyKey });
      if (existing) {
        return {
          ok: true,
          idempotentReplay: true,
          ledgerId: existing._id.toHexString(),
          availablePoints: existing.balanceAfter,
        };
      }
    }
    throw err;
  }
}

/**
 * Atomically converts reward points into wallet cash at the currently active rate.
 * Prevents double-conversion under concurrent requests via:
 *  1) Unique idempotency index `{ userId, idempotencyKey }` on `point_conversions`
 *  2) Atomic conditional debit `point_wallets.findOneAndUpdate({ userId, availablePoints: { $gte: points } })`
 *     inside a MongoDB snapshot-isolated ACID transaction.
 */
async function convertPointsToCash({
  authenticatedUserId,
  pointsToConvert,
  idempotencyKey,
  now = new Date(),
}) {
  if (!authenticatedUserId || !ObjectId.isValid(authenticatedUserId)) {
    throw new AppError(
      401,
      "UNAUTHORIZED",
      "Valid authenticated user is required",
    );
  }
  if (!Number.isSafeInteger(pointsToConvert) || pointsToConvert <= 0) {
    throw new AppError(
      400,
      "INVALID_POINTS",
      "pointsToConvert must be a positive integer",
    );
  }
  if (
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)
  ) {
    throw new AppError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Valid Idempotency-Key is required",
    );
  }

  const userId = new ObjectId(authenticatedUserId);
  const db = getDb();
  const users = db.collection("users");
  const pointWallets = db.collection("point_wallets");
  const pointGrants = db.collection("point_grants");
  const pointLedger = db.collection("point_ledger");
  const pointConversions = db.collection("point_conversions");
  const conversionRates = db.collection("conversion_rates");
  const wallets = db.collection("wallets");
  const cashLedger = db.collection("ledger");

  // Fast-path idempotency replay check
  const existing = await pointConversions.findOne({ userId, idempotencyKey });
  if (existing) {
    return buildConversionReplay(existing, pointsToConvert);
  }

  const user = await users.findOne(
    { _id: userId },
    { projection: { status: 1, cohortMonth: 1 } },
  );
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  if (user.status !== "ACTIVE")
    throw new AppError(403, "USER_SUSPENDED", "User account is not active");

  try {
    return await withTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      // 1. Fetch active rate effective at `now`
      const rate = await conversionRates.findOne(
        {
          effectiveFrom: { $lte: now },
          $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
        },
        { ...sessionOpt, sort: { effectiveFrom: -1 } },
      );
      if (!rate) {
        throw new AppError(
          503,
          "NO_ACTIVE_RATE",
          "No active points conversion rate configured",
        );
      }
      if (pointsToConvert < (rate.minConvertPoints || 1)) {
        throw new AppError(
          400,
          "BELOW_MIN_POINTS",
          `Minimum points required for conversion is ${rate.minConvertPoints}`,
        );
      }

      // Exact integer arithmetic: floor to whole paise (never floats!)
      const cashPaise = Math.floor(
        (pointsToConvert * rate.paiseNumerator) / rate.pointsDenominator,
      );
      if (cashPaise <= 0) {
        throw new AppError(
          400,
          "ZERO_CASH_VALUE",
          "Points amount converts to 0 paise at current rate",
        );
      }

      const conversionId = new ObjectId();
      const pointLedgerId = new ObjectId();
      const walletLedgerId = new ObjectId();

      // 2. Claim idempotency key in `point_conversions`
      await pointConversions.insertOne(
        {
          _id: conversionId,
          userId,
          userCohort: user.cohortMonth,
          idempotencyKey,
          pointsConverted: pointsToConvert,
          rateId: rate._id,
          rateSnapshot: {
            paiseNumerator: rate.paiseNumerator,
            pointsDenominator: rate.pointsDenominator,
            effectiveFrom: rate.effectiveFrom,
          },
          cashPaiseCredited: cashPaise,
          pointLedgerId,
          walletLedgerId,
          status: "COMPLETED",
          createdAt: now,
        },
        sessionOpt,
      );

      // 3. Atomic conditional debit on `point_wallets` (blocks concurrent double-convert!)
      const updatedPointWallet = await pointWallets.findOneAndUpdate(
        {
          userId,
          availablePoints: { $gte: pointsToConvert },
        },
        {
          $inc: {
            availablePoints: -pointsToConvert,
            lifetimeConverted: pointsToConvert,
            version: 1,
          },
          $set: { updatedAt: now },
        },
        { ...sessionOpt, returnDocument: "after" },
      );

      if (!updatedPointWallet) {
        if (!session) {
          await pointConversions.deleteOne({ _id: conversionId });
        }
        throw new AppError(
          400,
          "INSUFFICIENT_POINTS",
          "Insufficient available reward points",
        );
      }

      // 4. Consume unexpired FIFO point grants (soonest-expiring first)
      let remainingToConsume = pointsToConvert;
      const grants = await pointGrants
        .find(
          {
            userId,
            remainingPoints: { $gt: 0 },
            $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
          },
          { ...sessionOpt, sort: { expiresAt: 1, createdAt: 1 } },
        )
        .toArray();

      for (const grant of grants) {
        if (remainingToConsume <= 0) break;
        const deduct = Math.min(grant.remainingPoints, remainingToConsume);
        await pointGrants.updateOne(
          { _id: grant._id, remainingPoints: { $gte: deduct } },
          { $inc: { remainingPoints: -deduct }, $set: { updatedAt: now } },
          sessionOpt,
        );
        remainingToConsume -= deduct;
      }

      // 5. Append immutable `point_ledger` CONVERT entry
      await pointLedger.insertOne(
        {
          _id: pointLedgerId,
          userId,
          userCohort: user.cohortMonth,
          type: "CONVERT",
          source: "WALLET_CONVERSION",
          sourceRefId: conversionId.toHexString(),
          points: -pointsToConvert, // negative int for debit
          balanceAfter: updatedPointWallet.availablePoints,
          idempotencyKey: `PT_CONV_${conversionId.toHexString()}`,
          createdAt: now,
        },
        sessionOpt,
      );

      // 6. Atomically credit cash `wallets`
      const updatedCashWallet = await wallets.findOneAndUpdate(
        { userId, status: "ACTIVE" },
        {
          $inc: { availablePaise: cashPaise },
          $set: { updatedAt: now },
        },
        { ...sessionOpt, returnDocument: "after" },
      );

      if (!updatedCashWallet) {
        throw new AppError(
          404,
          "WALLET_NOT_FOUND_OR_FROZEN",
          "Active cash wallet not found",
        );
      }

      // 7. Append immutable cash `ledger` credit linked to conversionId
      await cashLedger.insertOne(
        {
          _id: walletLedgerId,
          userId,
          type: "POINTS_CONVERSION_CREDIT",
          direction: "CREDIT",
          amountPaise: cashPaise,
          balanceAfterPaise: updatedCashWallet.availablePaise,
          referenceId: conversionId,
          idempotencyKey: `CASH_CONV_${conversionId.toHexString()}`,
          createdAt: now,
        },
        sessionOpt,
      );

      return {
        ok: true,
        idempotentReplay: false,
        conversionId: conversionId.toHexString(),
        pointsConverted: pointsToConvert,
        cashPaiseCredited: cashPaise,
        rateId: rate._id.toHexString(),
        availablePoints: updatedPointWallet.availablePoints,
        walletAvailablePaise: updatedCashWallet.availablePaise,
      };
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const winner = await pointConversions.findOne({ userId, idempotencyKey });
      if (winner) {
        return buildConversionReplay(winner, pointsToConvert);
      }
    }
    throw err;
  }
}

function buildConversionReplay(existing, requestedPoints) {
  if (existing.pointsConverted !== requestedPoints) {
    throw new AppError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used with a different points amount",
    );
  }
  return {
    ok: true,
    idempotentReplay: true,
    conversionId: existing._id.toHexString(),
    pointsConverted: existing.pointsConverted,
    cashPaiseCredited: existing.cashPaiseCredited,
    rateId: existing.rateId.toHexString(),
  };
}

/**
 * Scheduled job to expire overdue point grants cleanly.
 * Uses partial index `{ expiresAt: 1 }` where `remainingPoints > 0`.
 * Guarded per-grant inside a transaction so overlapping cron runs cannot double-expire.
 */
async function expireOverdueGrants(now = new Date(), batchSize = 500) {
  const db = getDb();
  const pointGrants = db.collection("point_grants");
  const pointWallets = db.collection("point_wallets");
  const pointLedger = db.collection("point_ledger");

  const overdueGrants = await pointGrants
    .find({ remainingPoints: { $gt: 0 }, expiresAt: { $lte: now } })
    .limit(batchSize)
    .toArray();

  let expiredGrantsCount = 0;
  let totalPointsExpired = 0;

  for (const grant of overdueGrants) {
    await withTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      // Atomically zero out remainingPoints ONLY if still > 0
      const claimed = await pointGrants.findOneAndUpdate(
        {
          _id: grant._id,
          remainingPoints: { $gt: 0 },
          expiresAt: { $lte: now },
        },
        { $set: { remainingPoints: 0, expiredAt: now, updatedAt: now } },
        { ...sessionOpt, returnDocument: "before" },
      );
      if (!claimed || claimed.remainingPoints <= 0) return;

      const expiredPts = claimed.remainingPoints;

      const updatedWallet = await pointWallets.findOneAndUpdate(
        { userId: claimed.userId, availablePoints: { $gte: expiredPts } },
        {
          $inc: {
            availablePoints: -expiredPts,
            lifetimeExpired: expiredPts,
            version: 1,
          },
          $set: { updatedAt: now },
        },
        { ...sessionOpt, returnDocument: "after" },
      );

      await pointLedger.insertOne(
        {
          _id: new ObjectId(),
          userId: claimed.userId,
          userCohort: claimed.userCohort,
          type: "EXPIRE",
          source: "EXPIRY_JOB",
          sourceRefId: claimed._id.toHexString(),
          points: -expiredPts,
          balanceAfter: updatedWallet ? updatedWallet.availablePoints : 0,
          idempotencyKey: `PT_EXP_${claimed._id.toHexString()}`,
          createdAt: now,
        },
        sessionOpt,
      );

      expiredGrantsCount += 1;
      totalPointsExpired += expiredPts;
    });
  }

  return { expiredGrantsCount, totalPointsExpired };
}

module.exports = {
  earnPoints,
  convertPointsToCash,
  expireOverdueGrants,
};
