// Ganhos médicos (somente leitura).
//
// Regra autorizada pelo dono em 17/11/2026:
//   - vigência: atendimentos encerrados a partir de 2026-11-16 00:00 America/Fortaleza;
//   - base: preço da consulta clínica R$ 49,90 (4990 centavos);
//   - faixa "reduzida" (Kivia, Victoria/Victória, Gabriel Bomfim, Gabriela Coutinho): 55% → 2745 centavos (half-up);
//   - faixa "padrão" (demais médicos): 70% → 3493 centavos;
//   - médico admin: 4990 centavos (bruto integral).
//
// Contrato de privacidade: a resposta NUNCA expõe percentuais, faixa, IDs de
// outros médicos, IDs de atendimentos ou qualquer dado de paciente. Apenas
// contagens e valores agregados da própria pessoa autenticada.
//
// Não há regra factual de data de pagamento nem registro de repasse pago para
// médicos clínicos: todos os valores são ESTIMATIVAS pendentes e a data de
// pagamento é sempre "a_definir".

export const GANHOS_FUSO = "America/Fortaleza";
export const GANHOS_INICIO_DATA = "2026-11-16";
// Fortaleza é UTC-3 fixo (sem horário de verão).
export const GANHOS_INICIO_ISO = "2026-11-16T00:00:00-03:00";
export const GANHOS_PRECO_BASE_CENTAVOS = 4990;

const PERCENTUAL_POR_FAIXA = Object.freeze({ admin: 100, reduzida: 55, padrao: 70 });

// Multiplicação percentual em inteiros com arredondamento half-up (valores >= 0).
export function percentualCentavosHalfUp(baseCentavos, percentualInteiro) {
  if (!Number.isInteger(baseCentavos) || baseCentavos < 0) throw new TypeError("baseCentavos inválido");
  if (!Number.isInteger(percentualInteiro) || percentualInteiro < 0) throw new TypeError("percentual inválido");
  return Math.floor((baseCentavos * percentualInteiro + 50) / 100);
}

export function normalizarTextoGanhos(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Uso interno apenas: a faixa nunca é devolvida ao cliente.
export function classificarFaixaMedico(medico, adminEmail) {
  const email = String(medico?.email || "").trim().toLowerCase();
  if (adminEmail && email && email === String(adminEmail).trim().toLowerCase()) return "admin";
  const nome = normalizarTextoGanhos(`${medico?.nome || ""} ${medico?.nome_exibicao || ""}`);
  const palavras = new Set(nome.split(" ").filter(Boolean));
  if (palavras.has("kivia")) return "reduzida";
  if (palavras.has("victoria")) return "reduzida";
  if (palavras.has("gabriel") && palavras.has("bomfim")) return "reduzida";
  if (palavras.has("gabriela") && palavras.has("coutinho")) return "reduzida";
  return "padrao";
}

export function valorPorAtendimentoCentavos(faixa) {
  const percentual = PERCENTUAL_POR_FAIXA[faixa];
  if (percentual === undefined) throw new Error("faixa desconhecida");
  return percentualCentavosHalfUp(GANHOS_PRECO_BASE_CENTAVOS, percentual);
}

// Decide se um atendimento entra no cálculo. Retorna { elegivel, motivo }.
// O SQL já restringe a: medico_id do token, status='encerrado', encerrado_em >= início,
// tipo diferente de renovação. Aqui ficam as regras finas, conservadoras.
export function classificarAtendimentoGanhos(at) {
  const pagamento = String(at?.pagamento_status || "").trim().toLowerCase();
  const reembolsoValor = Number(at?.reembolso_valor_centavos) || 0;
  const reembolsoStatus = String(at?.reembolso_status || "").trim();
  if (reembolsoValor > 0 || reembolsoStatus || pagamento.startsWith("reembols")) {
    return { elegivel: false, motivo: "estorno" };
  }
  if (pagamento === "isento_admin") return { elegivel: false, motivo: "isento_sem_regra" };
  if (pagamento !== "confirmado") return { elegivel: false, motivo: "pagamento_nao_confirmado" };

  const tipo = String(at?.tipo || "").trim().toLowerCase();
  if (tipo.startsWith("renovacao")) return { elegivel: false, motivo: "renovacao" };

  const status = normalizarTextoGanhos(at?.status_atendimento);
  if (status.includes("sem resposta")) return { elegivel: false, motivo: "sem_resposta" };
  if (status.includes("cancelad")) return { elegivel: false, motivo: "cancelado" };
  if (!/(^| )atendido( |$)/.test(status) || /\bnao atendido\b/.test(status)) {
    // Inclui "Encerrado pelo painel" e o default legado "Encerrado": não comprovam atendimento.
    return { elegivel: false, motivo: "status_nao_confirmado" };
  }

  const categoria = String(at?.categoria_atendimento || "clinico").trim().toLowerCase();
  if (categoria !== "clinico" || String(at?.especialidade_solicitada || "").trim()) {
    return { elegivel: false, motivo: "especialidade_sem_regra" };
  }
  if (Number(at?.valor_cobrado_centavos) !== GANHOS_PRECO_BASE_CENTAVOS) {
    // Promoção, desconto ou preço diferente: regra só cobre R$ 49,90.
    return { elegivel: false, motivo: "valor_cobrado_sem_regra" };
  }
  return { elegivel: true, motivo: null };
}

const DATA_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function quinzenaDe(dataIso) {
  const m = DATA_ISO_RE.exec(String(dataIso || ""));
  if (!m) throw new Error("data inválida");
  const [, ano, mes, dia] = m;
  const ultimoDia = new Date(Date.UTC(Number(ano), Number(mes), 0)).getUTCDate();
  const primeira = Number(dia) <= 15;
  return {
    id: `${ano}-${mes}-${primeira ? "Q1" : "Q2"}`,
    inicio: `${ano}-${mes}-${primeira ? "01" : "16"}`,
    fim: `${ano}-${mes}-${primeira ? "15" : String(ultimoDia).padStart(2, "0")}`,
  };
}

// Previsão para o primeiro dia útil após fechamento. Feriados locais/móveis
// dependem de conferência no financeiro; a data nunca é garantia de pagamento.
const FERIADOS_FIXOS_NACIONAIS = new Set(['01-01','04-21','05-01','09-07','10-12','11-02','11-15','11-20','12-25']);
// Feriados bancários móveis: Carnaval, Sexta-feira Santa e Corpus Christi.
function pascoaUTC(ano) {
  const a=ano%19,b=Math.floor(ano/100),c=ano%100,d=Math.floor(b/4),e=b%4;
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4;
  const l=(32+2*e+2*i-h-k+7)%7,m=Math.floor((a+11*h+22*l)/451);
  const mes=Math.floor((h+l-7*m+114)/31),dia=(h+l-7*m+114)%31+1;
  return new Date(Date.UTC(ano,mes-1,dia,12));
}
function ehFeriadoBancarioMovel(data) {
  const ano=data.getUTCFullYear(), pascoa=pascoaUTC(ano);
  const diff=Math.round((data.getTime()-pascoa.getTime())/86400000);
  return diff===-48||diff===-47||diff===-46||diff===-2||diff===60;
}
export function preverDiaUtilRepasse(fim) {
  const data=new Date(fim+'T12:00:00Z');
  if (!Number.isFinite(data.getTime())) return { data:null,provisorio:true };
  for (let i=0;i<20;i++) {
    data.setUTCDate(data.getUTCDate()+1);
    const dia=data.getUTCDay(),iso=data.toISOString().slice(0,10);
    if (dia!==0 && dia!==6 && !FERIADOS_FIXOS_NACIONAIS.has(iso.slice(5)) && !ehFeriadoBancarioMovel(data))
      return {data:iso,provisorio:true,observacao:'Sujeito à conferência de feriados estaduais e municipais'};
  }
  return {data:null,provisorio:true};
}

export function dataIsoNoFuso(date = new Date(), fuso = GANHOS_FUSO) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// Monta o corpo da resposta só com agregados. `rows` contém apenas colunas não identificáveis.
export function montarResumoGanhos({ medico, rows, hojeIso, adminEmail, agora = new Date() }) {
  const faixa = classificarFaixaMedico(medico, adminEmail);
  const unitario = valorPorAtendimentoCentavos(faixa);

  const porDia = new Map();
  const porQuinzena = new Map();
  const motivos = {};
  let totalAtendimentos = 0;
  let naoContabilizados = 0;

  for (const at of rows || []) {
    const dia = String(at?.dia || "");
    if (!DATA_ISO_RE.test(dia) || dia < GANHOS_INICIO_DATA) continue;
    const { elegivel, motivo } = classificarAtendimentoGanhos(at);
    if (!elegivel) {
      naoContabilizados += 1;
      motivos[motivo] = (motivos[motivo] || 0) + 1;
      continue;
    }
    totalAtendimentos += 1;
    porDia.set(dia, (porDia.get(dia) || 0) + 1);
    const q = quinzenaDe(dia);
    const atual = porQuinzena.get(q.id) || { ...q, atendimentos: 0 };
    atual.atendimentos += 1;
    porQuinzena.set(q.id, atual);
  }

  const hojeQtd = porDia.get(hojeIso) || 0;
  const valor = (n) => n * unitario;

  return {
    ok: true,
    natureza: "estimativa",
    aviso: "Valores estimados a partir dos atendimentos registrados. Não representam pagamento efetuado.",
    moeda: "BRL",
    periodo: { inicio: GANHOS_INICIO_DATA, ate: hojeIso, fuso: GANHOS_FUSO },
    valor_por_atendimento_centavos: unitario,
    hoje: { data: hojeIso, atendimentos: hojeQtd, valor_centavos: valor(hojeQtd) },
    total: {
      atendimentos: totalAtendimentos,
      valor_centavos: valor(totalAtendimentos),
      situacao: "pendente_estimado",
    },
    por_dia: [...porDia.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([data, n]) => ({ data, atendimentos: n, valor_centavos: valor(n) })),
    quinzenas: [...porQuinzena.values()]
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .map((q) => ({
        id: q.id,
        inicio: q.inicio,
        fim: q.fim,
        atendimentos: q.atendimentos,
        valor_centavos: valor(q.atendimentos),
        situacao: "pendente_estimado",
        data_pagamento: preverDiaUtilRepasse(q.fim).data,
        data_pagamento_status: "previsao_provisoria",
      })),
    pagamento: { regra_definida: true, criterio: "primeiro_dia_util_apos_fechamento", data_prevista: null, status: "previsao_provisoria" },
    nao_contabilizados: { total: naoContabilizados, motivos },
    atualizado_em: agora.toISOString(),
  };
}

// Colunas estritamente necessárias: nada de nome, telefone, CPF, triagem ou IDs.
export const SQL_GANHOS_MEDICO = `
  SELECT to_char((f.encerrado_em::timestamptz AT TIME ZONE '${GANHOS_FUSO}'), 'YYYY-MM-DD') AS dia,
         f.tipo,
         f.pagamento_status,
         f.status_atendimento,
         f.categoria_atendimento,
         f.especialidade_solicitada,
         f.valor_cobrado_centavos,
         f.reembolso_status,
         f.reembolso_valor_centavos
    FROM fila_atendimentos f
   WHERE f.medico_id = $1
     AND f.status = 'encerrado'
     AND f.encerrado_em IS NOT NULL
     AND f.encerrado_em::timestamptz >= $2::timestamptz
     AND COALESCE(f.tipo, '') NOT LIKE 'renovacao%'`;

export function registrarRotaGanhosMedico(app, { pool, checkMedico, adminEmail }) {
  app.get("/api/medico/ganhos", checkMedico, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const token = req.medico || {};
      const medicoId = Number(token.id);
      // Tokens de paciente/psicólogo/especialista/links compartilham o segredo JWT:
      // só aceitamos o formato de login médico ({ id, email } sem `tipo`).
      if (token.tipo || !Number.isInteger(medicoId) || medicoId <= 0 || !token.email) {
        return res.status(403).json({ ok: false, error: "Acesso não autorizado." });
      }
      const med = await pool.query(
        "SELECT nome, nome_exibicao, email FROM medicos WHERE id = $1",
        [medicoId]
      );
      const medico = med.rows[0];
      if (!medico || String(medico.email || "").trim().toLowerCase() !== String(token.email).trim().toLowerCase()) {
        return res.status(403).json({ ok: false, error: "Acesso não autorizado." });
      }
      const { rows } = await pool.query(SQL_GANHOS_MEDICO, [medicoId, GANHOS_INICIO_ISO]);
      const resumo = montarResumoGanhos({ medico, rows, hojeIso: dataIsoNoFuso(), adminEmail });
      // Registro manual de quinzena paga (quando tabela ainda não foi criada,
      // permite uso da consulta sem simular pagamentos).
      let pagos=[];
      try {
        pagos=(await pool.query("SELECT periodo,valor_centavos,atendimentos,pago_em FROM medico_repasses_registros WHERE medico_id=$1",[medicoId])).rows;
      } catch(e) {
        if (e.code!=='42P01') throw e;
      }
      const mapa=new Map(pagos.map(p=>[String(p.periodo),p]));
      resumo.quinzenas=resumo.quinzenas.map(q=>{
        const pago=mapa.get(q.id);
        return {...q, situacao:pago?"pago_registrado":"pendente_estimado",
          registrado_pago:!!pago, pago_em:pago?.pago_em||null,
          divergencia:!!pago&&(Number(pago.valor_centavos)!==q.valor_centavos||Number(pago.atendimentos)!==q.atendimentos)};
      });
      resumo.total_pendente_centavos=resumo.quinzenas.filter(q=>!q.registrado_pago).reduce((sum,q)=>sum+q.valor_centavos,0);
      const periodoAtual=quinzenaDe(dataIsoNoFuso());
      const atual=resumo.quinzenas.find(q=>q.id===periodoAtual.id);
      resumo.quinzena_atual=atual||{...periodoAtual,atendimentos:0,valor_centavos:0,
        data_pagamento:preverDiaUtilRepasse(periodoAtual.fim).data,
        data_pagamento_status:"previsao_provisoria",
        situacao:"pendente_estimado",registrado_pago:false};
      resumo.pagamento.data_prevista=resumo.quinzena_atual.data_pagamento;
      return res.json(resumo);
    } catch (e) {
      console.error("[MEDICO-GANHOS] Erro:", e.message);
      return res.status(500).json({ ok: false, error: "Erro ao calcular ganhos." });
    }
  });
}
