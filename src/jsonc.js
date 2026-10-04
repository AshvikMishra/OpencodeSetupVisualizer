/**
 * Minimal, string-aware JSONC stripper.
 *
 * Removes `//` and comments while preserving quoted strings (including escaped
 * quotes), then removes trailing commas before a closing brace/bracket.
 *
 * This is a stripper, not a parser: the result is fed to JSON.parse, so if the
 * input is genuinely malformed JSON.parse will throw and the caller reports it.
 */
export function stripJsonComments(input) {
  // A leading BOM makes JSON.parse throw, which would silently skip structural
  // redaction for the whole body, so it is removed here.
  const s = String(input).replace(/^﻿/, '');
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];

    if (inLine) {
      if (c === '\n' || c === '\r') {
        inLine = false;
        out += c;
      }
      continue;
    }

    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      } else if (c === '\n' || c === '\r') {
        // Preserve line breaks so error offsets stay meaningful.
        out += c;
      }
      continue;
    }

    if (inString) {
      out += c;
      if (c === '\\') {
        // Copy the escaped character verbatim.
        if (i + 1 < s.length) {
          out += s[i + 1];
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }

    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }

    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }

    out += c;
  }

  return out;
}

/**
 * Lenient pre-pass for a config body that is neither strict JSON nor
 * tolerable-with-one-pass JSONC.
 *
 * Single-quoted keys and values are the common hand-written form in loose
 * config files. They are not JSON at all, so they are rewritten to double
 * quotes BEFORE `parseJsonc` runs — otherwise the body falls back to
 * pattern-only redaction and every key name inside it goes unexamined.
 *
 * This is deliberately narrow: it only rewrites quotes when the character run
 * between them cannot contain an unescaped delimiter, so a JSON body is never
 * damaged.
 */
export function normalizeQuotes(input) {
  const s = String(input);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      // Copy a double-quoted string verbatim, honouring escapes.
      out += c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i];
        if (s[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "'") {
      const end = findSingleQuotedEnd(s, i);
      if (end === -1) { out += c; i++; continue; }
      const inner = s.slice(i + 1, end);
      // Only rewrite when the contents are safe to express in double quotes.
      if (!inner.includes('"') && !/[\n\r\t]/.test(inner) && !/[\u0000-\u001f]/.test(inner)) {
        out += '"' + inner.replace(/\\/g, '\\\\') + '"';
      } else {
        out += s.slice(i, end + 1);
      }
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Index of the closing quote for the single-quoted run starting at start. */
function findSingleQuotedEnd(s, start) {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === "'") return i;
    i++;
  }
  return -1;
}

/** Remove `,` that is immediately followed by whitespace and a closer. */
export function stripTrailingCommas(input) {
  const s = String(input);
  let out = '';
  let inString = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inString) {
      out += c;
      if (c === '\\') {
        if (i + 1 < s.length) {
          out += s[i + 1];
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }

    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j < s.length && (s[j] === '}' || s[j] === ']')) {
        // Drop this comma; the whitespace after it is copied on the next pass.
        continue;
      }
    }

    out += c;
  }

  return out;
}

/** Strip comments and trailing commas, then JSON.parse. Throws on bad JSON. */
export function parseJsonc(input) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(input)));
}
