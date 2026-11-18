# Part 1 – Code Review of the Withdrawal Handler

## 1. Critical – Missing Authentication and Authorization

**What is the problem?**

The API takes `userId` directly from the request body. It does not check whether the logged-in user owns that wallet.

Because of this, a user could try to withdraw money from someone else's wallet by changing the `userId`.

**Real-world example:**

A user checks the API request from the mobile app and changes their own user ID to another user's ID. They may then try to withdraw money from that account.

**How I would fix it:**

I would get the user ID from `req.user.id` instead of the request body. I would also check that the account is active, KYC is completed, and the bank account is verified before allowing a withdrawal.

---

## 2. Critical – Missing Amount Validation

**What is the problem?**

The API does not properly check the withdrawal amount.

It should check whether the amount is positive and within the allowed withdrawal limits.

For example, if someone sends `-50000`, subtracting this negative amount will actually increase the wallet balance.

Using decimal numbers for money can also cause calculation problems in JavaScript.

**Real-world example:**

A user sends a negative withdrawal amount. The application may increase their wallet balance instead of deducting money.

**How I would fix it:**

I would check that the amount is positive and within the minimum and maximum limits. I would store money in paise as an integer instead of using decimal values.

I would also validate all request data before using it.

---

## 3. Critical – Race Condition and Double Spending

**What is the problem?**

The code first reads the wallet balance, checks it, and then updates it using `$set`.

These are separate operations. If two withdrawal requests arrive at the same time, both may read the same balance and pass the balance check.

This can allow the user to withdraw more money than they actually have.

**Real-world example:**

Suppose a user has ₹1,000 and sends two withdrawal requests of ₹1,000 at the same time.

Both requests may read the balance as ₹1,000 and pass the check. This could result in two payouts of ₹1,000.

**How I would fix it:**

I would use an atomic update. MongoDB would check the available balance and update it in one operation.

For example:

```javascript
const wallet = await Wallet.findOneAndUpdate(
  {
    userId,
    availablePaise: { $gte: amountPaise }
  },
  {
    $inc: {
      availablePaise: -amountPaise,
      heldPaise: amountPaise
    }
  },
  {
    new: true,
    session
  }
);

if (!wallet) {
  throw new Error("Insufficient balance");
}
```

This makes sure that the same available balance cannot be used for two successful withdrawals.

---

## 4. Critical – Missing Idempotency

**What is the problem?**

Sometimes a mobile app sends the same request again if it does not receive a response.

The current API does not check whether the request has already been processed. It creates a new payout reference using `Date.now()` every time.

This can create duplicate withdrawals.

**Real-world example:**

A user requests a withdrawal of ₹500. The server processes it, but the response takes too long.

The mobile app thinks the request failed and sends it again. The server may process another withdrawal of ₹500.

**How I would fix it:**

I would use an `Idempotency-Key` for every withdrawal request.

I would store this key in the withdrawal collection and create a unique index:

```javascript
db.withdrawals.createIndex(
  { userId: 1, idempotencyKey: 1 },
  { unique: true }
);
```

If the same request comes again, the API should return the existing withdrawal status instead of creating a new withdrawal.

I would also use a permanent withdrawal ID as the payment gateway reference to avoid duplicate payouts during retries.

---

## 5. Critical – Payment Gateway Errors Are Not Handled Properly

**What is the problem?**

The payment gateway call is missing `await`. This means the application does not properly wait for the payout result.

Also, if the gateway call fails, the catch block only logs the error. The application still inserts the ledger entry and returns a successful response.

This can show a successful withdrawal even when the money was never sent.

A timeout is also important. Sometimes the gateway processes the payment but does not send a response back.

**Real-world example:**

A user requests ₹2,000. The gateway rejects the payout because of a bank account issue.

But the API still returns `{ ok: true }`, so the user sees a successful withdrawal even though the money never reaches their bank account.

**How I would fix it:**

I would separate wallet deduction from actual payout processing.

I would maintain withdrawal statuses such as:

- `PENDING`
- `PROCESSING`
- `COMPLETED`
- `FAILED`
- `UNKNOWN_PENDING_RECON`

First, I would move the amount from the available balance to the held balance.

Then a background worker would process the payout.

- If the gateway confirms success, I would mark the withdrawal as `COMPLETED`.
- If the gateway confirms failure, I would release the held amount back to the available balance.
- If the gateway times out, I would check the payout status using its reference ID before trying again.

I would also use a transactional outbox so that a saved withdrawal is not lost before the worker processes it.

---

## 6. High – Missing Database Indexes and Unnecessary Ledger Query

**What is the problem?**

The assessment says that the Wallets collection has around 2 million documents and the Ledger collection has around 40 million documents.

But both collections only have the default `_id` index.

This query does not have a suitable index:

```javascript
Ledger.find({ userId })
  .sort({ createdAt: -1 });
```

MongoDB may need to scan many records and perform an expensive sort to get one user's transaction history.

Also, the withdrawal API is loading the complete ledger history every time. This is unnecessary.

**Real-world example:**

During busy hours, many users request withdrawals. Every request loads a large amount of ledger data.

This increases database load and can make other API requests slower. Some requests may even time out.

**How I would fix it:**

I would remove the ledger history query from the withdrawal API.

I would create a separate transaction history API with pagination.

I would create these indexes:

```javascript
// Wallet collection
db.wallets.createIndex(
  { userId: 1 },
  { unique: true }
);

// Ledger collection
db.ledger.createIndex(
  { userId: 1, createdAt: -1 }
);
```

The wallet index helps find a user's wallet quickly and prevents duplicate wallets.

The ledger index helps load the latest transactions for a user.

I would also use pagination, for example, 20 records per request.

---

## 7. High – Wallet Update and Ledger Insert Are Not Atomic

**What is the problem?**

The code updates the wallet balance first and inserts the ledger entry afterward.

These are two separate operations without a database transaction.

If the server crashes after updating the wallet but before inserting the ledger entry, the money will be deducted but there will be no transaction record.

**Real-world example:**

A user's wallet is reduced by ₹500, but the server crashes before saving the ledger entry.

The user sees the money deducted, but the finance team cannot find the transaction in the ledger.

**How I would fix it:**

I would use a MongoDB transaction so that all related database operations succeed or fail together.

The transaction would include:

1. Creating the withdrawal record.
2. Moving money from the available balance to the held balance.
3. Creating the ledger entry.
4. Creating the outbox event for payout processing.

If any database operation fails, the transaction will be rolled back.

This keeps the wallet balance and transaction history in sync.

---

## 8. High – Missing Wallet, Bank Account and User Checks

**What is the problem?**

The code assumes that the wallet and bank account always exist.

If the wallet does not exist, accessing `wallet.balance` can cause an error.

The code also does not check whether the user's bank account is verified or whether the account is allowed to make withdrawals.

**Real-world example:**

A user who has not verified their bank account tries to withdraw money.

The application may deduct the amount and try to send the payout without checking the bank details properly.

This can cause failed payouts and support issues.

**How I would fix it:**

Before processing a withdrawal, I would check:

- The user exists and the account is active.
- KYC is completed.
- The wallet exists and is active.
- The bank account is available and verified.
- The withdrawal amount is within the allowed limits.

If any check fails, the API should return an error without changing the wallet balance.

---

## 9. Medium – Synchronous Gateway Processing and Missing Controls

**What is the problem?**

The current code processes the payout directly inside the API request.

This means the API has to wait for the payment gateway. If the gateway becomes slow, the API also becomes slow.

The code is also missing proper timeouts, logs, withdrawal limits, and a way to stop payouts during an incident.

**Real-world example:**

Suppose the payment gateway takes 10–12 seconds to respond.

Many requests remain waiting, mobile apps may retry them, and the overall system becomes slower.

**How I would fix it:**

I would move payout processing to a background worker using a message queue.

The withdrawal API would:

1. Validate the request.
2. Reserve the wallet balance.
3. Save the withdrawal record.
4. Return `202 Accepted` with a withdrawal ID.

The background worker would then contact the payment gateway and update the withdrawal status.

I would also add:

- Proper gateway timeouts and controlled retries.
- Daily withdrawal limits for each user.
- Structured logs with withdrawal IDs.
- Monitoring and alerts for failed or pending payouts.
- A switch to pause new payouts if something goes wrong.

This would make the system easier to manage and more reliable.

---

## Overall Summary

The biggest problems in the existing code are missing authentication, unsafe wallet updates, duplicate withdrawal requests, and poor payment gateway error handling.

These issues can directly affect users' money.

Before using this code in production, I would make wallet updates atomic, maintain a proper transaction history, add idempotency, and process payouts through a background worker.

My main goal would be to make sure that every withdrawal is handled correctly and users do not lose money or receive duplicate payouts because of technical issues.

---

## How I Would Explain Part 1 in an Interview

"I found nine main issues in the withdrawal handler.

The most important ones are missing authentication, amount validation, race conditions, and duplicate withdrawal requests.

For example, two requests can arrive at the same time and try to withdraw the same balance. To prevent this, I would use an atomic MongoDB update.

I would also use idempotency keys to prevent duplicate requests and MongoDB transactions to keep wallet updates and ledger entries together.

For payment processing, I would use a background worker instead of waiting for the gateway inside the API request.

My main focus is to keep the user's money safe and make sure every withdrawal is properly recorded."