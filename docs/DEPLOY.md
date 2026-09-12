# Guia de publicação — Foco de Elite

Como colocar a plataforma no ar em **https://focoelite.com.br**, configurar as integrações e manter o
sistema atualizado e com backup.

O caminho principal deste guia é uma **VPS Ubuntu 22.04** com Node 22, PostgreSQL 16, PM2 e Nginx.
No fim há uma alternativa mais simples em Railway ou Render com banco na Neon, para quem preferir não
administrar servidor.

Arquivos de apoio, todos neste diretório:

| Arquivo | Para que serve |
|---------|----------------|
| `docs/ecosystem.config.js` | Configuração do PM2 (como o processo Node roda e reinicia). |
| `docs/nginx-focoelite.conf` | Configuração completa do Nginx como proxy reverso com HTTPS. |
| `docs/backup-db.sh` | Script de backup diário do PostgreSQL, para agendar no cron. |

---

## Sumário

1. [Preparar o servidor](#1-preparar-o-servidor)
2. [PostgreSQL 16](#2-postgresql-16)
3. [Publicar a aplicação](#3-publicar-a-aplicação)
4. [PM2](#4-pm2)
5. [Nginx e HTTPS](#5-nginx-e-https)
6. [Firewall](#6-firewall)
7. [Backup diário](#7-backup-diário)
8. [Atualizar a aplicação](#8-atualizar-a-aplicação)
9. [Square Cloud (opção escolhida)](#9-square-cloud-opção-escolhida)
9b. [Alternativa: Railway ou Render com Neon](#9b-alternativa-railway-ou-render-com-neon)
10. [Asaas](#10-asaas)
11. [OpenRouter](#11-openrouter)
12. [SMTP](#12-smtp)
13. [DNS](#13-dns)
14. [Verificação final](#14-verificação-final)

---

## 1. Preparar o servidor

Uma VPS de 2 vCPU e 2 GB de RAM atende com folga o início da operação. Todos os comandos abaixo
partem de um acesso SSH como usuário com `sudo`.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw ca-certificates gnupg

# Node 22 LTS (repositório oficial NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v        # deve mostrar v22.x
npm -v
```

### Usuário de serviço

A aplicação não roda como root nem com o seu usuário pessoal.

```bash
sudo adduser --system --group --home /opt/focoelite --shell /bin/bash focoelite
sudo install -d -o focoelite -g focoelite -m 750 /opt/focoelite/app
sudo install -d -o focoelite -g focoelite -m 750 /var/log/focoelite
sudo install -d -o focoelite -g focoelite -m 750 /var/backups/focoelite
```

Fuso horário do servidor em horário de Brasília (importante para o cronograma e para as revisões):

```bash
sudo timedatectl set-timezone America/Sao_Paulo
```

---

## 2. PostgreSQL 16

```bash
sudo apt install -y postgresql-16 postgresql-client-16
# Em imagens que ainda trazem o PostgreSQL 14, use o repositório oficial:
#   sudo sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
#   curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
#   sudo apt update && sudo apt install -y postgresql-16

sudo systemctl enable --now postgresql
```

Crie o usuário e o banco (troque a senha por uma gerada aleatoriamente):

```bash
SENHA_BANCO="$(openssl rand -base64 24)"
echo "guarde esta senha: $SENHA_BANCO"

sudo -u postgres psql <<SQL
CREATE ROLE focoelite LOGIN PASSWORD '${SENHA_BANCO}';
CREATE DATABASE focoelite OWNER focoelite;
SQL
```

O banco escuta apenas em `localhost` na configuração padrão do Ubuntu — é o que queremos, já que a
aplicação roda no mesmo servidor. Confirme com `sudo ss -lntp | grep 5432`.

---

## 3. Publicar a aplicação

### Clonar

```bash
sudo -u focoelite -H bash
cd /opt/focoelite/app
git clone <url-do-repositorio> .
npm ci --omit=dev
```

> `npm ci --omit=dev` instala apenas as dependências de execução. As `devDependencies`
> (`chart.js`, `marked`, `dompurify`, `lucide-static`) servem só para regenerar os arquivos de
> `public/vendor/` e `public/assets/icons.svg`, que já estão versionados.

### Arquivo `.env`

```bash
cp .env.example .env
openssl rand -hex 48    # JWT_SECRET
openssl rand -hex 48    # ADMIN_JWT_SECRET
nano .env
```

Conteúdo mínimo para produção:

```ini
NODE_ENV=production
PORT=4100
APP_URL=https://focoelite.com.br
BRAND_NAME=Foco de Elite

DATABASE_URL=postgres://focoelite:SENHA_DO_BANCO@localhost:5432/focoelite
PGSSL=false

JWT_SECRET=<primeiro valor gerado>
ADMIN_JWT_SECRET=<segundo valor gerado, diferente do primeiro>
COOKIE_SECURE=true
TRUST_PROXY=1

OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=qwen/qwen3.8-flash
OPENROUTER_ESSAY_MODEL=qwen/qwen3.8-flash
OPENROUTER_MONTHLY_TOKEN_LIMIT=5000000

PAYMENT_PROVIDER=asaas
ASAAS_API_KEY=$aact_prod_...
ASAAS_ENV=production
ASAAS_WEBHOOK_TOKEN=<token aleatório de 32 a 255 caracteres>
REQUIRE_SUBSCRIPTION=true

SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USER=no-reply@focoelite.com.br
SMTP_PASS=...
SMTP_FROM="Foco de Elite <no-reply@focoelite.com.br>"

# O administrador não vem de variável: veja "Primeiro acesso ao painel" abaixo.
# Preencha estas três só se um dia precisar repor o acesso pelo terminal.
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_NAME=Guilherme
```

Proteja o arquivo, que guarda todos os segredos:

```bash
chmod 600 /opt/focoelite/app/.env
```

O servidor recusa subir em produção se `JWT_SECRET` e `ADMIN_JWT_SECRET` forem iguais, se tiverem
menos de 32 caracteres ou se `DATABASE_URL` estiver ausente. A mensagem de erro diz qual variável é.

### Migrations e seed

```bash
cd /opt/focoelite/app
npm run migrate        # cria o schema
npm run seed           # provas, áreas, matérias, assuntos, pesos, critérios de redação, planos
```

Não rode `npm run seed:demo` em produção: ele insere aulas e questões de exemplo.

### Primeiro acesso ao painel

O administrador não é criado por script nem por variável de ambiente. Com o servidor no ar, abra
`https://focoelite.com.br/admin/login`: enquanto o banco não tiver nenhum administrador, a tela pede
nome, e-mail e senha, cria a conta e entra já autenticado. A senha é guardada com hash no banco.

Feito isso, a rota de criação se fecha: uma segunda tentativa é recusada, e a tela volta a ser o
login normal. Por isso faça esse primeiro acesso você mesmo, logo depois de publicar, antes de
divulgar o endereço — quem chegar primeiro é quem cria a conta.

Se a senha se perder, o acesso se repõe pelo terminal, sem mexer no banco à mão:

```bash
node scripts/create-admin.js --email seu@email.com --password "senha forte"
```

Teste o processo uma vez em primeiro plano antes de entregar ao PM2:

```bash
npm start
# outro terminal:  curl -s localhost:4100/api/health
# Ctrl+C para encerrar
```

---

## 4. PM2

```bash
sudo npm install -g pm2
sudo -u focoelite -H bash -c 'cd /opt/focoelite/app && pm2 start docs/ecosystem.config.js --env production && pm2 save'

# Fazer o PM2 subir junto com o servidor
pm2 startup systemd -u focoelite --hp /opt/focoelite
# copie e execute a linha que o comando imprimir

# Rotação de logs
sudo -u focoelite -H pm2 install pm2-logrotate
```

Comandos do dia a dia (sempre como usuário `focoelite`):

```bash
pm2 status
pm2 logs focoelite --lines 100
pm2 reload focoelite     # recarrega sem derrubar
pm2 restart focoelite
```

O `docs/ecosystem.config.js` mantém uma única instância em modo `fork`. Isso é intencional: o rate
limit e o cache de configurações vivem na memória do processo. Rodar em cluster exige mover esses dois
para o Redis antes.

---

## 5. Nginx e HTTPS

```bash
sudo apt install -y nginx
sudo cp /opt/focoelite/app/docs/nginx-focoelite.conf /etc/nginx/sites-available/focoelite
sudo ln -sf /etc/nginx/sites-available/focoelite /etc/nginx/sites-enabled/focoelite
sudo rm -f /etc/nginx/sites-enabled/default
```

Antes de o certificado existir, o arquivo aponta para caminhos que ainda não estão lá. O caminho mais
simples é gerar os certificados primeiro, deixando apenas o bloco HTTP ativo:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d focoelite.com.br -d www.focoelite.com.br \
     --agree-tos -m contato@focoelite.com.br --redirect
sudo nginx -t && sudo systemctl reload nginx
```

Com os certificados emitidos, a configuração completa passa a valer:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

A renovação é automática (o pacote instala um timer do systemd). Para conferir:

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

O que a configuração do Nginx resolve, e que não pode ser esquecido em nenhum outro proxy:

* **`/api/billing/webhook`** passa sem buffering e recebe os eventos do Asaas. A aplicação valida o
  token secreto enviado no cabeçalho `asaas-access-token` antes de processar qualquer evento.
* **Streaming do tutor** (`/api/tutor/conversations/:id/messages`) roda com `proxy_buffering off` e
  timeout longo, senão a resposta chega toda de uma vez, no fim, em vez de aparecer palavra a palavra.
* **Correção de redação** (`/api/essays/:id/submit`) recebe timeout de 180 s, porque é uma chamada
  síncrona à OpenRouter que pode passar de um minuto.
* **`X-Forwarded-For` e `X-Forwarded-Proto`** são repassados, e no `.env` está `TRUST_PROXY=1`, para o
  rate limit enxergar o IP real do visitante e não o do proxy.
* Os cabeçalhos de segurança do Helmet vêm da aplicação. O Nginx acrescenta apenas HSTS,
  `X-Content-Type-Options` e `Referrer-Policy`; não duplique Content-Security-Policy.

---

## 6. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status verbose
```

As portas 4100 (Node) e 5432 (PostgreSQL) **não** são abertas: elas só respondem em `localhost`.

Recomendações adicionais: desligar o login por senha no SSH (`PasswordAuthentication no` em
`/etc/ssh/sshd_config`, usando chave), e instalar `fail2ban` para bloquear tentativas repetidas.

---

## 7. Backup diário

```bash
sudo install -m 750 -o focoelite -g focoelite \
     /opt/focoelite/app/docs/backup-db.sh /usr/local/bin/focoelite-backup

# testar antes de agendar
sudo -u focoelite -H /usr/local/bin/focoelite-backup

# agendar às 03:15 todos os dias
sudo -u focoelite -H crontab -e
```

Linha do cron:

```cron
15 3 * * * /usr/local/bin/focoelite-backup >> /var/log/focoelite/backup.log 2>&1
```

O script lê `DATABASE_URL` do `.env`, gera um dump no formato custom do `pg_dump` em
`/var/backups/focoelite`, confere se o arquivo tem tamanho plausível e apaga os anteriores a 14 dias
(ajustável em `RETENTION_DAYS`).

**Um backup que fica no mesmo disco do banco não protege contra a perda do servidor.** Descomente a
linha do `rclone` no fim do script e configure um destino externo (S3, Backblaze B2, Google Drive) ou
copie os dumps por `scp` para outra máquina.

Restaurar:

```bash
# banco novo, vazio
sudo -u postgres createdb -O focoelite focoelite_restore
pg_restore --dbname="postgres://focoelite:SENHA@localhost:5432/focoelite_restore" \
           --no-owner --no-privileges /var/backups/focoelite/focoelite-20260910-031500.dump
```

Teste a restauração pelo menos uma vez. Backup que nunca foi restaurado é uma suposição, não uma
garantia.

### Arquivos enviados pelo painel

Com `STORAGE_PROVIDER=squarecloud` (o caso da entrega), os arquivos ficam no Blob Storage e **não**
no servidor: não há pasta para copiar, e o dump do banco continua pequeno porque ele guarda só o
endereço de cada arquivo. Em compensação, o Blob passa a ser a única cópia — mantenha os originais
das videoaulas guardados fora da plataforma.

O que segue abaixo vale apenas para `STORAGE_PROVIDER=local`, quando a aplicação roda em servidor
próprio e grava em `/opt/focoelite/app/uploads`. Essa pasta **não está no Git** e **não entra no dump
do banco**: sem backup dela, uma restauração devolve a plataforma com todas as imagens quebradas.

Inclua a pasta no backup:

```bash
# junto do dump diário, na mesma janela do cron
tar -czf /var/backups/focoelite/uploads-$(date +%Y%m%d).tar.gz -C /opt/focoelite/app uploads
```

Confira também que ela sobrevive à atualização. Se você publicar clonando o repositório em uma pasta
nova a cada versão, mantenha os arquivos fora dela e crie um atalho:

```bash
sudo mkdir -p /var/lib/focoelite/uploads
sudo chown focoelite:focoelite /var/lib/focoelite/uploads
sudo -u focoelite ln -s /var/lib/focoelite/uploads /opt/focoelite/app/uploads
```

Limites em vigor: imagens até 5 MB, PDF até 20 MB. O tipo é conferido pelos primeiros bytes do
arquivo, não pelo que o navegador declara, e SVG é recusado de propósito, por ser executável. Se o
Nginx estiver na frente, o `client_max_body_size` precisa acompanhar (o arquivo de site já vem com
`25m`; confirme antes de subir um edital grande).

---

## 8. Atualizar a aplicação

```bash
sudo -u focoelite -H bash
cd /opt/focoelite/app

# 1. backup antes de qualquer coisa
/usr/local/bin/focoelite-backup

# 2. trazer o código novo
git pull --ff-only

# 3. dependências (só se package-lock.json mudou)
npm ci --omit=dev

# 4. migrations pendentes (só aplica o que ainda não rodou)
npm run migrate

# 5. recarregar
pm2 reload focoelite

# 6. conferir
pm2 logs focoelite --lines 50
curl -s https://focoelite.com.br/api/health
```

Se algo der errado, volte ao commit anterior (`git reset --hard <commit>`), rode `npm ci --omit=dev` e
`pm2 reload focoelite`. Migrations não têm reversão automática: por isso o backup do passo 1 é
obrigatório, e não opcional.

---

## 9. Square Cloud (opção escolhida)

A plataforma foi preparada para rodar na Square Cloud, com os arquivos no Blob Storage da própria
conta. Dois arquivos na raiz do projeto cuidam disso:

* **`squarecloud.app`** — configuração da aplicação (nome, memória, arquivo principal, subdomínio e
  comando de início).
* **`.squarecloudignore`** — o que não sobe: `node_modules`, testes, documentação e o `.env`.

O comando de início é `npm run start:cloud`, que antes de subir o servidor executa
`scripts/bootstrap.js`:

1. aplica as migrations pendentes;
2. garante o conteúdo base (provas, matérias, assuntos, critérios de redação, planos de estudo e os
   textos da página inicial);

Tudo é idempotente: publicar uma versão nova roda de novo sem duplicar nada e sem desfazer o que a
equipe editou pelo painel.

O administrador de propósito não entra nessa lista. Ele se cria no primeiro acesso a
`/admin/login` (veja "Primeiro acesso ao painel") e fica só no banco: nenhuma senha passa por
variável de ambiente, por log de deploy ou pelo repositório, e uma troca de senha feita no painel
não corre o risco de voltar sozinha ao valor antigo no próximo reinício.

### 9.1 Publicar

O jeito mais direto é conectar o repositório do GitHub no painel da Square Cloud: a cada versão nova
enviada para a branch `main`, o deploy acontece a partir dela, sem pacote manual.

A integração com o GitHub também transforma o conteúdo da branch em um pacote de aplicação nos
bastidores. Por isso o painel pode mostrar a mensagem genérica sobre um `.zip` quando o repositório
ultrapassa o limite de 100 MB, mesmo sem nenhum arquivo compactado ter sido enviado manualmente.
Dependências, caches e arquivos grandes não devem estar versionados.

1. Ou, se preferir o envio manual: gere o pacote com o conteúdo do projeto (sem `node_modules`) e
   envie pelo painel da Square Cloud, ou use a CLI oficial na pasta do projeto.
2. Ajuste `MEMORY` em `squarecloud.app` conforme o plano. 1024 MB atende bem; o envio de vídeo em si
   não consome memória proporcional ao arquivo, porque o conteúdo é repassado ao Blob em partes.
3. Ajuste `SUBDOMAIN` ou aponte o domínio próprio (item 13).

### 9.2 A porta 80, que é a falha silenciosa da plataforma

A Square Cloud encerra o HTTPS na borda e entrega o tráfego na **porta 80** do container. A
documentação é direta: *"aplicações dinâmicas devem se vincular ao host `0.0.0.0` e à porta `80`;
vincular a `localhost`/`127.0.0.1` ou qualquer outra porta causa um timeout do site"*.

Isso merece destaque porque o modo de falha é traiçoeiro: escutando na porta errada, **a aplicação
sobe, o log fica limpo e o endereço simplesmente não responde**. Não há erro para investigar.

A aplicação já resolve isso sozinha. A Square Cloud injeta a variável `SQUARECLOUD_APP_ID` no
processo, e é por ela que a aplicação reconhece onde está e passa a escutar na porta 80 — em vez de
depender de `NODE_ENV`, que a plataforma não define, ou de `PORT`, que a documentação não promete
injetar. O bind em `0.0.0.0` é explícito no código.

Ainda assim, **cadastre `PORT=80` nas variáveis de ambiente**. Com os dois caminhos, qualquer um
deles acerta. Uma `PORT` explícita sempre vence a detecção automática, o que mantém a aplicação
hospedável em qualquer outro lugar.

Confirme no log de deploy a linha final:

```
Foco de Elite v1.0.0 — production — 0.0.0.0:80 — https://focoelite.com.br
```

Se aparecer outra porta ali, o site vai dar timeout.

### 9.3 Variáveis de ambiente

No painel: abra a aplicação → aba **Settings** → seção **Environment Variables** (depois da
reformulação de dezembro de 2025 a tela aparece como **Secrets**). **Salve e reinicie a aplicação** —
as variáveis só entram em vigor no restart.

O `.env` do projeto está no `.squarecloudignore` e não sobe com o deploy, de propósito: nenhum
segredo passa pelo repositório, que é público. Então o painel é o caminho, não o arquivo.

```
NODE_ENV=production
PORT=80
APP_URL=https://focoelite.com.br
DATABASE_URL=postgres://usuario:senha@host:porta/focoelite
JWT_SECRET=...
ADMIN_JWT_SECRET=...
COOKIE_SECURE=true
TRUST_PROXY=1
STORAGE_PROVIDER=squarecloud
SQUARECLOUD_API_KEY=...
OPENROUTER_API_KEY=sk-or-v1-...
PAYMENT_PROVIDER=asaas
ASAAS_API_KEY=...
ASAAS_WEBHOOK_TOKEN=...
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=...
```

`HOST`, `PORT` e `SQUARECLOUD_APP_ID` aparecem na tela em cinza: são injetadas pela plataforma e não
precisam ser cadastradas. Cadastrar `PORT=80` mesmo assim não faz mal e serve de rede de segurança.

Gere os dois segredos de sessão com `openssl rand -hex 48` (precisam ser diferentes entre si e ter ao
menos 32 caracteres, senão a aplicação recusa subir em produção). A `SQUARECLOUD_API_KEY` é a chave
da conta, em Configurações da conta → API; é a mesma usada pelo Blob Storage.

`NODE_ENV` não é obrigatória aqui: encontrando `SQUARECLOUD_APP_ID` no ambiente, a aplicação assume
produção. Isso é deliberado e importa para a segurança — presumir desenvolvimento numa hospedagem
daria aos cookies e às sessões os valores de desenvolvimento, que são previsíveis e estão publicados
neste repositório, e o site subiria funcionando e aberto, sem erro nenhum no log. Ainda assim,
cadastre `NODE_ENV=production` explicitamente: é uma linha, e não depende de nenhuma dedução.

Se faltar alguma variável obrigatória, a aplicação não sobe e o log lista **todas** as que faltam de
uma vez, com o formato esperado de cada uma — não uma por publicação.

Limites do recurso, que importam para o certificado do banco: 256 variáveis por aplicação, 1024
caracteres na chave e **4096 caracteres no valor**.

Pela CLI oficial, em lote, a partir do seu `.env` local:

```bash
squarecloud app env set --from-file .env --app <appID>
```

Cuidado com `squarecloud app env replace`: ele substitui o conjunto inteiro e apaga o que não for
listado.

### 9.4 Banco de dados

A Square Cloud **tem** PostgreSQL gerenciado, e ele está incluído a partir do plano Standard — o
plano Pro cobre com folga. A versão oferecida é a **17**; o projeto foi desenvolvido na 16 e o schema
não usa nada específico de uma nem de outra.

No painel, em Bancos de dados, crie uma instância `postgres`. Dois detalhes que a documentação
avisa e que custam caro se passarem batidos:

* **Memória mínima de 1024 MB** para PostgreSQL. Abaixo disso a criação é recusada.
* **A senha e o certificado aparecem uma única vez.** *"Nem a senha nem o certificado podem ser
  recuperados depois"* — só resetados, o que invalida na hora quem estiver conectado. Copie os dois
  antes de fechar a tela.

Os bancos de lá **recusam conexão em texto puro** e exigem o certificado emitido para aquela
instância. Ao criar o banco você baixa três arquivos:

| Arquivo | O que é | Variável |
|---------|---------|----------|
| `certificate.pem` | certificado **e** chave do cliente no mesmo arquivo | `PGSSL_CERT` |
| `ca-certificate.crt` | a autoridade certificadora, que confere o servidor | `PGSSL_CA` |
| `private-key.key` | a chave sozinha, para clientes que a exigem separada | não é usada aqui |

A biblioteca `pg` aceita o `certificate.pem` como certificado e chave ao mesmo tempo, então bastam os
dois primeiros. **Copiar os arquivos para a pasta da aplicação não basta** — nada os lê sozinho; é
preciso apontar as variáveis.

O caminho recomendado é o conteúdo em **base64**, direto nas variáveis de ambiente: fica numa linha
só, não depende de arquivo nenhum sobreviver a uma republicação, e cabe no limite de 4096 caracteres
(o `certificate.pem` dá 3.780 e o `ca-certificate.crt`, 1.508).

```bash
base64 -i certificate.pem | tr -d '\n'      # cole em PGSSL_CERT
base64 -i ca-certificate.crt | tr -d '\n'   # cole em PGSSL_CA
```

Se preferir arquivos, suba os dois pelo gerenciador de arquivos do painel e aponte
`PGSSL_CERT_FILE` e `PGSSL_CA_FILE` para eles — o caminho é relativo à raiz da aplicação, então basta
`PGSSL_CERT_FILE=certificate.pem`. Nesse caso, confira depois de cada republicação se os arquivos
continuam lá. É também a saída mais simples quando colar o conteúdo der errado.

Colar certificado em campo de painel costuma dar problema, e a aplicação já absorve o que dá para
absorver: aspas em volta, `\n` escrito literalmente, quebras de linha viradas espaço e base64 em
várias linhas chegam todos ao mesmo certificado. O que ela recusa é valor **cortado** — um PEM
truncado ainda mostra o `-----BEGIN`, e sem essa checagem a aplicação subiria para falhar só ao
conectar, com uma mensagem do OpenSSL que não diz onde está o erro.

**Nunca versione esses arquivos.** São credenciais e o repositório é público; o `.gitignore` bloqueia
`.pem`, `.key` e `.crt` justamente para que um `git add` distraído não vaze a chave do banco.

Se o arquivo apontado não existir, ou o valor não for um PEM, a aplicação recusa subir dizendo qual
variável está errada — em vez de subir e falhar na primeira consulta.

Com a `DATABASE_URL` e o certificado no lugar, a primeira publicação aplica as migrations e o
conteúdo base sozinha. Depois abra `/admin/login` para criar o administrador (item "Primeiro acesso
ao painel"). Para repor o acesso mais tarde:

```bash
node scripts/create-admin.js --email seu@email.com --password "senha forte"
```

**Alternativa externa**, se preferir não usar o banco da Square Cloud: a Neon tem região em São Paulo
(`aws-sa-east-1`), e aí basta a `DATABASE_URL` com `sslmode=require`, sem certificado. Duas ressalvas
do plano gratuito dela: o compute hiberna após 5 minutos de inatividade e não dá para desligar isso,
e os 100 CU-hours/mês não cobrem um processo no ar 24 horas por dia — para produção, o plano pago.

### 9.5 O que a plataforma faz com as dependências

Três comportamentos que explicam surpresas em publicações futuras:

* **`devDependencies` não são instaladas.** A instalação é em modo produção. No projeto isso é
  inofensivo: as bibliotecas de front-end (`chart.js`, `marked`, `dompurify`) só geram os arquivos de
  `public/vendor/`, que estão versionados e vão prontos para o servidor.
* **`node_modules` persiste entre publicações**, e a instalação só roda *se a pasta não existir*.
  Quando uma dependência nova entrar no `package.json`, ela pode não ser instalada na publicação
  seguinte. Nesse caso, apague `node_modules` pelo gerenciador de arquivos e reinicie.
* **`package-lock.json` é ignorado** — a instalação usa `npm install --no-package-lock`. Ou seja, a
  árvore de dependências da Square Cloud não é necessariamente idêntica à da sua máquina.

Sobre o runtime: `VERSION=recommended` resolve hoje para **Node.js 24.15.0** (foi o que apareceu no
log do primeiro deploy). É um alias móvel — quando a Square Cloud promover o trilho, a aplicação
troca de versão maior do Node sozinha no próximo restart. A documentação aceita fixar uma versão
exata em `VERSION`, se um dia preferir previsibilidade a atualização automática.

E sobre reinício automático: com `AUTORESTART=true`, a plataforma só reinicia uma aplicação que caiu
se o uptime anterior passou de 60 segundos, a saída foi código 1 e não houve outro reinício
automático na última hora. Consequência prática: **se o `bootstrap.js` falhar rápido — por exemplo
por falta da `DATABASE_URL` — não há reinício nenhum, e a aplicação fica fora do ar até você
reiniciar na mão.** Não existe ciclo de reinícios com migrations rodando repetidamente.

Os logs do painel são as últimas 1000 linhas, sem histórico. Log antigo se perde.

### 9.6 Arquivos no Blob Storage

Com `STORAGE_PROVIDER=squarecloud`, tudo que a equipe envia pelo painel — videoaula, miniatura, logo,
print de depoimento, PDF de edital e de prova — vai para o Blob e é servido pelo CDN da Square Cloud,
em `public-blob.squarecloud.dev`. O banco guarda só o endereço.

As provas históricas que acompanham o conteúdo inicial também ficam no Blob. Seus endereços públicos
estão registrados em `server/db/seed/data/curated_asset_urls.json`; o bootstrap usa esse manifesto
para criar instalações novas e para trocar URLs locais antigas sem duplicar registros. Os PDFs não
devem voltar para `public/assets/past-exams/`, pois fariam o pacote do GitHub ultrapassar o limite.
Caso seja preciso republicá-los a partir de uma cópia local organizada nas pastas `enem/` e
`barro-branco/`, use:

```bash
npm run publish:curated-pdfs -- "/caminho/para/past-exams"
```

O que isso significa na prática:

* **A aplicação não guarda arquivo.** Publicar uma versão nova não apaga nada, e a pasta `uploads/`
  do projeto deixa de existir em produção.
* **Vídeo até 1 GB.** Acima de 100 MB o envio é dividido em partes automaticamente. Se uma parte
  falhar, o envio inteiro é abortado para não deixar pedaço órfão consumindo cota.
* **O backup do banco não carrega os vídeos**, o que mantém o dump pequeno. Em compensação, o Blob é
  a única cópia dos arquivos: mantenha os originais das aulas guardados fora da plataforma.
* **Trocar de provedor** é questão de configuração: `STORAGE_PROVIDER=local` volta a gravar em disco,
  útil para rodar na sua máquina. Os endereços já gravados continuam funcionando.

Limites e regras do Blob que a plataforma já respeita, conforme a documentação oficial:

| Regra | Valor |
|-------|-------|
| Tamanho mínimo por arquivo | 512 bytes |
| Envio em uma requisição | até 100 MB |
| Envio em partes | acima de 100 MB, até 1 GiB |
| Tamanho de cada parte | 5 MB a 32 MB (a última pode ser menor) |
| Máximo de partes | 205 por arquivo |
| Envios simultâneos | 4 simples, 8 em partes |
| Tipos recusados pelo Blob | executáveis e instaladores |

O plano **Pro** não tem o limite de um envio por segundo dos planos Hobby e Standard, o que importa
no envio em massa de aulas. Os valores de parte não ficam presos no código: a plataforma usa os que o
próprio servidor informa ao abrir cada envio.

Chunks de um envio interrompido contam para a cota por cerca de 24 horas. Por isso, se uma parte
falha, a plataforma aborta o envio inteiro em vez de deixar pedaço solto.

---

## 9b. Alternativa: Railway ou Render com Neon

Para quem prefere não administrar servidor. O custo mensal costuma ser parecido, e não há Nginx,
Certbot, PM2 nem firewall para manter — em troca, o controle sobre a máquina é menor.

### Banco na Neon

1. Crie um projeto em [neon.tech](https://neon.tech) na região `aws-us-east-1` (ou a mais próxima).
2. Copie a connection string (formato `postgres://usuario:senha@host/neondb?sslmode=require`).
3. Ela vai para `DATABASE_URL`, e defina também `PGSSL=true`.

### Railway

1. **New Project → Deploy from GitHub repo** e escolha o repositório.
2. Em **Variables**, cadastre todas as variáveis da seção 4 do README. `PORT` é injetada pela
   plataforma — a aplicação já a respeita. `APP_URL` recebe o domínio final.
3. Em **Settings → Deploy**, confirme:
   * Build: `npm ci --omit=dev`
   * Start: `npm start`
4. Rode as migrations uma única vez pelo terminal do serviço (`railway run npm run migrate`, depois
   `npm run seed` e `npm run create-admin`).
5. Em **Settings → Networking → Custom Domain**, aponte `focoelite.com.br`. O certificado é emitido
   automaticamente.

### Render

1. **New → Web Service**, conectando o repositório.
2. Build Command: `npm ci --omit=dev` · Start Command: `npm start` · Health Check Path: `/api/health`.
3. Cadastre as variáveis de ambiente em **Environment**.
4. Rode `npm run migrate`, `npm run seed` e `npm run create-admin` no **Shell** do serviço.
5. Em **Settings → Custom Domain**, aponte o domínio e siga as instruções de DNS.

Pontos de atenção nas duas plataformas:

* O streaming do tutor exige que a plataforma não faça buffer de respostas — Railway e Render
  entregam SSE corretamente, mas confirme na primeira conversa de teste.
* O plano gratuito do Render hiberna o serviço após inatividade; a primeira requisição depois disso
  demora. Para produção, use um plano pago.
* O backup passa a ser responsabilidade do provedor do banco. Na Neon, ative o *point-in-time
  restore* e ainda assim mantenha um `pg_dump` periódico fora dela.

---

## 10. Asaas

### 10.1 Conta e credenciais

1. Crie uma conta separada no [Sandbox do Asaas](https://sandbox.asaas.com/) e gere uma chave de API.
2. No servidor de homologação, configure `PAYMENT_PROVIDER=asaas`, `ASAAS_ENV=sandbox` e a chave de
   Sandbox em `ASAAS_API_KEY`.
3. Em produção, use `ASAAS_ENV=production` e uma chave criada na conta real. Chaves e dados dos dois
   ambientes são independentes.

Os planos e preços são administrados dentro da própria plataforma em **/admin/planos**. O Asaas recebe
os itens, o valor e o ciclo a cada Checkout, por isso não existe catálogo externo para sincronizar.

### 10.2 Webhook

O webhook é a fonte de verdade que libera o teste, confirma pagamentos e bloqueia inadimplentes.

1. No Asaas, abra **Menu do usuário → Integrações → Webhooks** e crie um Webhook.
2. Use a URL **`https://focoelite.com.br/api/billing/webhook`** e a versão 3 da API.
3. Gere um token forte exclusivo, de 32 a 255 caracteres, e coloque o mesmo valor em
   `ASAAS_WEBHOOK_TOKEN`. Não reutilize a chave da API.
4. Selecione estes eventos:

   | Evento | O que a plataforma faz |
   |--------|------------------------|
   | `CHECKOUT_PAID` | Registra a conclusão do Checkout. |
   | `CHECKOUT_CANCELED` / `CHECKOUT_EXPIRED` | Encerra a tentativa correspondente. |
   | `SUBSCRIPTION_CREATED` | Vincula a assinatura ao aluno e inicia as 24h grátis quando elegível. |
   | `SUBSCRIPTION_DELETED` | Cancela a renovação e preserva somente o período já pago. |
   | `PAYMENT_CONFIRMED` / `PAYMENT_RECEIVED` | Confirma a cobrança e libera o período contratado. |
   | `PAYMENT_OVERDUE` | Marca a assinatura como atrasada. |
   | `PAYMENT_REFUNDED` / `PAYMENT_DELETED` | Revoga ou reavalia o acesso da cobrança. |

O token chega no cabeçalho `asaas-access-token`. Todos os eventos são registrados por ID antes de
alterar a assinatura, então uma reentrega do Asaas não duplica acesso nem pagamento.

### 10.3 Homologar o fluxo

1. Publique a aplicação com credenciais de Sandbox e configure o Webhook de Sandbox.
2. Crie um aluno e abra **Assinatura**.
3. Confirme que o plano mensal cobra imediatamente no cartão e no Pix.
4. Confirme que os planos de 6 e 12 meses oferecem 24h apenas no cartão; no Pix, a cobrança é imediata.
5. Conclua o Checkout e confira o evento no painel de Webhooks e a assinatura no painel administrativo.
6. Só depois repita a configuração com a conta e a chave de produção.

O retorno do navegador não libera acesso. A aplicação espera os Webhooks do Asaas, porque a URL de
sucesso do Checkout representa apenas redirecionamento, não confirmação financeira.

---

## 11. OpenRouter

Em uma instalação atualizada, remova as variáveis `OPENAI_*`: elas não são mais lidas. Cadastre as
variáveis `OPENROUTER_*` abaixo antes de publicar para manter os recursos de IA disponíveis.

1. Crie a chave em [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys), de preferência
   com um nome dedicado ("Foco de Elite").
2. Coloque a chave em `OPENROUTER_API_KEY` no `.env` do servidor. **A chave nunca vai para o navegador**:
   todas as chamadas saem do backend, e o painel mostra apenas o status e os últimos caracteres.
3. Modelos:
   * `OPENROUTER_MODEL=qwen/qwen3.8-flash` — tutor, geração de temas e tarefas leves.
   * `OPENROUTER_ESSAY_MODEL=qwen/qwen3.8-flash` — correção de redação. O backend usa raciocínio mínimo
     no tutor e baixo na correção para equilibrar velocidade, qualidade e consumo.
   * Consulte os identificadores atuais no [catálogo de modelos](https://openrouter.ai/models). Os dois podem ser trocados sem alterar código, tanto pelo `.env` quanto pelas configurações
     `openrouter_model` e `openrouter_essay_model` no painel.
4. Controle de custo, em três camadas:
   * `OPENROUTER_MONTHLY_TOKEN_LIMIT` (padrão 5.000.000) é o teto mensal somando todos os alunos. Ao ser
     atingido, as funções de IA passam a recusar novas chamadas com mensagem clara em vez de continuar
     gastando.
   * Rate limit de 30 chamadas por minuto por aluno.
   * No painel do próprio OpenRouter, defina um **limite de crédito** para a chave. É a proteção final.
5. Em **/admin/plataforma** o administrador acompanha o uso de IA por dia, por recurso e por aluno.

Sem a chave configurada, a plataforma continua funcionando: apenas o tutor, a correção de redação e a
geração de temas informam que a IA está indisponível no momento.

---

## 12. SMTP

O e-mail é usado para a recuperação de senha e para os avisos de aula particular. Sem ele, o aluno
que esquecer a senha **não consegue voltar sozinho** — só com alguém intervindo pelo painel.

A plataforma envia de duas formas, e escolhe sozinha: se `RESEND_API_KEY` existir, usa o Resend; se
não, usa o SMTP. Nenhuma das duas exige mudança no código.

### Qual usar

O Resend **só envia de um domínio verificado no painel dele** — a verificação é por registro de DNS,
então exige ser dono do domínio raiz. Subdomínio funciona (e é o recomendado), mas continua
dependendo do domínio raiz ser seu.

Enquanto `focoelite.com.br` não existir, há dois caminhos:

| | Remetente | Grátis | Observação |
|---|---|---|---|
| **Resend** com outro domínio seu | `no-reply@mail.<seu-dominio>` | 3.000/mês | Em uso hoje. O nome de exibição mostra "Foco de Elite". |
| **Brevo** por SMTP | um e-mail comum verificado | 300/dia | Alternativa sem domínio nenhum. |

### O arranjo atual (provisório)

O envio sai de **`perto-de-vencer.com`**, um domínio do desenvolvedor que já estava verificado no
Resend, porque `focoelite.com.br` ainda não foi registrado.

```ini
RESEND_API_KEY=re_...
SMTP_FROM="Foco de Elite <nao-responda@perto-de-vencer.com>"
```

O que o aluno vê na caixa de entrada é o **nome de exibição** — "Foco de Elite" — e não o domínio,
que só aparece se ele expandir o remetente.

> **Isto é uma ponte, não a configuração final.** Um aluno que olhe o endereço vai ver um domínio
> que não tem relação com a plataforma, e isso gera desconfiança justamente no e-mail de recuperação
> de senha, que já é alvo comum de golpe. Registrar `focoelite.com.br` resolve o e-mail, o endereço
> do site e a marca de uma vez — é item do checklist do cliente.

Um subdomínio (`mail.perto-de-vencer.com`) separaria melhor a reputação de envio do outro projeto,
mas exigiria cadastrar os registros de DNS e esperar a verificação. Como o arranjo é temporário e o
volume é baixo, o domínio raiz já verificado resolve sem espera.

### Quando `focoelite.com.br` existir

1. Em **Domains**, no Resend, adicione o domínio (ou `mail.focoelite.com.br`) e cadastre os registros
   de DNS que ele mostrar.
2. Espere virar **Verified**.
3. Troque uma variável na hospedagem e reinicie:

```ini
SMTP_FROM="Foco de Elite <no-reply@focoelite.com.br>"
```

A `RESEND_API_KEY` continua a mesma. Não há nada a mudar no código.

### Alternativa sem domínio nenhum: Brevo por SMTP

Deixe `RESEND_API_KEY` vazia e cadastre o SMTP. O Brevo aceita um e-mail comum como remetente, basta
verificá-lo em **Senders**:

```ini
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<o login que o Brevo mostra>
SMTP_PASS=<a chave SMTP gerada>
SMTP_FROM="Foco de Elite <seu-email-verificado>"
```

Havendo as duas configurações, o Resend é o usado.

### Conferir se funcionou

No painel, em **Configurações → E-mail**, o botão **Enviar e-mail de teste** dispara uma mensagem
para o seu endereço de administrador e diz o que aconteceu. Os dois erros possíveis pedem ações
diferentes, e a mensagem separa um do outro:

* **"recusou a conexão"** — chave ou credenciais erradas nas variáveis da hospedagem.
* **"recusou a mensagem"** — remetente ou domínio não verificado no provedor. A mensagem traz a
  explicação dele, que costuma dizer exatamente o que falta.

* Porta **587** usa STARTTLS (o padrão). Porta **465** exige `SMTP_SECURE=true`.
* O remetente precisa ser um endereço do domínio, autorizado por **SPF** e **DKIM** (registros
  fornecidos pelo provedor). Sem isso, o e-mail de recuperação vai para a caixa de spam.
* Configure também um registro **DMARC** simples: `v=DMARC1; p=none; rua=mailto:contato@focoelite.com.br`.
* Teste: acesse `/recuperar-senha`, informe um e-mail cadastrado e confira a chegada da mensagem.
* Sem `SMTP_HOST`, o servidor não tenta enviar nada e imprime o link de recuperação no log — útil em
  desenvolvimento, inaceitável em produção.

---

## 13. DNS

No painel do registrador do domínio (Registro.br, Cloudflare, GoDaddy…), aponte:

| Tipo | Nome | Valor | Observação |
|------|------|-------|------------|
| `A` | `@` | IP público da VPS | Registro principal. |
| `A` | `www` | IP público da VPS | O Nginx redireciona `www` para o domínio principal. |
| `AAAA` | `@` e `www` | IPv6 da VPS | Só se o servidor tiver IPv6. |
| `TXT` | `@` | `v=spf1 include:<provedor-smtp> ~all` | SPF do provedor de e-mail. |
| `TXT` | `<seletor>._domainkey` | fornecido pelo provedor | DKIM. |
| `TXT` | `_dmarc` | `v=DMARC1; p=none; rua=mailto:contato@focoelite.com.br` | DMARC. |

Se usar Railway ou Render, no lugar dos registros `A` entra um `CNAME` para o host que a plataforma
informar (e o `@` costuma exigir o recurso de *ALIAS/ANAME* do provedor de DNS, ou o proxy da
Cloudflare).

A propagação leva de alguns minutos a algumas horas. **Só rode o Certbot depois que o domínio já
resolver para o IP do servidor** — a validação do certificado depende disso.

```bash
dig +short focoelite.com.br
dig +short www.focoelite.com.br
```

---

## 14. Verificação final

Antes de qualquer coisa, rode a conferência automática no servidor:

```bash
npm run check
```

Ela lê a configuração e o banco e responde, em português, o que está pronto e o que falta: conexão com
o banco, migrations aplicadas, conteúdo base, administrador criado, segredos de sessão, armazenamento
de arquivos, OpenRouter, meio de cobrança, e-mail e endereço público. Sai com erro quando algo impede o
funcionamento, então serve também dentro de um script de publicação.

Depois, confira na mão:

Depois de tudo no ar, percorra esta lista:

```bash
curl -s https://focoelite.com.br/api/health          # {"ok":true,"version":"1.0.0","db":"ok",...}
curl -sI https://focoelite.com.br/ | head -n 1       # HTTP/2 200
curl -sI http://focoelite.com.br/ | head -n 1        # 301 para HTTPS
```

* [ ] A landing abre em `https://focoelite.com.br`, com cadeado válido, e os planos aparecem.
* [ ] O cadastro de um aluno de teste funciona, e o onboarding gera o cronograma do primeiro dia.
* [ ] O painel abre em `/admin/login` com o administrador criado, e o login do aluno **não** dá acesso a ele.
* [ ] Uma aula com vídeo enviado pelo painel reproduz normalmente, inclusive avançando a barra.
* [ ] O tutor responde com o texto aparecendo aos poucos (streaming funcionando através do proxy).
* [ ] Uma redação enviada volta corrigida, com nota por critério.
* [ ] Uma assinatura de teste libera o acesso, e o evento correspondente aparece no log de Webhooks do Asaas.
* [ ] O e-mail de recuperação de senha chega à caixa de entrada, e não ao spam.
* [ ] `pm2 status` mostra o processo `online`, e `pm2 startup` está configurado.
* [ ] O primeiro backup existe em `/var/backups/focoelite` e a linha do cron está ativa.
* [ ] `sudo ufw status` mostra apenas SSH e Nginx liberados.
* [ ] A senha inicial do administrador foi trocada.
