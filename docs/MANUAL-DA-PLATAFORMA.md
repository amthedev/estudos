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
18. Como o painel se organiza · 19. Visão geral · 20. Alunos · 21. Conteúdo · 22. Aulas ·
23. Questões · 24. Provas anteriores · 25. Editais · 26. Vestibulares · 27. Planos de estudo ·
28. Redação · 29. Simulados · 30. Professores e agendamentos · 31. Planos e assinaturas ·
32. Página inicial · 33. Configurações · 34. Plataforma · 35. Rotina sugerida ·
36. Perguntas frequentes · 37. O que a plataforma ainda não faz

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
> prova dele (seção 26).

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
> configurável (seção 33). Se ainda assim faltar, o simulado **avisa na abertura**: "este simulado
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
> vestibular (seção 26.4). Sem ele, a conta passa a usar *todas* as aulas da plataforma como
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

> Desligar o recurso em **Configurações** (seção 33) faz a tela responder "Aulas particulares
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
(seção 20) vale como assinatura, até a data escolhida.

> **Troca de plano e cancelamento não são automáticos.** O Asaas não tem portal do assinante: com uma
> assinatura ativa, tentar assinar outro plano é recusado com a orientação de falar com o suporte, e
> o botão "Gerenciar assinatura" abre a fatura, não um painel de troca. Quem faz a troca ou o
> cancelamento é você, pelo painel do Asaas.

---

# PARTE II — O ADMINISTRADOR

---

## 18. Como o painel se organiza

O menu lateral segue a ordem do trabalho.

| Seção | Onde fica | Para que serve |
|---|---|---|
| Visão geral | `/admin` | Números do dia e consumo de IA do mês. |
| Alunos | `/admin/alunos` | Ficha, progresso, bloqueio e liberação manual de acesso. |
| Professores · Agendamentos | `/admin/professores`, `/admin/agendamentos` | Aulas particulares. |
| Conteúdo | `/admin/conteudo` | Áreas, matérias, assuntos e subassuntos — a base de tudo. |
| Aulas | `/admin/aulas` | Videoaulas. |
| Questões | `/admin/questoes` | Banco de questões. |
| Ler prova em PDF | `/admin/ler-prova` | Transforma a prova aplicada em questões do banco. |
| Editais | `/admin/editais` | Edital de cada certame, com as datas oficiais. |
| Provas anteriores | `/admin/provas-anteriores` | PDFs de prova e gabarito. |
| Planos de estudo | `/admin/planos-de-estudo` | **A sequência que comanda o cronograma do aluno.** |
| Vestibulares | `/admin/vestibulares` | Provas atendidas, pesos, conteúdo programático e matriz de redação. |
| Simulados | `/admin/simulados` | Modelos de simulado prontos. |
| Redação | `/admin/redacao` | Temas, critérios e redações corrigidas. |
| Planos | `/admin/planos` | Planos de assinatura e integração com o Asaas. |
| Página inicial | `/admin/pagina-inicial` | Textos, depoimentos e perguntas do site público. |
| Configurações | `/admin/configuracoes` | Marca, acesso, IA, e-mail e cronograma. |
| Plataforma | `/admin/plataforma` | Saúde do sistema, uso de IA, erros e auditoria. |

No rodapé da barra lateral ficam **Ver como aluno** (abre a área do aluno em outra aba, útil para
conferir o que ele enxerga), **Recolher menu** (o estado fica guardado no navegador) e **Sair**.

Toda alteração fica registrada na auditoria (`/admin/plataforma`), com quem fez, o que mudou e quando.

> **Regra de ouro:** para tirar algo do ar preservando o histórico, use **desativar**. Excluir é
> definitivo.

### Ordem recomendada em uma implantação nova

1. Vestibular (dados básicos) → 2. Conteúdo (áreas, matérias, assuntos) → 3. Conteúdo programático e
pesos do vestibular → 4. **Plano de estudos** do vestibular → 5. Aulas → 6. Questões →
7. Critérios e temas de redação → 8. Simulados e provas anteriores → 9. Planos e configurações.

---

## 19. Visão geral

Tela: `/admin`.

Nove cartões com os números do dia (alunos, estudo, questões respondidas, redações, assinaturas), o
**consumo de IA do mês** com barra mostrando quanto do limite já foi usado, os gráficos
**Cadastros por dia** e **Atividade por dia**, e as listas **Últimos alunos** e **Últimas redações**.

É a tela para abrir de manhã: se o consumo de IA está perto do teto, ou se as redações pararam de ser
corrigidas, aparece aqui antes de o aluno reclamar.

---

## 20. Alunos

Telas: **Alunos** (`/admin/alunos`) e a ficha do aluno (`/admin/alunos/:id`).

**Não existe cadastrar aluno pelo painel.** Quem cria a conta é a própria pessoa, pelo site.

Na lista há quatro cartões de número e filtros por **Situação**, **Prova**, **Onboarding** e
**Assinatura** — incluindo o estado "Acesso liberado à mão". Em cada linha: **Ver perfil**,
**Liberar acesso** e **Bloquear / desbloquear**.

Na ficha do aluno:

* Oito cartões: aulas concluídas, questões respondidas, acurácia, horas de estudo, sequência de dias,
  simulados, redações e tamanho do caderno de erros.
* Gráfico de atividade dos últimos 30 dias, progresso por matéria, últimas atividades e redações.
* Formulário com os dados da conta **e as preferências de estudo**. Mudar prova, dias ou horas
  **recalcula o cronograma do aluno** — a própria tela avisa.
* **Redefinir senha** — é a saída quando o envio de e-mail ainda não está configurado e o aluno não
  consegue recuperar a senha sozinho.
* **Liberar acesso até** uma data: vale como assinatura, sem cobrança.
* **Excluir aluno** — definitivo, leva o histórico junto.

---

## 21. Conteúdo: áreas, matérias, assuntos e subassuntos

Tela: **Conteúdo** (`/admin/conteudo`). É uma árvore de quatro níveis:

**Área** (Linguagens, Matemática, Natureza, Humanas) → **Matéria** (Língua Portuguesa, Física) →
**Assunto** (Porcentagem) → **Subassunto** (Juros simples).

Em cada nível há o botão **Adicionar**, e no topo **Expandir**, **Recolher** e **Atualizar**.

* **Área** — só nome e ordem. Área não tem descrição nem interruptor de ativa.
* **Matéria** — nome, área, descrição, ícone, cor (usada nos cartões, gráficos e no cronograma) e
  ordem.
* **Assunto e subassunto** — nome, descrição e ordem. No assunto você ainda marca **em quais provas
  ele cai**, e é isso que faz o assunto aparecer para o aluno daquela prova.

Arrastar reordena. Desativar tira do aluno mantendo o histórico. Excluir só funciona quando não há
nada pendurado — o aviso diz o que está preso.

> **O identificador (slug) não aparece nesta tela e não muda quando você renomeia.** Ele é gerado uma
> vez, a partir do nome original. Quando precisar dele — para preencher uma planilha de questões, por
> exemplo — pegue no **Baixar modelo CSV** ou no **Exportar CSV** da tela de Questões.

---

## 22. Aulas

Telas: **Aulas** (`/admin/aulas`), **Nova aula** (`/admin/aulas/nova`) e
**Enviar aulas em massa** (`/admin/aulas/enviar`).

### 22.1 Cadastrar uma aula

1. **Arquivo da videoaula** — o vídeo é **enviado por você**, não é link de YouTube nem de Vimeo. O
   campo é preenchido pelo envio do arquivo e não aceita digitação.
2. **Duração** — lida do próprio arquivo durante o envio, quando o campo ainda está no padrão.
3. **Título**, **descrição** e **resumo da aula** (aceita formatação).
4. **Classificação**: matéria → assunto → subassunto.
5. **Dificuldade**, **professor** e **miniatura**.
6. **Provas em que cai** — marque todas; é o que leva a aula ao aluno de cada prova.
7. **Aula ativa** — desmarque para preparar sem publicar.

Além de **Salvar**, há **Salvar e criar outra**, que mantém matéria, assunto, subassunto, professor,
provas e dificuldade — é o caminho rápido para cadastrar uma sequência. Na edição existe **Excluir**.

> Aulas antigas gravadas com link de YouTube ou Vimeo continuam tocando, mas **não há mais como criar
> uma assim** pelo formulário.

### 22.2 Enviar várias aulas de uma vez

Em **Aulas › Enviar aulas em massa** você solta vários arquivos, define de uma vez a classificação
comum (matéria, assunto, subassunto, professor, dificuldade, provas e o interruptor **Aulas ativas**),
ajusta o título de cada uma e envia. **Limpar lista** recomeça. O progresso de cada arquivo aparece
na própria linha.

---

## 23. Questões

Telas: **Questões** (`/admin/questoes`), **Nova questão**, **Importar** e
**Ler prova em PDF** (`/admin/ler-prova`).

A lista filtra por matéria, prova, dificuldade, **ano**, **banca**, **situação**, **origem** e
**conferência**.

### 23.1 Cadastrar manualmente

1. **Enunciado** — com aba de prévia. Textos de apoio, tabelas e citações entram aqui.
2. **Imagem da questão** (opcional).
3. **Alternativas** — de duas a cinco (A–E), marcando a correta. As vazias são ignoradas.
4. **Resolução passo a passo** e **Explicação da resposta** — aparecem depois que o aluno responde.
   Vale muito a pena preencher: é o que transforma erro em aprendizado.
5. **Classificação**, **dificuldade** e **origem** (prova, ano, banca).
6. **Provas em que cai**.
7. **Questão ativa** — questões inativas não são sorteadas.

À direita, o cartão **Como o aluno vê** reproduz a questão em tempo real. **Salvar e criar outra**
mantém apenas matéria, assunto e subassunto. Na edição há **Excluir**.

### 23.2 Importar por planilha

**Questões › Importar**: baixe o modelo CSV (já vem com o cabeçalho certo e uma linha de exemplo com
matéria e assunto reais do seu banco), preencha uma questão por linha, envie o arquivo ou cole o
texto, confira a prévia e importe.

O resultado mostra quantas entraram e lista **linha a linha** o que deu errado. As linhas válidas são
gravadas mesmo quando outras falham: corrija só as com erro e reenvie essas.

Separador ponto e vírgula (vírgula e tabulação também servem). O cabeçalho aceita nomes em português:
`enunciado`, `gabarito`, `materia`, `assunto`, `dificuldade`, `ano`, `banca`, `provas`.
Limite: 2.000 linhas por importação e 4 MB por arquivo.

### 23.3 Ler uma prova em PDF

Tela: **Ler prova em PDF** (`/admin/ler-prova`). É o caminho para transformar uma prova já aplicada —
ENEM, ENEM PPL, Barro Branco — em questões do banco sem digitar uma a uma.

**O caminho rápido, para encher o banco de uma vez:** na própria tela, o botão
**Ler todas de uma vez** percorre todas as provas cadastradas que ainda não foram lidas — lê o
gabarito oficial de cada uma, lê o PDF, varre até o fim e deixa tudo na fila de conferência. Dá para
parar no meio; o que entrou fica, e a prova interrompida continua pronta para retomar.

Para uma prova só, o caminho é este:

1. **Nova leitura de prova.** Nome, **vestibular**, **ano** e **banca**. Se a prova já está em
   **Provas anteriores**, escolha-a em *Aproveitar uma prova já cadastrada*: os campos se preenchem,
   o arquivo não precisa ser enviado de novo e o gabarito é lido do PDF cadastrado.
2. **Cole o gabarito oficial.** Aceita `1-A 2-B 3-C`, `1) A`, um por linha. **Faça isso.** Sem o
   gabarito, a inteligência artificial precisa *resolver* cada questão para marcar a resposta, e erra
   com confiança. Com o gabarito, ela só transcreve.
3. **Escolha o PDF.** O texto é lido no seu próprio navegador; o arquivo não vai para a IA.
4. **Varrer a prova.** Use **Varrer a prova inteira** e deixe rodando, ou vá por partes. Pode fechar a
   aba: o botão vira **Continuar de onde parou**.
5. **Conferir.** Cada questão aparece com enunciado, alternativas e a resposta em verde. Dá para
   trocar o gabarito na hora ou **descartar**.
6. **Mandar as marcadas para o banco.** **Marcar as N com gabarito** seleciona de uma vez tudo que
   veio do gabarito oficial.

Também há **excluir a leitura** — as questões que já foram para o banco continuam lá.

**PDF digitalizado não funciona.** Se a prova for foto de cada página, a tela avisa. Use o campo
**Cole o texto da prova**, logo abaixo do arquivo: serve para prova em Word, copiada de um site, ou
digitalizada que você já passou por um leitor de texto.

### 23.4 Conferir as questões que a IA escreveu

Quando um aluno pede para praticar depois da aula, a plataforma usa primeiro o banco; o que faltar, a
IA elabora na hora e **guarda**. Essas questões entram **ativas**, sem esperar conferência — se
ficassem escondidas, o erro do aluno sumiria do caderno de erros dele.

Em troca, a lista de questões tem como achar o que precisa de atenção:

* Filtro **Origem › Elaboradas pela IA**.
* Filtro **Conferência › Ainda não conferidas**, **Com aviso de aluno** ou **Já conferidas**.

Na coluna de situação aparecem os selos **IA**, **Sem conferência**, **N avisos** e a **taxa de
acerto** quando está muito baixa — gabarito trocado quase sempre aparece como "5 tentativas, 0% de
acerto". Use **Marcar como conferida** no menu da linha; isso também fecha os avisos dos alunos.

### 23.5 Exportar

**Exportar CSV** baixa exatamente o que está filtrado, no formato da importação. Serve para revisar em
planilha, corrigir em massa e reimportar. Para em 5.000 linhas.

---

## 24. Provas anteriores

Tela: **Provas anteriores** (`/admin/provas-anteriores`).

Cadastre **vestibular**, **ano**, **título** (como o aluno vê), **dia** (ENEM: 1 ou 2), **banca**, o
**PDF da prova** e o **PDF do gabarito** — os dois são campos de envio de arquivo, com até 20 MB cada,
e também aceitam um endereço já hospedado, **inclusive um link do Google Drive** (o arquivo precisa
estar como "qualquer pessoa com o link"). Há ainda **link externo**, **observações** e o interruptor
**visível para o aluno**.

> **Cadastre o PDF do gabarito sempre que tiver.** É ele que dispensa digitar as respostas na hora de
> ler as questões (seção 23.3) — e sem gabarito a inteligência artificial precisa *resolver* cada
> questão para marcar a correta, que é onde ela erra.

---

## 25. Editais

Tela: **Editais** (`/admin/editais`).

Um edital por certame, com: vestibular, ano, título, banca organizadora, vagas, **PDF do edital**,
página oficial, resumo para o aluno, início e fim das inscrições, **data da prova**, segundo dia,
resultado, taxa de inscrição e anotações internas (essas ficam só para você).

Três situações: **Rascunho**, **Publicado** e **Arquivado**.

> **Publicar um edital sobrescreve a data oficial do vestibular** — e a data da prova é o que o
> cronograma usa para calcular quanto tempo resta. Publicar reorganiza o estudo de todos os alunos
> daquela prova. É o que se quer, mas é bom saber antes de clicar.

---

## 26. Vestibulares

Telas: **Vestibulares** (`/admin/vestibulares`) e a página do vestibular.

A lista mostra, por prova, quantas matérias têm peso, quantos assuntos estão no conteúdo programático,
quantas provas anteriores existem e quantos alunos escolheram aquela prova.

### 26.1 Criar

No modal de criação: nome, sigla, trilha (ENEM, Barro Branco ou vestibular), data da prova,
**escala máxima da redação** e **ordem na lista**.

### 26.2 Aba Dados

Nome, sigla, banca, descrição, data da prova, se tem redação, **identificador** e situação.

### 26.3 Aba Matérias e pesos

Marque as matérias que caem e dê o peso de cada uma.

> O peso rege a distribuição das questões nos **simulados da prova**. Para o **cronograma**, ele só
> decide quando a prova **não tem plano de estudos** (seção 27) — e ENEM e Barro Branco já vêm com
> plano ativo.

### 26.4 Aba Conteúdo programático

Marque os assuntos cobrados. É o que define o que o aluno daquela prova enxerga em Matérias, e o
denominador do "% do conteúdo da sua prova" no Meu Desempenho.

### 26.5 Aba Redação

**Escala máxima** e a matriz de critérios — ver seção 28.1.

---

## 27. Planos de estudo

Tela: **Planos de estudo** (`/admin/planos-de-estudo`).

**É esta tela que comanda o cronograma do aluno.** Quando o vestibular tem um plano ativo, a sequência
dos dias vem daqui — não dos pesos das matérias. ENEM e Barro Branco já nascem com plano ativo.

No cabeçalho do plano: vestibular, nome, descrição, **aulas novas por semana**, **duração prevista em
semanas**, **prova anterior a cada N semanas**, **dias de treino** e o **nome da atividade** de treino
(é assim que o TAF do Barro Branco entra no cronograma). O interruptor **Plano ativo** vale a regra:
só um plano ativo por vestibular guia o cronograma.

Dentro do plano, uma sequência ordenada de passos, que você acrescenta e reordena. Cada passo é de um
tipo: **Aula**, **Revisão**, **Redação**, **Simulado**, **Prova anterior** ou **Treino físico**.

> Se você mexeu nos pesos e no conteúdo programático e o cronograma do aluno não mudou como esperava,
> o motivo está aqui.

---

## 28. Redação

Tela: **Redação** (`/admin/redacao`), com as abas Critérios, Temas e Redações.

### 28.1 Critérios de correção

A matriz de cada prova: um critério por linha, com nome, descrição, orientação de pontuação e nota
máxima. **A soma das notas máximas tem que bater com a escala máxima da prova** — se não bater, o
servidor recusa ao salvar e a tela mostra o erro.

É esta matriz que a IA usa. As competências do ENEM não são aplicadas ao Barro Branco. Prova sem
critérios cadastrados recebe um conjunto genérico, e a correção sai marcada como tal.

### 28.2 Temas

Cadastre o tema com proposta e textos motivadores, ou use **Gerar com IA**, que escreve um tema no
estilo da banca, publica e já abre o formulário para você revisar. A lista filtra por **origem**
(cadastrados ou gerados por IA) e mostra quantas redações cada tema recebeu.

### 28.3 Redações

Lista das redações dos alunos, com tema, prova, data, nota e situação — **Rascunho**,
**Aguardando correção**, **Corrigida** e **Falha na correção**. O modal traz a nota por critério, os
pareceres, as **sugestões** e o texto do aluno, e há a ação **Abrir o aluno**.

Falha na correção costuma ser chave da IA ausente ou limite mensal atingido; a mensagem do erro
aparece no topo do modal.

---

## 29. Simulados

Tela: **Simulados** (`/admin/simulados`).

Modelos prontos que aparecem para o aluno. Cadastre nome, descrição, **tipo** (prova completa, por
matéria, por assunto ou personalizado), a referência correspondente, **duração** e **número de
questões**, e o interruptor de disponível.

As questões são sorteadas no momento em que o aluno inicia — o mesmo modelo rende simulados diferentes
a cada tentativa. A lista mostra quantas **tentativas** cada modelo já teve e se as questões são
**sorteadas** ou **fixas**.

Tetos: 90 questões e 330 minutos.

### 29.1 O que o aluno vê

Ao escolher **Simulado da minha prova**, ele escolhe qual prova quer simular e o formato:
**Simulado completo** (80 questões em 4 h), **Mini simulado** (20 em 1 h) ou **Do meu jeito**.

### 29.2 Quando o banco não fecha a conta

A IA completa até o teto de **Configurações › Questões por IA em um simulado** (padrão 20; `0`
desliga). As questões criadas ficam no banco para os próximos. Faltando ainda, o simulado avisa o
aluno na abertura.

Quanto mais questão de prova de verdade você subir (seção 23.3), menos a IA precisa inventar.

---

## 30. Professores e agendamentos

Telas: **Professores** (`/admin/professores`) e **Agendamentos** (`/admin/agendamentos`).

No professor: nome, e-mail, telefone, foto, **Apresentação**, **preço por hora**,
**Duração da aula (minutos)** (padrão 60) e o **Link padrão da reunião**, enviado ao aluno na
confirmação. Marque as **matérias** que ele atende — é por elas que o aluno filtra.

A **disponibilidade** é editada num modal semanal, com **Adicionar janela** e **Salvar horários**. A
plataforma monta os horários livres a partir daí e nunca oferece um já reservado. A lista alerta quem
está **sem disponibilidade**.

Em Agendamentos: **confirmar**, **cancelar**, **marcar como realizada** e **ver detalhes** (recado do
aluno, observações internas e motivo do cancelamento).

Para desligar o recurso, use **Configurações › Oferecer aulas particulares aos alunos**.

---

## 31. Planos e assinaturas

Tela: **Planos** (`/admin/planos`).

Cada plano tem nome, identificador, descrição, preço, **preço de comparação**, intervalo, **A cada**
(meses entre cobranças), **meses pagos** e **meses de bônus** (pague 12, receba 15),
**teste grátis no cartão** (0 ou 1 dia, só faz sentido em planos longos), **Recursos** (a lista de
vantagens), **selo do card**, **ordem** e destaque.

Quatro cartões no topo, incluindo a **receita mensal recorrente**, e o status do Asaas. Sem a chave
configurada, os planos aparecem mas cartão e Pix não funcionam.

As assinaturas têm oito estados: em teste, ativa, em atraso, cancelada, incompleta, expirada, não paga
e pausada.

> **Pagamentos sem acesso** — botão no cabeçalho. Lista as cobranças que o provedor confirmou e que
> **não liberaram acesso** ao aluno, com a ação **Reprocessar**. É a ferramenta de resgate quando um
> aviso do Asaas se perde. Se um aluno disser "paguei e não liberou", é aqui.

Para liberar alguém sem cobrança, use **Alunos › Liberar acesso até**.

---

## 32. Página inicial

Tela: **Página inicial** (`/admin/pagina-inicial`), com quatro abas.

* **Blocos de texto** — nove blocos nomeados: Abertura, Reconhece isso?, Escolha seu objetivo, Como
  funciona, Planos, Tudo em um só lugar, Depoimentos, Perguntas frequentes e Fechamento.
* **Depoimentos** — nome, texto e foto.
* **Perguntas frequentes** — pergunta e resposta. Dentro de uma resposta, o marcador `{{planos}}` é
  trocado pela lista de preços atual, então não é preciso atualizar preço em dois lugares.
* **Provas em destaque**.

---

## 33. Configurações

Tela: **Configurações** (`/admin/configuracoes`). Há atalhos em chips no topo e um botão **Atualizar**.

| Configuração | O que faz |
|---|---|
| **Nome da marca** | Nome no painel, nos e-mails e no título das páginas. |
| **Logo da marca** | Imagem enviada por você, usada no cabeçalho e nos e-mails. Obrigatória. |
| **E-mail de suporte** | Endereço mostrado ao aluno. |
| **Exigir assinatura** | Ligado, o aluno sem assinatura ativa só acessa Perfil e Assinatura. |
| **Meio de cobrança das assinaturas** | Asaas ou Nenhum (desliga a cobrança). |
| **Modelo do tutor** | Modelo de IA usado no Tutor. |
| **Modelo da correção de redação** | Costuma ser um modelo mais forte. |
| **Limite mensal de tokens** | Teto de consumo de IA no mês; `0` é sem limite. |
| **Questões por IA em um simulado** | Quantas a IA pode elaborar para fechar um simulado; `0` desliga. |
| **Prompt do sistema** (Tutor IA) | Tom, nível de detalhe e o que o tutor não deve fazer. |
| **Intervalos de revisão** | Os três intervalos, em dias (padrão 1, 7 e 30). |
| **Padrões do cronograma** | Bloco de questões, bloco de revisão, redação semanal e de quantos em quantos dias entra simulado. |
| **Oferecer aulas particulares aos alunos** | Liga e desliga a área de aulas particulares. |
| **Frases do dia** | Frases exibidas no Início do aluno. |

Três ferramentas que valem mais que a tabela:

* **Enviar e-mail de teste** — dispara um e-mail de verdade e separa "o provedor recusou a conexão"
  de "o provedor recusou a mensagem", com a dica certa para remetente não verificado. **Use antes de
  o primeiro aluno esquecer a senha.**
* **Bloco Asaas** — mostra a **URL do webhook com botão Copiar** e a **lista dos eventos
  obrigatórios** a marcar no painel do Asaas, além dos selos Produção/Teste e webhook
  configurado/pendente.
* Chaves e segredos (IA, Asaas, e-mail) **não ficam aqui**: vivem em variáveis de ambiente no
  servidor. A tela mostra só o status e os últimos caracteres da chave.

---

## 34. Plataforma

Tela: **Plataforma** (`/admin/plataforma`).

* **Saúde**: tempo no ar, versão, banco de dados e memória em uso.
* **Registros no banco**.
* **Consumo de IA**: 30 dias, mês, erros, latência média, gráfico por dia, por funcionalidade e os
  alunos que mais usam.
* **Últimos erros**, com "Carregar mais".
* **Registro de auditoria**, com filtros por ação e período e detalhe de cada alteração.

---

## 35. Rotina sugerida

* **Toda semana:** redações aguardando correção, agendamentos pendentes, alunos parados e a fila de
  **questões da IA sem conferência**.
* **Todo mês:** uso de IA em Plataforma, novas aulas e questões, temas de redação novos.
* **A cada edital novo:** publicar o edital (atualiza a data da prova), revisar o conteúdo
  programático, os pesos e o plano de estudos, e subir a prova anterior mais recente.

---

## 36. Perguntas frequentes

**Excluí sem querer. Dá para voltar?**
Não. Para tirar do ar preservando o histórico, use **desativar**. Quem excluiu o quê fica em
Plataforma › Auditoria.

**Por que não consigo excluir uma matéria?**
Porque há assuntos, aulas ou questões vinculados. O aviso diz o que está preso.

**Cadastrei a aula e ela não aparece para o aluno.**
Confira: a aula está **ativa**; o assunto e a matéria estão **ativos**; o assunto está no **conteúdo
programático da prova** do aluno; e, se a prova tem **plano de estudos**, o passo correspondente
existe no plano.

**Mexi nos pesos e o cronograma não mudou.**
Porque a prova tem plano de estudos ativo, e é ele que manda (seção 27).

**A questão não aparece nos simulados de uma prova.**
Marque a prova em **Provas em que cai**, no formulário da questão, ou na coluna `exams` do CSV.

**Onde acho o identificador (slug) da matéria para a planilha?**
No **Baixar modelo CSV** ou no **Exportar CSV** da tela de Questões. Ele não aparece na tela Conteúdo
e não muda quando você renomeia.

**Um aluno pagou e não liberou.**
**Planos › Pagamentos sem acesso › Reprocessar** (seção 31).

**A correção de redação falhou.**
Veja a mensagem no modal e confira, em Configurações, a chave da IA e o limite mensal de tokens.

**O aluno não recebe o e-mail de recuperação de senha.**
Configure o provedor e use **Enviar e-mail de teste** (seção 33). Enquanto isso, redefina a senha dele
em **Alunos › Redefinir senha**.

---

## 37. O que a plataforma ainda não faz

Lista curta e honesta, para não prometer o que não existe:

* **Não há confirmação de e-mail no cadastro.** Endereço digitado errado só aparece quando o aluno
  tenta recuperar a senha.
* **Não há termos de uso nem política de privacidade.** O aceite foi retirado da tela de cadastro
  justamente por prometer um documento que não existia.
* **Troca de plano e cancelamento pelo aluno não existem.** São feitos por você, no painel do Asaas.
* **Não dá para cadastrar aluno pelo painel** — a conta é criada pela própria pessoa.
* **O item "Aulas Particulares" não some do menu do aluno** quando o recurso é desligado; a tela avisa
  que está indisponível.
* **A redação para em 6.000 caracteres** sem avisar quem está escrevendo.
* **Não há mais como cadastrar aula por link de YouTube ou Vimeo** — o vídeo é enviado por você.
* **PDF digitalizado não vira questão**; use o campo de colar texto (seção 23.3).
* **Exclusão é definitiva.**

---

*Este manual descreve a plataforma como ela está hoje. Quando uma tela mudar, a seção correspondente
muda junto — é por isso que ele mora no repositório, ao lado do código, e não em um arquivo solto.*
