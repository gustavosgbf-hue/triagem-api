function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  if (phone.length > 11 && phone.startsWith('55')) phone = phone.slice(2);
  return phone;
}

function normalizeCpf(value) {
  return String(value || '').replace(/\D/g, '');
}

function publicPatientLookupResponse(found) {
  return {
    ok: true,
    cadastroEncontrado: !!found,
    ...(found ? { requerVerificacao: true } : {}),
  };
}

function canResumePaidAttendance({ cpf, atendimentoParaTerceiro } = {}) {
  return !atendimentoParaTerceiro && normalizeCpf(cpf).length === 11;
}

function createPublicPatientLookupHandler(query) {
  return async function publicPatientLookup(req, res) {
    try {
      const phone = normalizePhone(req.query?.tel);
      if (phone.length < 10) {
        return res.status(400).json({ ok: false, error: 'telefone_invalido' });
      }
      const result = await query(
        `SELECT 1
           FROM fila_atendimentos
          WHERE regexp_replace(tel, '\\D', '', 'g') LIKE $1
          LIMIT 1`,
        [`%${phone}`],
      );
      return res.json(publicPatientLookupResponse(result.rowCount > 0));
    } catch {
      return res.status(500).json({ ok: false, error: 'busca_indisponivel' });
    }
  };
}

export {
  canResumePaidAttendance,
  createPublicPatientLookupHandler,
  normalizeCpf,
  normalizePhone,
  publicPatientLookupResponse,
};
