"use strict";

const express = require("express");
const { connectDb, closeDb, AppError } = require("./db/client");
const { ensureIndexes } = require("./db/indexes");
const {
  createWithdrawRouteHandler,
  getWalletLedgerHandler,
} = require("./part1/withdrawHandler");
const { convertPointsToCash } = require("./part2/rewardPointsService");
const {
  getMonthlyFinanceReport,
  getMonthlyCohortSummary,
} = require("./part2/monthlyFinanceReport");

const PORT = parseInt(process.env.PORT || "3000", 10);

/**
 * Placeholder auth middleware for local testing.
 * In production, replace with verified JWT / session middleware (e.g., Auth0 / custom JWT + RS256).
 * Notice: userId is NEVER read from `req.body`.
 */
function requireAuth(req, res, next) {
  const userId = req.get("X-Auth-User-Id");
  if (!userId) {
    return next(
      new AppError(401, "UNAUTHORIZED", "Missing authentication credentials"),
    );
  }
  req.user = { id: userId };
  return next();
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Part 1: Safe Wallet Withdrawal & Paginated Ledger History
  app.post("/api/wallet/withdraw", requireAuth, createWithdrawRouteHandler());
  app.get("/api/wallet/ledger", requireAuth, getWalletLedgerHandler);

  // Part 2: Atomic Reward Points Conversion
  app.post("/api/rewards/convert", requireAuth, async (req, res, next) => {
    try {
      const result = await convertPointsToCash({
        authenticatedUserId: req.user.id,
        pointsToConvert: req.body && req.body.pointsToConvert,
        idempotencyKey: req.get("Idempotency-Key"),
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return next(err);
    }
  });

  // Part 2: Monthly Finance Report (in production: protect with Finance/Admin RBAC middleware)
  app.get("/api/finance/points-report", async (req, res, next) => {
    try {
      const year = parseInt(req.query.year, 10);
      const month = parseInt(req.query.month, 10);
      const tzOffset = parseInt(req.query.tzOffsetMinutes || "330", 10); // default IST (+05:30)
      if (!year || !month || month < 1 || month > 12) {
        throw new AppError(
          400,
          "INVALID_MONTH",
          "Provide valid ?year=YYYY&month=1..12",
        );
      }

      const [perUser, byCohort] = await Promise.all([
        getMonthlyFinanceReport({
          year,
          month,
          timezoneOffsetMinutes: tzOffset,
        }),
        getMonthlyCohortSummary({
          year,
          month,
          timezoneOffsetMinutes: tzOffset,
        }),
      ]);

      return res.json({ ok: true, year, month, perUser, byCohort });
    } catch (err) {
      return next(err);
    }
  });

  // Centralized error handler (never leaks raw stack traces or sensitive bank details)
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        ok: false,
        code: err.code,
        error: err.message,
      });
    }

    console.error(
      JSON.stringify({
        level: "error",
        event: "unhandled_api_error",
        message: err && err.message,
      }),
    );
    return res.status(500).json({
      ok: false,
      code: "INTERNAL_ERROR",
      error: "Internal server error",
    });
  });

  return app;
}

if (require.main === module) {
  (async () => {
    const { db } = await connectDb();
    await ensureIndexes(db);
    const app = createApp();
    const server = app.listen(PORT, () => {
      console.log(
        `Funngro assessment server listening on http://localhost:${PORT} (db: ${db.databaseName})`,
      );
    });

    process.on("SIGINT", async () => {
      server.close();
      await closeDb();
      process.exit(0);
    });
  })().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

module.exports = { createApp };
