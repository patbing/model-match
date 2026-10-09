export function buildShareText({ dateLabel, bankLabel, pattern, score, modeLabel, url }) {
  return `Model Match ${dateLabel} · ${bankLabel}\n${pattern}\n${score}/600 · ${modeLabel}\n${url}`;
}

export async function shareText(text) {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch (_) { /* ignore */ }
  return 'failed';
}
