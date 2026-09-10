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
9. [Alternativa: Railway ou Render com Neon](#9-alternativa-railway-ou-render-com-neon)
10. [Stripe](#10-stripe)
11. [OpenAI](#11-openai)
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

OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
OPENAI_ESSAY_MODEL=gpt-4o
OPENAI_MONTHLY_TOKEN_LIMIT=5000000

STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
REQUIRE_SUBSCRIPTION=true

SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USER=no-reply@focoelite.com.br
SMTP_PASS=...
SMTP_FROM="Foco de Elite <no-reply@focoelite.com.br>"

ADMIN_EMAIL=guilherme@focoelite.com.br
ADMIN_PASSWORD=<senha forte, trocada no primeiro acesso>
ADMIN_NAME=Guilherme
```

Proteja o arquivo, que guarda todos os segredos:

```bash
chmod 600 /opt/focoelite/app/.env
```

O servidor recusa subir em produção se `JWT_SECRET` e `ADMIN_JWT_SECRET` forem iguais, se tiverem
menos de 32 caracteres ou se `DATABASE_URL` estiver ausente. A mensagem de erro diz qual variável é.

### Migrations, seed e administrador

```bash
cd /opt/focoelite/app
npm run migrate        # cria o schema
npm run seed           # provas, áreas, matérias, assuntos, pesos, critérios de redação, planos
npm run create-admin   # cria o administrador a partir do .env
```

Não rode `npm run seed:demo` em produção: ele insere aulas e questões de exemplo.

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

* **`/api/billing/webhook`** passa sem buffering e com o corpo intacto — a assinatura do Stripe é
  validada sobre os bytes originais; qualquer reescrita quebra a validação.
* **Streaming do tutor** (`/api/tutor/conversations/:id/messages`) roda com `proxy_buffering off` e
  timeout longo, senão a resposta chega toda de uma vez, no fim, em vez de aparecer palavra a palavra.
* **Correção de redação** (`/api/essays/:id/submit`) recebe timeout de 180 s, porque é uma chamada
  síncrona à OpenAI que pode passar de um minuto.
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
  comando de início). O comando é `npm run start:cloud`, que aplica as migrations pendentes antes de
  subir o servidor, então publicar uma versão nova já atualiza o banco.
* **`.squarecloudignore`** — o que não sobe: `node_modules`, testes, documentação e o `.env`.

### 9.1 Publicar

1. Gere o pacote com o conteúdo do projeto (sem `node_modules`) e envie pelo painel da Square Cloud,
   ou use a CLI oficial na pasta do projeto.
2. Ajuste `MEMORY` em `squarecloud.app` conforme o plano. 1024 MB atende bem; o envio de vídeo em si
   não consome memória proporcional ao arquivo, porque o conteúdo é repassado ao Blob em partes.
3. Ajuste `SUBDOMAIN` ou aponte o domínio próprio (item 13).

### 9.2 Variáveis de ambiente

Cadastre no painel da Square Cloud, nunca no código:

```
NODE_ENV=production
APP_URL=https://focoelite.com.br
DATABASE_URL=postgres://usuario:senha@host:5432/focoelite
JWT_SECRET=...
ADMIN_JWT_SECRET=...
COOKIE_SECURE=true
STORAGE_PROVIDER=squarecloud
SQUARECLOUD_API_KEY=...
OPENAI_API_KEY=...
PAYMENT_PROVIDER=asaas
ASAAS_API_KEY=...
ASAAS_WEBHOOK_TOKEN=...
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=...
```

A `SQUARECLOUD_API_KEY` é a chave da conta, em Configurações da conta → API. É a mesma chave usada
pelo Blob Storage.

### 9.3 Banco de dados

A Square Cloud hospeda a aplicação, não o PostgreSQL. Use um banco gerenciado (Neon, Supabase ou
Railway) e informe a `DATABASE_URL` completa, com SSL. Depois da primeira publicação, crie o
administrador uma única vez, pelo terminal do painel:

```bash
node scripts/create-admin.js --email seu@email.com --password "senha forte"
```

### 9.4 Arquivos no Blob Storage

Com `STORAGE_PROVIDER=squarecloud`, tudo que a equipe envia pelo painel — videoaula, miniatura, logo,
print de depoimento, PDF de edital e de prova — vai para o Blob e é servido pelo CDN da Square Cloud,
em `public-blob.squarecloud.dev`. O banco guarda só o endereço.

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

## 10. Stripe

### 10.1 Produtos e preços

1. Entre no [dashboard do Stripe](https://dashboard.stripe.com) e conclua a ativação da conta (dados
   da empresa, conta bancária, documento). Sem isso, só o modo de teste funciona.
2. Deixe a moeda padrão em **BRL**.
3. Para cada plano da plataforma, crie em **Produtos → Adicionar produto**:
   * Nome igual ao do plano no painel administrativo (Mensal, 6 meses, 15 meses).
   * Preço **recorrente**, no valor e no período correspondentes.
4. Copie o `price_...` de cada preço.

O caminho mais prático é o inverso: cadastre os planos em **/admin/planos**, com nome, descrição,
valor, período e itens inclusos, e use o botão **Sincronizar com o Stripe**
(`POST /api/admin/plans/:id/sync-stripe`), que cria produto e preço na conta e grava os identificadores
no banco. Assim, painel e Stripe nascem consistentes.

### 10.2 Webhook

O webhook é o que faz a assinatura liberar e bloquear o acesso do aluno automaticamente.

1. **Desenvolvedores → Webhooks → Adicionar endpoint**.
2. URL: **`https://focoelite.com.br/api/billing/webhook`**
3. Versão da API: a mais recente oferecida.
4. Eventos a assinar (exatamente estes seis):

   | Evento | O que a plataforma faz |
   |--------|------------------------|
   | `checkout.session.completed` | Vincula o cliente do Stripe ao aluno e registra a assinatura recém-criada. |
   | `customer.subscription.created` | Grava status, plano e período da assinatura. |
   | `customer.subscription.updated` | Atualiza status, troca de plano, renovação e cancelamento agendado. |
   | `customer.subscription.deleted` | Marca a assinatura como cancelada e encerra o acesso ao fim do período. |
   | `invoice.paid` | Confirma o pagamento e estende o período de acesso. |
   | `invoice.payment_failed` | Marca a assinatura como inadimplente para a cobrança ser reavaliada. |

5. Copie o **Signing secret** (`whsec_...`) para `STRIPE_WEBHOOK_SECRET` no `.env` e recarregue a
   aplicação (`pm2 reload focoelite`).

Cada evento é validado pela assinatura criptográfica e registrado, de modo que uma reentrega do Stripe
não processa o mesmo evento duas vezes. Esta é a única rota da API que não exige o cabeçalho de
proteção contra CSRF, justamente porque é autenticada pela assinatura.

### 10.3 Testar com a CLI

```bash
# instalação (Linux)
curl -fsSL https://packages.stripe.com/api/security/keypair/stripe-cli-gpg/public | \
  sudo gpg --dearmor -o /usr/share/keyrings/stripe.gpg
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.com/stripe-cli-debian-local stable main" | \
  sudo tee /etc/apt/sources.list.d/stripe.list
sudo apt update && sudo apt install -y stripe

stripe login

# 1. encaminhar os eventos para a aplicação local (use as chaves de TESTE no .env)
stripe listen --forward-to localhost:4100/api/billing/webhook
# o comando imprime um whsec_... temporário: coloque em STRIPE_WEBHOOK_SECRET e reinicie o servidor

# 2. em outro terminal, disparar eventos
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
```

Fluxo completo de teste, ponta a ponta: crie um aluno, vá em **Assinatura**, escolha um plano e pague
com o cartão de teste `4242 4242 4242 4242` (qualquer validade futura e qualquer CVC). Confira que o
acesso liberou, que a assinatura aparece no perfil e que o portal de cobrança abre.

Ao migrar para produção, troque `sk_test_`/`whsec_` de teste pelas chaves `sk_live_` e pelo signing
secret do endpoint de produção, e refaça a sincronização dos planos — **produtos e preços do modo de
teste não existem no modo real**.

---

## 11. OpenAI

1. Crie a chave em [platform.openai.com/api-keys](https://platform.openai.com/api-keys), de preferência
   dentro de um projeto dedicado ("Foco de Elite").
2. Coloque a chave em `OPENAI_API_KEY` no `.env` do servidor. **A chave nunca vai para o navegador**:
   todas as chamadas saem do backend, e o painel mostra apenas o status e os últimos caracteres.
3. Modelos:
   * `OPENAI_MODEL=gpt-4o-mini` — tutor, geração de temas e tarefas leves. É o volume maior.
   * `OPENAI_ESSAY_MODEL=gpt-4o` — correção de redação, que precisa de mais qualidade na avaliação por
     critério.
   * Os dois podem ser trocados sem alterar código, tanto pelo `.env` quanto pelas configurações
     `openai_model` e `openai_essay_model` no painel.
4. Controle de custo, em três camadas:
   * `OPENAI_MONTHLY_TOKEN_LIMIT` (padrão 5.000.000) é o teto mensal somando todos os alunos. Ao ser
     atingido, as funções de IA passam a recusar novas chamadas com mensagem clara em vez de continuar
     gastando.
   * Rate limit de 30 chamadas por minuto por aluno.
   * No painel do próprio OpenAI, defina um **limite de gasto mensal** e um alerta por e-mail em
     **Settings → Limits**. É a rede de proteção final.
5. Em **/admin/plataforma** o administrador acompanha o uso de IA por dia, por recurso e por aluno.

Sem a chave configurada, a plataforma continua funcionando: apenas o tutor, a correção de redação e a
geração de temas informam que a IA está indisponível no momento.

---

## 12. SMTP

O e-mail é usado para a recuperação de senha e para avisos da plataforma. Qualquer provedor SMTP
serve; os mais comuns são Amazon SES, Brevo, SendGrid, Mailgun ou o SMTP autenticado do e-mail
profissional do domínio.

```ini
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USER=no-reply@focoelite.com.br
SMTP_PASS=<senha ou chave de API>
SMTP_FROM="Foco de Elite <no-reply@focoelite.com.br>"
```

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
de arquivos, OpenAI, meio de cobrança, e-mail e endereço público. Sai com erro quando algo impede o
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
* [ ] Uma assinatura de teste libera o acesso, e o evento correspondente aparece no log de webhooks do Stripe.
* [ ] O e-mail de recuperação de senha chega à caixa de entrada, e não ao spam.
* [ ] `pm2 status` mostra o processo `online`, e `pm2 startup` está configurado.
* [ ] O primeiro backup existe em `/var/backups/focoelite` e a linha do cron está ativa.
* [ ] `sudo ufw status` mostra apenas SSH e Nginx liberados.
* [ ] A senha inicial do administrador foi trocada.
