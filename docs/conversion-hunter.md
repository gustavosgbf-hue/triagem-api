# Caçador de Conversões — MVP somente leitura

## O que já existe na ConsultaJá24h
- `payment-recovery-preload.js`: recuperação por push/e-mail, controlada por `PAYMENT_RECOVERY_ENABLED`.
- `pix-reconciliation-preload.js`: reconciliação PIX.
- Eventos de recuperação e acesso registrados em tabelas dedicadas.

**Este MVP NÃO substitui os serviços existentes.** Mede o volume de atendimentos criados, cobranças iniciadas (por identificadores Stripe/PagBank/Efi), pendências e confirmações, além dos eventos de recuperação agregados. Não lê informações clínicas nem dados pessoais identificáveis no resultado.

## Executar sob demanda

```bash
CONVERSION_HUNTER_HOURS=24 node scripts/conversion-hunter.mjs
```

Requer `DATABASE_URL` disponível no ambiente. Para produção, preferir usuário PostgreSQL com permissão apenas SELECT. Não colocar credenciais em logs ou arquivos versionados.

Saída: JSON com `funil_aproximado`, `recuperacao`, `alertas` e ressalvas metodológicas. A execução impõe transação READ ONLY, limite de 8 segundos por consulta e janela de 1 a 168 horas. Nenhuma chamada à API de IA é necessária para a coleta.

## Limites e próximos passos
1. Este não é um funil de sessão no frontend: não mede visita, clique no CTA nem exibição do checkout. Deve ser cruzado com GA4/analytics devidamente configurados.
2. Cobertura inicial: `chat`, `video`, `renovacao_digital`. Não inferir conversão de agendamento ou outras categorias.
3. A contagem de status pendente/confirmado não é uma métrica causal de recuperação. Para medir vendas efetivamente recuperadas, adicionar evento de reconciliação de pagamento associado à exposição e avaliar atribuição, evitando duplas contagens.
4. Alertas são triagem, não diagnóstico; limiares iniciais fixos devem ser calibrados com histórico e sazonalidade.
5. Antes de agendar, testar com leitura restrita e validar schema da produção. Não programar envio de mensagens, alterações Google Ads nem deploy automaticamente.
6. Orquestração futura: executar em cron isolado (não dentro do web server), salvar métricas agregadas, comparar com baseline por hora/dia, enviar alerta quando desvio for significativo e abrir issue/PR para revisão humana.
