// especialista-senha-reset.js
// Recuperação de senha do especialista por token de uso único.
//
// Antes: POST /api/especialista/esqueci-senha sobrescrevia a senha na hora e
// mandava uma senha temporária por e-mail (com cópia ao admin). Qualquer pessoa
// que soubesse o e-mail conseguia derrubar o acesso do especialista, e a senha
// trafegava em texto puro para duas caixas de e-mail.
//
// Agora:
//   1. /esqueci-senha gera 32 bytes aleatórios, grava SOMENTE o SHA-256 do token
//      com expiração e envia o link apenas para o e-mail da conta. A senha atual
//      continua válida. A resposta é sempre a mesma (não revela se a conta existe)
//      e o envio é assíncrono (tempo de resposta não depende da existência).
//   2. /redefinir-senha consome o token (UPDATE atômico condicionado ao hash e à
//      validade → uso único) e só então altera a senha.
//   3. Limites: rate limit por IP (injetado), por e-mail (memória) e por conta
//      (cooldown no banco); tentativas inválidas com um token real o invalidam.
//
// Módulo sem dependências de runtime pesadas (bcrypt/pool/e-mail são injetados)
// para ser testável com `node --test`.

import { createHash, randomBytes } from 'crypto';

export const RESET_TOKEN_BYTES = 32;
export const RESET_EXPIRA_MIN = 60;
export const RESET_COOLDOWN_SEG = 120;          // por conta, entre e-mails
export const RESET_MAX_POR_EMAIL = 3;           // por e-mail, por janela
export const RESET_JANELA_EMAIL_MS = 15 * 60 * 1000;
export const RESET_MAX_TENTATIVAS_TOKEN = 5;    // erros de validação com token real
export const SENHA_MIN = 8;
export const SENHA_MAX = 128;

export const MSG_GENERICA_ESQUECI = Object.freeze({
  ok: true,
  message: 'Se o e-mail existir na plataforma, enviamos as instruções de acesso.',
});
export const ERRO_TOKEN_INVALIDO = 'Link inválido ou expirado. Solicite uma nova recuperação de senha.';

// Tabelas suportadas (whitelist: o nome entra em SQL por interpolação).
const TABELAS_RESET = new Set(['especialistas', 'medicos']);
function tabelaSegura(tabela) {
  if (!TABELAS_RESET.has(tabela)) throw new Error('Tabela de recuperação de senha não suportada: ' + tabela);
  return tabela;
}

export function migracoesResetSenha(tabela) {
  const t = tabelaSegura(tabela);
  return [
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS senha_reset_hash TEXT`,
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS senha_reset_expira_em TIMESTAMPTZ`,
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS senha_reset_solicitado_em TIMESTAMPTZ`,
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS senha_reset_tentativas INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS senha_alterada_em TIMESTAMPTZ`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${t}_senha_reset_hash_uidx
       ON ${t} (senha_reset_hash) WHERE senha_reset_hash IS NOT NULL`,
  ];
}

export const MIGRACOES_RESET_ESPECIALISTA = migracoesResetSenha('especialistas');
export const MIGRACOES_RESET_MEDICO = migracoesResetSenha('medicos');

export function gerarTokenReset() {
  return randomBytes(RESET_TOKEN_BYTES).toString('base64url');
}

export function hashTokenReset(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Token no formato que nós geramos (43 chars base64url para 32 bytes). */
export function formatoTokenValido(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function normalizarEmail(email) {
  if (typeof email !== 'string') return '';
  const e = email.trim().toLowerCase();
  if (e.length < 3 || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '';
  return e;
}

export function validarNovaSenha(novaSenha, confirmarSenha) {
  if (typeof novaSenha !== 'string' || typeof confirmarSenha !== 'string' || !novaSenha) {
    return { ok: false, error: 'Informe e confirme a nova senha.' };
  }
  if (novaSenha !== confirmarSenha) return { ok: false, error: 'As senhas não coincidem.' };
  if (novaSenha.length < SENHA_MIN) return { ok: false, error: `A senha deve ter ao menos ${SENHA_MIN} caracteres.` };
  if (novaSenha.length > SENHA_MAX) return { ok: false, error: `A senha deve ter no máximo ${SENHA_MAX} caracteres.` };
  return { ok: true };
}

/** Limitador simples em memória (por chave), com limpeza periódica. */
export function criarLimitadorJanela({ max, janelaMs, agora = () => Date.now() }) {
  const mapa = new Map();
  return {
    permitir(chave) {
      const t = agora();
      const recentes = (mapa.get(chave) || []).filter(x => t - x < janelaMs);
      if (recentes.length >= max) { mapa.set(chave, recentes); return false; }
      recentes.push(t);
      mapa.set(chave, recentes);
      if (mapa.size > 5000) {
        for (const [k, v] of mapa) if (!v.some(x => t - x < janelaMs)) mapa.delete(k);
      }
      return true;
    },
  };
}

/** JWT emitido antes da última redefinição de senha não vale mais. */
export function tokenSessaoRevogado(iatSeg, senhaAlteradaEm) {
  if (!senhaAlteradaEm || !Number.isFinite(Number(iatSeg))) return false;
  const alterada = new Date(senhaAlteradaEm).getTime();
  if (!Number.isFinite(alterada)) return false;
  // Tolerância de 2 s (iat é truncado em segundos).
  return Number(iatSeg) * 1000 + 2000 < alterada;
}

/**
 * Cache em memória id → instante da última redefinição de senha, para revogar
 * JWTs sem consulta ao banco por request (o JWT de médico não carrega versão).
 */
export function criarRevogadorSessoes({ agora = () => Date.now() } = {}) {
  const mapa = new Map();
  return {
    registrar(id, alteradaEm) {
      const k = String(id ?? '');
      const t = new Date(alteradaEm).getTime();
      if (!k || !Number.isFinite(t)) return;
      if (!(mapa.get(k) >= t)) mapa.set(k, t);
    },
    revogado(id, iatSeg) {
      const t = mapa.get(String(id ?? ''));
      return t !== undefined && tokenSessaoRevogado(iatSeg, t);
    },
    limpar(maxIdadeMs) {
      const limite = agora() - maxIdadeMs;
      for (const [k, t] of mapa) if (t < limite) mapa.delete(k);
    },
    get tamanho() { return mapa.size; },
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function htmlEmailReset({ nome, link, expiraMin = RESET_EXPIRA_MIN, painelNome = 'Painel do Especialista' }) {
  return `<div style="background:#f5f5f5;padding:32px;font-family:sans-serif">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
      <h2 style="color:#1a1612;margin:0 0 12px">Redefinir senha — ${escapeHtml(painelNome)}</h2>
      <p style="color:#555;font-size:.9rem;margin-bottom:20px">Olá, ${escapeHtml(nome)}. Recebemos um pedido para redefinir a senha do seu acesso ao painel.</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 26px;border-radius:10px;background:#166534;color:#fff;font-weight:700;text-decoration:none">Criar nova senha</a>
      </p>
      <p style="color:#555;font-size:.85rem">O link vale por ${expiraMin} minutos e só pode ser usado uma vez. Sua senha atual continua funcionando até você criar a nova.</p>
      <p style="color:#999;font-size:.78rem;margin-top:16px">Se você não fez este pedido, ignore este e-mail — nada será alterado.</p>
    </div>
  </div>`;
}

/** Página mínima (sem recursos externos) que lê o token do fragmento (#token=…). */
export function htmlPaginaRedefinir({ apiPath = '/api/especialista/redefinir-senha', painelUrl, painelNome = 'Painel do Especialista' }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer"><title>Redefinir senha — ${escapeHtml(painelNome)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f5f5;margin:0;padding:24px;color:#1a1612}
main{max-width:420px;margin:40px auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
label{display:block;font-size:.85rem;margin:14px 0 6px}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #ccc;border-radius:8px;font-size:1rem}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:#166534;color:#fff;font-weight:700;font-size:1rem;cursor:pointer}
button:disabled{opacity:.6}.msg{margin-top:14px;font-size:.9rem}.err{color:#b91c1c}.ok{color:#166534}</style></head>
<body><main><h1 style="font-size:1.25rem;margin:0 0 8px">Criar nova senha</h1>
<p style="color:#555;font-size:.9rem;margin:0">${escapeHtml(painelNome)} — ConsultaJá24h</p>
<form id="f" autocomplete="off"><label for="s1">Nova senha (mín. ${SENHA_MIN} caracteres)</label>
<input id="s1" type="password" autocomplete="new-password" minlength="${SENHA_MIN}" maxlength="${SENHA_MAX}" required>
<label for="s2">Confirmar nova senha</label><input id="s2" type="password" autocomplete="new-password" minlength="${SENHA_MIN}" maxlength="${SENHA_MAX}" required>
<button id="b" type="submit">Salvar nova senha</button><div id="m" class="msg" role="status"></div></form>
<p id="voltar" style="display:none;margin-top:18px"><a href="${escapeHtml(painelUrl)}">Ir para o painel</a></p></main>
<script>(function(){var p=new URLSearchParams(location.hash.slice(1));var t=p.get('token')||'';
try{history.replaceState(null,'',location.pathname);}catch(e){}
var f=document.getElementById('f'),b=document.getElementById('b'),m=document.getElementById('m');
function msg(x,c){m.textContent=x;m.className='msg '+c;}
if(!/^[A-Za-z0-9_-]{43}$/.test(t)){b.disabled=true;msg(${JSON.stringify(ERRO_TOKEN_INVALIDO)},'err');return;}
f.addEventListener('submit',function(ev){ev.preventDefault();b.disabled=true;msg('Salvando…','');
fetch(${JSON.stringify(apiPath)},{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({token:t,novaSenha:document.getElementById('s1').value,confirmarSenha:document.getElementById('s2').value})})
.then(function(r){return r.json().catch(function(){return{ok:false}})}).then(function(d){
if(d&&d.ok){t='';f.querySelectorAll('input').forEach(function(i){i.value='';i.disabled=true});msg('Senha alterada. Entre no painel com a nova senha.','ok');document.getElementById('voltar').style.display='block';}
else{msg((d&&d.error)||'Não foi possível salvar. Tente novamente.','err');b.disabled=!!(d&&d.tokenInvalido);}})
.catch(function(){b.disabled=false;msg('Falha de conexão. Tente novamente.','err');});});})();</script></body></html>`;
}

/**
 * Registra as rotas. Dependências injetadas:
 *   pool, hashSenha(senha) → Promise<string>, enviarEmail({to,subject,html}) → Promise,
 *   rlLogin (middleware), medicoBloqueado(row) → bool, apiBaseUrl, painelUrl, log.
 */
export const PERFIL_RESET_ESPECIALISTA = Object.freeze({
  tabela: 'especialistas',
  esqueciPath: '/api/especialista/esqueci-senha',
  redefinirPath: '/api/especialista/redefinir-senha',
  paginaPath: '/especialista/redefinir-senha',
  painelNome: 'Painel do Especialista',
  logTag: '[ESP-RECOVERY]',
  rotulo: 'especialista',
});

export const PERFIL_RESET_MEDICO = Object.freeze({
  tabela: 'medicos',
  esqueciPath: '/api/medico/esqueci-senha',
  redefinirPath: '/api/medico/redefinir-senha',
  paginaPath: '/medico/redefinir-senha',
  painelNome: 'Painel Médico',
  logTag: '[MED-RECOVERY]',
  rotulo: 'médico',
});

export function registrarRotasRecuperacaoEspecialista(app, deps) {
  return registrarRotasRecuperacaoSenha(app, { ...deps, perfil: PERFIL_RESET_ESPECIALISTA });
}

/** Mesmo fluxo para a tabela `medicos` (JWT de médico, painel médico). */
export function registrarRotasRecuperacaoMedico(app, deps) {
  return registrarRotasRecuperacaoSenha(app, { ...deps, perfil: PERFIL_RESET_MEDICO });
}

/**
 * Fluxo genérico. deps extras: perfil (PERFIL_RESET_*), onSenhaRedefinida({id, alteradaEm})
 * — chamado após o consumo do token (ex.: revogar sessões em cache).
 */
export function registrarRotasRecuperacaoSenha(app, deps) {
  const {
    perfil = PERFIL_RESET_ESPECIALISTA,
    onSenhaRedefinida = () => {},
    pool, hashSenha, enviarEmail, rlLogin = (_q, _s, n) => n(),
    medicoBloqueado = () => false,
    apiBaseUrl = 'https://triagem-api.onrender.com',
    painelUrl = 'https://painel.consultaja24h.com.br/especialista.html',
    log = console,
    limitadorEmail = criarLimitadorJanela({ max: RESET_MAX_POR_EMAIL, janelaMs: RESET_JANELA_EMAIL_MS }),
    limitadorRedefinir = criarLimitadorJanela({ max: 10, janelaMs: 15 * 60 * 1000 }),
  } = deps;

  const T = tabelaSegura(perfil.tabela);
  const PAGINA_PATH = perfil.paginaPath;
  const TAG = perfil.logTag;

  app.post(perfil.esqueciPath, rlLogin, async (req, res) => {
    // Resposta idêntica em todos os caminhos; o trabalho segue em segundo plano.
    res.json(MSG_GENERICA_ESQUECI);
    try {
      const email = normalizarEmail(req.body?.email);
      if (!email || !limitadorEmail.permitir(email)) return;
      const token = gerarTokenReset();
      const tokenHash = hashTokenReset(token);
      // Só grava se a conta existe, está ativa e não pediu nos últimos RESET_COOLDOWN_SEG.
      // NÃO altera senha_hash: a senha atual continua válida até o token ser usado.
      const { rows } = await pool.query(
        `UPDATE ${T}
            SET senha_reset_hash = $2,
                senha_reset_expira_em = NOW() + make_interval(mins => $3::int),
                senha_reset_solicitado_em = NOW(),
                senha_reset_tentativas = 0
          WHERE id = (
                SELECT id FROM ${T}
                 WHERE LOWER(email) = $1 AND ativo = true
                 ORDER BY id ASC LIMIT 1)
            AND (senha_reset_solicitado_em IS NULL
                 OR senha_reset_solicitado_em < NOW() - make_interval(secs => $4::int))
        RETURNING id, nome, nome_exibicao, email`,
        [email, tokenHash, RESET_EXPIRA_MIN, RESET_COOLDOWN_SEG]
      );
      const esp = rows?.[0];
      if (!esp) return;
      if (medicoBloqueado(esp)) {
        await pool.query(`UPDATE ${T} SET senha_reset_hash = NULL, senha_reset_expira_em = NULL WHERE id = $1`, [esp.id]);
        return;
      }
      const link = `${apiBaseUrl}${PAGINA_PATH}#token=${token}`;
      await enviarEmail({
        to: esp.email,
        subject: 'Redefinir sua senha — ConsultaJá24h',
        html: htmlEmailReset({ nome: esp.nome_exibicao || esp.nome || '', link, painelNome: perfil.painelNome }),
      });
      log.log?.(`${TAG} Link de redefinição enviado ao ${perfil.rotulo} #${esp.id}`);
    } catch (e) {
      log.error?.(TAG + ' Erro (silencioso):', e.message);
    }
  });

  app.get(PAGINA_PATH, (_req, res) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.type('html').send(htmlPaginaRedefinir({ painelUrl, painelNome: perfil.painelNome, apiPath: perfil.redefinirPath }));
  });

  app.post(perfil.redefinirPath, rlLogin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ip = String(req.ip || 'sem-ip');
    if (!limitadorRedefinir.permitir(ip)) {
      return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde alguns minutos.' });
    }
    const { token, novaSenha, confirmarSenha } = req.body || {};
    const invalido = () => res.status(400).json({ ok: false, error: ERRO_TOKEN_INVALIDO, tokenInvalido: true });
    if (!formatoTokenValido(token)) return invalido();
    const tokenHash = hashTokenReset(token);
    try {
      const v = validarNovaSenha(novaSenha, confirmarSenha);
      if (!v.ok) {
        // Conta a tentativa; após o limite o token deixa de valer.
        const { rows } = await pool.query(
          `UPDATE ${T}
              SET senha_reset_tentativas = senha_reset_tentativas + 1,
                  senha_reset_hash = CASE WHEN senha_reset_tentativas + 1 >= $2 THEN NULL ELSE senha_reset_hash END
            WHERE senha_reset_hash = $1 AND senha_reset_expira_em > NOW()
          RETURNING senha_reset_hash IS NULL AS esgotado`,
          [tokenHash, RESET_MAX_TENTATIVAS_TOKEN]
        );
        if (!rows.length || rows[0].esgotado) return invalido();
        return res.status(400).json({ ok: false, error: v.error });
      }
      const novoHash = await hashSenha(novaSenha);
      // Consumo atômico: só um request consegue trocar a senha com este token.
      const { rows } = await pool.query(
        `UPDATE ${T}
            SET senha_hash = $2,
                precisa_trocar_senha = false,
                senha_alterada_em = NOW(),
                senha_reset_hash = NULL,
                senha_reset_expira_em = NULL,
                senha_reset_tentativas = 0
          WHERE senha_reset_hash = $1
            AND senha_reset_expira_em > NOW()
            AND ativo = true
        RETURNING id, senha_alterada_em`,
        [tokenHash, novoHash]
      );
      if (!rows.length) return invalido();
      try { onSenhaRedefinida({ id: rows[0].id, alteradaEm: rows[0].senha_alterada_em }); } catch (_) {}
      log.log?.(`${TAG} ${perfil.rotulo} #${rows[0].id} redefiniu a senha via token`);
      return res.json({ ok: true });
    } catch (e) {
      log.error?.(TAG + ' Erro ao redefinir:', e.message);
      return res.status(500).json({ ok: false, error: 'Não foi possível redefinir a senha agora.' });
    }
  });
}
