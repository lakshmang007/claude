function isHigh(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Replaces a Y.Text's content with `next`, touching only the part that differs so
 * collaborators' cursors outside it stay put. Call inside a transaction.
 * @param {{ toString(): string, delete(index: number, length: number): void, insert(index: number, text: string): void }} ytext
 * @param {string} next
 * @returns {boolean} whether anything changed
 */
export function replaceText(ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return false;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  // Never split a surrogate pair.
  if (start > 0 && isHigh(prev.charCodeAt(start - 1))) start--;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  if (endPrev < prev.length && endPrev > start && isHigh(prev.charCodeAt(endPrev - 1))) {
    endPrev++;
    endNext++;
  }
  if (endPrev > start) ytext.delete(start, endPrev - start);
  if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  return true;
}
