// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeToScVal, scValToNative, scvU32, scvVoid } from "@stellar/stellar-sdk";
import { FatalError } from "../src/relayer.js";
import { SorobanDestinationDelivery } from "../src/soroban-delivery.js";

const SIGNER_SECRET = "SATIFRDTRKIU6OIU3FURVUO2NIVO5KVH6GQIAGBFPMV4UE4WOXYK5PBW";
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const INTENT_HASH = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeDelivery(): SorobanDestinationDelivery {
  return new SorobanDestinationDelivery({
    rpcUrl: "https://soroban.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    settlementContractId: CONTRACT_ID,
    signerSecret: SIGNER_SECRET,
  });
}

test("Soroban delivery encodes intent hashes as 32 raw bytes", () => {
  const delivery = makeDelivery();
  const scVal = (delivery as unknown as { intentHashScVal(hash: string): unknown })
    .intentHashScVal(INTENT_HASH);
  const native = scValToNative(scVal as Parameters<typeof scValToNative>[0]);

  assert.deepEqual(Buffer.from(native as Uint8Array), Buffer.from(INTENT_HASH.slice(2), "hex"));
});

test("Soroban delivery rejects invalid intent hash lengths", () => {
  const delivery = makeDelivery();
  assert.throws(
    () => (delivery as unknown as { intentHashScVal(hash: string): unknown })
      .intentHashScVal("0x1234"),
    FatalError,
  );
});

test("Soroban delivery decodes numeric IntentStatus discriminants", () => {
  const delivery = makeDelivery();
  const decode = (delivery as unknown as { decodeStatus(retval: unknown): unknown }).decodeStatus;

  assert.equal(decode.call(delivery, scvU32(0)), "Locked");
  assert.equal(decode.call(delivery, scvU32(1)), "Filled");
  assert.equal(decode.call(delivery, scvU32(2)), "ConfirmationSent");
  assert.equal(decode.call(delivery, scvU32(3)), "Cancelled");
  assert.equal(decode.call(delivery, scvVoid()), null);
  assert.equal(decode.call(delivery, nativeToScVal(undefined)), null);
});

test("Soroban delivery treats Filled and ConfirmationSent as delivered", () => {
  const delivery = makeDelivery();
  const isDelivered = (delivery as unknown as { isDeliveredStatus(status: unknown): boolean })
    .isDeliveredStatus;

  assert.equal(isDelivered.call(delivery, "Filled"), true);
  assert.equal(isDelivered.call(delivery, "ConfirmationSent"), true);
  assert.equal(isDelivered.call(delivery, "Locked"), false);
  assert.equal(isDelivered.call(delivery, "Cancelled"), false);
  assert.equal(isDelivered.call(delivery, null), false);
});

test("Soroban delivery fails fast when sendTransaction returns ERROR", async () => {
  const delivery = makeDelivery();
  const errorXdr = "AAAAAAABBBBBCCCCCDDDDD";
  const rpc = {
    sendTransaction: async () => ({
      status: "ERROR",
      hash: "deadbeef",
      errorResult: { toXDR: () => errorXdr },
    }),
    getTransaction: async () => {
      throw new Error("getTransaction must not be called after ERROR");
    },
  };
  (delivery as unknown as { rpc: unknown }).rpc = rpc;

  await assert.rejects(
    () => (delivery as unknown as { submitAndWait(tx: unknown): Promise<unknown> })
      .submitAndWait({}),
    (error: unknown) => error instanceof Error && error.message.includes(errorXdr),
  );
});

test("Soroban delivery restores archived entries before invoking", async () => {
  const delivery = makeDelivery();
  const calls: string[] = [];
  const restorePreamble = {
    minResourceFee: "100",
    transactionData: { build: () => ({}) },
  };
  const rpc = {
    simulateTransaction: async () => {
      calls.push("simulate");
      if (calls.filter((c) => c === "simulate").length === 1) {
        return { restorePreamble, result: { retval: scvVoid() } };
      }
      return { result: { retval: scvVoid() } };
    },
    prepareTransaction: async (tx: unknown) => tx,
    sendTransaction: async () => {
      calls.push("send");
      return { status: "PENDING", hash: "abc" };
    },
    getTransaction: async () => ({ status: "SUCCESS", ledger: 1 }),
  };
  (delivery as unknown as { rpc: unknown }).rpc = rpc;
  (delivery as unknown as { restoreFootprint(preamble: unknown): Promise<void> })
    .restoreFootprint = async () => {
      calls.push("restore");
    };

  await (delivery as unknown as { simulateAndSubmit(tx: unknown): Promise<unknown> })
    .simulateAndSubmit({});

  assert.deepEqual(calls, ["simulate", "restore", "simulate", "send"]);
});

test("Soroban delivery preserves FatalError", async () => {
  const delivery = makeDelivery();
  const fatal = new FatalError("permanent delivery failure");
  (delivery as unknown as { isEntryArchived(): Promise<boolean> }).isEntryArchived = async () => {
    throw fatal;
  };

  await assert.rejects(() => delivery.deliver({} as never), (error) => error === fatal);
});

test("Soroban delivery preserves the cause of ordinary errors", async () => {
  const delivery = makeDelivery();
  const original = new Error("temporary RPC failure");
  (delivery as unknown as { isEntryArchived(): Promise<boolean> }).isEntryArchived = async () => {
    throw original;
  };

  await assert.rejects(
    () => delivery.deliver({} as never),
    (error: unknown) => error instanceof Error && error.cause === original,
  );
});
