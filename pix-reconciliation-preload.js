// Reconcilia PIX de consultas mesmo quando o webhook não chega e o paciente fecha o app.
// Reutiliza a rota existente, que valida a cobrança no PagBank e executa os efeitos de confirmação.
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
let busy = false;
const INTERVAL_MS = 120000;
const LOOKBACK_HOURS = 48;
async function reconcile() {
  if (busy || !process.env.PAGBANK_TOKEN) return;
  busy = true;
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT pagbank_order_id AS order_id
        FROM fila_atendimentos
       WHERE pagamento_status='pendente'
         AND pagbank_order_id IS NOT NULL
         AND btrim(pagbank_order_id)<>''
         AND tipo NOT LIKE 'renovacao_%'
         AND COALESCE(status,'') NOT IN ('cancelado','expirado','arquivado')
         AND criado_em >= NOW() - ($1::text || ' hours')::interval
         AND criado_em <= NOW() - INTERVAL '2 minutes'
       ORDER BY order_id
       LIMIT 30
    `, [LOOKBACK_HOURS]);
    for (const row of rows) {
      try {
        const response = await fetch(`http://127.0.0.1:${process.env.PORT || 10000}/api/pagbank/order/${encodeURIComponent(row.order_id)}`, {
          signal: AbortSignal.timeout(12000),
          headers: { 'Cache-Control': 'no-store' },
        });
        if (!response.ok) console.warn('[PIX-RECONCILE] Gateway status HTTP', response.status);
        else {
          const data = await response.json();
          if (data.pago === true) console.log('[PIX-RECONCILE] Pedido confirmado pela rota de status');
        }
      } catch (error) {
        console.warn('[PIX-RECONCILE] Tentativa falhou:', error.message);
      }
    }
  } catch (error) {
    console.warn('[PIX-RECONCILE] Erro de consulta:', error.message);
  } finally {
    busy = false;
  }
}
// Aguarda a inicialização do servidor HTTP antes de consultar sua rota.
setTimeout(() => { void reconcile(); }, 45000).unref?.();
setInterval(() => { void reconcile(); }, INTERVAL_MS).unref?.();
