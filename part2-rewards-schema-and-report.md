# Part 2 — Reward points schema and queries

## 1. Collections

I would store points as integers, not floating-point numbers. The user's cohort should be captured when points are earned so that later changes to profile information do not rewrite historical reporting.

### `users`
```js
{
  _id: ObjectId,
  cohortId: String,       // e.g. "2026-Q4"
  createdAt: Date
}
```

### `pointsWallets`
One current balance per user.

```js
{
  _id: ObjectId,
  userId: ObjectId,
  availablePoints: Number, // integer
  updatedAt: Date
}
```

### `pointsLedger`
Append-only record of every points movement.

```js
{
  _id: ObjectId,
  userId: ObjectId,
  cohortId: String,       // cohort snapshot
  type: String,           // "earned", "converted", "expired"
  points: Number,          // positive integer movement amount
  sourceType: String,      // "project", "promotion", "conversion", "expiry"
  sourceId: String,        // project/event/conversion reference
  conversionId: ObjectId,  // present for conversions
  createdAt: Date
}
```

For clarity, `points` is the positive number of points involved in the event. The `type` tells finance whether it was earned, converted or expired.

### `pointConversions`
Stores the conversion details and the rate actually used.

```js
{
  _id: ObjectId,
  userId: ObjectId,
  idempotencyKey: String,
  points: Number,
  rateId: ObjectId,
  ratePoints: Number,       // points in the rate
  rateCashPaise: Number,    // cash paise in the rate
  cashPaise: Number,        // calculated and stored result
  status: String,            // "completed"
  createdAt: Date
}
```

### `pointConversionRates`
Rates are time-based and should not be overwritten.

```js
{
  _id: ObjectId,
  points: Number,
  cashPaise: Number,
  effectiveFrom: Date,
  effectiveTo: Date,        // null means no known end yet
  createdAt: Date
}
```

### `pointExpiries`
Tracks points that are due to expire.

```js
{
  _id: ObjectId,
  userId: ObjectId,
  points: Number,
  expiresAt: Date,
  status: String,            // "active", "expired"
  sourceLedgerId: ObjectId,
  createdAt: Date
}
```

## 2. Indexes and why they exist

```js
// One points wallet per user.
db.pointsWallets.createIndex(
  { userId: 1 },
  { unique: true }
);

// User's ledger history, newest first.
db.pointsLedger.createIndex(
  { userId: 1, createdAt: -1 }
);

// Monthly finance report by cohort and event type.
db.pointsLedger.createIndex(
  { createdAt: 1, cohortId: 1, type: 1, userId: 1 }
);

// Prevent the same conversion request from being created twice.
db.pointConversions.createIndex(
  { userId: 1, idempotencyKey: 1 },
  { unique: true }
);

// Find the rate that was active at a conversion time.
db.pointConversionRates.createIndex(
  { effectiveFrom: -1 }
);

// Find points that need to expire.
db.pointExpiries.createIndex(
  { status: 1, expiresAt: 1 }
);

// Do not create two expiry records for the same source points lot.
db.pointExpiries.createIndex(
  { sourceLedgerId: 1 },
  { unique: true }
);
```

The monthly report index is designed around the report's date range and grouping fields. I would check the actual query plan with `explain("executionStats")` on production-like data before deciding whether to change its field order.

## 3. Monthly finance report

The following pipeline returns one row per user and cohort, with earned, converted and expired points in the selected month.

```js
const monthStart = new Date("2026-10-01T00:00:00.000Z");
const nextMonth = new Date("2026-11-01T00:00:00.000Z");

db.pointsLedger.aggregate([
  {
    $match: {
      createdAt: {
        $gte: monthStart,
        $lt: nextMonth
      },
      type: {
        $in: ["earned", "converted", "expired"]
      }
    }
  },
  {
    $group: {
      _id: {
        userId: "$userId",
        cohortId: "$cohortId"
      },
      pointsEarned: {
        $sum: {
          $cond: [
            { $eq: ["$type", "earned"] },
            "$points",
            0
          ]
        }
      },
      pointsConverted: {
        $sum: {
          $cond: [
            { $eq: ["$type", "converted"] },
            "$points",
            0
          ]
        }
      },
      pointsExpired: {
        $sum: {
          $cond: [
            { $eq: ["$type", "expired"] },
            "$points",
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
      cohortId: "$_id.cohortId",
      pointsEarned: 1,
      pointsConverted: 1,
      pointsExpired: 1
    }
  },
  {
    $sort: {
      cohortId: 1,
      userId: 1
    }
  }
]);
```

The month uses an inclusive start and exclusive end. This avoids problems with milliseconds at the end of a month. The example uses UTC; I would confirm with Finance which timezone defines a reporting month.

## 4. Preventing the same points from being converted twice

I would never calculate the available points in application code and then update them later. The conversion must use a MongoDB transaction: first, atomically decrease the wallet only if `availablePoints >= requestedPoints`; then insert the conversion record and the `converted` points-ledger entry in that same transaction. If the balance check fails, the transaction does not create a conversion. A unique `(userId, idempotencyKey)` index prevents a mobile retry from creating a second conversion. This way, two concurrent requests cannot both spend the same points, and every successful conversion has an auditable record with the exact rate used.
