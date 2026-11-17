// Assessment example. See README.md for required models and assumptions.

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
