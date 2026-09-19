import assert from "node:assert/strict";
import test from "node:test";
import { crc16ccitt, parseQris } from "../src/lib/qris.js";
import { analyzeQris } from "../src/lib/qris-analyzer.js";

const tlv = (tag, value) => tag + String(value.length).padStart(2, "0") + value;
const signed = (body) => body + "6304" + crc16ccitt(body + "6304");
const fields = [
  ["00", "01"],
  ["01", "11"],
  ["26", "9360091400000000001234"],
  ["51", "IDR"],
  ["53", "360"],
  ["58", "ID"],
  ["59", "TOKO CONTOH"],
  ["60", "JAKARTA"],
  ["61", "10110"],
];
const buildPayload = (entries) => signed(entries.map(([tag, value]) => tlv(tag, value)).join(""));

test("flags static QRIS with masked PAN and merchant fields", () => {
  const payload = buildPayload(fields);
  const info = analyzeQris(payload);
  assert.equal(info.valid, true);
  assert.equal(info.type, "static");
  assert.equal(info.merchantName, "TOKO CONTOH");
  assert.equal(info.city, "JAKARTA");
  assert.equal(info.postal, "10110");
  assert.equal(info.currency, "360");
  assert.equal(info.country, "ID");
  assert.equal(info.panMasked, "…00001234");
  assert.equal(info.hasAmount, false);
  assert.equal(info.crcValid, true);
  assert.equal(info.errors.length, 0);
});

test("flags dynamic QRIS when tag 01=12 and amount present", () => {
  const dynamicFields = [
    ["00", "01"],
    ["01", "12"],
    ["53", "360"],
    ["54", "25000"],
    ["58", "ID"],
    ["59", "TOKO CONTOH"],
    ["60", "JAKARTA"],
  ];
  const payload = buildPayload(dynamicFields);
  const info = analyzeQris(payload);
  assert.equal(info.valid, true);
  assert.equal(info.type, "dynamic");
  assert.equal(info.hasAmount, true);
  assert.equal(info.amount, "25000");
});

test("rejects invalid input shape (empty, oversized, non-ASCII)", () => {
  for (const bad of ["", "a".repeat(4097), "5901\u0000"]) {
    const info = analyzeQris(bad);
    assert.equal(info.valid, false);
    assert.ok(info.errors.length >= 1);
  }
});

test("rejects bad CRC", () => {
  const payload = buildPayload(fields);
  const broken = payload.slice(0, -4) + "0000";
  const info = analyzeQris(broken);
  assert.equal(info.crcValid, false);
  assert.equal(info.valid, false);
});

test("rejects non-QRIS payload format (tag 00 missing or wrong)", () => {
  const wrong = signed(fields.filter(([t]) => t !== "00").map(([t, v]) => tlv(t, v)).join(""));
  const info = analyzeQris(wrong);
  assert.equal(info.valid, false);
  assert.ok(info.errors.some((e) => /Format QRIS|Format bukan/.test(e)));
});

test("rejects non-IDR / non-ID payloads", () => {
  const usd = signed(
    fields.map(([t, v]) => (t === "53" ? tlv(t, "840") : t == "58" ? tlv(t, "US") : tlv(t, v))).join("")
  );
  const info = analyzeQris(usd);
  assert.equal(info.valid, false);
});

test("masks PAN when short enough, returns null when no PAN tag", () => {
  const noPan = buildPayload(fields.filter(([t]) => t !== "26"));
  const info = analyzeQris(noPan);
  assert.equal(info.panMasked, null);
});

test("never echoes full PAN even with very long merchant PAN", () => {
  const longPan = "93600914" + "00000000000000000000";
  const fieldsLong = [["00", "01"], ["01", "11"], ["26", longPan], ["53", "360"], ["58", "ID"], ["59", "TOKO"]];
  const payload = buildPayload(fieldsLong);
  const info = analyzeQris(payload);
  assert.ok(info.panMasked.startsWith("…"));
  assert.ok(!info.panMasked.includes(longPan));
});
