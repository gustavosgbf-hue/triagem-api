# Distribuicao da fila clinica

Entre 15:00 e 21:00 no fuso `America/Fortaleza`, consultas clinicas imediatas por chat ou video recebem uma reserva operacional de 5 minutos para o admin.

Durante a reserva:

- somente o admin ve o atendimento disponivel na fila;
- toda a equipe recebe o e-mail normal para acompanhar o movimento da plataforma;
- os demais medicos nao recebem selo ou indicacao de prioridade;
- tentativas de assumir pelo painel ou por link antigo sao recusadas de forma atomica.

Se o atendimento continuar aguardando ao fim dos 5 minutos, ele passa a aparecer normalmente para a equipe sem um segundo disparo de e-mail. Se o admin o assumir durante a reserva, o caso nao aparece posteriormente como ja assumido na fila dos demais.

Agendamentos, renovacoes e atendimentos de especialista imediato nao usam essa reserva.
