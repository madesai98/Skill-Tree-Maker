import type { FirebaseOptions } from 'firebase/app';

type Scalar = string | number | boolean | null;

class ConfigReader {
  private index = 0;

  constructor(private readonly source: string) {}

  parseObject(): Record<string, Scalar> {
    this.skipIgnored();
    this.expect('{');
    const result: Record<string, Scalar> = {};

    while (true) {
      this.skipIgnored();
      if (this.peek() === '}') {
        this.index += 1;
        return result;
      }

      const key = this.readKey();
      this.skipIgnored();
      this.expect(':');
      this.skipIgnored();
      result[key] = this.readValue();
      this.skipIgnored();

      const next = this.peek();
      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === '}') continue;
      throw new Error(`Expected a comma after “${key}”.`);
    }
  }

  private readKey() {
    const next = this.peek();
    if (next === '"' || next === "'" || next === '`') return this.readString();
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
    if (!match) throw new Error('Expected a Firebase configuration field name.');
    this.index += match[0].length;
    return match[0];
  }

  private readValue(): Scalar {
    const next = this.peek();
    if (next === '"' || next === "'" || next === '`') return this.readString();

    const remaining = this.source.slice(this.index);
    const keyword = remaining.match(/^(true|false|null)\b/);
    if (keyword) {
      this.index += keyword[0].length;
      if (keyword[0] === 'true') return true;
      if (keyword[0] === 'false') return false;
      return null;
    }

    const number = remaining.match(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) {
      this.index += number[0].length;
      return Number(number[0]);
    }

    throw new Error('Firebase configuration values must be literal strings, numbers, booleans, or null.');
  }

  private readString() {
    const quote = this.peek();
    this.index += 1;
    let result = '';

    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === quote) return result;
      if (quote === '`' && char === '$' && this.peek() === '{') {
        throw new Error('Template expressions are not supported in Firebase configuration values.');
      }
      if (char !== '\\') {
        result += char;
        continue;
      }

      if (this.index >= this.source.length) break;
      const escaped = this.source[this.index++];
      const simpleEscapes: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
        v: '\v',
        '0': '\0',
        '\\': '\\',
        '"': '"',
        "'": "'",
        '`': '`',
      };
      if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
        result += simpleEscapes[escaped];
        continue;
      }
      if (escaped === 'x') {
        result += this.readHexEscape(2);
        continue;
      }
      if (escaped === 'u') {
        result += this.readHexEscape(4);
        continue;
      }
      result += escaped;
    }

    throw new Error('Unterminated string in Firebase configuration.');
  }

  private readHexEscape(length: number) {
    const value = this.source.slice(this.index, this.index + length);
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)) {
      throw new Error('Invalid escape sequence in Firebase configuration.');
    }
    this.index += length;
    return String.fromCharCode(Number.parseInt(value, 16));
  }

  private skipIgnored() {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index])) {
        this.index += 1;
        continue;
      }
      if (this.source.startsWith('//', this.index)) {
        const newline = this.source.indexOf('\n', this.index + 2);
        this.index = newline === -1 ? this.source.length : newline + 1;
        continue;
      }
      if (this.source.startsWith('/*', this.index)) {
        const close = this.source.indexOf('*/', this.index + 2);
        if (close === -1) throw new Error('Unterminated comment in Firebase configuration.');
        this.index = close + 2;
        continue;
      }
      break;
    }
  }

  private peek() {
    return this.source[this.index];
  }

  private expect(char: string) {
    if (this.peek() !== char) throw new Error(`Expected “${char}” in Firebase configuration.`);
    this.index += 1;
  }
}

function stripCodeFence(input: string) {
  return input
    .trim()
    .replace(/^```(?:javascript|js|typescript|ts|json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function findObjectStart(input: string) {
  const configName = input.search(/\bfirebaseConfig\b/i);
  const start = input.indexOf('{', configName >= 0 ? configName : 0);
  if (start < 0) throw new Error('Paste the Firebase configuration object or the full firebaseConfig snippet.');
  return start;
}

function extractBalancedObject(input: string, start: number) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1] ?? '';

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
    }
  }

  throw new Error('The Firebase configuration object is missing its closing brace.');
}

function asFirebaseOptions(value: Record<string, Scalar>): FirebaseOptions {
  const config: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) config[key] = item;

  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
    throw new Error('The Firebase config needs a valid apiKey.');
  }
  if (typeof config.projectId !== 'string' || !config.projectId.trim()) {
    throw new Error('The Firebase config needs a valid projectId.');
  }

  return config as FirebaseOptions;
}

/**
 * Accepts the formats Firebase commonly presents in its web setup UI:
 * - strict JSON
 * - a JavaScript object literal with unquoted field names
 * - `const firebaseConfig = { ... };`
 * - a fenced JS/JSON snippet
 *
 * It intentionally parses literals rather than evaluating pasted JavaScript.
 */
export function parseFirebaseConfigInput(input: string): FirebaseOptions {
  const cleaned = stripCodeFence(input);
  if (!cleaned) throw new Error('Paste your Firebase configuration first.');

  const start = findObjectStart(cleaned);
  const objectText = extractBalancedObject(cleaned, start);
  return asFirebaseOptions(new ConfigReader(objectText).parseObject());
}
