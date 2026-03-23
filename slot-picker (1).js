/**
 * slot-picker.js
 * Módulo de seleção de horários com bloqueio de ocupados.
 *
 * Uso:
 *   const picker = SlotPicker.init({
 *     containerId:  'horarios-grid',   // id do elemento container
 *     psicologoId:  42,                // id do profissional
 *     apiBase:      'https://triagem-api.onrender.com',
 *     diasAfrente:  14,                // quantos dias gerar (default 14)
 *     horaInicio:   8,                 // hora inicial dos slots (default 8)
 *     horaFim:      19,                // hora final inclusive (default 19)
 *     maxSlots:     18,                // máximo de slots exibidos (default 18)
 *     onSelect:     (isoString) => {}  // callback quando slot é selecionado
 *   });
 *
 *   picker.reload();  // recarrega horários ocupados da API
 *   picker.reset();   // desmarca seleção atual
 */

const SlotPicker = (() => {

  // ─── Helpers de data ───────────────────────────────────────────────────────

  /**
   * Normaliza um ISO string para um inteiro comparável (YYYYMMDDHHOO),
   * zerando segundos e milissegundos para evitar bugs de comparação.
   * Usa horário local do Brasil (America/Fortaleza, UTC-3).
   */
  function normalizar(isoString) {
    const d = new Date(isoString);
    // Converte para horário de Fortaleza antes de extrair partes
    const brStr = d.toLocaleString('sv-SE', { timeZone: 'America/Fortaleza' }); // "YYYY-MM-DD HH:MM:SS"
    return brStr.slice(0, 16); // "YYYY-MM-DD HH:MM"
  }

  /**
   * Formata um Date para exibição no grid (ex: "qui, 27/03 · 14:00")
   */
  function formatar(date) {
    return date.toLocaleString('pt-BR', {
      timeZone: 'America/Fortaleza',
      weekday: 'short',
      day:     '2-digit',
      month:   '2-digit',
      hour:    '2-digit',
      minute:  '2-digit',
    }).replace(',', ' ·');
  }

  // ─── Geração de slots ──────────────────────────────────────────────────────

  /**
   * Gera array de Date, um por hora, nos próximos `dias` dias,
   * das `horaInicio` às `horaFim`, limitado a `maxSlots`.
   */
  function gerarSlots({ diasAfrente, horaInicio, horaFim, maxSlots }) {
    const slots = [];
    const agora  = new Date();

    for (let d = 1; d <= diasAfrente && slots.length < maxSlots; d++) {
      for (let h = horaInicio; h <= horaFim && slots.length < maxSlots; h++) {
        const slot = new Date(agora);
        slot.setDate(slot.getDate() + d);
        slot.setHours(h, 0, 0, 0);
        slots.push(slot);
      }
    }

    return slots;
  }

  // ─── Fetch de ocupados ─────────────────────────────────────────────────────

  async function buscarOcupados({ apiBase, psicologoId, diasAfrente }) {
    const url = `${apiBase}/api/psicologia/horarios-ocupados/${psicologoId}?dias=${diasAfrente}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Resposta inválida da API');
    return data.ocupados || [];
  }

  // ─── Renderização ──────────────────────────────────────────────────────────

  const STYLE_BASE = [
    'padding:8px 6px',
    'border-radius:8px',
    'font-size:.72rem',
    'font-family:inherit',
    'text-align:center',
    'line-height:1.3',
    'transition:all .15s',
  ].join(';');

  const STYLE_LIVRE = STYLE_BASE + ';' + [
    'border:1px solid rgba(38,80,142,.18)',
    'background:#e8eef7',
    'color:#26508e',
    'cursor:pointer',
  ].join(';');

  const STYLE_OCUPADO = STYLE_BASE + ';' + [
    'border:1px solid rgba(0,0,0,.08)',
    'background:#e0e0e0',
    'color:#aaa',
    'cursor:not-allowed',
    'text-decoration:line-through',
  ].join(';');

  const STYLE_SELECIONADO = STYLE_BASE + ';' + [
    'border:1px solid #26508e',
    'background:#26508e',
    'color:#fff',
    'cursor:pointer',
    'box-shadow:0 2px 8px rgba(38,80,142,.28)',
  ].join(';');

  function renderGrid({ container, slots, ocupadosSet, onSelect, state }) {
    container.innerHTML = '';

    if (!slots.length) {
      container.innerHTML = '<p style="color:#8c857d;font-size:.82rem;grid-column:1/-1">Nenhum horário disponível no momento.</p>';
      return;
    }

    slots.forEach(slot => {
      const iso      = slot.toISOString();
      const chave    = normalizar(iso);
      const ocupado  = ocupadosSet.has(chave);
      const label    = formatar(slot);

      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.textContent = label;
      btn.setAttribute('data-iso', iso);

      if (ocupado) {
        btn.disabled = true;
        btn.title    = 'Horário indisponível';
        btn.style.cssText = STYLE_OCUPADO;
      } else {
        btn.style.cssText = STYLE_LIVRE;

        btn.addEventListener('click', () => {
          // Previne double-click
          if (state.bloqueado) return;
          state.bloqueado = true;
          setTimeout(() => { state.bloqueado = false; }, 400);

          // Desmarca todos os livres, marca o clicado
          container.querySelectorAll('button:not(:disabled)').forEach(b => {
            b.style.cssText = STYLE_LIVRE;
          });
          btn.style.cssText = STYLE_SELECIONADO;
          state.horarioSelecionado = iso;

          onSelect(iso);
        });
      }

      container.appendChild(btn);
    });
  }

  // ─── Estado de loading ─────────────────────────────────────────────────────

  function mostrarLoading(container) {
    container.innerHTML = `
      <p style="color:#8c857d;font-size:.82rem;grid-column:1/-1;display:flex;align-items:center;gap:8px">
        <span style="display:inline-block;width:14px;height:14px;border:2px solid #c5d3e8;border-top-color:#26508e;border-radius:50%;animation:spin .7s linear infinite"></span>
        Carregando horários…
      </p>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
  }

  function mostrarErro(container, msg) {
    container.innerHTML = `<p style="color:#b91c1c;font-size:.8rem;grid-column:1/-1">${msg}</p>`;
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init(opcoes) {
    const cfg = {
      diasAfrente: 14,
      horaInicio:  8,
      horaFim:     19,
      maxSlots:    18,
      onSelect:    () => {},
      ...opcoes,
    };

    const container = document.getElementById(cfg.containerId);
    if (!container) throw new Error(`SlotPicker: elemento #${cfg.containerId} não encontrado`);

    const state = {
      horarioSelecionado: null,
      bloqueado: false,
    };

    const slots = gerarSlots(cfg);

    async function carregar() {
      mostrarLoading(container);
      state.horarioSelecionado = null;

      try {
        const ocupados    = await buscarOcupados(cfg);
        const ocupadosSet = new Set(ocupados.map(normalizar));
        renderGrid({ container, slots, ocupadosSet, onSelect: cfg.onSelect, state });
      } catch (e) {
        console.warn('[SlotPicker] Falha ao buscar ocupados:', e.message);
        mostrarErro(container, 'Não foi possível carregar os horários agora. Tente novamente.');
      }
    }

    // Carrega imediatamente
    carregar();

    // API pública do picker
    return {
      reload: carregar,
      reset() {
        state.horarioSelecionado = null;
        container.querySelectorAll('button:not(:disabled)').forEach(b => {
          b.style.cssText = STYLE_LIVRE;
        });
        cfg.onSelect(null);
      },
      getHorario() {
        return state.horarioSelecionado;
      },
    };
  }

  return { init };

})();
