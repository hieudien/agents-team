const USAGE_LIMIT = /usage_limit_reached|hit your (?:\w+ )?limit|out of (?:extra )?usage|usage limit|weekly limit|5-hour limit|session limit|rate_limit_error.*rejected/i;
const AUTH = /not logged in|please run \/login|invalid api key|authentication_error|oauth token|401 unauthorized/i;
const TRANSIENT = /\b(?:http|status|error|code)\W{0,3}(?:429|50[0-4]|52\d)\b|\b(?:429|529)\s+(?:too many|overloaded)|overloaded|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|request timed out|timed out|temporarily unavailable|network error|fetch failed/i;

function classify(text) {
  const t = String(text || '');
  if (USAGE_LIMIT.test(t)) return 'usage_limit';
  if (AUTH.test(t)) return 'auth';
  if (TRANSIENT.test(t)) return 'transient';
  return 'other';
}

module.exports = { classify };
