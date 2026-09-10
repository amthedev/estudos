# Checklist de entrega — Foco de Elite

Duas listas: o que **você precisa providenciar** para a plataforma entrar em operação comercial, e o
que **já está pronto e entregue**.

---

## Parte 1 — O que o cliente precisa providenciar

### 1. Chave da OpenAI (tutor e correção de redação)

| Item | Detalhe |
|------|---------|
| O que é | Uma chave de API da OpenAI, criada em [platform.openai.com/api-keys](https://platform.openai.com/api-keys). |
| Por que | É o que faz o tutor responder, a correção de redação funcionar e os temas serem gerados. |
| Como fazer | Criar a conta, adicionar um cartão, criar um projeto chamado "Foco de Elite" e gerar a chave dentro dele. |
| O que enviar | A chave (começa com `sk-`), por canal privado. Ela é configurada **apenas no servidor**. |
| Custo | Pago por uso. Com os modelos configurados (`gpt-4o-mini` para o tutor, `gpt-4o` para a redação), o gasto é de centavos por aluno ativo por dia. |
| Proteção | Já existe um teto mensal de tokens na plataforma. Defina também um limite de gasto no painel da própria OpenAI, em **Settings → Limits**. |
| Se faltar | A plataforma inteira continua funcionando. Só o tutor, a correção de redação e a geração de temas ficam indisponíveis, com aviso ao aluno. |

### 2. Conta no Stripe (cobrança recorrente)

| Item | Detalhe |
|------|---------|
| O que é | Conta em [stripe.com](https://stripe.com), com a ativação concluída (CNPJ ou CPF, dados da empresa e conta bancária de recebimento). |
| Por que | É quem cobra a assinatura mensal e repassa o dinheiro para a sua conta. |
| O que enviar | A chave secreta (`sk_live_...`) e a chave publicável (`pk_live_...`), por canal privado. |
| Decisões suas | Os planos: nome, valor e período de cada um. Já existem três sugeridos (Mensal, 6 meses e 15 meses) e todos são editáveis no painel. |
| Depois | Criamos o endpoint de webhook e sincronizamos os planos com o Stripe. Os passos estão em `docs/DEPLOY.md`, seção 10. |
| Se faltar | Os planos aparecem na landing, mas o botão de assinar informa que o pagamento ainda não está disponível. |

### 3. Domínio e DNS

| Item | Detalhe |
|------|---------|
| O que é | O domínio `focoelite.com.br` registrado e com acesso ao painel de DNS. |
| O que enviar | Acesso ao painel do registrador (Registro.br ou equivalente), ou a disposição de apontar os registros que eu indicar. |
| Registros necessários | `A` para `@` e para `www` apontando ao IP do servidor, mais os `TXT` de SPF, DKIM e DMARC do provedor de e-mail. |
| Prazo | A propagação leva de minutos a algumas horas. O certificado HTTPS só pode ser emitido depois que o domínio já resolver para o servidor. |

### 4. E-mail de envio (SMTP)

| Item | Detalhe |
|------|---------|
| O que é | Um servidor SMTP autenticado para a plataforma enviar mensagens. |
| Por que | Recuperação de senha e avisos ao aluno. |
| Opções | O SMTP do e-mail profissional do domínio (Google Workspace, Zoho, Titan), ou um serviço de envio como Brevo, SendGrid, Mailgun ou Amazon SES. |
| O que enviar | Servidor, porta, usuário e senha, e o endereço remetente (sugestão: `no-reply@focoelite.com.br`). |
| Importante | Configurar SPF e DKIM no DNS. Sem isso, o e-mail de recuperação cai no spam. |
| Se faltar | O aluno que esquecer a senha não consegue recuperá-la sozinho — só com intervenção pelo painel. |

### 5. Logo definitiva e identidade

| Item | Detalhe |
|------|---------|
| O que está no ar | Uma versão vetorial da marca (dourada sobre fundo escuro), usada na landing, no painel e no favicon. |
| O que enviar | O arquivo original da logo em **SVG** (ou PDF/AI vetorial), nas versões horizontal e apenas símbolo. Se houver manual de marca, envie também. |
| Por que SVG | Fica nítida em qualquer tamanho e em qualquer tela, e não pesa no carregamento. |
| Também útil | Uma variação da logo para fundo claro, para materiais impressos e para a assinatura de e-mail. |

### 6. Vídeos das aulas e conteúdo

| Item | Detalhe |
|------|---------|
| O que é | Os vídeos das aulas, hospedados no **YouTube** (podem ser "não listados") ou no Vimeo. |
| Por que assim | A plataforma não armazena vídeo: ela incorpora o player. Isso evita custo de armazenamento e de banda, e o vídeo carrega rápido em qualquer conexão. |
| O que cadastrar em cada aula | Título, matéria, assunto, link do vídeo, duração, um resumo em texto e em quais provas aquele conteúdo cai. |
| Questões | O banco de questões pode ser preenchido uma a uma pelo painel ou em lote, por planilha CSV, usando o modelo que a própria tela de importação disponibiliza. |
| Sugestão de início | Comece por uma matéria completa, de ponta a ponta, para os primeiros alunos terem uma trilha inteira, em vez de espalhar aulas soltas por várias matérias. |
| Professores | Para as aulas particulares: nome, matéria e horários disponíveis de cada professor. |

### 7. Servidor (se ainda não houver)

| Item | Detalhe |
|------|---------|
| Opção A | VPS Ubuntu 22.04 com 2 vCPU e 2 GB de RAM (Hetzner, DigitalOcean, Contabo, Hostinger). Mais controle e menor custo por recurso. |
| Opção B | Railway ou Render, com o banco na Neon. Mais simples, sem manutenção de servidor. |
| Ambos | Estão documentados passo a passo em `docs/DEPLOY.md`. |

---

## Parte 2 — O que já foi entregue

### Área do aluno

- [x] Landing pública institucional, com recursos, trilhas, como funciona, planos vindos do banco, perguntas frequentes e rodapé
- [x] Cadastro, login, recuperação e redefinição de senha
- [x] Onboarding em etapas: prova, dias de estudo, horas por dia, nível e matéria com mais dificuldade
- [x] Dashboard com próxima atividade, barra do plano de estudos, sequência de dias, horas, aulas, acertos, redações, matérias difíceis e o cronograma do dia
- [x] Cronograma diário, semanal e mensal, com concluir, reagendar, mudar horário, marcar como não realizada, incluir item manual e recalcular
- [x] Botão "Não consegui estudar hoje", que redistribui o que ficou pendente pelos próximos dias
- [x] Matérias → assuntos → subassuntos → aulas, com progresso em cada nível
- [x] Aula com player (YouTube, Vimeo ou link externo), resumo, anotações com salvamento automático, provas em que o assunto cai e botão de concluir
- [x] Cinco questões do assunto logo após a conclusão da aula, com resposta comentada imediata
- [x] Banco de questões com filtros por matéria, assunto, subassunto, ano, banca e dificuldade
- [x] Caderno de erros automático, com filtros e modo de refazer
- [x] Revisões espaçadas em 1, 7 e 30 dias, com cinco questões cada, entrando sozinhas no cronograma
- [x] Simulados da prova inteira, por matéria, por assunto ou personalizados, com cronômetro e resultado por área
- [x] Provas anteriores organizadas por prova e por ano
- [x] Tutor com IA, com resposta em tempo real e contexto da aula ou da questão
- [x] Redação: escolha ou geração de tema, escrita, envio e correção por critério, com histórico de evolução
- [x] Meu Desempenho, com gráficos por matéria, por assunto, por semana, pontos fortes e pontos fracos
- [x] Meus Resumos, com filtro por matéria, assunto e data
- [x] Favoritos de aulas, questões, assuntos e resumos
- [x] Busca global
- [x] Perfil com dados, metas, disponibilidade, troca de senha e situação da assinatura
- [x] Aulas particulares: professores, horários e agendamento
- [x] Assinatura com planos, checkout e portal de cobrança do Stripe
- [x] Interface responsiva: funciona no computador, no tablet e no celular, com menu inferior próprio no celular

### Painel administrativo

- [x] Login separado do login do aluno, com sessão e chave próprias
- [x] Dashboard com as métricas da operação
- [x] Alunos: lista, ficha individual com progresso, bloqueio, desbloqueio e liberação manual de acesso
- [x] Conteúdo: árvore de área → matéria → assunto → subassunto, com criação, edição e reordenação
- [x] Aulas: cadastro com link do YouTube ou do Vimeo, reconhecimento automático de miniatura e duração, resumo e vínculo com várias provas de uma vez
- [x] Questões: cadastro completo com alternativas, resolução e explicação; importação e exportação em CSV com validação linha a linha
- [x] Provas anteriores
- [x] Vestibulares: dados da prova, data, matérias com pesos e assuntos cobrados
- [x] Simulados: modelos configuráveis
- [x] Redação: temas, critérios por prova e acompanhamento das redações corrigidas
- [x] Professores e agendamentos das aulas particulares
- [x] Planos, com sincronização para o Stripe, e acompanhamento das assinaturas
- [x] Configurações: marca, exigência de assinatura, modelos de IA e status das integrações
- [x] Plataforma: saúde do sistema, uso de IA por dia, por recurso e por aluno, erros e registro de auditoria

### Base técnica

- [x] Banco PostgreSQL com schema versionado em migrations
- [x] Seed com as provas, áreas, matérias, o conteúdo programático completo, os pesos por prova, os critérios de redação e os planos
- [x] Chave da OpenAI protegida no servidor, com teto mensal de consumo de tokens
- [x] Senhas com hash bcrypt, sessões separadas por perfil, proteção contra CSRF, limitação de tentativas e SQL parametrizado
- [x] Registro de auditoria de toda escrita administrativa e de todos os erros do servidor
- [x] Testes automatizados de integração cobrindo os fluxos principais e as regras de segurança
- [x] Documentação: `README.md`, `ARCHITECTURE.md`, `docs/CONTEUDO.md`, `docs/DEPLOY.md`, este checklist, o roteiro do vídeo e o resumo para o cliente

---

## Ordem sugerida para entrar no ar

1. Enviar a logo definitiva em SVG.
2. Contratar o servidor (ou aprovar a opção Railway/Render).
3. Apontar o DNS de `focoelite.com.br` para o servidor.
4. Criar a chave da OpenAI e definir o limite de gasto.
5. Criar e ativar a conta no Stripe, e decidir os valores dos planos.
6. Configurar o e-mail de envio, com SPF e DKIM.
7. Publicação, HTTPS e backup diário configurados.
8. Cadastrar a primeira matéria completa: aulas com vídeo e questões.
9. Testar com um aluno de verdade, do cadastro à primeira redação corrigida.
10. Abrir para o público.
