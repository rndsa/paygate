import QRCode from "qrcode";

/**
 * Format-only QRIS helpers; CRC does not authenticate a merchant or prove payment.
 * Modification is not legal/acquirer approval or a guarantee of acceptance.
 * https://www.emvco.com/emv-technologies/qr-codes/
 * https://www.bi.go.id/en/fungsi-utama/sistem-pembayaran/ritel/kanal-layanan/qris/default.aspx
 * ponytail: printable-ASCII, top-level LAB subset; use approved acquirer APIs for production.
 */

// CRC16-CCITT-FALSE: init 0xFFFF, polynomial 0x1021, no reflection/final XOR.
export function crc16ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Parse complete top-level TLVs {tag, length, value}; throw on malformed input.
 * Values (including nested templates) stay opaque; isValidQris checks CRC separately.
 */
export function parseQris(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 4096 || /[^\x20-\x7e]/.test(str)) {
    throw new Error("QRIS invalid: printable ASCII, max 4096 characters");
  }
  const tlv = [];
  const seen = new Set();
  let i = 0;
  while (i < str.length) {
    const header = str.slice(i, i + 4);
    if (!/^[0-9]{4}$/.test(header)) throw new Error("QRIS invalid: header TLV");
    const tag = header.slice(0, 2);
    if (seen.has(tag)) throw new Error("QRIS invalid: duplicate tag " + tag);
    seen.add(tag);
    const len = Number(header.slice(2));
    if (len === 0 || i + 4 + len > str.length) throw new Error("QRIS invalid: length TLV");
    const value = str.slice(i + 4, i + 4 + len);
    tlv.push({ tag, length: len, value });
    i += 4 + len;
  }
  return tlv;
}

/** TLV/CRC check only, not full QRIS scheme or merchant-account validation. */
export function isValidQris(str) {
  // CRC must be the final TLV with exactly four checksum characters.
  let tlv;
  try { tlv = parseQris(str); } catch { return false; }
  if (tlv.length < 4) return false;
  const last = tlv[tlv.length - 1];
  if (last.tag !== "63" || last.length !== 4) return false;
  // Validasi CRC
  const body = str.slice(0, -4);
  const expected = crc16ccitt(body);
  return expected === last.value.toUpperCase();
}

/** Baca nilai tag tertentu dari QRIS (misal 59 = merchant name). */
export function getQrisField(str, tag) {
  const tlv = parseQris(str);
  const found = tlv.find((t) => t.tag === tag);
  return found ? found.value : null;
}

/**
 * LAB conversion: static 01=11 to 01=12, exactly one whole-IDR amount (54).
 * Reject fee/tip fields; preserve all other values and regenerate the checksum.
 */
export function staticToDynamicQris(staticQris, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Amount harus angka bulat positif yang aman (IDR)");
  }
  if (!isValidQris(staticQris)) throw new Error("QRIS invalid: TLV atau CRC");
  const fields = new Map(parseQris(staticQris).map(({ tag, value }) => [tag, value]));
  if (fields.get("00") !== "01" || fields.get("01") !== "11" || fields.get("53") !== "360" || fields.get("58") !== "ID") {
    throw new Error("QRIS harus statis (01=11), format 00=01, IDR (53=360), negara ID (58=ID)");
  }
  if (["55", "56", "57"].some(tag => fields.has(tag))) {
    throw new Error("QRIS fee/tip tidak didukung untuk nominal tepat LAB");
  }

  fields.delete("63");
  fields.set("01", "12");
  fields.set("54", String(amount));
  // Canonical numeric order, except CRC must always be last (even after tags >63).
  const payload = [...fields].sort(([a], [b]) => Number(a) - Number(b))
    .map(([tag, value]) => tag + String(value.length).padStart(2, "0") + value)
    .join("") + "6304";
  if (payload.length + 4 > 4096) throw new Error("QRIS invalid: max 4096 characters");
  return payload + crc16ccitt(payload);
}

export async function qrisImageDataUrl(payload) {
  return QRCode.toDataURL(payload, {
    scale: 6,
    errorCorrectionLevel: "M",
    margin: 1,
  });
}
