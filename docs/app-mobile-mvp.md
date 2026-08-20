# ConsultaJá24h — arquitetura inicial do app mobile

## Objetivo

Criar a experiência mobile do ConsultaJá24h para iOS e Android reaproveitando o backend e os fluxos já existentes, sem substituir nem quebrar o site atual.

Princípio do projeto:

- Web continua sendo o principal canal de aquisição (Google/Meta/SEO).
- App do paciente vira o principal canal de retenção, retorno e acompanhamento.
- App profissional concentra fila imediata, agenda e atendimento.
- A API atual continua sendo o núcleo do negócio.

## Arquitetura atual identificada

### teleconsulta24h

Frontend público/paciente. Já contém:

- landing e checkout;
- triagem;
- atendimento por chat;
- página de confirmação;
- área do paciente (`paciente.html`);
- psicologia;
- especialistas;
- renovação de receita.

### consultaja24h-painel

Frontend profissional. Já contém:

- painel médico;
- painel de especialistas;
- painel de psicologia;
- cadastros e perfis profissionais;
- agenda e atendimento.

### triagem-api

Backend central. Já contém, entre outros:

- PostgreSQL;
- autenticação JWT;
- login/cadastro de pacientes;
- ativação de conta guest;
- conta do paciente e agendamentos;
- autenticação de médicos, psicólogos e especialistas;
- fila clínica;
- trava atômica para somente um médico assumir o atendimento;
- chat e arquivos;
- pagamentos PagBank e Efí;
- confirmação/polling/webhooks de pagamento;
- OpenAI server-side;
- Cloudflare R2;
- Memed;
- notificações por e-mail;
- tracking e Google Ads.

## O que será reaproveitado no app

### Reaproveitamento direto

- banco PostgreSQL;
- API em Node/Express;
- regras de pagamento;
- webhooks de pagamento;
- cadastro/login do paciente;
- tokens JWT;
- fila médica e regra de primeiro profissional a assumir;
- mensagens e anexos;
- psicologia;
- especialistas;
- perfis e agenda;
- OpenAI;
- R2;
- Memed;
- regras comerciais existentes.

### Precisa de adaptação

- armazenamento seguro de token no mobile (Keychain/Keystore em vez de localStorage);
- push notifications;
- registro dos dispositivos e push tokens;
- deep links;
- endpoints de home mobile agregando dados úteis em uma única resposta;
- arquivos clínicos privados com URLs temporárias assinadas;
- camada genérica de encaminhamentos entre profissionais;
- eventual unificação progressiva de profissionais/permissões.

### Novo

- frontend React Native;
- navegação nativa;
- push iOS/Android;
- biometria opcional;
- tela inicial orientada ao paciente recorrente;
- módulo de encaminhamentos/plano de cuidado;
- integrações externas como MFit quando aplicável.

## Aplicativos

### 1. ConsultaJá24h — Paciente

MVP:

1. Splash / restauração de sessão.
2. Login e cadastro usando a API atual.
3. Home.
4. Consulta médica imediata.
5. Triagem.
6. Pagamento.
7. Sala/chat de atendimento.
8. Meus atendimentos.
9. Especialistas.
10. Psicologia.
11. Perfil.
12. Notificações push.

Home inicial sugerida:

- Consultar médico agora;
- próximos atendimentos;
- histórico recente;
- especialistas;
- psicologia;
- serviços/encaminhamentos futuros.

O fluxo web atual não será removido.

### 2. ConsultaJá24h Profissionais

MVP:

1. Login.
2. Identificação do tipo/permissões do profissional.
3. Fila de pacientes disponíveis.
4. Push `Novo paciente aguardando`.
5. Botão `Assumir` usando a mesma trava atômica atual.
6. Atendimento por chat.
7. Histórico.
8. Agenda.
9. Perfil.
10. Valores/repasse quando aplicável.

Para especialistas/psicologia, o app mostra apenas os recursos pertinentes ao perfil.

## Fila imediata no app

A regra de negócio existente deve ser preservada.

Fluxo:

1. pagamento confirmado;
2. paciente entra em `aguardando`;
3. backend identifica profissionais elegíveis;
4. push é enviado;
5. profissional toca em `Assumir`;
6. app chama a rota de assumir;
7. banco altera o atendimento somente se ainda estiver `aguardando`;
8. primeiro profissional vence;
9. demais recebem atendimento indisponível/atualização da fila.

Não criar uma segunda lógica concorrente no app. A autoridade continua sendo o backend/PostgreSQL.

## Profissionais e serviços futuros

Evitar criar novos silos completos para cada profissão.

Objetivo progressivo: abstrair uma camada de profissional + capacidades/permissões, mantendo compatibilidade com as tabelas/rotas existentes enquanto a migração acontece.

Tipos previstos:

- médico;
- psicólogo;
- nutricionista;
- educador físico;
- outros profissionais futuramente.

Capacidades possíveis:

- atender fila imediata;
- atender por agenda;
- prescrever medicamentos (quando legalmente habilitado);
- emitir documentos clínicos (quando habilitado);
- criar plano alimentar;
- encaminhar;
- acompanhar plano de cuidado.

## Encaminhamentos e plano de cuidado

Novo conceito de domínio:

`encaminhamentos`

Campos mínimos esperados:

- paciente_id;
- profissional_origem;
- tipo_profissional_destino;
- profissional_destino opcional;
- motivo/resumo compartilhável;
- status;
- criado_em;
- aceito_em;
- concluido_em.

O profissional de destino não deve ganhar acesso automático a todo o prontuário do paciente. Compartilhamento deve obedecer finalidade, consentimento e escopo necessário.

No futuro, vários acompanhamentos podem ser agrupados em um `plano_de_cuidado`.

## Personal trainer / MFit

Não construir biblioteca própria de exercícios/vídeos no MVP.

Estratégia:

- ConsultaJá24h gerencia contratação, encaminhamento e vínculo com o profissional;
- MFit gerencia prescrição e execução detalhada dos treinos;
- app ConsultaJá24h pode exibir `Meu treino` e abrir o fluxo do MFit por link/deep link;
- integração mais profunda só será feita se houver API oficial útil.

Isso evita duplicar biblioteca de vídeos, exercícios e ferramentas já maduras no MFit.

## Nutrição

Primeira versão pode ser baseada em:

- contratação/agendamento;
- consulta;
- encaminhamento;
- acompanhamento dentro do plano de cuidado;
- integração externa, se uma ferramenta madura já resolver plano alimentar e diário.

Evitar construir um software completo de nutrição antes de validar necessidade.

## Programa de controle de peso / saúde metabólica

Deve ser tratado como programa clínico integrado, não como venda de medicamento.

Possíveis componentes:

- avaliação médica;
- acompanhamento médico;
- nutrição;
- atividade física;
- métricas de evolução;
- prescrição medicamentosa somente quando houver indicação clínica e por profissional habilitado.

## Segurança antes da expansão

Prioridades:

1. manter chaves e segredos apenas no backend;
2. guardar tokens mobile em armazenamento seguro;
3. transformar anexos clínicos do R2 em privados;
4. entregar arquivos por URL assinada/temporária ou proxy autenticado;
5. revisar autorização por recurso (paciente/profissional/atendimento);
6. logs de acesso a dados clínicos relevantes;
7. política de privacidade e consentimentos adequados ao app;
8. evitar expor dados sensíveis em push notification.

## Organização do backend

O `server.js` concentra grande parte do sistema em um único arquivo. Não é necessário migrar para microserviços.

Antes de adicionar vários módulos novos, evoluir gradualmente para um monólito modular, sem reescrever o que funciona:

```text
src/
  auth/
  pacientes/
  profissionais/
  atendimentos/
  fila/
  agenda/
  pagamentos/
  mensagens/
  arquivos/
  notificacoes/
  prescricoes/
  psicologia/
  encaminhamentos/
  ai/
```

A separação deve ser progressiva e coberta por testes, sem big-bang rewrite.

## Stack mobile proposta

React Native + TypeScript.

Motivos:

- um código-base para iOS/Android;
- proximidade com o ecossistema JavaScript já existente;
- boa integração com APIs REST;
- suporte maduro para push, deep links, câmera, arquivos e armazenamento seguro;
- possibilidade de Expo/EAS para acelerar build e distribuição, desde que nenhum requisito do projeto exija saída do managed workflow.

## Primeira entrega técnica

O primeiro marco não deve alterar produção.

Criar um repositório mobile separado e provar somente este fluxo:

`abrir app -> restaurar sessão/login -> /api/paciente/me -> home -> /api/paciente/agendamentos`

Critério de sucesso:

- mesmo paciente do site consegue entrar no app sem novo cadastro;
- token é armazenado de forma segura;
- dados retornados pela API atual aparecem corretamente;
- nenhuma mudança no checkout, fila ou pagamentos em produção.

Depois dessa prova, implementar Consulta Médica Agora e push da fila profissional.

## Sequência sugerida

### Fase 0 — preparação

- documentar APIs reutilizadas;
- mapear autenticação e autorização;
- definir contrato de endpoints mobile;
- preparar privacidade de arquivos clínicos;
- definir estrutura de push tokens.

### Fase 1 — paciente

- projeto React Native;
- autenticação;
- home;
- minha conta;
- agendamentos/histórico;
- navegação para serviços existentes.

### Fase 2 — consulta imediata

- triagem;
- pagamento;
- confirmação;
- atendimento/chat;
- documentos.

### Fase 3 — profissional

- app profissional;
- autenticação;
- fila;
- push;
- assumir atendimento;
- atendimento;
- histórico.

### Fase 4 — ecossistema

- encaminhamentos;
- nutrição;
- MFit;
- programas integrados;
- plano de cuidado.

## Regra principal de migração

O sistema web atual permanece funcionando durante todo o desenvolvimento.

Não alterar mecanismos críticos de pagamento, atribuição, fila ou atendimento apenas para acomodar o app se uma camada de compatibilidade/API puder resolver.
