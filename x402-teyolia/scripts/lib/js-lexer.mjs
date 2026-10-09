// Lexer mínimo para JS/TS: reemplaza comentarios por espacios conservando saltos de
// línea (los números de línea no cambian) y deja intactos strings, templates y regex.
// Si el lexer se equivoca, los verificadores fallan cerrados (ven más, no menos).

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let lastSignificant = '';
  let lastWord = '';
  const templateDepth = [];

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      out += blank(source.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const j = end === -1 ? n : end + 2;
      out += blank(source.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = ch;
      lastWord = '';
      continue;
    }
    if (ch === '`' || (ch === '}' && templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === 0)) {
      if (ch === '}') templateDepth.pop();
      let j = i + 1;
      let closedExpr = false;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '`') { j++; break; }
        if (source[j] === '$' && source[j + 1] === '{') { j += 2; templateDepth.push(0); closedExpr = true; break; }
        j++;
      }
      out += source.slice(i, j);
      i = j;
      lastSignificant = closedExpr ? '{' : '`';
      lastWord = '';
      continue;
    }
    if (ch === '{' && templateDepth.length > 0) templateDepth[templateDepth.length - 1]++;
    if (ch === '}' && templateDepth.length > 0) templateDepth[templateDepth.length - 1]--;

    if (ch === '/') {
      const isRegex = lastSignificant === '' || REGEX_PRECEDERS.has(lastSignificant) || REGEX_KEYWORDS.has(lastWord);
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n && source[j] !== '\n') {
          const c = source[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(source[j])) j++;
        out += source.slice(i, j);
        i = j;
        lastSignificant = ')';
        lastWord = '';
        continue;
      }
    }

    out += ch;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      out += word.slice(1);
      lastWord = word;
      lastSignificant = 'w';
      i = j;
      continue;
    }
    if (!/\s/.test(ch)) {
      lastSignificant = ch;
      lastWord = '';
    }
    i++;
  }
  return out;
}

export function lineOf(text, index) {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/** Devuelve el contenido entre el paréntesis en `openIndex` y su cierre balanceado. */
export function balancedParens(text, openIndex) {
  let depth = 0;
  for (let k = openIndex; k < text.length; k++) {
    const c = text[k];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, k);
    } else if (c === '"' || c === "'" || c === '`') {
      let j = k + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      k = j;
    }
  }
  return text.slice(openIndex + 1);
}

/** Devuelve el cuerpo entre la llave en `openIndex` y su cierre balanceado. */
export function balancedBraces(text, openIndex) {
  let depth = 0;
  for (let k = openIndex; k < text.length; k++) {
    const c = text[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, k);
    } else if (c === '"' || c === "'" || c === '`') {
      let j = k + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      k = j;
    }
  }
  return text.slice(openIndex + 1);
}
