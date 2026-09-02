import fs from 'node:fs';

const file = new URL('../mobile-beta-test-preload.js', import.meta.url);
let source = fs.readFileSync(file, 'utf8');

const replacements = [
  ["const REVIEW_PATIENT_NAME = 'Apple Review Patient';", "const REVIEW_PATIENT_NAME = 'Review Patient';"],
  ['(App Review - ambiente de demonstração)', '(Ambiente de revisão - demonstração)'],
  ['para revisão da App Store.', 'para revisão da loja de aplicativos.'],
];

let changed = false;
for (const [from, to] of replacements) {
  if (source.includes(from)) {
    source = source.replaceAll(from, to);
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(file, source);
  console.log('[review-sandbox] Labels neutralizados para Apple/Google review.');
} else {
  console.log('[review-sandbox] Labels já estavam neutros.');
}
