import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTax, TAX_MODES, TAX_DIRECTIONS, DEFAULT_TAX } from "../src/lib/tax.js";

// Inti: pajak harus bisa diatur bebas (persen / nominal, potong / tambah / info)
// dan hitungannya benar untuk kasus ujung. Nilai persen disimpan sebagai
// basis poin: 11% = 1100, 2,5% = 250.

const t = (over) => ({ ...DEFAULT_TAX, enabled: true, ...over });

test("pajak persen memotong dari uang masuk", () => {
  const r = computeTax(50000, t({ mode: "percent", value: 1100, direction: "deduct" }));
  assert.equal(r.taxAmount, 5500);
  assert.equal(r.netAmount, 44500);
});

test("pajak persen ditambahkan ke uang masuk", () => {
  const r = computeTax(50000, t({ mode: "percent", value: 1100, direction: "add" }));
  assert.equal(r.taxAmount, 5500);
  assert.equal(r.netAmount, 55500);
});

test("pajak mode info tidak mengubah uang masuk", () => {
  const r = computeTax(50000, t({ mode: "percent", value: 1000, direction: "info" }));
  assert.equal(r.taxAmount, 5000);
  assert.equal(r.netAmount, 50000);
});

test("pajak nominal tetap (rupiah) tidak bergantung pada dasar", () => {
  const r = computeTax(10000, t({ mode: "fixed", value: 2500, direction: "deduct" }));
  assert.equal(r.taxAmount, 2500);
  assert.equal(r.netAmount, 7500);
});

test("pajak persen pecahan: 2,5% dari 40.000", () => {
  const r = computeTax(40000, t({ mode: "percent", value: 250, direction: "deduct" }));
  assert.equal(r.taxAmount, 1000);
  assert.equal(r.netAmount, 39000);
});

test("pajak nonaktif = uang masuk utuh", () => {
  const r = computeTax(50000, { ...DEFAULT_TAX, enabled: false, mode: "percent", value: 1100, direction: "deduct" });
  assert.equal(r.taxAmount, 0);
  assert.equal(r.netAmount, 50000);
});

test("potongan tidak boleh bikin uang masuk negatif", () => {
  const r = computeTax(50000, t({ mode: "fixed", value: 60000, direction: "deduct" }));
  assert.equal(r.taxAmount, 60000);
  assert.equal(r.netAmount, 0);
});

test("nominal nol / bukan angka tidak meledak", () => {
  for (const bad of [0, -5, null, undefined, NaN, "abc"]) {
    const r = computeTax(bad, t({ mode: "percent", value: 1100, direction: "deduct" }));
    assert.equal(r.netAmount, 0, `gross=${bad} harus aman`);
    assert.equal(r.taxAmount, 0, `gross=${bad} pajak 0`);
  }
});

test("daftar mode dan arah pajak tetap seperti yang didukung UI", () => {
  assert.deepEqual(TAX_MODES, ["percent", "fixed"]);
  assert.deepEqual(TAX_DIRECTIONS, ["deduct", "add", "info"]);
});
