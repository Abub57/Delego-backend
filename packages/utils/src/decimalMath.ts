// Issue #338 — BigInt-safe decimal string arithmetic for currency/stroop
// amounts. `Number(amountString)` silently truncates precision once the
// value exceeds Number.MAX_SAFE_INTEGER (2^53 - 1), which Stellar i128
// stroop amounts routinely do. These helpers do exact arbitrary-precision
// addition on decimal strings via BigInt, never touching `number`.

/** Splits a decimal string ("-123.4500") into a sign, integer and fraction part. */
function splitDecimal(value: string): { negative: boolean; whole: string; fraction: string } {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount string: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = unsigned.split(".");
  return { negative, whole, fraction };
}

/**
 * Adds two arbitrary-precision decimal strings exactly (no floating point).
 * Returns a canonical decimal string (no unnecessary leading zeros; a
 * fractional part only when non-zero).
 */
export function addDecimalStrings(a: string, b: string): string {
  const left = splitDecimal(a);
  const right = splitDecimal(b);
  const scale = Math.max(left.fraction.length, right.fraction.length);

  const toScaledBigInt = (part: { negative: boolean; whole: string; fraction: string }): bigint => {
    const scaledDigits = part.fraction.padEnd(scale, "0");
    const magnitude = BigInt(part.whole + scaledDigits || "0");
    return part.negative ? -magnitude : magnitude;
  };

  const sumScaled = toScaledBigInt(left) + toScaledBigInt(right);
  return unscaleBigInt(sumScaled, scale);
}

/** Sums a list of decimal (or plain integer) strings exactly. */
export function sumDecimalStrings(values: Iterable<string>): string {
  let total = "0";
  for (const value of values) {
    total = addDecimalStrings(total, value);
  }
  return total;
}

function unscaleBigInt(scaled: bigint, scale: number): string {
  if (scale === 0) return scaled.toString();

  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const digits = abs.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");

  const unsigned = fraction ? `${whole}.${fraction}` : whole;
  return negative && unsigned !== "0" ? `-${unsigned}` : unsigned;
}
