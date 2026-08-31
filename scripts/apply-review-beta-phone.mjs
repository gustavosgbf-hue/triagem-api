import fs from 'fs';

const path = 'mobile-beta-test-preload.js';
let src = fs.readFileSync(path, 'utf8');

if (src.includes('BETA_TEST_PHONES')) {
  console.log('[review-beta] already applied');
  process.exit(0);
}

src = src.replace(
  "const BETA_TEST_PHONE = '98991344646';",
  "const BETA_TEST_PHONES = new Set(['98991344646', '98900000000']);",
);
src = src.replace(
  "return normalizePhone(paciente.tel) === BETA_TEST_PHONE ? paciente : null;",
  "return BETA_TEST_PHONES.has(normalizePhone(paciente.tel)) ? paciente : null;",
);
src = src.replace(
  "if (tel !== BETA_TEST_PHONE) return null;",
  "if (!BETA_TEST_PHONES.has(tel)) return null;",
);
src = src.replace(
  "if (normalizePhone(row.tel) !== BETA_TEST_PHONE) return null;",
  "if (!BETA_TEST_PHONES.has(normalizePhone(row.tel))) return null;",
);
src = src.replace(
  "if (phone !== BETA_TEST_PHONE) return next();",
  "if (!BETA_TEST_PHONES.has(phone)) return next();",
);

if (/\bBETA_TEST_PHONE\b/.test(src)) {
  throw new Error('Unpatched BETA_TEST_PHONE occurrence remains');
}

fs.writeFileSync(path, src);
console.log('[review-beta] dedicated reviewer phone enabled');
