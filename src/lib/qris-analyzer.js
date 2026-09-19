// QRIS Analyzer — reads public fields from a static or dynamic QRIS payload
// so the UI can preview the merchant before saving. NO token, NO credential,
// NO provider HTTP. Output is masked for sensitive PAN / additional-data tags.

import { isValidQris, parseQris } from "./qris.js";

const CURRENCY_IDR = "360";
const COUNTRY_ID = "ID";

function maskPan(value) {
  if (typeof value !== "string" || value.length < 8) return null;
  return "…" + value.slice(-8);
}

function getField(tlvs, tag) {
  const found = tlvs.find((t) => t.tag === tag);
  return found ? found.value : null;
}

export function analyzeQris(payload) {
  const result = {
    valid: false,
    type: null, // "static" | "dynamic" | null
    merchantName: null,
    city: null,
    postal: null,
    currency: null,
    country: null,
    hasAmount: false,
    amount: null,
    panMasked: null,
    merchantCategory: null,
    crcValid: false,
    errors: [],
  };

  if (typeof payload !== "string" || payload.length === 0 || payload.length > 4096) {
    result.errors.push("Payload kosong atau melebihi 4096 karakter.");
    return result;
  }
  if (/[^\x20-\x7e]/.test(payload)) {
    result.errors.push("Payload berisi karakter non-ASCII.");
    return result;
  }

  let tlvs;
  try {
    tlvs = parseQris(payload);
  } catch (e) {
    result.errors.push("TLV rusak: " + (e?.message ?? "parse gagal"));
    return result;
  }

  result.crcValid = isValidQris(payload);

  const tag00 = getField(tlvs, "00"); // Payload Format Indicator
  const tag01 = getField(tlvs, "01"); // Point of Initiation
  const tag53 = getField(tlvs, "53"); // Transaction Currency
  const tag58 = getField(tlvs, "58"); // Country Code

  if (tag00 !== "01") result.errors.push("Format bukan QRIS (tag 00 ≠ 01).");
  if (tag53 && tag53 !== CURRENCY_IDR) result.errors.push("Mata uang bukan IDR (tag 53 ≠ 360).");
  if (tag58 && tag58 !== COUNTRY_ID) result.errors.push("Negara bukan ID (tag 58 ≠ ID).");

  if (tag01 === "11") result.type = "static";
  else if (tag01 === "12") result.type = "dynamic";
  else if (tag01 != null) result.errors.push("POI tidak dikenal (tag 01 bukan 11/12).");

  result.merchantName = getField(tlvs, "59");
  result.city = getField(tlvs, "60");
  result.postal = getField(tlvs, "61");
  result.currency = tag53;
  result.country = tag58;
  result.merchantCategory = getField(tlvs, "52");

  const panRaw = getField(tlvs, "26");
  result.panMasked = panRaw ? maskPan(panRaw) : null;

  const tag54 = getField(tlvs, "54");
  if (tag54 && /^\d{1,12}$/.test(tag54)) {
    result.hasAmount = true;
    result.amount = tag54;
  }

  result.valid =
    result.crcValid &&
    tag00 === "01" &&
    result.errors.length === 0 &&
    (result.type === "static" || result.type === "dynamic");

  return result;
}
