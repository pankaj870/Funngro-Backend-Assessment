"use strict";

const { getDb } = require("../db/client");

/**
 * Computes [monthStart, monthEnd) boundaries for a given year & 1-based month.
 * Defaults to UTC (`timezoneOffsetMinutes = 0`); pass `330` for IST (UTC+05:30).
 */
function getMonthBoundaries(year, month, timezoneOffsetMinutes = 0) {
  const offsetMs = timezoneOffsetMinutes * 60 * 1000;
  const startUtcMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - offsetMs;
  const endUtcMs = Date.UTC(year, month, 1, 0, 0, 0, 0) - offsetMs;
  return {
    monthStart: new Date(startUtcMs),
    monthEnd: new Date(endUtcMs),
  };
}

/**
 * Monthly Finance Report (Per User, tagged with User Cohort):
 * Returns pointsEarned, pointsConverted, pointsExpired, and netChange for every active user
 * in the target month.
 *
 * Served by covered index: `{ createdAt: 1, userCohort: 1, userId: 1, type: 1, points: 1 }`
 * Always run with `allowDiskUse: true` and `secondaryPreferred` in production so month-end
 * finance queries never contend with live wallet payouts.
 */
async function getMonthlyFinanceReport({
  year,
  month,
  timezoneOffsetMinutes = 0,
}) {
  const { monthStart, monthEnd } = getMonthBoundaries(
    year,
    month,
    timezoneOffsetMinutes,
  );
  const db = getDb();

  const pipeline = [
    {
      $match: {
        createdAt: { $gte: monthStart, $lt: monthEnd },
        type: { $in: ["EARN", "CONVERT", "EXPIRE"] },
      },
    },
    {
      // Project only indexed fields so MongoDB can satisfy the query via a covered IXSCAN
      $project: {
        _id: 0,
        userId: 1,
        userCohort: 1,
        type: 1,
        points: 1,
      },
    },
    {
      $group: {
        _id: {
          userId: "$userId",
          userCohort: "$userCohort",
        },
        pointsEarned: {
          $sum: { $cond: [{ $eq: ["$type", "EARN"] }, "$points", 0] },
        },
        pointsConverted: {
          $sum: {
            $cond: [{ $eq: ["$type", "CONVERT"] }, { $abs: "$points" }, 0],
          },
        },
        pointsExpired: {
          $sum: {
            $cond: [{ $eq: ["$type", "EXPIRE"] }, { $abs: "$points" }, 0],
          },
        },
      },
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
            { $add: ["$pointsConverted", "$pointsExpired"] },
          ],
        },
      },
    },
    {
      $sort: { userCohort: 1, userId: 1 },
    },
  ];

  return db
    .collection("point_ledger")
    .aggregate(pipeline, { allowDiskUse: true })
    .toArray();
}

/**
 * Optional cohort-level rollup for finance dashboards (points earned/converted/expired per cohort).
 */
async function getMonthlyCohortSummary({
  year,
  month,
  timezoneOffsetMinutes = 0,
}) {
  const { monthStart, monthEnd } = getMonthBoundaries(
    year,
    month,
    timezoneOffsetMinutes,
  );
  const db = getDb();

  const pipeline = [
    {
      $match: {
        createdAt: { $gte: monthStart, $lt: monthEnd },
        type: { $in: ["EARN", "CONVERT", "EXPIRE"] },
      },
    },
    {
      $project: { _id: 0, userCohort: 1, userId: 1, type: 1, points: 1 },
    },
    {
      $group: {
        _id: "$userCohort",
        activeUsers: { $addToSet: "$userId" },
        pointsEarned: {
          $sum: { $cond: [{ $eq: ["$type", "EARN"] }, "$points", 0] },
        },
        pointsConverted: {
          $sum: {
            $cond: [{ $eq: ["$type", "CONVERT"] }, { $abs: "$points" }, 0],
          },
        },
        pointsExpired: {
          $sum: {
            $cond: [{ $eq: ["$type", "EXPIRE"] }, { $abs: "$points" }, 0],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        userCohort: "$_id",
        activeUserCount: { $size: "$activeUsers" },
        pointsEarned: 1,
        pointsConverted: 1,
        pointsExpired: 1,
        netChange: {
          $subtract: [
            "$pointsEarned",
            { $add: ["$pointsConverted", "$pointsExpired"] },
          ],
        },
      },
    },
    {
      $sort: { userCohort: 1 },
    },
  ];

  return db
    .collection("point_ledger")
    .aggregate(pipeline, { allowDiskUse: true })
    .toArray();
}

module.exports = {
  getMonthBoundaries,
  getMonthlyFinanceReport,
  getMonthlyCohortSummary,
};
