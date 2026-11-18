'use strict';

const crypto = require('crypto');

/**
 * Lightweight in-memory payment gateway stub for local development & verification.
 * Models real-world payout gateway behavior (e.g., RazorpayX / Cashfree):
 *  - Deduplicates payouts by `reference` (gateway-side idempotency key)
 *  - Supports simulating terminal rejections (4xx) and ambiguous network timeouts
 */
class MockPaymentGateway {
  constructor() {
    this.payoutsByRef = new Map();
    this.nextMode = 'SUCCESS'; // 'SUCCESS' | 'TERMINAL_FAILURE' | 'TIMEOUT_AFTER_ACCEPT' | 'TIMEOUT_BEFORE_ACCEPT'
  }

  setMode(mode) {
    this.nextMode = mode;
  }

  async createPayout({ reference, beneficiaryId, amountPaise }) {
    if (!reference || !beneficiaryId || !Number.isInteger(amountPaise) || amountPaise <= 0) {
      const err = new Error('Invalid payout payload');
      err.isTerminal = true;
      err.code = 'INVALID_PAYLOAD';
      throw err;
    }

    // Gateway-side idempotency: returning existing payout if reference already accepted
    if (this.payoutsByRef.has(reference)) {
      return this.payoutsByRef.get(reference);
    }

    if (this.nextMode === 'TERMINAL_FAILURE') {
      const err = new Error('Beneficiary bank account rejected by bank');
      err.isTerminal = true;
      err.code = 'INVALID_BANK_ACCOUNT';
      throw err;
    }

    if (this.nextMode === 'TIMEOUT_BEFORE_ACCEPT') {
      const err = new Error('Gateway socket timeout (ETIMEDOUT)');
      err.isTerminal = false;
      err.code = 'ETIMEDOUT';
      throw err;
    }

    const payout = {
      gatewayPayoutId: 'pg_' + crypto.randomBytes(8).toString('hex'),
      reference,
      beneficiaryId,
      amountPaise,
      status: 'PROCESSING',
      createdAt: new Date(),
    };
    this.payoutsByRef.set(reference, payout);

    if (this.nextMode === 'TIMEOUT_AFTER_ACCEPT') {
      // Simulates the nastiest real-world failure: gateway accepted & queued the transfer,
      // but the HTTP response timed out before reaching our server!
      const err = new Error('Gateway response timed out after accept (ETIMEDOUT)');
      err.isTerminal = false;
      err.code = 'ETIMEDOUT';
      throw err;
    }

    return payout;
  }

  async getPayoutByReference(reference) {
    return this.payoutsByRef.get(reference) || null;
  }

  markSettled(reference) {
    const p = this.payoutsByRef.get(reference);
    if (p) p.status = 'COMPLETED';
    return p;
  }

  markFailed(reference) {
    const p = this.payoutsByRef.get(reference);
    if (p) p.status = 'FAILED';
    return p;
  }
}

module.exports = { MockPaymentGateway };
