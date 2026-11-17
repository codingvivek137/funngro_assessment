# Part 1 — Withdrawal handler review

## 1. Problems, ordered by severity

### 1. A retry can pay the same withdrawal twice
**What goes wrong:** The endpoint has no idempotency key. If the app times out after the server has processed a withdrawal, the app retries and the server treats it as a new withdrawal.

**Realistic scenario:** A user's ₹500 withdrawal succeeds at the gateway, but the response never reaches the phone. The retry creates another ₹500 payout.

**Fix:** Require an idempotency key for every withdrawal. Store it with the withdrawal request and enforce a unique index. Repeated requests with the same key must return the original request instead of creating another payout. Send the same stable key to the gateway as its idempotency key too.

### 2. Two simultaneous withdrawals can spend the same balance
**What goes wrong:** The code reads the balance, calculates a new balance in JavaScript, and writes it back. Two requests can read the same old balance and both pass the check.

**Realistic scenario:** The wallet has ₹1,000. Two requests for ₹700 arrive together. Both read ₹1,000, both pass, and both can trigger payouts. The final stored balance may show only one deduction.

**Fix:** Do the balance check and deduction in one atomic MongoDB update, using a condition such as `balancePaise: { $gte: amountPaise }`. Put the wallet update, payout record, ledger entry and outbox event in one MongoDB transaction.

### 3. Gateway failure can leave the user's money deducted
**What goes wrong:** The wallet is debited before the gateway call. If the gateway rejects the payout, the catch block only logs the error. The user is left with a lower balance and no payout.

**Realistic scenario:** The gateway is temporarily unavailable during payout day. The endpoint still returns `ok: true`, even though no payout was made.

**Fix:** Do not treat a gateway call as successful just because it did not throw synchronously. Create a pending payout and an outbox event in the database transaction. A worker processes it and records success or failure. If the gateway confirms a permanent failure, refund the wallet in a separate transaction and add a reversal ledger entry.

### 4. The gateway call is not awaited
**What goes wrong:** `gateway.createPayout()` is not awaited. If it returns a Promise, the `try/catch` will not catch a later rejection. The API can return success before the gateway has responded.

**Realistic scenario:** The gateway rejects the payout a few seconds later. The request has already returned success and the error may become an unhandled rejection.

**Fix:** Await asynchronous gateway calls in a worker and handle both rejected calls and unclear timeouts. A timeout does not prove that the gateway failed; check the gateway using the same reference before retrying.

### 5. A timeout after processing can create a second payout
**What goes wrong:** Even if the gateway accepted the payout, the API may time out before the client receives the response. Without idempotency, the retry can pay again.

**Realistic scenario:** The gateway transfers ₹1,000, but the app sees a timeout and retries.

**Fix:** Use a stable payout ID as the gateway reference/idempotency key. Never generate a new reference for a retry of the same withdrawal.

### 6. The amount is not validated
**What goes wrong:** The code accepts negative numbers, zero, decimals, strings and potentially invalid values. A negative amount can increase the wallet balance when subtracted.

**Realistic scenario:** A request with `amount: -500` makes `balance - amount` larger than the original balance.

**Fix:** Accept only a positive, safe integer in the smallest currency unit (paise). Check minimum/maximum withdrawal limits and use integer arithmetic. Never use floating-point rupees for money calculations.

### 7. The user ID comes from the request body
**What goes wrong:** The caller can try to withdraw from another user's wallet by changing `userId`.

**Realistic scenario:** An authenticated user changes the body to another user's ID and attempts to withdraw their money.

**Fix:** Get the user ID from the authenticated session/token (`req.user.id`). Do not trust a user ID supplied by the client. Also check that the account is allowed to withdraw.

### 8. Wallet and user records are not checked safely
**What goes wrong:** `wallet` can be null, and `user.bankAccount` can be missing, unverified or invalid. The code can crash or send a payout to an unsafe destination.

**Realistic scenario:** A new user has no wallet document, or a user has not completed bank verification.

**Fix:** Handle missing wallet explicitly. Check bank-account verification and payout eligibility before creating a withdrawal.

### 9. The wallet update and ledger insert are not atomic
**What goes wrong:** The balance can be updated while the ledger insert fails. The database then has no reliable record explaining the balance change.

**Realistic scenario:** MongoDB is interrupted after the wallet update but before the ledger insert.

**Fix:** Write the wallet change, withdrawal record, ledger entry and outbox event in one MongoDB transaction. Use a replica set or sharded cluster that supports transactions.

### 10. The wallet query needs an index and a uniqueness rule
**What goes wrong:** `Wallets.findOne({ userId })` can scan a large collection. If multiple wallet documents exist for one user, `findOne` may select an arbitrary one.

**Realistic scenario:** The wallet collection grows to millions of users and withdrawals become slower; duplicate wallet records can also make balances inconsistent.

**Fix:** Create a unique index on `{ userId: 1 }`.

### 11. The ledger history query will become very expensive
**What goes wrong:** Every withdrawal loads the user's entire ledger history and sorts it. The collection has 40 million documents and only the default `_id` index.

**Realistic scenario:** A long-time user has thousands of ledger entries. Every withdrawal reads and sorts all of them, increasing latency and memory use.

**Fix:** Create `{ userId: 1, createdAt: -1 }` and return only a paginated history when the client asks for it. Do not fetch the full history during a withdrawal.

### 12. The ledger has no useful link to a withdrawal
**What goes wrong:** The ledger entry does not contain a unique withdrawal/payout ID or idempotency key.

**Realistic scenario:** Support sees two similar entries and cannot easily tell whether one is a retry, a refund or a separate withdrawal.

**Fix:** Store `withdrawalId`, a stable reference, and a clear status/type. Keep ledger entries append-only; record reversals as new entries instead of editing old financial history.

### 13. `updateOne({ userId })` may update an ambiguous wallet
**What goes wrong:** The filter does not include the balance condition, and it assumes there is exactly one wallet for that user.

**Realistic scenario:** A duplicate wallet document exists or another request changes the balance after the read.

**Fix:** Use a unique user index and a conditional atomic update. Check `modifiedCount`/`matchedCount` and handle a failed balance condition.

### 14. Logging and response design are weak
**What goes wrong:** `console.log` is not structured operational logging. The endpoint also returns the entire ledger history and says `ok: true` even if the gateway failed.

**Realistic scenario:** During an incident, engineers cannot correlate the API request, database withdrawal and gateway payout. Large responses also make the endpoint slower.

**Fix:** Use structured logs with request ID and withdrawal ID, but never log bank details or secrets. Return a small response with a pending status and let a separate history endpoint provide paginated entries.

## 2. A safer withdrawal implementation

### Assumptions

- `amountPaise` is an integer. For example, ₹100 is `10000`.
- Authentication middleware has already set `req.user.id`.
- The client sends an `Idempotency-Key` header and reuses it when retrying the same action.
- MongoDB runs as a replica set, so transactions are supported.
- `Withdrawal`, `Wallet`, `Ledger` and `Outbox` are Mongoose models.
- A background worker reads the outbox and talks to the payment gateway. The API does not wait for the bank transfer to finish.

```js
const mongoose = require("mongoose");

async function withdraw(req, res, next) {
  const userId = req.user.id; // Never trust userId from the body.
  const amountPaise = req.body.amountPaise;
  const idempotencyKey = req.get("Idempotency-Key");

  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    return res.status(400).json({
      error: "amountPaise must be a positive integer"
    });
  }

  if (!idempotencyKey || idempotencyKey.length > 100) {
    return res.status(400).json({
      error: "A valid Idempotency-Key header is required"
    });
  }

  // This example assumes the key is unique per user.
  // The unique index is also required in the database.
  const existing = await Withdrawal.findOne({ userId, idempotencyKey });

  if (existing) {
    return res.status(200).json({
      withdrawalId: existing._id,
      status: existing.status
    });
  }

  const session = await mongoose.startSession();
  let withdrawal;

  try {
    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);

      if (!user || !user.bankAccount?.verified) {
        const error = new Error("Verified bank account required");
        error.statusCode = 400;
        throw error;
      }

      // This is the important money-safety operation:
      // check the balance and deduct it in one atomic update.
      const wallet = await Wallet.findOneAndUpdate(
        {
          userId,
          balancePaise: { $gte: amountPaise }
        },
        {
          $inc: { balancePaise: -amountPaise }
        },
        {
          new: true,
          session
        }
      );

      if (!wallet) {
        const error = new Error("Insufficient balance");
        error.statusCode = 400;
        throw error;
      }

      const [createdWithdrawal] = await Withdrawal.create(
        [{
          userId,
          idempotencyKey,
          amountPaise,
          status: "pending",
          gatewayReference: null,
          createdAt: new Date()
        }],
        { session }
      );

      withdrawal = createdWithdrawal;

      await Ledger.create(
        [{
          userId,
          withdrawalId: withdrawal._id,
          type: "withdrawal_reserved",
          amountPaise: -amountPaise,
          balanceAfterPaise: wallet.balancePaise,
          createdAt: new Date()
        }],
        { session }
      );

      // The worker will process this after the transaction commits.
      await Outbox.create(
        [{
          eventType: "PAYOUT_REQUESTED",
          aggregateId: withdrawal._id,
          status: "pending",
          createdAt: new Date()
        }],
        { session }
      );
    });

    return res.status(202).json({
      withdrawalId: withdrawal._id,
      status: "pending",
      message: "Withdrawal request received"
    });
  } catch (error) {
    // Two identical requests can arrive at almost the same time.
    // The unique index decides which one is created.
    if (error.code === 11000) {
      const previous = await Withdrawal.findOne({
        userId,
        idempotencyKey
      });

      if (previous) {
        return res.status(200).json({
          withdrawalId: previous._id,
          status: previous.status
        });
      }
    }

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        error: error.message
      });
    }

    return next(error);
  } finally {
    await session.endSession();
  }
}
```

### Required unique indexes

```js
db.wallets.createIndex({ userId: 1 }, { unique: true });

db.withdrawals.createIndex(
  { userId: 1, idempotencyKey: 1 },
  { unique: true }
);

db.ledger.createIndex({ userId: 1, createdAt: -1 });

db.outbox.createIndex({ status: 1, createdAt: 1 });
```

### What the background worker does

1. It picks a pending outbox event and claims it safely so two workers do not process it at the same time.
2. It calls the gateway using the withdrawal ID as the stable idempotency/reference key.
3. If the gateway confirms success, it marks the withdrawal as `succeeded`.
4. If the gateway confirms a permanent failure, it refunds the wallet in a MongoDB transaction and inserts a `withdrawal_refund` ledger entry.
5. If the gateway times out and the result is unclear, it checks the gateway using the same reference. It must not blindly refund or create a new payout.

The worker must also be safe to run more than once. Gateway idempotency and conditional status updates are important because background jobs can be retried.

## 3. Overall design changes

Before trusting payouts at scale, I would make the ledger the permanent record of every money movement and keep wallet balances as fast-to-read totals. I would use MongoDB transactions and an outbox worker so database changes and payout requests cannot silently get out of sync. Every withdrawal would have an idempotency key, a stable gateway reference and clear states such as pending, succeeded and failed. Finally, I would add reconciliation between our payout records and the gateway's reports, along with alerts for stuck payouts, failed refunds and balance mismatches.
