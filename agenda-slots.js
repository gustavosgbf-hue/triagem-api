// agenda-slots.js
// Cálculo de agenda SOB DEMANDA (sem materializar linhas no banco).
//
// Regras:
//  - Fuso oficial da agenda: America/Fortaleza (UTC-3, sem horário de verão).
//  - Horizonte máximo: 90 dias a partir de "agora".
//  - Cada requisição cobre uma janela curta (padrão 7, máx. 14 dias) e devolve
//    no máximo AGENDA_MAX_SLOTS_POR_REQUISICAO slots. O cliente pagina pela
//    próxima janela (`proximo_inicio`).
//  - Horários passados e horários que colidem com reservas ativas são removidos.
//  - Nunca inventa horário: só gera a partir da disponibilidade cadastrada.
//
// Módulo puro (sem I/O) para ser testável com `node --test`.

export const AGENDA_TZ = 'America/Fortaleza';
export const AGENDA_HORIZONTE_DIAS = 90;
export const AGENDA_JANELA_PADRAO_DIAS = 7;
export const AGENDA_JANELA_MAX_DIAS = 14;
export const AGENDA_MAX_SLOTS_POR_REQUISICAO = 120;
// Proteção contra disponibilidade gigante gravada pelo painel (JSONB/texto).
export const AGENDA_MAX_ITENS_DISPONIBILIDADE = 2000;
export const AGENDA_MAX_HORARIOS_POR_DIA = 48;

const DIA_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_HORA = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const dtfCache = new Map();
function getDtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    }));
  }
  return dtfCache.get(tz);
}

const WEEKDAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Partes de calendário de um instante no fuso informado. */
export function partesNoFuso(date, tz = AGENDA_TZ) {
  const parts = {};
  for (const p of getDtf(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    ano: Number(parts.year),
    mes: Number(parts.month),
    dia: Number(parts.day),
    hora: Number(parts.hour),
    minuto: Number(parts.minute),
    diaSemana: WEEKDAY_IDX[parts.weekday],
  };
}

function offsetMinutos(date, tz) {
  const p = partesNoFuso(date, tz);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, date.getUTCSeconds());
  return Math.round((comoUtc - date.getTime()) / MIN_MS);
}

/** Converte um horário de parede no fuso `tz` para o instante UTC correspondente. */
export function zonedParaUtc({ ano, mes, dia, hora = 0, minuto = 0 }, tz = AGENDA_TZ) {
  const palpite = Date.UTC(ano, mes - 1, dia, hora, minuto);
  let off = offsetMinutos(new Date(palpite), tz);
  let ts = palpite - off * MIN_MS;
  const off2 = offsetMinutos(new Date(ts), tz);
  if (off2 !== off) ts = palpite - off2 * MIN_MS;
  return new Date(ts);
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' do instante no fuso da agenda. */
export function dataLocal(date, tz = AGENDA_TZ) {
  const p = partesNoFuso(date, tz);
  return `${p.ano}-${pad2(p.mes)}-${pad2(p.dia)}`;
}

function parseDataLocal(str) {
  const m = RE_DATA.exec(String(str || '').trim());
  if (!m) return null;
  const ano = Number(m[1]); const mes = Number(m[2]); const dia = Number(m[3]);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return { ano, mes, dia };
}

function somarDias({ ano, mes, dia }, n) {
  const d = new Date(Date.UTC(ano, mes - 1, dia) + n * DIA_MS);
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

function diffDias(a, b) {
  return Math.round((Date.UTC(b.ano, b.mes - 1, b.dia) - Date.UTC(a.ano, a.mes - 1, a.dia)) / DIA_MS);
}

function fmtData({ ano, mes, dia }) { return `${ano}-${pad2(mes)}-${pad2(dia)}`; }

/**
 * Resolve a janela de consulta (paginação por janela de dias).
 * @returns {{ok:true, inicio:string, fim:string, dias:number, inicioUtc:Date, fimUtc:Date,
 *            limiteHorizonte:Date, proximoInicio:string|null} | {ok:false, error:string}}
 */
export function resolverJanela({ inicio, dias, agora = new Date(), tz = AGENDA_TZ,
  horizonteDias = AGENDA_HORIZONTE_DIAS, janelaPadrao = AGENDA_JANELA_PADRAO_DIAS,
  janelaMax = AGENDA_JANELA_MAX_DIAS } = {}) {
  const hoje = parseDataLocal(dataLocal(agora, tz));
  const ultimoDia = somarDias(hoje, horizonteDias); // inclusivo (limitado pelo instante abaixo)
  let ini = hoje;
  if (inicio !== undefined && inicio !== null && String(inicio).trim() !== '') {
    const parsed = parseDataLocal(inicio);
    if (!parsed) return { ok: false, error: 'Parâmetro inicio inválido (use AAAA-MM-DD)' };
    ini = diffDias(hoje, parsed) < 0 ? hoje : parsed;
  }
  if (diffDias(ini, ultimoDia) < 0) {
    return { ok: false, error: `Data fora do horizonte de ${horizonteDias} dias` };
  }
  let n = parseInt(dias, 10);
  if (!Number.isFinite(n) || n < 1) n = janelaPadrao;
  n = Math.min(n, janelaMax);
  // Não ultrapassa o horizonte
  const restantes = diffDias(ini, ultimoDia) + 1;
  n = Math.min(n, restantes);
  const fimExclusivo = somarDias(ini, n);
  const limiteHorizonte = new Date(agora.getTime() + horizonteDias * DIA_MS);
  const inicioUtc = zonedParaUtc({ ...ini, hora: 0, minuto: 0 }, tz);
  let fimUtc = zonedParaUtc({ ...fimExclusivo, hora: 0, minuto: 0 }, tz);
  if (fimUtc.getTime() > limiteHorizonte.getTime()) fimUtc = limiteHorizonte;
  const proximoInicio = diffDias(fimExclusivo, ultimoDia) >= 0 && fimUtc.getTime() < limiteHorizonte.getTime()
    ? fmtData(fimExclusivo)
    : null;
  return {
    ok: true,
    inicio: fmtData(ini),
    fim: fmtData(somarDias(fimExclusivo, -1)),
    dias: n,
    inicioUtc,
    fimUtc,
    limiteHorizonte,
    proximoInicio,
    _ini: ini,
  };
}

/**
 * Lê a disponibilidade semanal do psicólogo: {"0":["09:00"], "1":[...]} (0=Dom).
 * Aceita objeto ou string JSON. Retorna null quando não for estruturada
 * (ex.: texto livre) — nesse caso NÃO geramos horários.
 */
export function parseDisponibilidadeSemanal(raw) {
  let obj = raw;
  if (typeof obj === 'string') {
    const t = obj.trim();
    if (!t.startsWith('{')) return null;
    try { obj = JSON.parse(t); } catch (_) { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const semanal = {};
  let total = 0;
  for (const [k, v] of Object.entries(obj)) {
    const dow = Number(k);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6 || !Array.isArray(v)) continue;
    const horas = new Set();
    for (const item of v.slice(0, AGENDA_MAX_HORARIOS_POR_DIA)) {
      const m = RE_HORA.exec(String(item || '').trim());
      if (!m) continue;
      horas.add(`${pad2(Number(m[1]))}:${m[2]}`);
    }
    if (horas.size) {
      semanal[dow] = [...horas].sort();
      total += horas.size;
    }
  }
  return total ? semanal : null;
}

/** Gera slots da janela a partir da disponibilidade semanal (no fuso da agenda). */
export function gerarSlotsSemanais(semanal, janela, { agora = new Date(), tz = AGENDA_TZ, antecedenciaMin = 0 } = {}) {
  if (!semanal || !janela?.ok) return [];
  const minTs = agora.getTime() + antecedenciaMin * MIN_MS;
  const out = [];
  for (let i = 0; i < janela.dias; i++) {
    const dia = somarDias(janela._ini, i);
    const dow = new Date(Date.UTC(dia.ano, dia.mes - 1, dia.dia)).getUTCDay();
    for (const hhmm of semanal[dow] || []) {
      const [h, m] = hhmm.split(':').map(Number);
      const d = zonedParaUtc({ ...dia, hora: h, minuto: m }, tz);
      const ts = d.getTime();
      if (ts <= minTs) continue;
      if (ts < janela.inicioUtc.getTime() || ts >= janela.fimUtc.getTime()) continue;
      out.push(d);
    }
  }
  return out.sort((a, b) => a - b);
}

/** Converte item de disponibilidade explícita (ISO ou objeto) para Date. */
export function itemParaData(item) {
  const valor = item && typeof item === 'object' ? (item.iso || item.data || item.datetime) : item;
  if (valor === null || valor === undefined || valor === '') return null;
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d;
}

/** Filtra disponibilidade explícita (lista de instantes) para a janela. */
export function filtrarSlotsExplicitos(lista, janela, { agora = new Date(), antecedenciaMin = 0 } = {}) {
  if (!Array.isArray(lista) || !janela?.ok) return [];
  const minTs = agora.getTime() + antecedenciaMin * MIN_MS;
  const vistos = new Set();
  const out = [];
  for (const item of lista.slice(0, AGENDA_MAX_ITENS_DISPONIBILIDADE)) {
    const d = itemParaData(item);
    if (!d) continue;
    const ts = d.getTime();
    if (ts <= minTs || ts < janela.inicioUtc.getTime() || ts >= janela.fimUtc.getTime()) continue;
    if (vistos.has(ts)) continue;
    vistos.add(ts);
    out.push(d);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Remove slots que colidem com reservas ativas (sobreposição de intervalos
 * de `duracaoMin`): |slot - ocupado| < duração.
 */
export function removerOcupados(slots, ocupados, duracaoMin = 60) {
  const occ = (ocupados || [])
    .map((o) => (o instanceof Date ? o.getTime() : new Date(o).getTime()))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!occ.length) return slots.slice();
  const dur = duracaoMin * MIN_MS;
  return slots.filter((s) => {
    const ts = s.getTime();
    // busca binária do primeiro ocupado > ts - dur
    let lo = 0; let hi = occ.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (occ[mid] <= ts - dur) lo = mid + 1; else hi = mid; }
    return !(lo < occ.length && occ[lo] < ts + dur);
  });
}

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

export function formatarSlot(date, tz = AGENDA_TZ) {
  const p = partesNoFuso(date, tz);
  return {
    iso: date.toISOString(),
    data: `${p.ano}-${pad2(p.mes)}-${pad2(p.dia)}`,
    hora: `${pad2(p.hora)}:${pad2(p.minuto)}`,
    dia_semana: DIAS_SEMANA[p.diaSemana],
  };
}

/** Aplica o limite rígido de slots por requisição. */
export function limitarSlots(slots, limite = AGENDA_MAX_SLOTS_POR_REQUISICAO) {
  const max = Math.max(1, Math.min(AGENDA_MAX_SLOTS_POR_REQUISICAO, parseInt(limite, 10) || AGENDA_MAX_SLOTS_POR_REQUISICAO));
  return { slots: slots.slice(0, max), truncado: slots.length > max, limite: max };
}

/**
 * Validação de horário no momento da reserva: futuro, alinhado ao minuto e
 * dentro do horizonte. Não decide disponibilidade (isso é feito por quem chama).
 */
export function validarHorarioReserva(date, { agora = new Date(), horizonteDias = AGENDA_HORIZONTE_DIAS } = {}) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return { ok: false, error: 'Horário inválido' };
  const ts = date.getTime();
  if (ts % MIN_MS !== 0) return { ok: false, error: 'Horário inválido' };
  if (ts <= agora.getTime()) return { ok: false, error: 'Este horário já passou. Escolha outro.' };
  if (ts > agora.getTime() + horizonteDias * DIA_MS) {
    return { ok: false, error: `Agendamentos são aceitos para até ${horizonteDias} dias.` };
  }
  return { ok: true };
}

/** O instante corresponde a um horário da disponibilidade semanal (no fuso da agenda)? */
export function horarioPertenceSemanal(date, semanal, tz = AGENDA_TZ) {
  if (!semanal) return false;
  const p = partesNoFuso(date, tz);
  const hhmm = `${pad2(p.hora)}:${pad2(p.minuto)}`;
  return (semanal[p.diaSemana] || []).includes(hhmm);
}

/** Valida payload de disponibilidade enviado pelos painéis (tamanho). */
export function validarTamanhoDisponibilidade(valor) {
  if (Array.isArray(valor)) {
    if (valor.length > AGENDA_MAX_ITENS_DISPONIBILIDADE) {
      return { ok: false, error: `Disponibilidade excede ${AGENDA_MAX_ITENS_DISPONIBILIDADE} horários` };
    }
    return { ok: true };
  }
  if (typeof valor === 'string') {
    if (valor.length > 20000) return { ok: false, error: 'Disponibilidade muito longa' };
    return { ok: true };
  }
  return { ok: true };
}

/**
 * Pagina a lista já filtrada respeitando o limite rígido sem cortar um dia ao
 * meio: se estourar, devolve só os dias completos e aponta `proximoInicio`
 * para o primeiro dia omitido. Se nem o primeiro dia cabe, devolve o recorte.
 */
export function paginarSlotsPorDia(slots, { limite, proximoInicioJanela = null, tz = AGENDA_TZ } = {}) {
  const { slots: cortados, truncado, limite: max } = limitarSlots(slots, limite);
  const formatados = cortados.map((d) => formatarSlot(d, tz));
  if (!truncado) return { slots: formatados, truncado: false, limite: max, proximoInicio: proximoInicioJanela };
  const diaOmitido = formatarSlot(slots[max], tz).data;
  const completos = formatados.filter((s) => s.data !== diaOmitido);
  if (completos.length) return { slots: completos, truncado: true, limite: max, proximoInicio: diaOmitido };
  // Um único dia com mais horários que o limite: devolve o recorte e avança um dia.
  const prox = somarDias(parseDataLocal(diaOmitido), 1);
  return { slots: formatados, truncado: true, limite: max, proximoInicio: fmtData(prox) };
}
