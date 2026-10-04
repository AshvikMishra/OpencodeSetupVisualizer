/**
 * inject.js — in-memory replacement of the template's SNAPSHOT block.
 *
 * The template file on disk is never written to. We locate exactly two markers
 * and replace the span between them. If either marker is missing we throw, so a
 * half-injected page can never be served.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.join(HERE, '..', 'template', 'opencode-dashboard-example.html');

/** The two markers, in order, exactly as they appear in the template. */
export const START_MARKER = 'const SNAPSHOT = ';
export const END_MARKER = '/* ============================ derived helpers';

export class InjectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InjectionError';
  }
}

/** Read the pristine template bytes. Read-only, never writes. */
export function readTemplate(templatePath = TEMPLATE_PATH) {
  try {
    return fs.readFileSync(templatePath, 'utf8');
  } catch (e) {
    throw new InjectionError(
      `Cannot read template at ${templatePath}: ${e.message}. ` +
      `The template must exist and is never created by this tool.`
    );
  }
}

/**
 * Make a JSON string safe to embed inside a <script> element.
 *  - `<` becomes < so "</script>" and friends cannot terminate the block.
 *  - U+2028 / U+2029 are escaped; they are literal newlines to a JS parser
 *    but are NOT valid inside a JSON string, so an unescaped one is a syntax
 *    error in some engines.
 */
/** Strip a leading BOM / ZWNBSP so it can never terminate an inline script. */
function stripLeadingBOM(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^[\uFEFF]+/, '');
}

export function scriptSafeJSON(value) {
  return JSON.stringify(stripLeadingBOM(value))
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Locate the injection span. Throws with a precise message if a marker is absent. */
export function findSpan(html) {
  const start = html.indexOf(START_MARKER);
  if (start === -1) {
    throw new InjectionError(
      `Template is missing the start marker ${JSON.stringify(START_MARKER)}. ` +
      `Refusing to serve a page with an uninjected snapshot.`
    );
  }
  const end = html.indexOf(END_MARKER, start + START_MARKER.length);
  if (end === -1) {
    throw new InjectionError(
      `Template is missing the end marker ${JSON.stringify(END_MARKER)} after the SNAPSHOT block. ` +
      `Refusing to serve a page with an uninjected snapshot.`
    );
  }
  if (end < start) {
    throw new InjectionError('Template markers are out of order (end marker precedes start marker).');
  }
  return { start, end };
}

/**
 * Replace the SNAPSHOT block with `const SNAPSHOT = <json>;`.
 * @returns {string} the full HTML document, ready to serve.
 */
export function inject(html, snapshot) {
  const { start, end } = findSpan(html);
  const replacement = `${START_MARKER}${scriptSafeJSON(snapshot)};`;
  return html.slice(0, start) + replacement + html.slice(end);
}

/** Convenience: read the template and inject in one step. */
export function renderPage(snapshot, templatePath = TEMPLATE_PATH) {
  return inject(readTemplate(templatePath), snapshot);
}
