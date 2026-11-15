// Lists the interface's text for translators: JSX text, the attributes people read (title,
// placeholder, aria-label, alt, label) and sentence-like strings (toasts, labels in objects).
// Template literals become patterns: `${n} people` -> "{0} people".
//   node apps/desktop/scripts/i18n-extract.mjs            -> writes src/renderer/i18n/strings.json
//   node apps/desktop/scripts/i18n-extract.mjs --missing hi -> prints keys hi.json lacks
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../src/renderer');
const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label']);
// props of the app's own components that carry words shown as they are (refText, hint, emptyText…)
const TEXT_PROP = /^(?:[a-z]+(?:Text|Label|Title|Hint|Note|Caption)|hint|note|caption|empty|subtitle|description|summary|heading|eyebrow)$/;
// JSX text arrives decoded (Q&A), so the list must hold it decoded too
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, '\u00a0');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n') walk(p); } else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith('.d.ts') && !/emoji-data/.test(e.name)) files.push(p);
  }
})(root);

const looksLikeText = (s) => {
  const t = s.trim();
  if (t.length < 2 || !/[A-Za-z]{2}/.test(t)) return false;
  if (/^[a-z0-9_.:/#@-]+$/i.test(t) && !/^[A-Z][a-z]+(-[a-z]+)*$/.test(t)) return false; // ids, classes, paths, single lowercase words (a capitalised word, hyphenated or not, is text: "Heads-down")
  if (/^(https?|dexconnect|data|blob):/.test(t)) return false;
  if (/^[a-z]+(-[a-z]+)+$/.test(t)) return false; // css-ish
  if (/[{}<>=]|=>/.test(t)) return false;
  if (/;/.test(t) && !/^[^;]*[A-Za-z]; [a-z]/.test(t)) return false; // code; but prose may have a semicolon ("Focused; notifications still on")
  if (/^[a-z][a-zA-Z]+$/.test(t)) return false; // camelCase
  if (/^[A-Z_]+$/.test(t) && t.length > 1 && !/\s/.test(t) && t.length < 3) return false;
  return /^[A-Z0-9"“'‘(@#•·…↑↓✓]/.test(t) || /\s/.test(t);
};

const out = new Map();
// the hub's refusals reach people as they are (toasts, dialogs): collect them too, from new XxxError('…')
const hubRoot = path.resolve(import.meta.dirname, '../../hub/src');
const hubFiles = [];
(function walkHub(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkHub(p); else if (e.name.endsWith('.ts')) hubFiles.push(p);
  }
})(hubRoot);
const add = (text, file, caption = false) => {
  const t = text.replace(/\s+/g, ' ').trim();
  // a capitalised caption in a component prop (refText="NOW") is words, though it looks like a constant
  if (caption && /^[A-Z]{3,}$/.test(t)) { if (!out.has(t)) out.set(t, path.relative(root, file)); return; }
  if (!looksLikeText(t.replace(/\{\d\}/g, 'X'))) return;
  if (!out.has(t)) out.set(t, path.relative(root, file));
};
const tpl = (node) => {
  let s = node.head.text; let i = 0;
  for (const span of node.templateSpans) s += `{${i++}}` + span.literal.text;
  return i <= 4 ? s : null;
};

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  if (/@jsxImportSource react\b/.test(src)) continue; // files that draw what people wrote
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    if (ts.isJsxText(n)) add(decode(n.text), file);
    else if (ts.isJsxAttribute(n) && (ATTRS.has(n.name.getText()) || TEXT_PROP.test(n.name.getText())) && n.initializer) {
      if (ts.isStringLiteral(n.initializer)) add(n.initializer.text, file, TEXT_PROP.test(n.name.getText()));
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const p = n.parent;
      const skip = p && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || (ts.isCallExpression(p) && /request|querySelector|getItem|setItem|addEventListener|getContext|createElement|matchMedia|startsWith|endsWith|includes|split|replace|test/.test(p.expression.getText())) || ts.isElementAccessExpression(p) || (ts.isBinaryExpression(p) && /===|!==|==|!=/.test(p.operatorToken.getText())) || ts.isCaseClause(p) || ts.isLiteralTypeNode(p) || ts.isPropertyAccessExpression(p));
      if (!skip && !ts.isJsxAttribute(p)) add(n.text, file);
    } else if (ts.isTemplateExpression(n)) {
      const s = tpl(n);
      if (s && /[A-Za-z]{3}/.test(s.replace(/\{\d\}/g, ''))) add(s, file);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

for (const file of hubFiles) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (n) => {
    if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText()) && n.arguments?.length) {
      const a = n.arguments[0];
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) add(a.text, `hub/${path.relative(hubRoot, file)}`);
      else if (ts.isTemplateExpression(a)) { const t = tpl(a); if (t) add(t, `hub/${path.relative(hubRoot, file)}`); }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const target = path.join(root, 'i18n', 'strings.json');
const sorted = Object.fromEntries([...out.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])));
const miss = process.argv.indexOf('--missing');
if (miss > -1) {
  const lang = process.argv[miss + 1];
  const have = JSON.parse(fs.readFileSync(path.join(root, 'i18n', `${lang}.json`), 'utf8'));
  const missing = Object.keys(sorted).filter((k) => !(k in have));
  process.stdout.write(JSON.stringify(Object.fromEntries(missing.map((k) => [k, sorted[k]])), null, 1));
} else {
  fs.writeFileSync(target, `${JSON.stringify(sorted, null, 1)}\n`);
  console.log(`${out.size} strings from ${files.length} files -> ${path.relative(process.cwd(), target)}`);
}
