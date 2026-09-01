import fs from 'fs';

const path = 'mobile-otp-preload.js';
let src = fs.readFileSync(path, 'utf8');

if (!src.includes("const APP_REVIEW_NAME = 'Apple Review Patient';")) {
  src = src.replace(
    "const APP_REVIEW_CODE = '246810';\n",
    "const APP_REVIEW_CODE = '246810';\nconst APP_REVIEW_NAME = 'Apple Review Patient';\n",
  );
}

const isReviewMarker = "  const isAppReview = normalizePhone(phone) === APP_REVIEW_PHONE;\n";
if (!src.includes('[PACIENTE-OTP] App Review account reset')) {
  if (!src.includes(isReviewMarker)) throw new Error('App Review marker not found');
  src = src.replace(isReviewMarker, `${isReviewMarker}  if (isAppReview) {\n    // Keep the dedicated review identity professional and start every fresh login\n    // without a stale demo consultation blocking the reviewer.\n    await pool.query(\n      \`UPDATE pacientes SET nome=$2\n         WHERE RIGHT(regexp_replace(COALESCE(tel,''), '\\\\D', '', 'g'), 11)=$1\`,\n      [APP_REVIEW_PHONE, APP_REVIEW_NAME],\n    ).catch(() => {});\n    await pool.query(\n      \`UPDATE fila_atendimentos f\n          SET status='arquivado'\n        WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\\\D', '', 'g'), 11)=$1\n          AND COALESCE(to_jsonb(f)->>'pagamento_metodo','')='beta_test'\n          AND COALESCE(LOWER(to_jsonb(f)->>'status'),'') NOT IN ('encerrado','finalizado','finalizada','concluido','concluído','cancelado','expirado','arquivado')\`,\n      [APP_REVIEW_PHONE],\n    ).catch(() => {});\n    console.log('[PACIENTE-OTP] App Review account reset para uma sessão limpa.');\n  }\n`);
}

const patientMarker = `      const patient = await ensurePatient({\n        phone: challenge.telefone,\n        email: challenge.email,\n        cpf: normalizeCpf(challenge.cpf),\n        name: challenge.nome || 'Paciente',\n      });\n`;
if (!src.includes('patient.nome = APP_REVIEW_NAME')) {
  if (!src.includes(patientMarker)) throw new Error('Patient marker not found');
  src = src.replace(patientMarker, `${patientMarker}\n      if (normalizePhone(challenge.telefone) === APP_REVIEW_PHONE) {\n        await pool.query('UPDATE pacientes SET nome=$2 WHERE id=$1', [patient.id, APP_REVIEW_NAME]);\n        patient.nome = APP_REVIEW_NAME;\n      }\n`);
}

fs.writeFileSync(path, src);
console.log('[app-review-account] review identity/reset patch applied');
