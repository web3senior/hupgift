/*
 * Minimal ABI codec shared by the claim frame and the admin page.
 *
 * A Hup mini app ships no dependencies, so the handful of types HupGift actually uses are encoded
 * and decoded here by hand: uint256/uint64/address in, string and address[] both ways. Keeping it
 * in one file is the point — two copies of this would drift and only one of them would be tested.
 */

// Same closure-and-export pattern as config.js, for the same extension-collision reason.
(() => {


// --- Words ---

/** Left-pads a bigint, number, address or hex string into one 32-byte word (no 0x). */
function pad32(value) {
  const hex = typeof value === 'bigint' || typeof value === 'number' ? value.toString(16) : String(value).replace(/^0x/, '').toLowerCase()
  return hex.padStart(64, '0')
}

const wordAt = (body, index) => body.slice(index * 64, index * 64 + 64)
const toBigInt = (word) => BigInt(`0x${word}`)
const toBool = (word) => toBigInt(word) === 1n
const toAddress = (word) => `0x${word.slice(24)}`

// --- Decoding ---

/** Reads a dynamic string sitting at byteOffset from the start of `body`. */
function decodeString(body, byteOffset) {
  const at = Number(byteOffset) * 2
  const length = Number(toBigInt(body.slice(at, at + 64)))
  if (!length) return ''

  const hex = body.slice(at + 64, at + 64 + length * 2)
  return new TextDecoder().decode(Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16))))
}

/** Reads an address[] return value (one dynamic array, alone). */
function decodeAddressArray(result) {
  const raw = String(result).replace(/^0x/, '')
  if (raw.length < 64) return []

  const body = raw.slice(Number(toBigInt(wordAt(raw, 0))) * 2)
  const length = Number(toBigInt(wordAt(body, 0)))

  return Array.from({ length }, (_, i) => toAddress(wordAt(body, i + 1)))
}

/** Positions `body` at the start of a returned dynamic struct. */
function structBody(result) {
  const raw = String(result).replace(/^0x/, '')
  if (raw.length < 64) return null

  return raw.slice(Number(toBigInt(wordAt(raw, 0))) * 2)
}

// --- Encoding ---

function encodeString(value) {
  const bytes = new TextEncoder().encode(value ?? '')
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  // A zero-length string is just its length word — no data word follows
  return pad32(BigInt(bytes.length)) + hex.padEnd(Math.ceil(bytes.length / 32) * 64, '0')
}

/**
 * Encodes call arguments head-first, dynamic values appended in a tail the heads point at.
 * Supported types: uint256, uint64, address, string, address[].
 */
function encodeParams(types, values) {
  const head = []
  const tail = []
  let tailOffset = types.length * 32

  types.forEach((type, index) => {
    const value = values[index]

    if (type === 'string' || type === 'address[]') {
      head.push(pad32(BigInt(tailOffset)))

      const chunk = type === 'string' ? encodeString(value) : pad32(BigInt(value.length)) + value.map((entry) => pad32(entry)).join('')

      tail.push(chunk)
      tailOffset += chunk.length / 2
      return
    }

    head.push(pad32(value))
  })

  return head.join('') + tail.join('')
}

const encodeCall = (selector, types = [], values = []) => selector + encodeParams(types, values)

/** Native coin amount ("10", "0.5") to a wei bigint, without floating point. */
function parseAmount(input) {
  const text = String(input ?? '').trim()
  if (!text || !/^\d*\.?\d*$/.test(text)) return null

  const [whole = '0', fraction = ''] = text.split('.')
  if (fraction.length > 18) return null

  return BigInt(whole || '0') * 10n ** 18n + BigInt((fraction || '0').padEnd(18, '0'))
}

/** wei -> a human amount, grouped, at most 6 decimals and never trailing zeros. */
function formatAmount(wei) {
  const digits = wei.toString().padStart(19, '0')
  const whole = new Intl.NumberFormat().format(BigInt(digits.slice(0, -18)))
  const fraction = digits.slice(-18).slice(0, 6).replace(/0+$/, '')

  return fraction ? `${whole}.${fraction}` : whole
}

  Object.assign(globalThis, {
    pad32,
    wordAt,
    toBigInt,
    toBool,
    toAddress,
    decodeString,
    decodeAddressArray,
    structBody,
    encodeParams,
    encodeCall,
    parseAmount,
    formatAmount,
  });
})();
