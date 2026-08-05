# Distribuicao da fila clinica

Entre 15:00 e 21:00 no fuso `America/Fortaleza`, consultas clinicas imediatas por chat ou video recebem uma reserva operacional de 5 minutos para o admin.

Durante a reserva:

- somente o admin ve o atendimento disponivel na fila;
- nenhum e-mail e enviado a equipe antes de o admin decidir se vai assumir;
- os demais medicos nao recebem selo ou indicacao de prioridade;
- tentativas de assumir pelo painel ou por link antigo sao recusadas de forma atomica.

Se o admin assumir durante a reserva, a equipe recebe entao o e-mail normal de paciente novo. O atendimento aparece no painel como ja assumido, sem identificar quem assumiu. O botao continua no e-mail, mas ao clicar tambem informa que o atendimento ja foi assumido.

Se o atendimento continuar aguardando ao fim dos 5 minutos, ele passa a aparecer normalmente e o e-mail acionavel e enviado a equipe.

Agendamentos, renovacoes e atendimentos de especialista imediato nao usam essa reserva.
