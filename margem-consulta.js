// Margem econômica por consulta (mensuração interna). Não envia nada a terceiros.
// Reaproveita as regras reais de repasse de medico-ganhos.js; nenhum percentual
// de repasse é fixado aqui. Taxas de gateway e impostos vêm de variáveis de
// ambiente; sem configuração, ficam como pendência e a margem é marcada incompleta.
import {
  GANHOS_INICIO_ISO,
  classificarFaixaMedico,
  valorPorAtendimentoCentavos,
  classificarAtendimentoGanhos,
  percentualCentavosHalfUp
} from "./medico-ganhos.js";

export const MARGEM_VERSAO_REGRA = "2026-11-26.1";

// Motivos de inelegibilidade em que o médico de fato não recebe repasse.
const MOTIVOS_SEM_REPASSE = new Set(["estorno", "pagamento_nao_confirmado", "sem_resposta", "cancelado", "status_nao_confirmado", "renovacao"]);

export function identificarGateway(at) {
  const metodo = String(at?.pagamento_metodo || "").trim().toLowerCase();
  const temStripe = !!(at?.stripe_payment_intent_id || at?.stripe_checkout_session_id);
  if (at?.efi_charge_id) return { gateway: "efi", metodo: metodo || "pix" };
  if (metodo === "cartao") return { gateway: temStripe ? "stripe" : (at?.pagbank_order_id ? "pagbank" : "desconhecido"), metodo };
  if (metodo === "pix") return { gateway: at?.pagbank_order_id ? "pagbank" : "desconhecido", metodo };
  if (temStripe) return { gateway: "stripe", metodo: metodo || "cartao" };
  if (at?.pagbank_order_id) return { gateway: "pagbank", metodo: metodo || "desconhecido" };
  return { gateway: "desconhecido", metodo: metodo || "desconhecido" };
}

// "0,99" | "0.99" (percentual) -> pontos-base inteiros (99). Inválido -> null.
function percentualParaPontosBase(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === "") return null;
  const n = Number(String(valor).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

function inteiroNaoNegativo(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === "") return null;
  const n = Number(String(valor).trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Lê MARGEM_TAXA_<GATEWAY>_<METODO>_PERCENTUAL / _FIXA_CENTAVOS e MARGEM_IMPOSTO_PERCENTUAL.
export function lerTaxasMargem(env = process.env) {
  const chave = (g, m, s) => `MARGEM_TAXA_${g}_${m}_${s}`.toUpperCase();
  return {
    taxa(gateway, metodo) {
      const bp = percentualParaPontosBase(env[chave(gateway, metodo, "PERCENTUAL")]);
      const fixa = inteiroNaoNegativo(env[chave(gateway, metodo, "FIXA_CENTAVOS")]);
      if (bp === null && fixa === null) return null;
      return { pontosBase: bp ?? 0, fixaCentavos: fixa ?? 0 };
    },
    impostoPontosBase: percentualParaPontosBase(env.MARGEM_IMPOSTO_PERCENTUAL)
  };
}

function pontosBaseCentavos(base, pontosBase) {
  return Math.floor((base * pontosBase + 5000) / 10000);
}

/**
 * Calcula a margem de uma consulta encerrada.
 * at: linha de fila_atendimentos; medico: {email,nome,nome_exibicao} ou null.
 * Retorna valores em centavos e a lista de pendências; completo=false quando
 * algum componente não pôde ser determinado com regra real.
 */
export function calcularMargemConsulta({ at, medico, adminEmail, taxas = lerTaxasMargem(), estimarAntesDaRegra = false }) {
  const pendencias = [];
  // Valor conferido no gateway prevalece sobre o valor registrado no pedido.
  const recebido = at?.valor_recebido_centavos;
  const cobrado = at?.valor_cobrado_centavos;
  const base = recebido !== null && recebido !== undefined && Number.isFinite(Number(recebido)) ? recebido : cobrado;
  const bruto = Math.max(0, base !== null && base !== undefined && Number.isFinite(Number(base)) ? Math.round(Number(base)) : 0);
  if (!bruto) pendencias.push("valor_cobrado_ausente");
  const reembolso = Math.min(bruto, Math.max(0, Math.round(Number(at?.reembolso_valor_centavos) || 0)));
  const liquido = bruto - reembolso;

  // Repasse médico: regra vigente em medico-ganhos.js.
  let repasse = null;
  const tipo = String(at?.tipo || "").trim().toLowerCase();
  if (tipo.startsWith("renovacao")) {
    repasse = 0;
  } else if (!medico || !medico.email) {
    pendencias.push("medico_nao_identificado");
  } else {
    const faixa = classificarFaixaMedico(medico, adminEmail);
    if (faixa === "admin") {
      repasse = 0;
    } else {
      const encerrado = at?.encerrado_em ? new Date(at.encerrado_em) : null;
      const antesDaRegra = encerrado && encerrado < new Date(GANHOS_INICIO_ISO);
      if (!encerrado) {
        pendencias.push("consulta_nao_encerrada");
      } else if (antesDaRegra && !estimarAntesDaRegra) {
        pendencias.push("repasse_antes_da_regra_vigente");
      } else {
        // Antes de 16/11 só como estimativa (regra atual aplicada ao passado), nunca para envio ao Google.
        if (antesDaRegra) pendencias.push("repasse_estimado_regra_atual");
        const { elegivel, motivo } = classificarAtendimentoGanhos(at);
        if (elegivel) repasse = valorPorAtendimentoCentavos(faixa);
        else if (MOTIVOS_SEM_REPASSE.has(motivo)) repasse = 0;
        else pendencias.push(`repasse_sem_regra:${motivo}`);
      }
    }
  }

  // Taxa do meio de pagamento, sobre o valor cobrado (não é devolvida no estorno).
  const { gateway, metodo } = identificarGateway(at);
  let taxaGateway = null;
  const taxaReal = at?.taxa_gateway_real_centavos;
  if (taxaReal !== null && taxaReal !== undefined && Number.isFinite(Number(taxaReal))) {
    taxaGateway = Math.round(Number(taxaReal));
  } else if (bruto) {
    const t = taxas.taxa(gateway, metodo);
    if (t) taxaGateway = pontosBaseCentavos(bruto, t.pontosBase) + t.fixaCentavos;
    else pendencias.push(`taxa_nao_configurada:${gateway}_${metodo}`);
  }

  // Imposto sobre a receita efetivamente retida (líquido de estorno).
  let imposto = null;
  if (taxas.impostoPontosBase !== null) imposto = pontosBaseCentavos(liquido, taxas.impostoPontosBase);
  else pendencias.push("imposto_nao_configurado");

  // Receita física: o frete cobrado do paciente é custo de envio pago pela empresa.
  const custoEnvio = tipo === "renovacao_fisica" && Number(at?.frete_valor) > 0 ? Math.round(Number(at.frete_valor) * 100) : 0;
  const contribuicao = repasse === null ? null : liquido - repasse - custoEnvio;
  const margem = contribuicao === null ? null : contribuicao - (taxaGateway ?? 0) - (imposto ?? 0);

  return {
    brutoCentavos: bruto,
    reembolsoCentavos: reembolso,
    liquidoCentavos: liquido,
    repasseCentavos: repasse,
    custoEnvioCentavos: custoEnvio,
    taxaGatewayCentavos: taxaGateway,
    impostoCentavos: imposto,
    contribuicaoCentavos: contribuicao,
    margemCentavos: margem,
    gateway,
    metodo,
    completo: pendencias.length === 0,
    pendencias,
    versaoRegra: MARGEM_VERSAO_REGRA
  };
}

// Ids de ações que NUNCA podem receber a margem (compra principal e compra servidor).
export function validarAcaoMargem(acaoMargemId, idsCompra = []) {
  const id = String(acaoMargemId || "").trim();
  if (!/^\d+$/.test(id)) return { ok: false, erro: "acao_margem_invalida" };
  const proibidos = new Set(idsCompra.map(v => String(v || "").trim()).filter(Boolean));
  if (proibidos.has(id)) return { ok: false, erro: "acao_margem_igual_a_compra" };
  return { ok: true, id };
}

// Identificador próprio da margem: nunca coincide com o da compra (id puro).
export function transactionIdMargem(atendimentoId) {
  return `m-${atendimentoId}`;
}
