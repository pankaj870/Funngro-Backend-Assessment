# Part 2: Reward Points System – MongoDB Design

## 1. MongoDB Collections

I would use five collections to manage the reward points system.

My main idea is to store the current points balance separately from the transaction history. This makes balance checks faster and also keeps a complete record of every points transaction.

### 1. `point_wallets` – Current points balance

This collection stores one document for each user. It helps us check the user's current points without calculating the balance from all previous transactions.

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  availablePoints: Number,
  lifetimeEarned: Number,
  lifetimeConverted: Number,
  lifetimeExpired: Number,
  version: Number,
  updatedAt: Date
}
```

### 2. `point_grants` – Points earned by users

Whenever a user earns points, I create a separate grant record.

This is useful because different points can have different expiry dates.

For example:
- Promotional points may expire after 30 days.
- Project completion points may expire after one year.

I would use FIFO logic, which means points that expire first are used first.

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  userCohort: String,
  ledgerId: ObjectId,
  source: String,
  sourceRefId: String,
  originalPoints: Number,
  remainingPoints: Number,
  expiresAt: Date,
  expiredAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```

When points are used or expire, I update the grant's remaining points. But I never change the original ledger transaction.

### 3. `point_ledger` – Complete transaction history

This collection stores every points transaction, such as:
- Points earned.
- Points converted into cash.
- Points expired.
- Points reversed.

I would keep this collection append-only. This means I never edit or delete an old transaction. I create a new entry for every new points movement.

This helps us track transactions and prepare reports.

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  userCohort: String,
  type: String, // EARN / CONVERT / EXPIRE / REVERSAL
  source: String,
  sourceRefId: String,
  points: Number,
  balanceAfter: Number,
  idempotencyKey: String,
  createdAt: Date
}
```

For example, if a user earns 100 points, I add an `EARN` entry with `points: 100`.

If the user converts 40 points, I add a separate `CONVERT` entry with `points: -40`.

### 4. `conversion_rates` – Conversion rate history

The conversion rate may change in the future. So I would store each rate with its start and end dates.

This helps us know which rate was used for an old transaction.

I would store the rate as integers instead of using decimal values. This helps avoid floating-point calculation problems.

```javascript
{
  _id: ObjectId,
  paiseNumerator: Number,
  pointsDenominator: Number,
  minConvertPoints: Number,
  effectiveFrom: Date,
  effectiveTo: Date,
  createdBy: String,
  createdAt: Date
}
```

For example, if 1 point is worth 25 paise, converting 100 points gives ₹25.

### 5. `point_conversions` – Conversion records

Whenever a user converts points into cash, I create a record here.

It stores how many points were converted, which rate was used, and how much cash was added to the user's wallet.

I also save a copy of the conversion rate. This is important because the rate may change later, but old transactions must keep their original rate.

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  userCohort: String,
  idempotencyKey: String,
  pointsConverted: Number,
  rateId: ObjectId,
  rateSnapshot: {
    paiseNumerator: Number,
    pointsDenominator: Number,
    effectiveFrom: Date
  },
  cashPaiseCredited: Number,
  pointLedgerId: ObjectId,
  walletLedgerId: ObjectId,
  status: String,
  createdAt: Date
}
```

---

## 2. Indexes and Why I Need Them

I would create indexes based on the queries used by the application.

| Collection | Index | Purpose |
|---|---|---|
| `point_wallets` | `{ userId: 1 }` unique | Finds a user's wallet quickly and prevents duplicate wallets. |
| `point_grants` | `{ userId: 1, expiresAt: 1 }` partial | Finds active points in expiry order. |
| `point_grants` | `{ expiresAt: 1 }` partial | Helps the expiry job find points that need to expire. |
| `point_ledger` | `{ userId: 1, createdAt: -1 }` | Loads a user's latest transactions. |
| `point_ledger` | `{ createdAt: 1, userCohort: 1, userId: 1, type: 1, points: 1 }` | Helps with monthly reports. |
| `point_ledger` | `{ idempotencyKey: 1 }` unique | Prevents duplicate transaction entries. |
| `conversion_rates` | `{ effectiveFrom: -1, effectiveTo: 1 }` | Finds the rate valid for a particular date. |
| `point_conversions` | `{ userId: 1, idempotencyKey: 1 }` unique | Prevents the same conversion request from running twice. |
| `point_conversions` | `{ userId: 1, createdAt: -1 }` | Loads a user's conversion history. |

For `point_grants`, I would use partial indexes so that records with zero remaining points are not included.

Example:

```javascript
db.point_grants.createIndex(
  { userId: 1, expiresAt: 1 },
  {
    partialFilterExpression: {
      remainingPoints: { $gt: 0 }
    }
  }
);
```

This keeps the index smaller and helps MongoDB find active points faster.

I would also check query performance using `explain("executionStats")`. If monthly reports start slowing down normal transactions, I would run those reports separately from the main application workload.

---

## 3. Monthly Finance Report

Finance needs a monthly report showing how many points each user earned, converted, and expired.

I would use the `point_ledger` collection because it contains the complete transaction history.

For example, for October 2026:

- Start date: 1 October 2026
- End date: 1 November 2026 (not included)

This way, we get all transactions from October only.

### Aggregation Pipeline

```javascript
const pipeline = [
  {
    $match: {
      createdAt: {
        $gte: monthStart,
        $lt: monthEnd
      },
      type: {
        $in: ["EARN", "CONVERT", "EXPIRE"]
      }
    }
  },
  {
    $project: {
      _id: 0,
      userId: 1,
      userCohort: 1,
      type: 1,
      points: 1
    }
  },
  {
    $group: {
      _id: {
        userId: "$userId",
        userCohort: "$userCohort"
      },
      pointsEarned: {
        $sum: {
          $cond: [
            { $eq: ["$type", "EARN"] },
            "$points",
            0
          ]
        }
      },
      pointsConverted: {
        $sum: {
          $cond: [
            { $eq: ["$type", "CONVERT"] },
            { $abs: "$points" },
            0
          ]
        }
      },
      pointsExpired: {
        $sum: {
          $cond: [
            { $eq: ["$type", "EXPIRE"] },
            { $abs: "$points" },
            0
          ]
        }
      }
    }
  },
  {
    $project: {
      _id: 0,
      userId: "$_id.userId",
      userCohort: "$_id.userCohort",
      pointsEarned: 1,
      pointsConverted: 1,
      pointsExpired: 1,
      netChange: {
        $subtract: [
          "$pointsEarned",
          {
            $add: [
              "$pointsConverted",
              "$pointsExpired"
            ]
          }
        ]
      }
    }
  },
  {
    $sort: {
      userCohort: 1,
      userId: 1
    }
  }
];
```

I would run it like this:

```javascript
const report = await db.collection("point_ledger")
  .aggregate(pipeline, {
    allowDiskUse: true
  })
  .toArray();
```

`allowDiskUse: true` allows MongoDB to use temporary disk space if the aggregation needs more memory.

### Example Result

```javascript
{
  userId: ObjectId("..."),
  userCohort: "2026-09",
  pointsEarned: 500,
  pointsConverted: 200,
  pointsExpired: 50,
  netChange: 250
}
```

This report shows that the user earned 500 points, converted 200, and lost 50 due to expiry. So the net increase was 250 points.

We can also add another grouping stage if finance needs totals for each user cohort.

---

## 4. How I Would Prevent Points from Being Converted Twice

I would use three things:

1. Idempotency keys.
2. Atomic balance updates.
3. MongoDB transactions.

First, every conversion request must have an idempotency key.

I would create a unique index on `userId` and `idempotencyKey` in the `point_conversions` collection.

This prevents duplicate conversions if the user sends the same request again because of a timeout or mobile app retry.

Second, I would use an atomic update on `point_wallets`.

MongoDB would check whether the user has enough points and deduct them in the same operation. If the user does not have enough points, the update would fail.

Third, I would put all related operations inside one MongoDB transaction:

- Deduct points from the user's balance.
- Update the FIFO grant records.
- Add a new point ledger entry.
- Create the conversion record.
- Add cash to the user's wallet.

If all operations succeed, the transaction is committed. If any operation fails, the transaction is rolled back.

This makes sure the same points cannot be used in two successful conversions, even if two requests arrive at the same time.

---

## How I Would Explain This in an Interview

"I divided the system into five collections to keep things easy to manage.

The wallet collection stores the current balance, while the ledger stores the full transaction history. I use grant records to manage points with different expiry dates.

I also store conversion rates with their effective dates so that old transactions always use the correct rate.

For monthly reports, I use MongoDB aggregation on the ledger collection.

To prevent duplicate conversions, I use idempotency keys, atomic balance updates, and MongoDB transactions. This ensures that points are deducted only once and all related updates happen together."