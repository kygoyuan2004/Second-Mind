import { jsonrepair } from 'jsonrepair';

// Providers occasionally emit literal quotes inside an otherwise complete JSON
// string. Permit that one syntax correction, without repairing missing facts,
// truncation, delimiters, keys, numbers or any other output characters.
export function parseReviewJson(output) {
  if (output && typeof output === 'object') return output;
  const text = String(output || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidate = start >= 0 && end >= start ? text.slice(start, end + 1) : text;
  try { return JSON.parse(candidate); }
  catch (originalError) {
    if (candidate.length > 128_000) throw originalError;
    let repaired;
    try { repaired = jsonrepair(candidate); } catch { throw originalError; }
    let source = 0;
    let target = 0;
    let escapes = 0;
    while (target < repaired.length) {
      if (repaired[target] === candidate[source]) { target += 1; source += 1; }
      else if (repaired[target] === '\\' && repaired[target + 1] === '"' && candidate[source] === '"') {
        target += 1;
        escapes += 1;
        if (escapes > 512) throw originalError;
      } else throw originalError;
    }
    if (source !== candidate.length || !escapes) throw originalError;
    return JSON.parse(repaired);
  }
}
