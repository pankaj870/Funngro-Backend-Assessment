'use strict';

const { ObjectId } = require('mongodb');
const { connectDb, closeDb } = require('../db/client');
const { ensureIndexes } = require('../db/indexes');
const { earnPoints } = require('../part2/rewardPointsService');

if (!process.env.ALLOW_STANDALONE_DEV_FALLBACK) {
  process.env.ALLOW_STANDALONE_DEV_FALLBACK = 'true';
}

const DEMO_USER_ID = '660000000000000000000001';

async function seed() {
  const { db } = await connectDb();
  await ensureIndexes(db);

  const userId = new ObjectId(DEMO_USER_ID);
  const now = new Date();

  // Upsert deterministic demo user (Aarav)
  await db.collection('users').updateOne(
    { _id: userId },
    {
      $set: {
        name: 'Aarav Demo',
        status: 'ACTIVE',
        kycStatus: 'VERIFIED',
        cohortMonth: '2026-10',
        bankAccount: {
          beneficiaryId: 'ben_demo_aarav_01',
          accountNumber: '123456789012',
          ifsc: 'HDFC0001234',
          verified: true,
        },
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  // Reset demo wallet to ₹2,500.00 (250000 paise)
  await db.collection('wallets').updateOne(
    { userId },
    {
      $set: {
        status: 'ACTIVE',
        availablePaise: 250000,
        heldPaise: 0,
        updatedAt: now,
      },
    },
    { upsert: true }
  );

  // Ensure an active conversion rate exists: 1 point = 25 paise (₹0.25)
  await db.collection('conversion_rates').updateOne(
    { effectiveTo: null },
    {
      $setOnInsert: {
        paiseNumerator: 25,
        pointsDenominator: 1,
        minConvertPoints: 100,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        createdBy: 'seed_script',
        createdAt: now,
      },
    },
    { upsert: true }
  );

  // Idempotently grant 1,500 reward points (1,000 project + 500 promo)
  await earnPoints({
    userId: DEMO_USER_ID,
    userCohort: '2026-10',
    points: 1000,
    source: 'PROJECT_COMPLETION',
    sourceRefId: 'proj_demo_001',
    expiresAt: new Date('2027-03-31T00:00:00.000Z'),
    idempotencyKey: 'seed_earn_proj_demo_001',
    createdAt: new Date('2026-11-05T10:00:00.000Z'),
  });

  await earnPoints({
    userId: DEMO_USER_ID,
    userCohort: '2026-10',
    points: 500,
    source: 'PROMO_EVENT',
    sourceRefId: 'promo_demo_001',
    expiresAt: new Date('2027-06-30T00:00:00.000Z'),
    idempotencyKey: 'seed_earn_promo_demo_001',
    createdAt: new Date('2026-11-10T10:00:00.000Z'),
  });

  console.log('Seeded demo data in funngro:');
  console.log('  userId:          ', DEMO_USER_ID);
  console.log('  availablePaise:   250000 (₹2,500.00)');
  console.log('  rewardPoints:     1500 pts (rate: 25 paise/pt)');
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
