// Coortes de aquisição: pacientes conquistados em cada mês, retorno e margem posterior em 30/60/90 dias.
// Sem dupla contagem: um pagamento posterior que chegou por NOVO clique pago (clique válido e inédito)
// é crédito daquele clique, não da aquisição original; ele é contado à parte ("readquirido por anúncio").
import { calcularMargemConsulta, lerTaxasMargem } from "./margem-consulta.js";

const DIA = 86400000;
const JANELAS = [30, 60, 90];

export function canalAquisicao(p) {
  const clique = p.ads_gclid || p.ads_gbraid || p.ads_wbraid;
  if (clique && !p.clique_reutilizado) return "google_ads";
  const origem = String(p.origem_plataforma || "").toLowerCase();
  if (["ios", "android", "app_desconhecido"].includes(origem)) return "app";
  return "outros";
}

/**
 * pagamentos: todos os pagamentos confirmados (ordenados ou não) com identidade, data e campos de margem.
 * Retorna coortes por mês de aquisição x canal.
 */
export function montarCoortes({ pagamentos, adminEmail, hoje = new Date(), taxas = lerTaxasMargem(), desdeMes = null }) {
  const porId = new Map();
  for (const p of pagamentos) {
    if (!p.identidade) continue;
    (porId.get(p.identidade) || porId.set(p.identidade, []).get(p.identidade)).push(p);
  }
  const margemDe = p => {
    const medico = p.medico_email ? { email: p.medico_email, nome: p.medico_nome_cad, nome_exibicao: p.medico_nome_exibicao } : null;
    return calcularMargemConsulta({ at: p, medico, adminEmail, taxas, estimarAntesDaRegra: true });
  };
  const grupos = new Map();
  for (const lista of porId.values()) {
    lista.sort((a, b) => new Date(a.pagamento_confirmado_em) - new Date(b.pagamento_confirmado_em));
    const primeiro = lista[0];
    const t0 = new Date(primeiro.pagamento_confirmado_em);
    const mes = t0.toLocaleDateString("en-CA", { timeZone: "America/Fortaleza" }).slice(0, 7);
    if (desdeMes && mes < desdeMes) continue;
    const canal = canalAquisicao(primeiro);
    const k = mes + "|" + canal;
    const g = grupos.get(k) || grupos.set(k, {
      mes, canal, pacientes: 0, margem_aquisicao: 0, maturidade_dias: 0,
      ...Object.fromEntries(JANELAS.flatMap(j => [[`voltaram_${j}`, 0], [`pagamentos_${j}`, 0], [`receita_${j}`, 0], [`margem_${j}`, 0], [`readquiridos_${j}`, 0]]))
    }).get(k);
    g.pacientes++;
    const m0 = margemDe(primeiro);
    g.margem_aquisicao += m0.margemCentavos ?? m0.contribuicaoCentavos ?? 0;
    const idade = (hoje - t0) / DIA;
    g.maturidade_dias = Math.max(g.maturidade_dias, Math.floor(idade));
    const voltou = Object.fromEntries(JANELAS.map(j => [j, false]));
    for (const p of lista.slice(1)) {
      const dt = (new Date(p.pagamento_confirmado_em) - t0) / DIA;
      const novoCliquePago = !!(p.ads_gclid || p.ads_gbraid || p.ads_wbraid) && !p.clique_reutilizado;
      const m = margemDe(p);
      for (const j of JANELAS) {
        if (dt > j) continue;
        if (novoCliquePago) { g[`readquiridos_${j}`]++; continue; }
        g[`pagamentos_${j}`]++;
        g[`receita_${j}`] += m.liquidoCentavos;
        g[`margem_${j}`] += m.margemCentavos ?? m.contribuicaoCentavos ?? 0;
        voltou[j] = true;
      }
    }
    for (const j of JANELAS) if (voltou[j]) g[`voltaram_${j}`]++;
  }
  // Coorte só é "madura" para a janela j se todos os pacientes já tiveram j dias (aproximação pelo fim do mês).
  return [...grupos.values()].map(g => {
    const fimMes = new Date(Date.UTC(+g.mes.slice(0, 4), +g.mes.slice(5, 7), 0, 23, 59));
    const idadeMin = Math.floor((hoje - fimMes) / DIA);
    const out = { ...g };
    for (const j of JANELAS) {
      out[`madura_${j}`] = idadeMin >= j;
      out[`taxa_retorno_${j}`] = g.pacientes ? g[`voltaram_${j}`] / g.pacientes : null;
      out[`margem_por_paciente_${j}`] = g.pacientes ? g[`margem_${j}`] / g.pacientes : null;
    }
    return out;
  }).sort((a, b) => a.mes.localeCompare(b.mes) || a.canal.localeCompare(b.canal));
}

// Valor futuro por paciente novo do Google: média ponderada das coortes MADURAS em 90 dias (ou 60/30 se faltar).
export function valorFuturoPorNovo(coortes, canal = "google_ads") {
  for (const j of [90, 60, 30]) {
    const ms = coortes.filter(c => c.canal === canal && c[`madura_${j}`] && c.pacientes >= 20);
    const pac = ms.reduce((s, c) => s + c.pacientes, 0);
    if (pac >= 40) return { janela: j, centavos: Math.round(ms.reduce((s, c) => s + c[`margem_${j}`], 0) / pac), pacientes: pac, meses: ms.map(c => c.mes) };
  }
  return null;
}

export const SQL_COORTES = `
  WITH base AS (
    SELECT f.*, COALESCE(NULLIF(f.ads_gclid,''),NULLIF(f.ads_gbraid,''),NULLIF(f.ads_wbraid,'')) AS clique
      FROM fila_atendimentos f
     WHERE f.pagamento_status='confirmado' AND f.pagamento_confirmado_em IS NOT NULL
  ), primeiro_clique AS (
    SELECT clique, MIN(pagamento_confirmado_em) t FROM base WHERE clique IS NOT NULL GROUP BY clique
  )
  SELECT b.id, b.pagamento_confirmado_em, b.tipo, b.status, b.pagamento_status, b.status_atendimento, b.categoria_atendimento,
         b.especialidade_solicitada, b.valor_cobrado_centavos, b.valor_recebido_centavos, b.taxa_gateway_real_centavos,
         b.reembolso_valor_centavos, b.reembolso_status, b.encerrado_em, b.pagamento_metodo, b.frete_valor,
         b.pagbank_order_id, b.stripe_payment_intent_id, b.stripe_checkout_session_id, b.efi_charge_id,
         b.origem_plataforma, b.ads_gclid, b.ads_gbraid, b.ads_wbraid,
         m.email AS medico_email, m.nome AS medico_nome_cad, m.nome_exibicao AS medico_nome_exibicao,
         (b.clique IS NOT NULL AND b.pagamento_confirmado_em > pc.t) AS clique_reutilizado,
         COALESCE(NULLIF(regexp_replace(COALESCE(b.cpf,''),'\\D','','g'),''), NULLIF(LOWER(TRIM(b.email)),''),
                  NULLIF(regexp_replace(COALESCE(b.tel,''),'\\D','','g'),'')) AS identidade
    FROM base b
    LEFT JOIN primeiro_clique pc ON pc.clique = b.clique
    LEFT JOIN medicos m ON m.id = b.medico_id`;

let cache = { em: 0, dados: null };
export async function calcularCoortes(pool, adminEmail, { meses = 9 } = {}) {
  if (cache.dados && Date.now() - cache.em < 15 * 60_000 && cache.meses === meses) return cache.dados;
  const { rows } = await pool.query(SQL_COORTES);
  const hoje = new Date();
  const d = new Date(hoje); d.setUTCMonth(d.getUTCMonth() - meses + 1);
  const desdeMes = d.toISOString().slice(0, 7);
  const coortes = montarCoortes({ pagamentos: rows, adminEmail, hoje, desdeMes });
  cache = { em: Date.now(), dados: coortes, meses };
  return coortes;
}
