import { assert } from './core.js';

/** Nonnegative integer quanta; exact multiplication and registry round-half-even. */
export function mulDiv(a,b,denominator) {
  assert([a,b,denominator].every(Number.isSafeInteger) && a>=0 && b>=0 && denominator>0,'invalid fixed-point operands');
  const numerator=BigInt(a)*BigInt(b), divisor=BigInt(denominator);
  let result=numerator/divisor;
  const remainder=numerator%divisor;
  if(2n*remainder>divisor || (2n*remainder===divisor && result%2n===1n))result++;
  assert(result<=BigInt(Number.MAX_SAFE_INTEGER),'fixed-point overflow');return Number(result);
}
