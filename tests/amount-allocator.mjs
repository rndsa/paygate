import assert from "node:assert/strict";
import test from "node:test";
import { allocateUniqueAmount } from "../src/lib/amount-allocator.js";

test("allocates smallest free offset, uniqueness on final amount", () => {
  const taken = new Set();
  const r = allocateUniqueAmount(25000, taken);
  assert.equal(r.offset, 1);
  assert.equal(r.uniqueAmount, 25001);
});

test("collides on baseAmount+offset, not offset alone (3500+1 vs 3499+2 both = 3501)", () => {
  const taken = new Set([3501]);
  const r = allocateUniqueAmount(3500, taken);
  assert.equal(r.offset, 2);
  assert.equal(r.uniqueAmount, 3502);
});

test("respects maxOffset option", () => {
  const taken = new Set([25001, 25002]);
  const r = allocateUniqueAmount(25000, taken, { maxOffset: 3 });
  assert.equal(r.offset, 3);
  assert.equal(r.uniqueAmount, 25003);
});

test("caps maxOffset at ceiling 999", () => {
  const taken = new Set([25001, 25003]);
  // maxOffset 5000 should be capped to 999 → offset 2 is free
  const r = allocateUniqueAmount(25000, taken, { maxOffset: 5000 });
  assert.equal(r.offset, 2);
  assert.equal(r.uniqueAmount, 25002);
});

test("throws AMOUNT_POOL_EXHAUSTED when all offsets claimed", () => {
  const taken = new Set();
  for (let i = 1; i <= 999; i++) taken.add(25000 + i);
  assert.throws(
    () => allocateUniqueAmount(25000, taken),
    (e) => e.code === "AMOUNT_POOL_EXHAUSTED"
  );
});

test("rejects non-integer baseAmount", () => {
  assert.throws(() => allocateUniqueAmount(1.5, new Set()), (e) => e.code === "INVALID_BASE");
  assert.throws(() => allocateUniqueAmount(0, new Set()), (e) => e.code === "INVALID_BASE");
  assert.throws(() => allocateUniqueAmount(-5, new Set()), (e) => e.code === "INVALID_BASE");
});

test("rejects non-Set taken", () => {
  assert.throws(() => allocateUniqueAmount(100, [101]), (e) => e.code === "INVALID_TAKEN");
  assert.throws(() => allocateUniqueAmount(100, "100"), (e) => e.code === "INVALID_TAKEN");
});

test("skips non-contiguous taken set and finds next free slot", () => {
  const taken = new Set([25002, 25003, 25004]);
  const r = allocateUniqueAmount(25000, taken);
  assert.equal(r.offset, 1);
  assert.equal(r.uniqueAmount, 25001);
});
