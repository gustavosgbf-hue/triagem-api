Preciso que você faça alguns ajustes no projeto atual do ConsultaJá24h.

O server.js já está funcionando, mas preciso melhorar o acesso aos relatórios e restaurar o log no Google Sheets.

Faça as seguintes alterações com cuidado para não quebrar o fluxo atual.

Permitir acesso ADMIN por URL

Hoje as rotas:

/relatorio
/identificacoes
/consentimentos

só funcionam quando a senha admin é enviada via header x-admin-password.

O navegador não envia esse header, então quero permitir também senha via query string.

Altere o middleware de verificação admin para aceitar:

header: x-admin-password

OU query: ?senha=

Exemplo de código esperado:

function checkAdmin(req, res, next) {
  const senha = req.headers["x-admin-password"] || req.query.senha;

  if (senha !== process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Acesso negado");
  }

  next();
}

Assim os links devem funcionar diretamente no navegador:

https://triagem-api.onrender.com/relatorio?senha=ADMIN_PASSWORD

https://triagem-api.onrender.com/identificacoes?senha=ADMIN_PASSWORD

https://triagem-api.onrender.com/consentimentos?senha=ADMIN_PASSWORD

Não remover o suporte ao header.

Restaurar log no Google Sheets

Antes o sistema salvava registros no Google Sheets e isso parou de funcionar.

Preciso restaurar essa integração.

Usar:

googleapis
service account JSON
SPREADSHEET_ID já existente no projeto

Planilha deve registrar:

IDENTIFICAÇÕES
nome
cpf
telefone
email
data
hora

CONSENTIMENTOS
cpf
aceitou_termos
data
hora

ATENDIMENTOS
id_atendimento
nome
cpf
telefone
modalidade
data
hora
status

Se a escrita no Sheets falhar, não quebrar o fluxo da API.

Apenas logar erro no console.

Melhorar endpoint /relatorio

O endpoint /relatorio deve mostrar:

atendimentos

identificações

consentimentos

status

horário

Formatado em tabela HTML simples para leitura no navegador.

Garantir que não quebre:

triagem.html
painel.html
chat
fila
meet_link
assumir atendimento
encerrar atendimento

Essas partes já estão funcionando e não devem ser alteradas.

Conferir se o retorno de /api/chat/enviar continua retornando:

{
  id,
  texto,
  autor,
  created_at
}

Porque o frontend depende disso.

Após implementar, me mostre:

trecho do novo middleware admin

trecho do Google Sheets funcionando

confirmação de que os 3 endpoints funcionam no navegador.
