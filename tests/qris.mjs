import assert from 'node:assert/strict';
import test from 'node:test';
import { crc16ccitt, parseQris, isValidQris, getQrisField, staticToDynamicQris, qrisImageDataUrl } from '../src/lib/qris.js';

// Synthetic, non-payable fixtures: no merchant account (26) or acquirer approval.
const fields = [
  ['00', '01'], ['01', '11'], ['53', '360'], ['58', 'ID'],
  ['59', 'PAYGATE LAB'], ['60', 'JAKARTA'],
];
const tlv = (tag, value) => tag + String(value.length).padStart(2, '0') + value;
const signed = body => body + '6304' + crc16ccitt(body + '6304');
const fixture = (entries = fields) => signed(entries.map(([tag, value]) => tlv(tag, value)).join(''));

test('CRC16-CCITT-FALSE matches independent known vector', () => {
  assert.equal(crc16ccitt('123456789'), '29B1');
});

test('parser returns complete TLV values and field lookup stays compatible', () => {
  const payload = fixture();
  assert.deepEqual(parseQris(payload).slice(0, -1), fields.map(([tag, value]) => ({ tag, length: value.length, value })));
  assert.equal(getQrisField(payload, '59'), 'PAYGATE LAB');
  assert.equal(getQrisField(payload, '26'), null);
  assert.equal(isValidQris(payload), true);
});

test('parser rejects invalid input types, controls, non-ASCII and duplicate tags', () => {
  for (const payload of [undefined, null, 123, {}, [], '', '5901\u0000', '5901\n', '5901\t', '5901\u007f', '5901é', '5902😀', '000201000201']) {
    assert.throws(() => parseQris(payload), Error);
    assert.equal(isValidQris(payload), false);
  }
  const duplicate = fixture([...fields, ['59', 'OTHER LAB']]);
  assert.throws(() => parseQris(duplicate), Error);
  assert.equal(isValidQris(duplicate), false);
  assert.throws(() => getQrisField(duplicate, '59'), Error);
});

test('parser enforces 4096-character ceiling inclusively', () => {
  const prefix = Array.from({ length: 39 }, (_, i) => tlv(String(i + 2).padStart(2, '0'), 'A'.repeat(99))).join('');
  const boundary = prefix + tlv('41', 'A'.repeat(75));
  assert.equal(boundary.length, 4096);
  assert.equal(parseQris(boundary).length, 40);
  assert.throws(() => parseQris(prefix + tlv('41', 'A'.repeat(76))), Error);
});

test('validator returns false rather than throwing on malformed signed TLVs', () => {
  for (const body of ['590xA', '5905AB', 'XX01A', '5900']) {
    assert.equal(isValidQris(signed(fields.map(([tag, value]) => tlv(tag, value)).join('') + body)), false);
  }
});

test('validator allows spaces and punctuation in merchant values', () => {
  const merchant = ' LAB & Co., \'TEST\' (#1)! ';
  const payload = fixture(fields.map(([tag, value]) => [tag, tag === '59' ? merchant : value]));
  assert.equal(isValidQris(payload), true);
  assert.equal(getQrisField(payload, '59'), merchant);
});

test('validator checks CRC bytes, exact length and final position', () => {
  const payload = fixture();
  const body = payload.slice(0, -8);
  assert.equal(isValidQris(payload.slice(0, -4) + payload.slice(-4).toLowerCase()), true);
  for (const invalid of [
    body, body + '6304', body + '6303ABC', body + '6305ABCDE', body + '6304ZZZZ',
    payload.slice(0, -1) + (payload.endsWith('0') ? '1' : '0'),
    payload.replace('PAYGATE', 'PAYGATX'),
    payload + 'X', payload + '   ', payload + '\n', payload + tlv('64', 'LAB'),
    signed(body + '6304ABCD'),
  ]) assert.equal(isValidQris(invalid), false, invalid);
  for (let i = 0; i < payload.length; i++) assert.equal(isValidQris(payload.slice(0, i)), false, `prefix ${i}`);
});

test('dynamic amount must be a positive numeric safe integer, never rounded or coerced', () => {
  const payload = fixture();
  for (const amount of [0, -0, -1, 0.5, 1.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '1', '1.0', '1e3', '0x10', '', ' 1 ', true, false, null, undefined, 1n, [1], {}, new Number(1)]) {
    assert.throws(() => staticToDynamicQris(payload, amount), Error, String(amount));
  }
  for (const amount of [1, 25001, Number.MAX_SAFE_INTEGER]) {
    const dynamic = staticToDynamicQris(payload, amount);
    assert.equal(getQrisField(dynamic, '54'), String(amount));
    assert.equal(getQrisField(dynamic, '01'), '12');
    assert.equal(isValidQris(dynamic), true);
  }
});

test('conversion rejects malformed payloads and invalid CRC before modifying bytes', () => {
  const payload = fixture();
  for (const invalid of [undefined, null, 123, '', payload.slice(0, -8), payload.slice(0, -1),
    payload.slice(0, -4) + 'FFFF', payload + tlv('64', 'LAB'),
    signed(payload.slice(0, -8) + '590xA'), fixture([...fields, ['53', '360']])]) {
    assert.throws(() => staticToDynamicQris(invalid, 123), Error);
  }
});

test('conversion requires actual static IDR/ID format fields, not matching substrings', () => {
  for (const [tag, invalidValues] of [['00', ['02', '1']], ['01', ['12', '10', '111']], ['53', ['840', '0360']], ['58', ['SG', 'id']]]) {
    for (const value of [null, ...invalidValues]) {
      const entries = fields.filter(([id]) => id !== tag);
      if (value !== null) entries.push([tag, value]);
      // Embedded markers must never satisfy missing/incorrect top-level fields.
      entries.push(['62', '00020101021153033605802ID']);
      const payload = fixture(entries);
      assert.equal(isValidQris(payload), true);
      assert.throws(() => staticToDynamicQris(payload, 100), Error, `${tag}=${value}`);
    }
  }
});

test('conversion rejects fee/tip tags for exact-amount LAB mode', () => {
  for (const [tag, value] of [['55', '01'], ['55', '02'], ['55', '03'], ['56', '0'], ['56', '123'], ['57', '0'], ['57', '1.5']]) {
    const payload = fixture([...fields, [tag, value]]);
    assert.equal(isValidQris(payload), true);
    assert.throws(() => staticToDynamicQris(payload, 100), Error, tag);
  }
});

test('conversion emits canonical tags and exactly one amount without changing embedded markers', () => {
  for (const oldAmount of [null, '9', '00123']) {
    const entries = [
      ['00', '01'], ['62', '00020101021153033605802ID6304'], ['80', 'NON-PAYABLE LAB'],
      ...fields.filter(([tag]) => tag !== '00').reverse(),
    ];
    if (oldAmount !== null) entries.splice(1, 0, ['54', oldAmount]);
    const payload = fixture(entries);
    const dynamic = staticToDynamicQris(payload, 25001);
    assert.equal(isValidQris(dynamic), true);
    const result = parseQris(dynamic);
    const expected = entries.filter(([tag]) => tag !== '54').map(([tag, value]) => [tag, tag === '01' ? '12' : value]);
    expected.push(['54', '25001']);
    expected.sort(([a], [b]) => Number(a) - Number(b));
    assert.deepEqual(result.slice(0, -1), expected.map(([tag, value]) => ({ tag, length: value.length, value })));
    assert.equal(result.filter(({ tag }) => tag === '54').length, 1);
    assert.equal(result.at(-1).tag, '63');
    assert.equal(dynamic, fixture(expected));
    assert.equal(staticToDynamicQris(payload, 25001), dynamic);
    assert.throws(() => staticToDynamicQris(dynamic, 25001), Error);
  }
});

test('conversion enforces output size after amount insertion', () => {
  const filler = Array.from({ length: 40 }, (_, i) => String(i + 2).padStart(2, '0'))
    .filter(tag => tag !== '26').map(tag => [tag, 'A'.repeat(99)]);
  const base = [...fields, ...filler];
  const sizedFixture = size => fixture([...base, ['42', 'A'.repeat(size - fixture(base).length - 4)]]);
  const boundary = staticToDynamicQris(sizedFixture(4091), 1);
  assert.equal(boundary.length, 4096);
  assert.equal(isValidQris(boundary), true);
  for (const size of [4092, 4096]) {
    const payload = sizedFixture(size);
    assert.equal(payload.length, size);
    assert.equal(isValidQris(payload), true);
    assert.throws(() => staticToDynamicQris(payload, 1), Error);
  }
});

test('image helper still returns real PNG data URL for non-payable fixture', async () => {
  const url = await qrisImageDataUrl(fixture());
  assert.match(url, /^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(url.split(',')[1], 'base64').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('parser rejects incomplete, nonnumeric and zero-length TLVs', () => {
  for (const payload of ['0', '000', '0002011', '5905AB', '5X01A', '591xA', '59+1A', '59 1A', '5900']) {
    assert.throws(() => parseQris(payload), Error, payload);
    assert.equal(isValidQris(payload), false, payload);
  }
});
