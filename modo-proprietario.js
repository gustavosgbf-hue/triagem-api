// Modo proprietário: reserva temporária das consultas imediatas para o administrador, com liberação automática.
// Segurança do paciente acima de tudo:
//  - reserva curta (padrão 3 min, máx. 5); depois a consulta vai para toda a equipe (liberarPrioridadesVencidas);
//  - não reserva se o admin estiver fora do plantão, com atendimentos demais em curso ou reservas acumuladas;
//  - desliga sozinho ao fim do prazo escolhido ou após 2 reservas seguidas que expiraram sem ele assumir;
//  - ao desligar, libera na hora as reservas ainda abertas.
export const PADRAO_PROPRIETARIO = Object.freeze({ ativo: false, ate: null, minutos_reserva: 3, max_simultaneos: 3, max_reservados: 2, max_expiradas_seguidas: 2 });

export function avaliarReserva({ modo, admin, emAtendimento, reservadosAbertos, agora = new Date(), at }) {
  const m = { ...PADRAO_PROPRIETARIO, ...(modo || {}) };
  if (!m.ativo) return { reservar: false, motivo: "desligado" };
  if (m.ate && new Date(m.ate) <= agora) return { reservar: false, motivo: "prazo_encerrado" };
  if (!admin || admin.status_online !== true) return { reservar: false, motivo: "fora_do_plantao" };
  if (emAtendimento >= m.max_simultaneos) return { reservar: false, motivo: "atendimentos_em_curso" };
  if (reservadosAbertos >= m.max_reservados) return { reservar: false, motivo: "reservas_acumuladas" };
  const tipo = String(at?.tipo || "").toLowerCase();
  if (!["chat", "video"].includes(tipo) || at?.especialidade_solicitada || at?.horario_agendado
      || String(at?.categoria_atendimento || "clinico") === "especialista_imediato") return { reservar: false, motivo: "tipo_nao_elegivel" };
  return { reservar: true, minutos: Math.min(5, Math.max(1, Number(m.minutos_reserva) || 3)) };
}

export function criarModoProprietario({ pool, adminEmail, log = console }) {
  let cache = { em: 0, modo: null };
  async function lerModo(forcar = false) {
    if (!forcar && cache.modo && Date.now() - cache.em < 10_000) return cache.modo;
    let modo = { ...PADRAO_PROPRIETARIO };
    try {
      const { rows } = await pool.query(`SELECT config->'modo_proprietario' m FROM autopilot_config WHERE id=1`);
      if (rows[0]?.m) modo = { ...modo, ...rows[0].m };
    } catch (_) {}
    cache = { em: Date.now(), modo };
    return modo;
  }
  async function gravarModo(parcial) {
    const atual = await lerModo(true);
    const novo = { ...atual, ...parcial };
    await pool.query(`CREATE TABLE IF NOT EXISTS autopilot_config (id INT PRIMARY KEY DEFAULT 1, config JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (id=1))`);
    await pool.query(`INSERT INTO autopilot_config (id, config) VALUES (1, jsonb_build_object('modo_proprietario', $1::jsonb))
                      ON CONFLICT (id) DO UPDATE SET config = autopilot_config.config || jsonb_build_object('modo_proprietario', $1::jsonb), atualizado_em=NOW()`,
      [JSON.stringify(novo)]);
    cache = { em: Date.now(), modo: novo };
    return novo;
  }
  async function admin() {
    const { rows } = await pool.query(`SELECT id, email, status_online FROM medicos WHERE LOWER(TRIM(email))=$1 AND ativo=true LIMIT 1`, [adminEmail]);
    return rows[0] || null;
  }

  // Chamado antes de notificar a equipe. Devolve true se a consulta ficou reservada para o admin.
  async function tentarReservar(at) {
    const modo = await lerModo();
    if (!modo.ativo) return false;
    const adm = await admin();
    if (!adm) return false;
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status='assumido' AND medico_id=$1)::int em_atendimento,
              COUNT(*) FILTER (WHERE status='aguardando' AND prioridade_medico_id=$1 AND prioridade_ate > NOW())::int reservados
         FROM fila_atendimentos WHERE status IN ('assumido','aguardando')`, [adm.id]);
    const av = avaliarReserva({ modo, admin: adm, emAtendimento: c.em_atendimento, reservadosAbertos: c.reservados, at });
    if (!av.reservar) { if (av.motivo !== "desligado") log.log?.("[PROPRIETARIO] sem reserva:", at?.id, av.motivo); return false; }
    const { rowCount } = await pool.query(
      `UPDATE fila_atendimentos SET prioridade_medico_id=$2, prioridade_ate=NOW() + ($3::text || ' minutes')::interval,
              prioridade_geral_notificada_em=NULL, prioridade_origem='proprietario'
        WHERE id=$1 AND status='aguardando' AND pagamento_status IN ('confirmado','isento_admin') AND prioridade_medico_id IS NULL`,
      [at.id, adm.id, av.minutos]);
    if (rowCount) log.log?.(`[PROPRIETARIO] #${at.id} reservado por ${av.minutos} min.`);
    return rowCount > 0;
  }

  // A cada 30 s: encerra o modo se preciso e libera reservas abertas na hora.
  async function vigiar() {
    const modo = await lerModo(true);
    const adm = await admin();
    let desligar = null;
    if (modo.ativo && modo.ate && new Date(modo.ate) <= new Date()) desligar = "prazo_encerrado";
    if (modo.ativo && adm && adm.status_online !== true) desligar = "fora_do_plantao";
    if (modo.ativo && adm && modo.ativado_em) {
      const { rows } = await pool.query(
        `SELECT medico_id FROM fila_atendimentos
          WHERE prioridade_origem='proprietario' AND prioridade_ate <= NOW() AND prioridade_ate > $1::timestamptz
          ORDER BY prioridade_ate DESC LIMIT $2`, [modo.ativado_em, modo.max_expiradas_seguidas || 2]);
      if (rows.length >= (modo.max_expiradas_seguidas || 2) && rows.every(r => Number(r.medico_id) !== Number(adm.id))) desligar = "reservas_expiradas";
    }
    if (desligar) { await gravarModo({ ativo: false, desligado_em: new Date().toISOString(), desligado_motivo: desligar }); log.log?.("[PROPRIETARIO] desligado:", desligar); }
    if (!modo.ativo || desligar) {
      // Libera reservas do modo ainda abertas: liberarPrioridadesVencidas avisa a equipe no próximo ciclo.
      await pool.query(`UPDATE fila_atendimentos SET prioridade_ate=NOW() WHERE prioridade_origem='proprietario' AND status='aguardando' AND prioridade_ate > NOW()`);
    }
  }

  async function participacao(dias = 7) {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE m.email ILIKE $1)::int suas, COUNT(*)::int total
         FROM fila_atendimentos f JOIN medicos m ON m.id=f.medico_id
        WHERE f.pagamento_status='confirmado' AND f.assumido_em > NOW() - ($2::int * INTERVAL '1 day')
          AND f.tipo IN ('chat','video') AND f.especialidade_solicitada IS NULL`, [adminEmail, dias]);
    return { suas: r.suas, total: r.total, fracao: r.total ? r.suas / r.total : null };
  }

  return { lerModo, gravarModo, tentarReservar, vigiar, participacao };
}
