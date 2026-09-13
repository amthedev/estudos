# Manual da plataforma — Foco de Elite

Este é o manual de uso da plataforma inteira: o que o **aluno** encontra e o que o **administrador**
opera. Cada seção explica **o que a tela faz**, **como usar** e **o que depende de quê**.

| | Endereço | Quem entra |
|---|---|---|
| Área do aluno | `focoelite.com.br/app` | quem se cadastrou pelo site |
| Painel administrativo | `focoelite.com.br/admin` | apenas administradores, com login separado |

Em desenvolvimento, troque o domínio por `http://localhost:4100`.

Os dois lados têm **login independente**: sair de um não desconecta o outro, e a mesma pessoa pode
ter conta de aluno e de administrador com o mesmo e-mail sem que uma atrapalhe a outra.

> **Regra de ouro do conteúdo:** nada se duplica por prova. "Porcentagem" existe uma única vez em
> Matemática e é *marcada* nas provas em que cai. Nunca crie "Porcentagem ENEM" e "Porcentagem Barro
> Branco" — marque as duas provas no mesmo assunto.

---

## Sumário

**Parte I — O aluno**
1. Entrar na plataforma · 2. Configurar estudos · 3. Início · 4. Meu Cronograma · 5. Matérias e
assuntos · 6. Aulas · 7. Pratique agora · 8. Questões · 9. Simulados · 10. Revisões · 11. Caderno de
Erros · 12. Redação IA · 13. Tutor IA · 14. Provas Anteriores · 15. Meu Desempenho · 16. Resumos,
Favoritos e Busca · 17. Aulas Particulares, Perfil e Assinatura

**Parte II — O administrador**
18. Como o painel se organiza · 19. Conteúdo · 20. Aulas · 21. Questões · 22. Provas anteriores ·
23. Vestibulares · 24. Redação · 25. Simulados · 26. Professores e agendamentos · 27. Planos e
assinaturas · 28. Configurações · 29. Rotina sugerida · 30. Perguntas frequentes

---

# PARTE I — O ALUNO

O menu do aluno segue a ordem do estudo: **Hoje** (Início e Cronograma), **Estudar** (Matérias,
Aulas, Questões, Simulados, Redação IA, Tutor IA) e **Acompanhar** (Provas Anteriores, Revisões,
Caderno de Erros, Meu Desempenho, Meus Resumos, Favoritos). No celular, o menu inferior deixa à mão
Início, Cronograma, Estudar, Tutor IA e Perfil.

---

## 1. Entrar na plataforma

**Cadastro** (`/cadastro`): nome, e-mail e senha. Não há confirmação por e-mail — ninguém verifica se
o endereço existe, e um e-mail digitado errado só aparece quando o aluno tenta recuperar a senha.

**A ordem real é: cadastrar → assinar → configurar os estudos.** Com a exigência de assinatura
ligada, o aluno recém-cadastrado vai direto para a tela de assinatura; a configuração de estudos só
abre depois que o acesso está liberado.

**Login** (`/login`). A mensagem de erro é a mesma para e-mail inexistente e senha errada — de
propósito, para não revelar quem é cadastrado. Conta desativada pelo administrador recebe
"Sua conta está bloqueada. Fale com o suporte."

**A sessão dura 7 dias.** Depois disso o aluno volta ao login mesmo sem ter clicado em "Sair".
Trocar a senha (pelo perfil ou pela recuperação) **encerra todas as sessões abertas** daquela conta —
quem estava logado no celular cai.

**Esqueci a senha** (`/recuperar-senha`): ele informa o e-mail e recebe um link de redefinição. A
resposta na tela é sempre a mesma, exista ou não aquele e-mail. O link serve **uma vez só** e tem
prazo de validade.

> **Configure o envio de e-mail antes do primeiro aluno esquecer a senha.** Sem provedor configurado,
> a plataforma **não envia nada** e mesmo assim diz "verifique seu e-mail" — o aluno fica esperando um
> e-mail que não existe. Use **Configurações › Enviar e-mail de teste** (seção 28) para confirmar que
> está funcionando. Enquanto não estiver, a única saída é o administrador trocar a senha do aluno por
> dentro do painel.

Cadastro, login e recuperação aceitam **10 tentativas a cada 15 minutos por endereço de internet**.
Em escola ou lan house, onde muita gente sai pelo mesmo endereço, o bloqueio pega todo mundo junto.

---

## 2. Configurar estudos

Assim que entra pela primeira vez, o aluno passa por cinco etapas (`/app/onboarding`):

1. **Prova** — ENEM, Academia do Barro Branco ou outro vestibular. É esta escolha que define todo o
   conteúdo que ele vai ver.
2. **Disponibilidade** — quais dias da semana ele estuda e quantas horas por dia. É esse número que
   define o tamanho do cronograma.
3. **Nível e dificuldade** — em que ponto ele está e qual matéria é a mais difícil para ele. A
   matéria apontada ganha prioridade no cronograma.
4. **Dados da trilha** — ano da prova, curso e instituição pretendidos, quando faz sentido.
5. **Resumo** — ele confere tudo antes de confirmar.

Voltar uma etapa **não apaga** o que já foi preenchido, e cada etapa valida antes de deixar avançar.
Ao concluir, a plataforma monta o cronograma automaticamente.

Duas coisas para saber: **não há como pular** — sem concluir as cinco etapas o aluno não chega a
nenhuma tela de conteúdo; e **nada é salvo antes do botão final**, então fechar o navegador no meio
faz começar de novo.

Tudo isso pode ser mudado depois em **Perfil**, e o cronograma se refaz.

---

## 3. Início

`/app` — a tela que responde "o que eu faço agora?". Ela traz, em uma só página:

* Saudação pelo primeiro nome e uma frase do dia (as frases são cadastradas no painel).
* **Próxima atividade** — o que fazer agora, com o botão que leva direto lá.
* **Continue estudando** — as últimas aulas que ele começou e não terminou.
* **Roteiro de hoje** — os itens do cronograma do dia, com marcação rápida: ele marca ali mesmo,
  sem sair da tela. Se a marcação falhar, ela volta sozinha ao estado anterior.
* Números do progresso, anéis por matéria, meta da semana, matérias em que ele vai pior e um atalho
  para as revisões pendentes.

Toda visita ao Início confere se o cronograma está acabando: faltando menos de uma semana pela
frente, a plataforma gera mais duas semanas ali mesmo. É por isso que a tela às vezes demora um
pouco mais a abrir.

---

## 4. Meu Cronograma

`/app/cronograma` — três visões: **Hoje**, **Semana** e **Mês**.

Cada item da lista mostra o tipo (aula, questões, revisão, simulado, redação), a matéria com a cor
dela, a duração e o horário. Em cada item o aluno pode:

* **Concluir**;
* **Reagendar** para outro dia;
* **Alterar o horário**;
* **Marcar como não realizada**;
* **Excluir** — só os itens que ele mesmo criou; os gerados pela plataforma não somem.

Três ações valem para o dia inteiro:

* **Não consegui estudar hoje** — redistribui o que ficou pendente pelos próximos dias, em vez de
  acumular um dia perdido.
* **Adicionar atividade** — para encaixar algo fora do plano.
* **Recalcular cronograma** — refaz o plano a partir da disponibilidade e do desempenho atuais.

**Reagendar ou mudar o horário torna o item "Sua"** — a partir daí ele ganha o selo e passa a poder
ser excluído. O mesmo vale para tudo que o "Não consegui estudar hoje" moveu.

O cronograma se adapta sozinho: concluir uma aula agenda as revisões, e ir mal na prática puxa
reforço do assunto.

> Cronograma vazio não é erro: se ainda não há matérias, assuntos e aulas cadastrados, a geração roda
> e não tem o que colocar.

---

## 5. Matérias e assuntos

**Matérias** (`/app/materias`) — um cartão por matéria, com ícone, cor, área, barra de progresso,
aulas concluídas e acurácia. Dá para filtrar por área, buscar pelo nome e alternar entre
**as matérias da minha prova** e **todas as matérias**.

**Matéria** (`/app/materias/:id`) — anel de progresso, indicadores e a lista dos assuntos que caem na
prova dele, cada um com progresso, número de aulas, acurácia e o botão **Estudar**.

**Assunto** (`/app/materias/:id/assuntos/:id`) — progresso do assunto, em quais provas ele cai, botão
de favoritar, as aulas agrupadas por subassunto e atalhos para as questões daquele assunto e para o
Tutor IA.

> Se um assunto não aparece para o aluno, é porque ele não está marcado no conteúdo programático da
> prova dele (seção 23).

---

## 6. Aulas

**Lista** (`/app/aulas`) — começa com **Continuar assistindo** e segue com todas as aulas, filtráveis
por matéria, por situação (não concluídas, em andamento, concluídas) e por busca.

**A aula** (`/app/aulas/:id`) — duas colunas:

* À esquerda, o vídeo e duas abas: **Resumo** da aula e **Minhas Anotações** — a caixa de anotações
  salva sozinha enquanto ele escreve, e a anotação fica guardada em Meus Resumos.
* À direita, a ficha: caminho (matéria › assunto › subassunto), dificuldade, duração, em quais provas
  cai e o professor. Ali ficam **Marcar aula como concluída**, **Pratique agora**,
  **Perguntar ao Tutor**, o favorito e a navegação para a aula anterior e a próxima.

**Concluir a aula** dispara três coisas de uma vez: o progresso sobe, as revisões daquele assunto são
agendadas (em 1, 7 e 30 dias, por padrão) e o item correspondente do cronograma é marcado.

---

## 7. Pratique agora

`/app/aulas/:id/praticar` — o treino logo depois da aula.

1. O aluno escolhe o **nível**: Fácil, Média ou Difícil.
2. Recebe **três questões, uma de cada assunto da aula** — e não três questões soltas do mesmo tema.
3. A cada resposta vê na hora se acertou, qual era a alternativa correta, a resolução passo a passo e
   a explicação.
4. No fim, um resumo com a porcentagem de acerto e os atalhos para o caderno de erros, para praticar
   de novo ou seguir para a próxima atividade.

As questões saem **primeiro do banco**. Quando o banco não tem nada daquele assunto no nível pedido,
a inteligência artificial elabora na hora — por isso existe uma tela de espera de até um minuto — e a
questão **fica guardada**, então o próximo aluno na mesma aula já a encontra pronta.

Em cada questão, depois de responder, há **Perguntar ao Tutor** e **Reportar problema**. O segundo
serve para quando algo está errado na questão (o gabarito, o enunciado, as alternativas); o aviso vai
para uma fila de conferência no painel e não muda a resposta nem o desempenho do aluno.

O botão só aparece **depois de responder**, quando ele já viu o gabarito — que é quando dá para
perceber que está errado. Por isso ele **não existe durante o simulado**, onde o gabarito só aparece
no fim.

> Há um teto diário de questões novas por aluno, para o custo de IA não virar torneira aberta.
> Atingido o teto, ele recebe o que existe no banco e um aviso — não um erro.

---

## 8. Questões

`/app/questoes` — o banco completo, para treinar fora da aula.

Filtros encadeados: prova, matéria, assunto, subassunto, dificuldade, ano, banca e situação (todas,
já respondidas, não respondidas, que ele errou). A lista é paginada e cada questão abre em uma janela
com a resolução e o retorno imediato.

É aqui que entra o que vem das provas anteriores: as questões lidas dos PDFs (seção 21) aparecem
nestes filtros com o ano e a banca de origem.

---

## 9. Simulados

`/app/simulados` — quatro formas de montar:

| Tipo | O que faz |
|---|---|
| **Simulado da minha prova** | Sorteia pelo peso de cada matéria na prova, no formato do dia oficial. |
| **Por matéria** | Concentra em uma matéria e mede a acurácia dela. |
| **Por assunto** | Fecha o foco em um único assunto — ideal logo depois da aula. |
| **Personalizado** | Ele escolhe matérias, dificuldade, quantidade e tempo. |

No **Simulado da minha prova**, ele escolhe qual prova quer simular — ENEM, Barro Branco ou outro
vestibular, independentemente da prova do perfil — e o **formato**:

* **Simulado completo** — 80 questões em 4 horas;
* **Mini simulado** — 20 questões em 1 hora;
* **Do meu jeito** — ele diz quantas questões e quanto tempo.

A tela também lista os **modelos prontos** cadastrados pelo administrador e o histórico com a
evolução das notas.

**Durante** (`/app/simulados/:id`): cronômetro regressivo, navegação livre entre as questões, marcar
e desmarcar resposta, e cada resposta é salva na hora — fechar a aba não perde o simulado.

**No fim** (`/app/simulados/:id/resultado`): nota, gráficos, desempenho por matéria e por assunto,
revisão questão a questão com a resolução, e o botão para refazer só o que errou. O resultado também
realimenta o cronograma.

> Quando o banco não tem questões suficientes para o recorte pedido, a IA completa até um teto
> configurável (seção 28). Se ainda assim faltar, o simulado **avisa na abertura**: "este simulado
> saiu com 52 das 80 questões pedidas".

---

## 10. Revisões

`/app/revisoes` — a revisão espaçada, criada sozinha quando o aluno conclui uma aula: uma em 1 dia,
outra em 7 e outra em 30 (os intervalos são configuráveis).

As três são criadas de uma vez, contadas **a partir da data da aula** — não a partir da revisão
anterior. E nascem apenas na **primeira** conclusão da aula: concluir de novo não agenda outra
rodada. O aluno não cria revisão à mão.

A tela separa em **Atrasadas**, **Hoje**, **Próximos 7 dias**, **Mais adiante** e **Concluídas**.

Revisar não é reler: o botão **Revisar** abre **cinco questões** daquele assunto, com correção
imediata. Também existem **Marcar como revisada** (sem fazer as questões) e **Pular**.

---

## 11. Caderno de Erros

`/app/caderno-de-erros` — toda questão errada entra aqui sozinha. O aluno não marca nada.

A tela abre com o resumo dos erros por matéria e a lista, que se expande mostrando a alternativa que
ele marcou contra a correta, a resolução, a explicação e um campo de **anotação pessoal**. Ele pode
filtrar por matéria, por assunto e por situação (a resolver / já resolvidos), e remover um registro.

O caderno **enche** sempre que ele erra, em qualquer lugar: no banco, na prática depois da aula, na
revisão, no refazer e ao finalizar um simulado. Errar a mesma questão de novo não cria outra linha —
soma no contador e reabre o registro.

E **esvazia** de três jeitos, só três: acertando a questão numa revisão ou no refazer, removendo o
registro à mão, ou quando o administrador desativa aquela questão.

**Refazer meus erros** (`/app/caderno-de-erros/refazer`) abre até dez questões erradas. Acertar ali
marca o erro como resolvido, e ele sai da lista.

---

## 12. Redação IA

**Minhas Redações** (`/app/redacao`) — estatísticas, gráfico de evolução das notas e a lista das
redações, com tema, prova, data, nota e situação. Rascunho volta para o editor; corrigida abre a
correção.

**Nova redação** (`/app/redacao/nova`) — três passos:

1. **Prova** — e, ao lado, o painel "Como sua redação será avaliada", com os critérios daquela banca.
2. **Tema** — escolher um tema cadastrado, **gerar um tema por IA** no estilo da banca, ou escrever
   sobre um tema livre.
3. **Editor** — contador de palavras e estimativa de linhas, rascunho salvo automaticamente e o envio
   para correção.

> **O texto para em 6.000 caracteres** — cerca de 70 linhas — e o campo simplesmente deixa de aceitar
> digitação, sem avisar. Quem escreve muito percebe tarde. O contador de linhas também é estimativa
> (caracteres ÷ 85), não corresponde à folha oficial.

A correção leva até cerca de um minuto e meio; a tela pede para manter a aba aberta.

**A correção** (`/app/redacao/:id`) traz a nota geral em anel, **um cartão por critério** com a nota e
o comentário, o parecer completo (pontos fortes, pontos a melhorar, erros gramaticais, argumentação,
repertório, estrutura, coesão, proposta de intervenção e sugestões) e o texto do aluno ao lado.

Cada prova é corrigida pelos **critérios dela**. As competências do ENEM não são aplicadas ao Barro
Branco. Se a prova ainda não tem critérios cadastrados, entra um conjunto genérico e a correção sai
marcada como tal.

**A nota nunca é a que a IA disse: é a que o código recalcula.** Cada nota é limitada entre zero e o
máximo do critério, a nota final é a soma dos critérios e a nota máxima é a soma dos máximos. Ou
seja, a escala sai da matriz que você cadastrou — se os critérios somam 950, a redação vale 950.

Não existe prazo nem data de entrega em redação. O bloco "Redação da semana" do cronograma é só um
item de agenda; não trava nada.

Se a correção falhar, a tela diz o motivo e oferece reenviar — o texto fica guardado por inteiro.

---

## 13. Tutor IA

`/app/tutor` — conversa com um professor particular de IA. À esquerda ficam as conversas (criar,
buscar, excluir); à direita o chat, com a resposta aparecendo palavra por palavra.

O tutor chega **com contexto**: os botões "Perguntar ao Tutor" espalhados pela plataforma (na aula, no
assunto, na questão, na redação) abrem uma conversa já amarrada àquele material, então o aluno não
precisa explicar do que está falando.

Quando a IA está indisponível ou o limite mensal foi atingido, as conversas antigas continuam
legíveis e o envio fica desabilitado com um aviso claro.

---

## 14. Provas Anteriores

`/app/provas-anteriores` — as provas já aplicadas, agrupadas por vestibular e por ano, com o PDF da
prova, o do gabarito e o link oficial quando houver.

---

## 15. Meu Desempenho

`/app/desempenho` — o retrato do estudo: métricas gerais, evolução por semana e por mês, acurácia por
matéria e por assunto, pontos fortes e pontos fracos, e os simulados e redações mais recentes.

É daqui que saem as "matérias difíceis" que aparecem no Início e a priorização do cronograma.

> O número **"% do conteúdo da sua prova"** depende de você ter montado o conteúdo programático do
> vestibular (seção 23). Sem ele, a conta passa a usar *todas* as aulas da plataforma como
> denominador, e o percentual fica menor do que deveria.

---

## 16. Resumos, Favoritos e Busca

**Meus Resumos** (`/app/resumos`) — as anotações feitas nas aulas e as criadas do zero. Filtros por
matéria, assunto e data, busca por texto, e criação direta. Cada resumo (`/app/resumos/:id`) tem
salvamento automático de título e conteúdo, prévia formatada, favoritar, excluir e link para a aula
de origem.

**Favoritos** (`/app/favoritos`) — em abas: aulas, questões, assuntos e resumos.

**Busca** (`/app/busca`) — busca global, com os resultados separados em aulas, questões, assuntos e
resumos.

---

## 17. Aulas Particulares, Perfil e Assinatura

**Aulas Particulares** (`/app/aulas-particulares`) — lista de professores por matéria, horários
livres de cada um, agendamento e acompanhamento das aulas marcadas. A plataforma nunca oferece um
horário já reservado.

> Desligar o recurso em **Configurações** (seção 28) faz a tela responder "Aulas particulares
> indisponíveis", mas **o item continua no menu do aluno** — ele clica e encontra o aviso. Está na
> lista de acertos pendentes.

**Perfil** (`/app/perfil`) — dados pessoais, prova e metas, rotina de estudos, troca de senha,
situação da assinatura e sair da conta. Mudar a prova ou a disponibilidade aqui refaz o cronograma.

**Assinatura** (`/app/assinatura`) — planos disponíveis, forma de pagamento e situação atual.

* **Cartão** — assinatura recorrente. Quando o plano oferece, há **24 horas de teste**, uma única vez
  por aluno.
* **Pix** — pagamento avulso do período contratado.

Enquanto a exigência de assinatura estiver ligada, o aluno sem assinatura ativa só acessa **Perfil** e
**Assinatura**; o resto responde com um convite a assinar. Liberação manual feita pelo administrador
(seção 18) vale como assinatura, até a data escolhida.

> **Troca de plano e cancelamento não são automáticos.** O Asaas não tem portal do assinante: com uma
> assinatura ativa, tentar assinar outro plano é recusado com a orientação de falar com o suporte, e
> o botão "Gerenciar assinatura" abre a fatura, não um painel de troca. Quem faz a troca ou o
> cancelamento é você, pelo painel do Asaas.

---

# PARTE II — O ADMINISTRADOR

## 18. Como o painel se organiza

O menu lateral segue a ordem do trabalho:

| Seção | Onde fica | Para que serve |
|-------|-----------|----------------|
| Visão geral | `/admin` | Números do dia: alunos, estudo, questões, redações, assinaturas. |
| Alunos | `/admin/alunos` | Cadastro, bloqueio, liberação manual de acesso e progresso de cada aluno. |
| Professores e Agendamentos | `/admin/professores`, `/admin/agendamentos` | Aulas particulares. |
| Conteúdo | `/admin/conteudo` | Áreas, matérias, assuntos e subassuntos — a base de tudo. |
| Aulas | `/admin/aulas` | Videoaulas. |
| Questões | `/admin/questoes` | Banco de questões (manual e importação). |
| Provas anteriores | `/admin/provas-anteriores` | PDFs de prova e gabarito. |
| Vestibulares | `/admin/vestibulares` | Provas atendidas, pesos, conteúdo programático e matriz de redação. |
| Simulados | `/admin/simulados` | Modelos de simulado prontos. |
| Redação | `/admin/redacao` | Temas, critérios e redações corrigidas. |
| Planos | `/admin/planos` | Planos de assinatura e integração com o Asaas. |
| Configurações | `/admin/configuracoes` | Marca, acesso, IA, e-mail e cronograma. |
| Plataforma | `/admin/plataforma` | Saúde do sistema, uso de IA, erros e auditoria. |

Toda alteração feita no painel fica registrada na auditoria (`/admin/plataforma`), com quem fez,
o que mudou e quando.

### Ordem recomendada em uma implantação nova

1. Vestibular (dados básicos) →
2. Conteúdo (áreas, matérias, assuntos) →
3. Conteúdo programático e pesos do vestibular →
4. Aulas →
5. Questões →
6. Critérios e temas de redação →
7. Simulados e provas anteriores →
8. Planos e configurações.

---

## 19. Conteúdo: áreas, matérias, assuntos e subassuntos

Tela: **Conteúdo** (`/admin/conteudo`).

A biblioteca tem quatro níveis, do mais geral para o mais específico:

```
Área                    Matemática e suas Tecnologias
└── Matéria             Matemática
    └── Assunto         Porcentagem
        └── Subassunto  Fator de aumento e de desconto
```

O que cada nível faz:

* **Área** agrupa matérias nos relatórios e nas telas do aluno.
* **Matéria** é a unidade de progresso, de peso no cronograma e de filtro nas questões. Tem ícone e
  cor próprios.
* **Assunto** é o que o cronograma agenda, o que as revisões repetem e o que o desempenho mede. É
  também o nível marcado no conteúdo programático de cada prova.
* **Subassunto** detalha o assunto e deixa a prática mais precisa (opcional).

### 19.1 Criar uma área

1. Clique em **Nova área** no topo da página.
2. Escreva o nome (ex.: "Ciências da Natureza") e clique em **Salvar**.

### 19.2 Criar uma matéria

1. Clique no **+** da área desejada (ou em **Nova matéria**, no topo, para escolher a área no
   formulário).
2. Preencha:
   * **Nome** — como o aluno vê (ex.: "Biologia").
   * **Área** — a que grupo pertence.
   * **Descrição** — uma linha sobre o que a matéria cobre (opcional).
   * **Ícone** — escolha um dos ícones da lista; ele aparece nos cards do aluno.
   * **Cor** — usada nas barras de progresso, nos gráficos e nos pontos coloridos das listas.
   * **Ativo** — desmarque para esconder a matéria do aluno sem excluir nada.
3. Clique em **Salvar**.

### 19.3 Criar assuntos e subassuntos

1. Expanda a matéria pela seta à esquerda.
2. Clique no **+** da matéria para criar um **assunto**; no **+** do assunto para criar um
   **subassunto**.
3. Preencha nome e descrição e salve.

### 19.4 Marcar em quais provas o assunto cai

1. Clique no **nome do assunto**. O painel lateral direito abre com a lista de vestibulares.
2. Marque as provas cujo edital cobra aquele assunto.
3. Clique em **Salvar provas**.

Isso alimenta o conteúdo programático (`/admin/vestibulares/:id`, aba Conteúdo programático) e o
cronograma do aluno: só entram no plano de estudos os assuntos marcados na prova dele.

### 19.5 Reordenar, desativar e excluir

* **Setas para cima e para baixo** mudam a ordem em que o aluno vê os itens. A ordem é salva na hora.
* **Botão de liga/desliga** ativa ou desativa. Item inativo some das telas do aluno, mas o histórico
  e o progresso continuam intactos. **É a opção certa para conteúdo que saiu do edital.**
* **Lixeira** exclui de vez. Se houver aulas, questões ou assuntos dependurados, o sistema recusa a
  exclusão, explica o que está vinculado e oferece **desativar em vez de excluir**.

### 19.6 Busca

O campo de busca filtra a árvore inteira por matéria, assunto e subassunto, abrindo automaticamente
os ramos com resultado. Os botões **Expandir** e **Recolher** abrem e fecham tudo.

---

## 20. Aulas

Telas: **Aulas** (`/admin/aulas`), **Nova aula** (`/admin/aulas/nova`), **Importar aulas** (`/admin/aulas/importar`).

A lista mostra miniatura, título, matéria e assunto, provas em que a aula cai, duração e situação.
Use a busca e os filtros de matéria, prova, dificuldade e situação para achar rápido.

### 20.1 Cadastrar uma aula

1. Clique em **Nova aula**.
2. **Coluna da esquerda — dados e vídeo:**
   * **Título** — o nome que o aluno vê.
   * **Descrição curta** — uma linha de apoio (opcional).
   * **Professor** e **Duração (minutos)** — a duração é usada pelo cronograma para montar o dia
     de estudo. Ao colar um link do Vimeo, ela costuma vir preenchida sozinha.
   * **Link do vídeo** — cole o endereço e aguarde: a prévia aparece logo abaixo e o sistema
     preenche título, miniatura e duração quando o serviço informa esses dados. O botão **Analisar**
     refaz a leitura.
   * **Miniatura** — opcional. Envie uma imagem para aparecer na lista de aulas; sem ela, o player mostra o primeiro quadro do vídeo.
   * **Resumo da aula** — texto em Markdown com aba de **Prévia**. Aceita `**negrito**`, `_itálico_`,
     listas, títulos e links. Aparece abaixo do player, na tela da aula.
3. **Coluna da direita — classificação:**
   * **Matéria → Assunto → Subassunto** (os campos se encadeiam: escolha a matéria e a lista de
     assuntos carrega).
   * **Dificuldade** — básico, intermediário ou avançado.
   * **Ordem no assunto** — deixe em branco para entrar no fim da fila.
   * **Provas em que cai** — marcar uma prova aqui também acrescenta o assunto ao conteúdo
     programático dela.
   * **Aula ativa** — desmarque para esconder do aluno.
4. Clique em **Salvar** — ou em **Salvar e criar questões**, que grava a aula e já abre o formulário
   de questão com a matéria e o assunto preenchidos.

### 20.2 Que arquivos funcionam

| Formato | Limite | O que acontece |
|---------|--------|----------------|
| MP4 | 1 GB | Melhor opção. Toca em qualquer navegador e celular. |
| WEBM | 1 GB | Toca normalmente nos navegadores atuais. |
| MOV | 1 GB | Aceito, mas prefira converter para MP4: alguns navegadores não reproduzem. |
| Sem vídeo | — | O aluno vê "Vídeo em breve" e aproveita o resumo e as questões. |

O arquivo é conferido pelo conteúdo, não pelo nome: renomear outro tipo de arquivo para `.mp4` não
engana a plataforma. A duração é lida do próprio vídeo e preenche o campo de minutos, que é o número
usado pelo cronograma para montar o dia de estudo do aluno.

Os vídeos ficam no armazenamento da plataforma (Blob Storage da Square Cloud) e são servidos por CDN,
com a barra de progresso funcionando normalmente.

### 20.3 Editar e excluir

Clique na linha da tabela para abrir a aula. Os botões de ação de cada linha permitem editar, ir
para as questões do assunto, ativar/desativar e excluir. **Excluir a aula apaga também o progresso
registrado pelos alunos nela** — quando a intenção é só tirar do ar, desative.

### 20.4 Enviar várias aulas de uma vez

Quando você já gravou uma sequência inteira, não cadastre uma por uma. Em **Aulas**, clique em
**Enviar em massa**.

1. **Escolha os arquivos** — arraste os vídeos para a área indicada ou clique para selecionar vários
   de uma vez. Aceita MP4, WEBM e MOV, até 1 GB cada, no máximo 200 por envio.

2. **Preencha o que vale para todas** na coluna da direita: matéria, assunto, subassunto opcional,
   professor, dificuldade, duração padrão e as provas em que as aulas caem. Matéria e assunto são
   obrigatórios: todas as aulas do lote entram no mesmo assunto.

3. **Confira a lista.** Cada arquivo aparece com o tamanho, a duração lida do próprio vídeo e um
   título sugerido a partir do nome do arquivo. Ajuste os títulos ali mesmo e tire da lista o que não
   deve entrar.

4. Clique em **Enviar e cadastrar**. Os vídeos sobem um por um, com a barra de progresso de cada um,
   e as aulas são criadas ao final. O resultado mostra o que entrou e o motivo de cada arquivo que
   ficou de fora.

As aulas entram na ordem da lista, continuando a numeração de onde o assunto parou. Depois é só abrir
cada uma para acrescentar o resumo, se for o caso. O mesmo vídeo não vira duas aulas.

**Onde os vídeos ficam:** no armazenamento da plataforma (Blob Storage da Square Cloud). Você não
precisa hospedar em nenhum outro lugar, e o aluno assiste direto na aula, com a barra de progresso
funcionando normalmente.

---

## 21. Questões

Telas: **Questões** (`/admin/questoes`), **Nova questão** (`/admin/questoes/nova`),
**Importar** (`/admin/questoes/importar`).

### 21.1 Cadastrar manualmente

1. Clique em **Nova questão**.
2. **Enunciado** — em Markdown, com aba de **Prévia**. Textos de apoio, tabelas e citações entram aqui.
3. **Imagem da questão** — endereço `https://` de uma imagem (opcional).
4. **Alternativas** — escreva de duas a cinco (A a E) e marque o círculo da **correta**. Alternativas
   em branco são ignoradas.
5. **Resolução passo a passo** e **Explicação da resposta** — aparecem para o aluno depois que ele
   responde. Vale muito a pena preencher: é o que transforma erro em aprendizado.
6. **Classificação** — matéria, assunto, subassunto e dificuldade.
7. **Origem** — prova de origem, ano, banca e referência livre. Questões autorais podem ficar sem
   prova de origem.
8. **Provas em que cai** — marque as provas para a questão entrar nos filtros e simulados delas.
9. Confira o cartão **Como o aluno vê**, à direita, que reproduz a questão em tempo real, e clique em
   **Salvar** (ou **Salvar e criar outra**, que mantém a classificação).

### 21.2 Importar várias questões de uma vez

1. Vá em **Questões › Importar**.
2. Clique em **Baixar modelo CSV** — o arquivo já vem com o cabeçalho certo e uma linha de exemplo
   usando uma matéria e um assunto reais do seu banco.
3. Preencha uma questão por linha e salve como CSV (UTF-8).
4. Envie o arquivo (clique ou arraste) ou cole o conteúdo no campo de texto.
5. Confira a **prévia das primeiras linhas** e o número de linhas detectadas.
6. Clique em **Importar questões**.
7. O resultado mostra quantas foram gravadas e lista **linha a linha** o que deu errado. As linhas
   válidas são gravadas mesmo quando outras falham: corrija apenas as linhas com erro e reenvie
   somente elas.

#### Formato do arquivo

Separador **ponto e vírgula** (`;`) — vírgula e tabulação também são aceitas. A primeira linha é o
cabeçalho. Textos com ponto e vírgula ou quebra de linha ficam entre aspas duplas (`"assim"`).

```
statement;A;B;C;D;E;correct;resolution;explanation;subject_slug;topic_slug;subtopic_slug;difficulty;year;board;exams
```

| Coluna | Obrigatória | O que preencher |
|--------|-------------|-----------------|
| `statement` | Sim | Enunciado (mínimo de 10 caracteres). |
| `A` a `E` | Sim | Texto das alternativas. Deixe em branco as que não usar (mínimo de duas). |
| `correct` | Sim | Letra do gabarito: `A`, `B`, `C`, `D` ou `E`. |
| `resolution` | Não | Resolução passo a passo. |
| `explanation` | Não | Explicação da resposta. |
| `subject_slug` | Sim | Identificador da matéria (ex.: `matematica`). |
| `topic_slug` | Sim | Identificador do assunto dentro daquela matéria. |
| `subtopic_slug` | Não | Identificador do subassunto. |
| `difficulty` | Não | `1` básico, `2` intermediário, `3` avançado. Padrão: `2`. |
| `year` | Não | Ano da prova de origem. |
| `board` | Não | Banca (INEP, VUNESP, FUVEST…). |
| `exams` | Não | Provas em que a questão cai, separadas por vírgula (ex.: `enem,barro-branco`). |

Os identificadores (`slug`) de matéria e assunto são os mesmos que aparecem na tela **Conteúdo** e no
identificador de cada vestibular (aba Dados). O cabeçalho também aceita nomes em português —
`enunciado`, `gabarito`, `materia`, `assunto`, `dificuldade`, `ano`, `banca`, `provas`.

Limite: 2.000 linhas por importação e 4 MB por arquivo.

### 21.3 Ler uma prova em PDF e virar questões

Tela: **Ler prova em PDF** (`/admin/ler-prova`). É o caminho para transformar uma prova já aplicada —
ENEM, ENEM PPL, Barro Branco — em questões do banco sem digitar uma a uma.

1. **Nova leitura de prova.** Dê um nome (só para você se achar depois), escolha o **vestibular**, o
   **ano** e a **banca**.
2. **Cole o gabarito oficial.** Aceita qualquer formato: `1-A 2-B 3-C`, `1) A`, um por linha. **Faça
   isso.** Sem o gabarito, a IA precisa *resolver* cada questão para marcar a resposta, e ela erra com
   confiança. Com o gabarito, ela só transcreve — e a resposta vem da prova, não do palpite.
3. **Criar leitura** e **escolher o PDF**. O texto é lido no seu próprio navegador; o arquivo não sai
   do seu computador para a inteligência artificial. Uma prova inteira leva alguns segundos.
4. **Varrer a prova.** Use **Varrer a prova inteira** e deixe rodando, ou **Começar a varrer** para
   ir por partes. A barra mostra o quanto já foi lido. Pode fechar a aba: o botão vira **Continuar de
   onde parou** e nada se perde.
5. **Conferir.** Cada questão encontrada aparece com enunciado, alternativas e a resposta em verde.
   Você pode trocar o gabarito na hora ou **descartar** a questão.
6. **Mandar as marcadas para o banco.** O botão **Marcar as N com gabarito** seleciona de uma vez
   tudo que veio do gabarito oficial. O resultado diz quantas entraram e, se alguma falhar, o motivo
   fica na própria questão.

**PDF digitalizado não funciona.** Se a prova for uma foto de cada página (sem texto selecionável), a
tela avisa com todas as letras. Procure a versão original do arquivo, ou use uma das alternativas
abaixo.

**Não tem PDF?** Na mesma tela, abaixo do arquivo, há o campo **Cole o texto da prova**. Serve para
prova em Word, copiada de uma página da internet, ou digitalizada que você já passou por um leitor de
texto. Cole tudo de uma vez, na ordem das questões, e clique em **Usar este texto** — daí em diante o
caminho é o mesmo.

### 21.4 Conferir as questões que a IA escreveu

Quando um aluno termina uma aula e pede para praticar, a plataforma entrega três questões — uma de
cada assunto da aula, no nível que ele escolher. Ela usa primeiro o que existe no banco; o que faltar,
a inteligência artificial elabora na hora e **guarda no banco**, para o próximo aluno já encontrar
pronto.

Essas questões entram **ativas**, sem esperar você conferir. É proposital: se ficassem escondidas, o
erro do aluno sumiria do caderno de erros dele. Em troca, a lista de questões tem duas formas de
achar o que precisa de atenção:

* Filtro **Origem › Elaboradas pela IA**.
* Filtro **Conferência › Ainda não conferidas**, **Com aviso de aluno** ou **Já conferidas**.

Na coluna de situação aparecem selos: **IA**, **Sem conferência**, **N avisos** (aluno reclamou) e a
**taxa de acerto** quando ela está muito baixa — gabarito trocado quase sempre aparece como
"5 tentativas, 0% de acerto". Use **Marcar como conferida** no menu da linha quando terminar de
olhar; isso também fecha os avisos dos alunos.

O aluno avisa pelo botão **Reportar problema**, que aparece depois que ele responde a questão.

### 21.5 Exportar

O botão **Exportar CSV** na lista de questões baixa exatamente o que está filtrado na tela, no mesmo
formato da importação. Serve para revisar em planilha, corrigir em massa e reimportar.

---

## 22. Provas anteriores

Tela: **Provas anteriores** (`/admin/provas-anteriores`).

1. Clique em **Nova prova anterior**.
2. Preencha:
   * **Vestibular** e **Ano** — obrigatórios.
   * **Título** — como o aluno vê (ex.: "ENEM 2024 — 1º dia (caderno azul)").
   * **Dia** — para provas aplicadas em mais de um dia (ENEM: 1 ou 2).
   * **Banca**.
   * **PDF da prova** e **PDF do gabarito** — endereços `https://` dos arquivos.
   * **Link externo** — página oficial, quando não houver PDF direto.
   * **Observações** — recados úteis ao aluno.
   * **Prova visível para o aluno** — desmarque para preparar sem publicar.
3. Salve. Use os filtros de vestibular, ano e situação para administrar o acervo.

O aluno acessa tudo isso em **Provas Anteriores**, agrupado por prova e ano.

---

## 23. Vestibulares

Telas: **Vestibulares** (`/admin/vestibulares`) e a página do vestibular (`/admin/vestibulares/:id`),
com quatro abas.

### 23.1 Criar um vestibular

1. Clique em **Novo vestibular**.
2. Preencha:
   * **Nome** e **Sigla** (a sigla aparece em badges e filtros).
   * **Trilha** — define a experiência do aluno: `ENEM`, `Barro Branco / PM` ou `Vestibular`.
   * **Banca**, **Data da próxima prova** e **Nota máxima da prova objetiva**.
   * **Descrição** — formato da prova, número de questões, o que o aluno precisa saber.
   * **A prova tem redação** e **Escala máxima da redação** (ENEM: 1000).
3. Ao salvar, o painel abre a página do vestibular para você continuar pelas abas.

### 23.2 Aba Dados

Todos os campos acima, mais o **Identificador** (o `slug` usado na importação de questões) e a
**Ordem na lista**. Desmarcar **Vestibular disponível** tira a prova das opções de escolha do aluno
sem apagar nada.

### 23.3 Aba Matérias e pesos

1. Escolha a matéria no seletor **Adicionar matéria** e clique em **Adicionar**.
2. Ajuste o **peso** de cada matéria. O peso multiplica a prioridade da matéria no cronograma:
   peso 3 recebe cerca de três vezes mais blocos de estudo que peso 1. Use os pesos do edital
   (quantidade de questões ou peso oficial da prova).
3. Clique em **Salvar matérias e pesos**.

Remover uma matéria da prova também remove os assuntos dela do conteúdo programático daquela prova.

### 23.4 Aba Conteúdo programático

1. Escolha a matéria na lista da esquerda.
2. Marque os assuntos cobrados no edital. **Marcar todos os assuntos desta matéria** resolve o caso
   comum de "cai a matéria inteira".
3. Clique em **Salvar conteúdo desta matéria**. Repita para cada matéria.

O contador ao lado de cada matéria (`9/12`) mostra quantos assuntos já estão no edital. É esta
marcação que o cronograma usa para escolher o que o aluno estuda.

### 23.5 Aba Redação

Ver a seção 24.1.

---

## 24. Redação

Tela: **Redação** (`/admin/redacao`), com três abas.

### 24.1 Critérios de correção

A matriz de correção é o que a IA usa para corrigir e o que o aluno vê na devolutiva. Ela é editada
na aba **Redação** de cada vestibular (`/admin/vestibulares/:id?aba=redacao`); a aba **Critérios**
do menu Redação lista todas as provas e leva direto para a edição.

Como alterar:

1. Abra o vestibular e vá na aba **Redação**.
2. Preencha o cabeçalho:
   * **Nome da matriz** (ex.: "Competências do ENEM").
   * **Escala máxima** — a nota total da redação (ENEM: 1000; Barro Branco: 100).
   * **Gênero do texto** — ex.: "Texto dissertativo-argumentativo".
   * **Mínimo e máximo de linhas** — usados no aviso ao aluno e na correção.
   * **Orientações ao corretor** — regras da banca, o que zera a redação, tom da devolutiva.
3. Em **Critérios**, para cada item informe:
   * **Nome** (ex.: "Competência 1 — domínio da norma-padrão").
   * **Pontuação máxima** do critério.
   * **Descrição para o aluno** — o que o critério avalia.
   * **Orientação ao corretor** — como pontuar cada faixa.
4. Use as setas para reordenar, a lixeira para remover e **Adicionar critério** para incluir novos.
5. **A soma dos máximos dos critérios precisa ser igual à escala máxima.** O painel mostra a soma em
   tempo real: verde quando bate, laranja quando falta ou sobra. Só é possível salvar quando bate.
6. Clique em **Salvar matriz de redação**. A escala do vestibular é atualizada junto.

### 24.2 Temas

1. Na aba **Temas**, clique em **Novo tema**.
2. Preencha:
   * **Título** — o tema como ele aparece na proposta.
   * **Prova** — deixe em branco para oferecer o tema a todos os alunos.
   * **Ano** e **Fonte** — de onde o tema veio.
   * **Proposta de redação** — o enunciado, como na prova.
   * **Textos motivadores** — textos de apoio (aceitam Markdown).
   * **Tema disponível** — desmarque para tirar da lista sem excluir.
3. Salve. O aluno escolhe entre os temas ativos da prova dele ao escrever uma redação — e também
   pode pedir um tema novo à IA, que entra nesta mesma lista marcado como "Gerado por IA".

Temas já usados em redações não podem ser excluídos; desative-os.

### 24.3 Redações corrigidas

A aba **Redações corrigidas** lista aluno, prova, tema, nota, data e situação, com filtros por prova,
situação e período. Clique na linha para abrir a correção completa: nota por critério, comentários,
pontos fortes, pontos a melhorar, correções de escrita e o texto do aluno.

Situações possíveis: **Aguardando correção** (enviada, IA processando), **Corrigida** e
**Falha na correção** (a mensagem do erro aparece no topo do modal — normalmente falta de chave da
OpenRouter ou limite mensal atingido; verifique em Configurações e Plataforma).

---

## 25. Simulados

Tela: **Simulados** (`/admin/simulados`).

Modelos de simulado aparecem para o aluno prontos para iniciar (ele também pode montar simulados
sozinhos, sem depender do cadastro).

1. Clique em **Novo simulado**.
2. Preencha:
   * **Nome** e **Descrição**.
   * **Tipo**:
     * *Prova completa* — sorteia questões de todas as matérias da prova escolhida (informe a prova).
     * *Por matéria* — questões de uma matéria (informe a matéria).
     * *Por assunto* — questões de um assunto (informe matéria e assunto).
     * *Personalizado* — combina os filtros que você definir.
   * **Duração (minutos)** e **Número de questões**.
   * **Disponível para os alunos**.
3. Salve. As questões são sorteadas na hora em que o aluno inicia, respeitando o tipo e os filtros —
   por isso o mesmo modelo rende simulados diferentes a cada tentativa.

Simulados excluídos não apagam as tentativas já feitas: o histórico do aluno continua no lugar.

### 25.1 O que o aluno vê

Na tela dele, ao escolher **Simulado da minha prova**, aparecem três formatos:

* **Simulado completo** — 80 questões em 4 horas, para treinar fôlego.
* **Mini simulado** — 20 questões em 1 hora, para caber numa sessão de estudo.
* **Do meu jeito** — ele escolhe quantas questões e quanto tempo.

Ele também escolhe qual prova quer simular (ENEM, Barro Branco ou outro vestibular), independente da
prova do perfil dele.

### 25.2 Quando o banco não fecha a conta

Se o aluno pede 80 questões e o banco só tem 30 do recorte escolhido, a inteligência artificial
elabora o que faltar — até um teto, e as questões ficam guardadas no banco para os próximos.

O teto é **Configurações › Questões por IA em um simulado** (padrão: 20). Coloque `0` para desligar e
só usar o que está no banco.

Quando ainda assim faltar, o simulado avisa o aluno na abertura: *"este simulado saiu com 52 das 80
questões pedidas"*. Antes ele saía menor em silêncio.

A conta de sempre: quanto mais questões de prova de verdade você subir (seção 21.3), menos a IA
precisa inventar.

---

## 26. Professores e agendamentos

Tela: **Professores** (`/admin/professores`), **Agendamentos** (`/admin/agendamentos`).

1. Em **Professores**, cadastre nome, e-mail, telefone, foto, biografia, **preço por hora**,
   **duração do horário** (padrão de 60 minutos) e o **link da sala** (Meet, Zoom) enviado ao aluno
   na confirmação.
2. Marque as **matérias** que o professor atende — é por elas que o aluno filtra.
3. Defina a **disponibilidade** por dia da semana e faixa de horário. A plataforma monta os horários
   livres a partir daí e nunca oferece um horário já reservado.
4. Em **Agendamentos**, confirme, cancele ou anote observações. O aluno acompanha tudo em
   Aulas Particulares.

Para desligar o recurso inteiro, use **Configurações › Aulas particulares habilitadas**.

---

## 27. Planos e assinaturas

Tela: **Planos** (`/admin/planos`).

1. Cadastre cada plano com **nome**, **descrição**, **preço**, **intervalo** (mensal ou anual),
   **24h de teste no cartão** (somente para 6 ou 12 meses), **lista de vantagens** e **destaque** (o plano que aparece
   marcado como recomendado).
2. Confira o status do **Asaas** no topo da tela. Sem `ASAAS_API_KEY`, os planos ficam visíveis,
   mas cartão e Pix permanecem indisponíveis.
3. A lista de assinaturas mostra quem está ativo, em teste, inadimplente ou cancelado.

Para liberar um aluno específico sem cobrança, use **Alunos › liberar acesso até** — a liberação
manual vale até a data escolhida, independentemente de assinatura.

---

## 28. Configurações

Tela: **Configurações** (`/admin/configuracoes`).

| Configuração | O que faz |
|--------------|-----------|
| **Nome da marca** | Nome exibido no painel, nos e-mails e no título das páginas. |
| **Logo** | Endereço da imagem usada no cabeçalho e nos e-mails. |
| **E-mail de suporte** | Endereço mostrado ao aluno e usado como remetente de resposta. |
| **Exigir assinatura** | Ligado, bloqueia o aluno sem assinatura ativa (ele só acessa perfil e assinatura). Desligado, a plataforma fica aberta a todos os cadastrados. |
| **Modelo do OpenRouter (tutor)** | Modelo usado no Tutor IA. |
| **Modelo do OpenRouter (redação)** | Modelo usado na correção de redação — costuma ser um modelo mais forte. |
| **Limite mensal de tokens** | Teto de consumo de IA no mês. Ao atingir, tutor e correção param com aviso claro. `0` significa sem limite. |
| **Prompt do tutor** | Instruções de comportamento do Tutor IA: tom, nível de detalhe, o que não fazer. |
| **Intervalos de revisão** | Os três intervalos, em dias, das revisões criadas ao concluir uma aula (padrão `1, 7, 30`). |
| **Padrões do cronograma** | Minutos do bloco de questões, minutos do bloco de revisão, redação semanal (sim/não) e de quantos em quantos dias entra um simulado. |
| **Aulas particulares habilitadas** | Liga ou desliga a área de aulas particulares para o aluno. |
| **Frases do dia** | Frases motivacionais discretas exibidas no início do aluno. |

Chaves e segredos (OpenRouter, Asaas, SMTP) **não** ficam no painel: vivem em variáveis de ambiente no
servidor. A tela mostra apenas o status de cada integração e os últimos caracteres da chave, para
você conferir que a configuração certa está no ar.

---

## 29. Rotina sugerida

* **Toda semana:** conferir redações aguardando correção, agendamentos pendentes e alunos parados.
* **Todo mês:** revisar o uso de IA em Plataforma, publicar novas aulas e questões, atualizar temas
  de redação.
* **A cada edital novo:** atualizar o conteúdo programático e os pesos do vestibular, e cadastrar a
  prova anterior mais recente.

## 30. Perguntas frequentes

**Excluí sem querer. Dá para voltar?**
Não. A exclusão é definitiva. Para tirar algo do ar preservando o histórico, use sempre
**desativar**. O registro de quem excluiu o quê fica em Plataforma › Auditoria.

**Por que não consigo excluir uma matéria?**
Porque existem assuntos, aulas ou questões vinculados. O aviso diz exatamente o que está preso —
mova ou exclua esse conteúdo antes, ou desative a matéria.

**Cadastrei a aula e ela não aparece para o aluno.**
Confira três pontos: a aula está **ativa**; o assunto e a matéria estão **ativos**; e o assunto está
marcado no **conteúdo programático da prova** do aluno.

**A questão não aparece nos simulados de uma prova.**
Marque a prova em **Provas em que cai**, no formulário da questão, ou na coluna `exams` do CSV.

**A correção de redação falhou.**
Veja a mensagem no modal da redação e confira, em Configurações, se a chave do OpenRouter está
configurada e se o limite mensal de tokens não foi atingido.

---

## 31. O que a plataforma ainda não faz

Lista curta e honesta, para não prometer o que não existe:

* **Não há confirmação de e-mail no cadastro.** Endereço digitado errado só aparece quando o aluno
  tenta recuperar a senha.
* **Não há termos de uso nem política de privacidade.** O aceite foi retirado da tela de cadastro
  justamente por prometer um documento que não existia. Volta quando os documentos existirem.
* **Troca de plano e cancelamento pelo aluno não existem.** São feitos por você, no painel do Asaas.
* **O item "Aulas Particulares" não some do menu** quando o recurso é desligado; a tela avisa que
  está indisponível.
* **A redação para em 6.000 caracteres** sem avisar quem está escrevendo.
* **Exclusão é definitiva.** Para tirar algo do ar preservando o histórico, use sempre *desativar*.
* **PDF digitalizado não vira questão** — prova que é foto de página não tem texto para ler. Use o
  campo de colar texto (seção 21.3).

---

*Este manual descreve a plataforma como ela está hoje. Quando uma tela mudar, a seção correspondente
muda junto — é por isso que ele mora no repositório, ao lado do código, e não em um arquivo solto.*
