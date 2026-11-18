# PART 3 – Production Scenario: 9 PM Payout Day
If I face this situation, my first priority would be to protect users' money and stop the problem from getting worse. I would not immediately try to fix the code without understanding what is happening.

I would divide my first 30 minutes into four steps.

### 1. First 3 Minutes – Control the Situation
First, I would check how serious the issue is.
I would look at:
- Application logs to check how many withdrawal requests are failing or timing out.
- Gateway dashboard to check whether payouts are successful, pending, or failed.
- MongoDB Atlas to see whether the database is responding slowly.

Since the withdrawal API latency has increased from 300ms to 11 seconds, there is a possibility that users are retrying their requests.

**My immediate decision:**

If I see multiple failed requests, gateway timeouts, or debits happening without confirmed payouts, I would temporarily disable new withdrawal requests using a feature flag or API configuration.

Users should still be able to check their wallet balance and transaction history.

I would also inform the team and support staff about the issue. I would clearly tell Support not to ask users to retry withdrawals because this could result in duplicate transactions.

### 2. Minutes 3–12 – Find Where the Problem Is

After controlling new withdrawal requests, I would investigate three areas.

**A. Check MongoDB**

I would open MongoDB Atlas and check:
- CPU usage
- Memory usage
- Database connections
- Read and write latency
- Slow queries
- Disk usage and IOPS

I would also run some read-only commands:

```javascript
// Check currently running slow operations
db.currentOp({
  active: true,
  secs_running: { $gte: 2 }
});

// Check indexes on wallet collection
db.wallets.getIndexes();

// Check indexes on ledger collection
db.ledger.getIndexes();
```

If I find slow queries or high database CPU usage, I would investigate whether missing indexes or expensive queries are causing the problem.

If MongoDB looks healthy, I would move my attention to the application and payment gateway.

**B. Check the Payment Gateway**

Next, I would check:
- Gateway response time.
- Successful and failed payouts.
- Pending transactions.
- Gateway error messages.
- Available payout balance.

For example, if many transactions are stuck in `PROCESSING`, I would not consider them failed immediately. The bank or payment gateway might still be processing them.

If the gateway is reporting insufficient balance, I would contact the finance or operations team.

If the gateway itself is responding slowly, I would avoid sending more withdrawal requests until the situation improves.

**C. Check Application Logs**

I would search the logs for errors such as:

```text
ETIMEDOUT
ECONNRESET
MongoNetworkTimeoutError
Gateway Error
Internal Server Error
```

I would also take 5 affected user IDs from Support and trace their transactions.

For each user, I would check:

1. Was the wallet balance deducted?
2. Was a transaction recorded in MongoDB?
3. Was a request sent to the payment gateway?
4. What is the final gateway status?

This would help me understand whether the problem is coming from MongoDB, our application, or the payment gateway.

### 3. Minutes 12–22 – Apply the Right Fix

At this point, I would use the information collected to decide the next step.

**Case 1: MongoDB is slow**
If I find missing indexes or expensive database queries, I would keep withdrawals paused and work with the database owner to fix the issue safely.

I would avoid making major database changes while the system is under heavy load.

**Case 2: Payment gateway is slow**
If the gateway is responding slowly or transactions are stuck in pending status, I would keep withdrawals disabled until the gateway becomes stable.

I would also coordinate with the payment gateway team.

**Case 3: Application issue**
If I find that our application is not handling gateway timeouts correctly, I would investigate the withdrawal flow.
I would specifically check whether:
- Wallet deduction and transaction creation are handled safely.
- Gateway errors are properly handled.
- Duplicate requests are prevented using idempotency keys.
- Failed or pending transactions can be tracked and recovered.

I would not deploy an untested code change directly to production.

### 4. Minutes 22–30 – Verify Transactions and Update the Team
Before thinking about restarting withdrawals, I would reconcile the affected transactions.
I would compare MongoDB withdrawal records with payment gateway records.
I would divide transactions into four categories:

1. **Successful:** Money was deducted and the gateway confirms the payout. I would collect the transaction reference number and share it with Support.

2. **Pending:** Money was deducted, but the gateway is still processing the payout. I would wait for the final status instead of refunding immediately.

3. **Failed:** The gateway confirms that the payout failed. I would arrange a safe refund through a verified process and create a corresponding reversal entry in the transaction ledger.

4. **Duplicate:** If the gateway processed the same payout more than once, I would inform the finance team and investigate recovery.

After that, I would share an update with the team explaining the issue, affected transactions, actions taken, and next steps.

I would reopen withdrawals only after confirming that:
- Database performance is stable.
- API response time is back to normal.
- Payment gateway errors have reduced.
- A test withdrawal has completed successfully.
- Transaction records and wallet balances are consistent.

I would also monitor the system closely after reopening.

### What I Would Not Do

There are a few things I would avoid during this incident:

1. **I would not immediately refund users.** The payment might still be processing, and refunding could result in the user receiving money twice.

2. **I would not ask users to retry withdrawals.** This could create duplicate transactions or multiple payouts.

3. **I would not restart all servers immediately.** First, I would understand the issue and make sure active transactions are handled safely.

4. **I would not directly update wallet balances in MongoDB.** Every balance correction should have a proper transaction and ledger entry.

5. **I would not deploy an untested fix in production.** Since I did not build this system, I would first understand the existing flow and take help from the responsible developer if needed.

### Final Approach

My main focus during these first 30 minutes would be to protect users' money, stop duplicate withdrawals, identify where the delay is happening, and make sure every affected transaction is accounted for.

I believe that during a financial production incident, protecting data and money is more important than quickly bringing an endpoint back online.