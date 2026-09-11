# Manual do administrador — Foco de Elite

Este manual é o passo a passo de quem opera a plataforma: cadastrar conteúdo, aulas, questões,
provas anteriores, vestibulares, redação, professores e planos. Cada seção explica **o que a tela
faz**, **como usar** e **o que muda para o aluno**.

Endereço do painel: `https://focoelite.com.br/admin` (em desenvolvimento, `http://localhost:4100/admin`).
Entre com o e-mail e a senha de administrador. Se a sessão expirar, o painel devolve você à tela de
login sem perder nada do que já estava salvo.

> Regra de ouro: **conteúdo não se duplica por prova**. "Porcentagem" existe uma única vez em
> Matemática e é marcada nas provas em que cai. Nunca crie "Porcentagem ENEM" e "Porcentagem Barro
> Branco" — marque as duas provas no mesmo assunto.

---

## 1. Como o painel se organiza

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

## 2. Conteúdo: áreas, matérias, assuntos e subassuntos

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

### 2.1 Criar uma área

1. Clique em **Nova área** no topo da página.
2. Escreva o nome (ex.: "Ciências da Natureza") e clique em **Salvar**.

### 2.2 Criar uma matéria

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

### 2.3 Criar assuntos e subassuntos

1. Expanda a matéria pela seta à esquerda.
2. Clique no **+** da matéria para criar um **assunto**; no **+** do assunto para criar um
   **subassunto**.
3. Preencha nome e descrição e salve.

### 2.4 Marcar em quais provas o assunto cai

1. Clique no **nome do assunto**. O painel lateral direito abre com a lista de vestibulares.
2. Marque as provas cujo edital cobra aquele assunto.
3. Clique em **Salvar provas**.

Isso alimenta o conteúdo programático (`/admin/vestibulares/:id`, aba Conteúdo programático) e o
cronograma do aluno: só entram no plano de estudos os assuntos marcados na prova dele.

### 2.5 Reordenar, desativar e excluir

* **Setas para cima e para baixo** mudam a ordem em que o aluno vê os itens. A ordem é salva na hora.
* **Botão de liga/desliga** ativa ou desativa. Item inativo some das telas do aluno, mas o histórico
  e o progresso continuam intactos. **É a opção certa para conteúdo que saiu do edital.**
* **Lixeira** exclui de vez. Se houver aulas, questões ou assuntos dependurados, o sistema recusa a
  exclusão, explica o que está vinculado e oferece **desativar em vez de excluir**.

### 2.6 Busca

O campo de busca filtra a árvore inteira por matéria, assunto e subassunto, abrindo automaticamente
os ramos com resultado. Os botões **Expandir** e **Recolher** abrem e fecham tudo.

---

## 3. Aulas

Telas: **Aulas** (`/admin/aulas`), **Nova aula** (`/admin/aulas/nova`), **Importar aulas** (`/admin/aulas/importar`).

A lista mostra miniatura, título, matéria e assunto, provas em que a aula cai, duração e situação.
Use a busca e os filtros de matéria, prova, dificuldade e situação para achar rápido.

### 3.1 Cadastrar uma aula

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

### 3.2 Que arquivos funcionam

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

### 3.3 Editar e excluir

Clique na linha da tabela para abrir a aula. Os botões de ação de cada linha permitem editar, ir
para as questões do assunto, ativar/desativar e excluir. **Excluir a aula apaga também o progresso
registrado pelos alunos nela** — quando a intenção é só tirar do ar, desative.

### 3.4 Enviar várias aulas de uma vez

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

## 4. Questões

Telas: **Questões** (`/admin/questoes`), **Nova questão** (`/admin/questoes/nova`),
**Importar** (`/admin/questoes/importar`).

### 4.1 Cadastrar manualmente

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

### 4.2 Importar várias questões de uma vez

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

### 4.3 Exportar

O botão **Exportar CSV** na lista de questões baixa exatamente o que está filtrado na tela, no mesmo
formato da importação. Serve para revisar em planilha, corrigir em massa e reimportar.

---

## 5. Provas anteriores

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

## 6. Vestibulares

Telas: **Vestibulares** (`/admin/vestibulares`) e a página do vestibular (`/admin/vestibulares/:id`),
com quatro abas.

### 6.1 Criar um vestibular

1. Clique em **Novo vestibular**.
2. Preencha:
   * **Nome** e **Sigla** (a sigla aparece em badges e filtros).
   * **Trilha** — define a experiência do aluno: `ENEM`, `Barro Branco / PM` ou `Vestibular`.
   * **Banca**, **Data da próxima prova** e **Nota máxima da prova objetiva**.
   * **Descrição** — formato da prova, número de questões, o que o aluno precisa saber.
   * **A prova tem redação** e **Escala máxima da redação** (ENEM: 1000).
3. Ao salvar, o painel abre a página do vestibular para você continuar pelas abas.

### 6.2 Aba Dados

Todos os campos acima, mais o **Identificador** (o `slug` usado na importação de questões) e a
**Ordem na lista**. Desmarcar **Vestibular disponível** tira a prova das opções de escolha do aluno
sem apagar nada.

### 6.3 Aba Matérias e pesos

1. Escolha a matéria no seletor **Adicionar matéria** e clique em **Adicionar**.
2. Ajuste o **peso** de cada matéria. O peso multiplica a prioridade da matéria no cronograma:
   peso 3 recebe cerca de três vezes mais blocos de estudo que peso 1. Use os pesos do edital
   (quantidade de questões ou peso oficial da prova).
3. Clique em **Salvar matérias e pesos**.

Remover uma matéria da prova também remove os assuntos dela do conteúdo programático daquela prova.

### 6.4 Aba Conteúdo programático

1. Escolha a matéria na lista da esquerda.
2. Marque os assuntos cobrados no edital. **Marcar todos os assuntos desta matéria** resolve o caso
   comum de "cai a matéria inteira".
3. Clique em **Salvar conteúdo desta matéria**. Repita para cada matéria.

O contador ao lado de cada matéria (`9/12`) mostra quantos assuntos já estão no edital. É esta
marcação que o cronograma usa para escolher o que o aluno estuda.

### 6.5 Aba Redação

Ver a seção 7.1.

---

## 7. Redação

Tela: **Redação** (`/admin/redacao`), com três abas.

### 7.1 Critérios de correção

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

### 7.2 Temas

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

### 7.3 Redações corrigidas

A aba **Redações corrigidas** lista aluno, prova, tema, nota, data e situação, com filtros por prova,
situação e período. Clique na linha para abrir a correção completa: nota por critério, comentários,
pontos fortes, pontos a melhorar, correções de escrita e o texto do aluno.

Situações possíveis: **Aguardando correção** (enviada, IA processando), **Corrigida** e
**Falha na correção** (a mensagem do erro aparece no topo do modal — normalmente falta de chave da
OpenRouter ou limite mensal atingido; verifique em Configurações e Plataforma).

---

## 8. Simulados

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

---

## 9. Professores e agendamentos

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

## 10. Planos e assinaturas

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

## 11. Configurações

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

## 12. Rotina sugerida

* **Toda semana:** conferir redações aguardando correção, agendamentos pendentes e alunos parados.
* **Todo mês:** revisar o uso de IA em Plataforma, publicar novas aulas e questões, atualizar temas
  de redação.
* **A cada edital novo:** atualizar o conteúdo programático e os pesos do vestibular, e cadastrar a
  prova anterior mais recente.

## 13. Perguntas frequentes

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
