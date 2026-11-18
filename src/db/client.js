"use strict";

const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/";
const DB_NAME = process.env.DB_NAME || "funngro";

class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

let client = null;
let db = null;
let supportsTransactions = null;
let warnedStandalone = false;

async function connectDb() {
  if (db) return { client, db };

  client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 20000,
  });

  await client.connect();
  db = client.db(DB_NAME);

  // Detect whether we're connected to a replica set / mongos (required for multi-doc ACID transactions).
  const hello = await db.command({ hello: 1 });
  supportsTransactions = Boolean(hello.setName || hello.msg === "isdbgrid");

  return { client, db };
}

function getDb() {
  if (!db) throw new Error("Database not initialized. Call connectDb() first.");
  return db;
}

function getClient() {
  if (!client)
    throw new Error("MongoClient not initialized. Call connectDb() first.");
  return client;
}

function isReplicaSet() {
  return Boolean(supportsTransactions);
}

/**
 * Executes `fn(session)` inside a MongoDB multi-document ACID transaction.
 * Production (MongoDB Atlas) always runs as a replica set, so `session.withTransaction`
 * is always used. For local development against a standalone `mongod`, set
 * ALLOW_STANDALONE_DEV_FALLBACK=true to run without multi-doc transactions (single-doc
 * conditional updates remain atomic, and a loud warning is logged).
 */
async function withTransaction(fn) {
  const mongoClient = getClient();

  if (supportsTransactions) {
    const session = mongoClient.startSession();
    try {
      let result;
      await session.withTransaction(
        async () => {
          result = await fn(session);
        },
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
        },
      );
      return result;
    } finally {
      await session.endSession();
    }
  }

  if (process.env.ALLOW_STANDALONE_DEV_FALLBACK === "true") {
    if (!warnedStandalone) {
      warnedStandalone = true;
      console.warn(
        "[WARN] Standalone MongoDB detected (no replica set). Running without multi-document ACID transactions. " +
          "Single-document atomic guards still apply, but NEVER run this mode in production.",
      );
    }
    return fn(undefined);
  }

  throw new Error(
    "MongoDB replica set is required for multi-document ACID transactions on the money path. " +
      "Either initialize a local single-node replica set or set ALLOW_STANDALONE_DEV_FALLBACK=true for local dev.",
  );
}

async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    supportsTransactions = null;
    warnedStandalone = false;
  }
}

module.exports = {
  MONGODB_URI,
  DB_NAME,
  AppError,
  connectDb,
  getDb,
  getClient,
  isReplicaSet,
  withTransaction,
  closeDb,
};
