"use strict";

const assert = require("assert");
const { ObjectId } = require("mongodb");
const { connectDb, closeDb, isReplicaSet } = require("../db/client");
const { ensureIndexes } = require("../db/indexes");
const { initiateWithdrawal } = require("../part1/withdrawHandler");
const {
  processNextWithdrawal,
  reconcileWithdrawal,
  finalizeWithdrawalCompleted,
  finalizeWithdrawalFailed,
} = require("../part1/payoutWorker");
const { MockPaymentGateway } = require("../part1/mockGateway");
const {
  earnPoints,
  convertPointsToCash,
  expireOverdueGrants,
} = require("../part2/rewardPointsService");
const {
  getMonthlyFinanceReport,
  getMonthlyCohortSummary,
} = require("../part2/monthlyFinanceReport");

// Allow local standalone mongod during `npm run verify` if user hasn't enabled a local replica set
if (!process.env.ALLOW_STANDALONE_DEV_FALLBACK) {
  process.env.ALLOW_STANDALONE_DEV_FALLBACK = "true";
}

async function resetTestCollections(db) {
  const names = [
    "users",
    "wallets",
    "withdrawals",
    "ledger",
    "point_wallets",
    "point_grants",
    "point_ledger",
    "conversion_rates",
    "point_conversions",
  ];
  for (const name of names) {
    await db.collection(name).deleteMany({});
  }
}

async function seedUser(
  db,
  { name, cohortMonth, availablePaise, verifiedBank = true },
) {
  const userId = new ObjectId();
  const now = new Date();
  await db.collection("users").insertOne({
    _id: userId,
    name,
    status: "ACTIVE",
    kycStatus: "VERIFIED",
    cohortMonth,
    bankAccount: verifiedBank
      ? {
          beneficiaryId: `ben_${userId.toHexString().slice(-6)}`,
          accountNumber: "123456789012",
          ifsc: "HDFC0001234",
          verified: true,
        }
      : null,
    createdAt: now,
  });

  await db.collection("wallets").insertOne({
    _id: new ObjectId(),
    userId,
    status: "ACTIVE",
    availablePaise,
    heldPaise: 0,
    updatedAt: now,
  });

  return userId;
}

async function runVerification() {
  const { db } = await connectDb();
  console.log(
    `Connected to MongoDB (${db.databaseName}) | topology: ${isReplicaSet() ? "Replica Set (Full ACID)" : "Standalone (Dev Fallback)"}`,
  );

  await resetTestCollections(db);
  await ensureIndexes(db);
  console.log("[PASS] Indexes ensured across all Part 1 & Part 2 collections");

  // -------------------------------------------------------------------------
  // TEST 1: Input validation blocks negative / float / zero amount exploits
  // -------------------------------------------------------------------------
  const user1 = await seedUser(db, {
    name: "Aarav",
    cohortMonth: "2026-09",
    availablePaise: 100000,
  }); // ₹1000

  for (const badAmount of [-50000, 0, 100.5, NaN, "50000", null]) {
    let failed = false;
    try {
      await initiateWithdrawal({
        authenticatedUserId: user1.toHexString(),
        amountPaise: badAmount,
        idempotencyKey: "idem_bad_amt_0001",
      });
    } catch (err) {
      failed = err.code === "INVALID_AMOUNT";
    }
    assert.strictEqual(
      failed,
      true,
      `Expected INVALID_AMOUNT for ${badAmount}`,
    );
  }
  const wAfterBad = await db.collection("wallets").findOne({ userId: user1 });
  assert.strictEqual(wAfterBad.availablePaise, 100000);
  console.log(
    "[PASS] Test 1: Negative, zero, float, and non-numeric withdrawal amounts rejected",
  );

  // -------------------------------------------------------------------------
  // TEST 2: Concurrent double-spend attack (10 parallel ₹1000 withdrawals)
  // -------------------------------------------------------------------------
  const raceAttempts = Array.from({ length: 10 }, (_, idx) =>
    initiateWithdrawal({
      authenticatedUserId: user1.toHexString(),
      amountPaise: 100000, // entire ₹1000 balance
      idempotencyKey: `idem_race_distinct_${String(idx).padStart(2, "0")}`,
    }).then(
      (res) => ({ ok: true, res }),
      (err) => ({ ok: false, code: err.code }),
    ),
  );
  const raceResults = await Promise.all(raceAttempts);
  const raceSuccesses = raceResults.filter((r) => r.ok);
  const raceFailures = raceResults.filter((r) => !r.ok);

  assert.strictEqual(
    raceSuccesses.length,
    1,
    "Exactly ONE concurrent withdrawal must succeed",
  );
  assert.strictEqual(
    raceFailures.length,
    9,
    "Other 9 concurrent withdrawals must fail",
  );

  const wAfterRace = await db.collection("wallets").findOne({ userId: user1 });
  assert.strictEqual(
    wAfterRace.availablePaise,
    0,
    "Available balance must be 0, never negative",
  );
  assert.strictEqual(
    wAfterRace.heldPaise,
    100000,
    "Held balance must be ₹1000",
  );
  console.log(
    "[PASS] Test 2: 10 concurrent withdrawal requests -> exactly 1 succeeded, 0 double-spend",
  );

  // -------------------------------------------------------------------------
  // TEST 3: Mobile app timeout retry with SAME Idempotency-Key (idempotent!)
  // -------------------------------------------------------------------------
  const user2 = await seedUser(db, {
    name: "Diya",
    cohortMonth: "2026-09",
    availablePaise: 200000,
  }); // ₹2000
  const retryCalls = Array.from({ length: 5 }, () =>
    initiateWithdrawal({
      authenticatedUserId: user2.toHexString(),
      amountPaise: 50000, // ₹500
      idempotencyKey: "mobile_retry_key_9999",
    }),
  );
  const retryResponses = await Promise.all(retryCalls);
  const uniqueWithdrawalIds = new Set(
    retryResponses.map((r) => r.body.withdrawalId),
  );
  assert.strictEqual(
    uniqueWithdrawalIds.size,
    1,
    "All retries must resolve to the SAME withdrawalId",
  );

  const wAfterRetry = await db.collection("wallets").findOne({ userId: user2 });
  assert.strictEqual(
    wAfterRetry.availablePaise,
    150000,
    "Wallet must be debited ONCE (₹1500 left)",
  );
  assert.strictEqual(wAfterRetry.heldPaise, 50000);

  // Reusing same key with a DIFFERENT amount must return 409 Conflict
  let conflictThrown = false;
  try {
    await initiateWithdrawal({
      authenticatedUserId: user2.toHexString(),
      amountPaise: 60000,
      idempotencyKey: "mobile_retry_key_9999",
    });
  } catch (err) {
    conflictThrown =
      err.statusCode === 409 && err.code === "IDEMPOTENCY_CONFLICT";
  }
  assert.strictEqual(
    conflictThrown,
    true,
    "Reusing Idempotency-Key with different amount must throw 409",
  );
  console.log(
    "[PASS] Test 3: Mobile retries are idempotent; mismatched retry payload rejected with 409",
  );

  // -------------------------------------------------------------------------
  // TEST 4: Async worker + Gateway timeout safety + Duplicate webhook guard
  // -------------------------------------------------------------------------
  const gateway = new MockPaymentGateway();

  // 4a. Simulate nastiest bug: gateway ACCEPTS payout but HTTP response times out!
  gateway.setMode("TIMEOUT_AFTER_ACCEPT");
  const job1 = await processNextWithdrawal(gateway);
  assert.strictEqual(
    job1.status,
    "UNKNOWN_PENDING_RECON",
    "Timeout must NEVER auto-refund",
  );

  // Reconcile queries gateway -> sees gateway accepted it -> marks COMPLETED once settled
  const wId1 = job1.withdrawalId;
  const wDoc1 = await db
    .collection("withdrawals")
    .findOne({ _id: new ObjectId(wId1) });
  gateway.markSettled(wDoc1.gatewayReference);

  const reconRes = await reconcileWithdrawal(wId1, gateway);
  assert.strictEqual(reconRes.status, "COMPLETED");

  // Duplicate COMPLETED webhook must be a no-op
  const dupComplete = await finalizeWithdrawalCompleted(
    wId1,
    wDoc1.gatewayPayoutId,
  );
  assert.strictEqual(dupComplete.applied, false);

  const w1Final = await db
    .collection("wallets")
    .findOne({ userId: wDoc1.userId });
  assert.strictEqual(
    w1Final.heldPaise,
    0,
    "Held balance released cleanly once",
  );

  // 4b. Simulate definite terminal failure -> refunds ONCE; duplicate failure webhook cannot double-refund!
  gateway.setMode("TERMINAL_FAILURE");
  const job2 = await processNextWithdrawal(gateway);
  assert.strictEqual(job2.status, "FAILED");

  const dupFail = await finalizeWithdrawalFailed(
    job2.withdrawalId,
    "DUPLICATE_WEBHOOK",
  );
  assert.strictEqual(
    dupFail.applied,
    false,
    "Duplicate FAILED webhook must NOT double-refund",
  );

  const wDoc2 = await db
    .collection("withdrawals")
    .findOne({ _id: new ObjectId(job2.withdrawalId) });
  const w2Final = await db
    .collection("wallets")
    .findOne({ userId: wDoc2.userId });
  assert.strictEqual(
    w2Final.availablePaise,
    200000,
    "Full ₹2000 restored exactly once",
  );
  assert.strictEqual(w2Final.heldPaise, 0);
  console.log(
    "[PASS] Test 4: Gateway timeout reconciled safely without double-pay; duplicate failure webhook guarded",
  );

  // -------------------------------------------------------------------------
  // TEST 5: Part 2 Reward Points — Earn, Concurrent Double-Convert, Expiry
  // -------------------------------------------------------------------------
  const oct2026 = new Date("2026-10-15T10:00:00.000Z");
  const rateId = new ObjectId();
  await db.collection("conversion_rates").insertOne({
    _id: rateId,
    paiseNumerator: 25, // 1 point = 25 paise (₹0.25)
    pointsDenominator: 1,
    minConvertPoints: 100,
    effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
    effectiveTo: null,
    createdBy: "finance_admin",
    createdAt: new Date("2026-09-25T00:00:00.000Z"),
  });

  // User 1 earns 600 pts (project, expires Oct 20) + 400 pts (promo, expires Dec 31)
  await earnPoints({
    userId: user1.toHexString(),
    userCohort: "2026-09",
    points: 600,
    source: "PROJECT_COMPLETION",
    sourceRefId: "proj_101",
    expiresAt: new Date("2026-10-20T00:00:00.000Z"),
    idempotencyKey: "earn_proj_101_u1",
    createdAt: new Date("2026-10-05T10:00:00.000Z"),
  });
  await earnPoints({
    userId: user1.toHexString(),
    userCohort: "2026-09",
    points: 400,
    source: "PROMO_EVENT",
    sourceRefId: "diwali_bonus",
    expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    idempotencyKey: "earn_promo_diwali_u1",
    createdAt: new Date("2026-10-10T10:00:00.000Z"),
  });

  // Fire 10 concurrent requests to convert 800 points (user only has 1000 -> ONLY 1 can succeed!)
  const convRace = Array.from({ length: 10 }, (_, idx) =>
    convertPointsToCash({
      authenticatedUserId: user1.toHexString(),
      pointsToConvert: 800,
      idempotencyKey: `conv_race_key_${String(idx).padStart(2, "0")}`,
      now: oct2026,
    }).then(
      (res) => ({ ok: true, res }),
      (err) => ({ ok: false, code: err.code }),
    ),
  );
  const convResults = await Promise.all(convRace);
  assert.strictEqual(
    convResults.filter((r) => r.ok).length,
    1,
    "Exactly 1 concurrent conversion must succeed",
  );
  assert.strictEqual(convResults.filter((r) => !r.ok).length, 9);

  // Verify FIFO consumption: 600-pt grant (expiring Oct 20) was consumed first -> 0 remaining;
  // 400-pt grant (expiring Dec 31) had 200 consumed -> 200 remaining.
  const pw1 = await db.collection("point_wallets").findOne({ userId: user1 });
  assert.strictEqual(pw1.availablePoints, 200);

  const cashW1 = await db.collection("wallets").findOne({ userId: user1 });
  assert.strictEqual(
    cashW1.availablePaise,
    20000,
    "800 pts * 25 paise = 20000 paise (₹200) credited",
  );

  // User 2 earns 300 pts expiring Oct 20, does not convert -> expiry job runs on Oct 21 -> expires 300 pts
  await earnPoints({
    userId: user2.toHexString(),
    userCohort: "2026-09",
    points: 300,
    source: "PROMO_EVENT",
    sourceRefId: "welcome_promo",
    expiresAt: new Date("2026-10-20T00:00:00.000Z"),
    idempotencyKey: "earn_promo_welcome_u2",
    createdAt: new Date("2026-10-02T10:00:00.000Z"),
  });

  const expRes = await expireOverdueGrants(
    new Date("2026-10-21T00:00:00.000Z"),
  );
  assert.strictEqual(
    expRes.expiredGrantsCount,
    1,
    "Only user2 unconsumed grant should expire",
  );
  assert.strictEqual(expRes.totalPointsExpired, 300);
  console.log(
    "[PASS] Test 5: Concurrent points conversion blocked double-spend; FIFO grants & expiry worked",
  );

  // -------------------------------------------------------------------------
  // TEST 6: Part 2 Monthly Finance Report Aggregation Pipeline (Oct 2026)
  // -------------------------------------------------------------------------
  const perUserReport = await getMonthlyFinanceReport({
    year: 2026,
    month: 10,
    timezoneOffsetMinutes: 0,
  });
  const cohortSummary = await getMonthlyCohortSummary({
    year: 2026,
    month: 10,
    timezoneOffsetMinutes: 0,
  });

  assert.strictEqual(perUserReport.length, 2);
  const r1 = perUserReport.find((r) => r.userId.equals(user1));
  const r2 = perUserReport.find((r) => r.userId.equals(user2));

  assert.deepStrictEqual(
    {
      earned: r1.pointsEarned,
      converted: r1.pointsConverted,
      expired: r1.pointsExpired,
      net: r1.netChange,
    },
    { earned: 1000, converted: 800, expired: 0, net: 200 },
  );
  assert.deepStrictEqual(
    {
      earned: r2.pointsEarned,
      converted: r2.pointsConverted,
      expired: r2.pointsExpired,
      net: r2.netChange,
    },
    { earned: 300, converted: 0, expired: 300, net: 0 },
  );

  assert.strictEqual(cohortSummary.length, 1);
  assert.strictEqual(cohortSummary[0].userCohort, "2026-09");
  assert.strictEqual(cohortSummary[0].pointsEarned, 1300);
  assert.strictEqual(cohortSummary[0].pointsConverted, 800);
  assert.strictEqual(cohortSummary[0].pointsExpired, 300);

  console.log(
    "[PASS] Test 6: Monthly finance aggregation pipeline matches expected earned/converted/expired",
  );
  console.log(
    "\nSample Monthly Report Output (Oct 2026):",
    JSON.stringify({ perUserReport, cohortSummary }, null, 2),
  );
  console.log("\nALL VERIFICATION TESTS PASSED!");
}

runVerification()
  .catch((err) => {
    console.error("VERIFICATION FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
