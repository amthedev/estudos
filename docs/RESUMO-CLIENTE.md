# Foco de Elite — o que foi entregue

*Texto pronto para enviar ao Guilherme.*

---

Guilherme, tudo certo?

A plataforma está pronta. Peguei a sua lista original, item por item, e abaixo mostro onde cada coisa
que você pediu ficou dentro do sistema. É bem detalhado de propósito: assim você consegue conferir
tudo sem precisar decorar nada e sabe exatamente onde clicar quando for usar.

Junto com este resumo vão um vídeo em que percorro a plataforma inteira, um checklist do que ainda
preciso de você para colocar no ar (chave da OpenAI, conta do Stripe, domínio, e-mail, logo definitiva
e os vídeos das aulas) e a documentação técnica.

---

## 1. Identidade visual

Você pediu uma cara séria, de plataforma premium, nada infantil e nada com jeito de "feito por
inteligência artificial".

A plataforma inteira usa fundo azul-marinho quase preto, cards em azul escuro, texto branco, azul
elétrico nas ações, verde no progresso e nos acertos, laranja nos alertas e vermelho suave nos erros.
O dourado da sua logo aparece só na marca, exatamente como no arquivo que você mandou — se ele virasse
cor de interface, perderia o valor. O lema "Disciplina transforma sonhos em realidade" está na página
inicial e no rodapé.

Não há emoji em lugar nenhum da interface: todos os ícones são de uma biblioteca profissional e seguem
o mesmo traço. Também não há texto de enfeite: tudo o que aparece na tela é informação real.

## 2. Login e cadastro

O aluno cria a conta com nome, e-mail e senha, e já entra. Existem também recuperação e redefinição de
senha por e-mail.

A senha nunca é guardada como texto: fica criptografada, e nem eu nem você conseguimos lê-la. O login
do painel administrativo é **separado** do login do aluno, com endereço e chave de segurança próprios.
Um aluno não consegue entrar no painel nem digitando o endereço.

## 3. Onboarding

Depois do cadastro, o aluno responde uma sequência curta de perguntas:

* qual prova vai fazer;
* quais dias da semana consegue estudar;
* quantas horas por dia;
* qual o nível em que se considera hoje;
* em qual matéria tem mais dificuldade.

No momento em que ele termina, o cronograma já está montado. Ele não cai numa tela vazia perguntando
"por onde começar" — cai no plano do dia.

## 4. Estrutura do conteúdo, sem duplicar aulas

Este foi o ponto que você mais reforçou, e ele está resolvido na raiz.

O conteúdo é organizado assim: **área → matéria → assunto → subassunto → aula**. A aula é cadastrada
**uma única vez** e depois marcada nas provas em que aquele conteúdo cai. "Porcentagem" existe uma vez
só, dentro de Matemática, e aparece tanto para quem estuda para o ENEM quanto para quem estuda para o
Barro Branco.

O mesmo vale para as questões. Você nunca vai precisar cadastrar a mesma coisa duas vezes, e quando
corrigir uma aula, a correção vale para todas as provas de uma vez.

## 5. As três trilhas

* **ENEM** — as quatro áreas de conhecimento com o peso de cada uma, questões do INEP e redação pelas
  cinco competências.
* **Academia do Barro Branco / Cadete PM-SP** — o conteúdo programático do concurso, as matérias
  específicas do edital, questões no formato da VUNESP e redação pelos critérios do edital.
* **Vestibulares concorridos** — FUVEST, UNICAMP, UNESP, FGV, Mackenzie e PUC-SP, cada uma com a sua
  lista de assuntos e os seus pesos.

Cada prova tem data, matérias com peso e a lista de assuntos que cobra — tudo editável por você no
painel. Se amanhã você quiser incluir outra prova, é cadastro, não programação.

## 6. Matérias

O aluno vê as matérias da prova dele em cards, cada um com o percentual já concluído. Ao entrar na
matéria, vê os assuntos, com quantas aulas já assistiu e qual a taxa de acerto dele em cada um. Dentro
do assunto, os subassuntos e as aulas.

O caminho de volta está sempre visível, então ele nunca se perde.

## 7. Aulas

Cada aula tem o vídeo hospedado na própria plataforma, o resumo em texto, a duração, a dificuldade e
a lista das provas em que aquele conteúdo cai — aquele "onde cai" que você queria que o aluno visse.

Ao concluir a aula, três coisas acontecem sozinhas: o progresso da matéria sobe, as revisões daquele
assunto são agendadas e o item correspondente do cronograma é marcado como feito.

## 8. Anotações

Ao lado do vídeo há um campo de anotações que **salva sozinho** enquanto o aluno digita — aparece um
"Salvo" discreto, sem botão para clicar.

Todas as anotações se acumulam em "Meus Resumos", filtráveis por matéria, assunto e data. Na reta
final, é o material de revisão dele, escrito por ele mesmo.

## 9. As cinco questões depois da aula

Assim que a aula é concluída, aparecem cinco questões daquele assunto. Não são aleatórias: o sistema
prioriza o subassunto da aula e evita repetir questões que ele acabou de responder.

A cada resposta ele vê na hora se acertou ou errou, qual era a alternativa correta, a resolução
comentada e a explicação. E há um botão para levar aquela dúvida direto ao tutor.

## 10. Banco de questões

Além das cinco da aula, existe o banco completo, com filtros por matéria, assunto, subassunto, ano,
banca e dificuldade. O aluno pode montar a própria sessão de treino a qualquer momento.

## 11. Caderno de erros

Toda questão errada entra no caderno automaticamente — o aluno não precisa marcar nada. Ele filtra por
matéria e por assunto e usa o modo "refazer" para reencontrar só os erros. Quando acerta, a questão sai
da lista.

Na prática, é o caderno de erros que todo mundo diz que vai manter e ninguém mantém — só que este se
mantém sozinho.

## 12. Cronograma e adaptação

O cronograma é gerado a partir de: prova escolhida, dias e horas disponíveis, peso de cada matéria
naquela prova, o que ele já concluiu, a taxa de acerto dele em cada assunto, as revisões vencidas e a
proximidade da data da prova.

Cada dia sai montado com aula, bloco de questões, revisões devidas, redação uma vez por semana e
simulado a cada quinze dias, tudo dentro do tempo que ele disse ter. Ele visualiza por dia, por semana
e por mês, e pode concluir, reagendar, mudar o horário, marcar como não realizada ou acrescentar um
item próprio.

E o plano se ajusta sozinho quando: ele muda a disponibilidade ou a prova, vai mal em um bloco de
questões, termina um simulado ou aperta o botão **"Não consegui estudar hoje"** — que redistribui o que
ficou pendente pelos próximos dias de estudo, respeitando o tempo disponível de cada um, em vez de
deixar a dívida acumular. Esse botão é, na minha opinião, o recurso que mais segura o aluno na
plataforma.

## 13. Revisões

Toda aula concluída gera revisões automáticas em **1, 7 e 30 dias**, o intervalo clássico para o
conteúdo não escorrer da memória. A revisão não é reler: são cinco questões daquele assunto.

Elas entram sozinhas no cronograma, com prioridade sobre conteúdo novo, e o aluno tem uma tela própria
separando as de hoje, as atrasadas e as próximas.

## 14. Simulados

Ele pode montar simulado da prova inteira, de uma matéria só, de um assunto específico ou personalizado
(escolhendo quantidade de questões e tempo). Roda com cronômetro, navegação livre entre as questões e
marcação do que já respondeu, como na prova de verdade.

No fim, o resultado traz a nota, o desempenho por área e por matéria em gráficos e a lista do que
errou. O resultado também realimenta o cronograma.

## 15. Provas anteriores

As provas anteriores ficam organizadas por prova e por ano, com o arquivo e o gabarito. As questões
delas também alimentam o banco, então aparecem nos filtros e nos simulados.

## 16. Tutor com inteligência artificial

O aluno conversa em português normal e recebe a resposta na hora, aparecendo enquanto é escrita — não
fica uma tela parada esperando.

O tutor sabe o contexto: se a dúvida partiu de uma aula ou de uma questão, ele já entra sabendo qual é.
As conversas ficam salvas para o aluno voltar depois.

## 17. Redação com os critérios de cada prova

O aluno escolhe um tema da prova dele (ou pede um tema novo), escreve na plataforma e envia. A correção
usa **os critérios cadastrados para aquela prova**:

* ENEM: as cinco competências, de 0 a 200 cada;
* Barro Branco: os critérios do edital da VUNESP, na escala do edital;
* FUVEST, UNICAMP e UNESP: os modelos próprios de cada uma.

Ele recebe a nota de cada critério, um comentário explicando aquela nota, os pontos fortes, o que
precisa corrigir e a nota final. Os critérios são editáveis por você no painel: se um edital mudar, a
correção seguinte já usa o critério novo, sem mexer no sistema.

## 18. Histórico

Nada se perde. Ficam registrados: aulas assistidas e concluídas, questões respondidas com data e
resultado, simulados com nota e desempenho, redações com a correção completa, anotações, horas
estudadas e a sequência de dias seguidos estudando.

Se o aluno trocar de prova no meio do caminho, o histórico continua lá, e o que ele já estudou e também
cai na prova nova segue contando como progresso.

## 19. Dashboard

A tela inicial responde à única pergunta que importa: **o que eu estudo agora?**

Ela traz a próxima atividade com o botão de começar, a barra "Seu plano de estudos" com o percentual
geral, a sequência de dias estudados, horas, aulas concluídas, questões respondidas, taxa de acerto,
redações enviadas, as matérias em que ele está mais fraco, a meta da semana e o cronograma de hoje item
a item.

## 20. Meu Desempenho

Uma tela só de números e gráficos: acerto por matéria e por assunto, evolução por semana e por mês,
horas estudadas, resultado dos simulados, notas das redações e as listas separadas de pontos fortes e
pontos fracos.

## 21. Busca

Uma busca no topo procura ao mesmo tempo em aulas, questões, assuntos e resumos, com os resultados
agrupados por tipo.

## 22. Favoritos

O aluno marca aulas, questões, assuntos e resumos como favoritos e encontra tudo em uma tela com abas.

## 23. Perfil

Dados pessoais, meta de estudo, disponibilidade (dias e horas), prova escolhida, troca de senha e a
situação da assinatura, com acesso ao portal de cobrança. Ao alterar disponibilidade ou prova, o
cronograma é refeito automaticamente.

## 24. Menus

No computador, um menu lateral fixo com: Início, Meu Cronograma, Matérias, Aulas, Questões, Simulados,
Redação IA, Tutor IA, Provas Anteriores, Revisões, Caderno de Erros, Meu Desempenho, Meus Resumos,
Favoritos, Aulas Particulares e Perfil.

No celular, um menu inferior com os cinco atalhos do dia a dia — Início, Cronograma, Estudar, Tutor IA
e Perfil — e o restante acessível pelo menu completo. A plataforma toda foi feita para funcionar bem na
tela do celular, que é onde a maior parte dos alunos vai estudar.

## 25. Painel administrativo

Tudo o que aparece para o aluno é cadastrado por você, sem depender de programador:

* **Dashboard** — números da operação: alunos, atividade, assinaturas.
* **Alunos** — lista com prova, progresso e situação da assinatura; ficha individual com o que o aluno
  estudou; bloquear, desbloquear e liberar acesso manualmente (útil para cortesias e casos especiais).
* **Conteúdo** — a árvore de área, matéria, assunto e subassunto, com criação, edição e reordenação
  direto na tela.
* **Aulas** — cadastro enviando o arquivo do vídeo (a duração é lida do próprio arquivo
  automaticamente), resumo, dificuldade e o vínculo com várias provas de uma vez.
* **Questões** — cadastro completo com alternativas, gabarito, resolução e explicação; além da
  importação em planilha CSV, que valida linha por linha e diz exatamente o que corrigir nas que têm
  problema. Também há exportação.
* **Provas anteriores** — organização por prova e por ano, com arquivo e gabarito.
* **Vestibulares** — cada prova com data, matérias e pesos, assuntos cobrados e a configuração da
  redação. Mudar um peso aqui muda o cronograma de todos os alunos daquela prova.
* **Simulados** — modelos de simulado configuráveis.
* **Redação** — temas por prova, critérios de correção por prova e acompanhamento das redações
  corrigidas.
* **Professores e agendamentos** — cadastro dos professores, matérias, horários e as aulas
  particulares marcadas, para confirmar ou cancelar.
* **Planos e assinaturas** — criação e edição dos planos, sincronização com o Stripe e a lista de
  assinaturas ativas.
* **Configurações** — nome da marca, se a assinatura é obrigatória para usar a plataforma, modelos de
  inteligência artificial e o status das integrações.
* **Plataforma** — saúde do sistema, consumo de inteligência artificial por dia, por recurso e por
  aluno, erros registrados e o histórico de tudo o que foi alterado no painel, com autor e data.

## 26. Segurança da chave da OpenAI

A chave fica guardada **apenas no servidor**, em um arquivo de configuração protegido. Ela nunca é
enviada ao navegador, nunca aparece no código da página e nunca é exibida por inteiro no painel — lá
você vê só "configurada" e os últimos caracteres.

Toda conversa com a inteligência artificial passa pelo nosso servidor, nunca direto do computador do
aluno. Além disso há um teto mensal de consumo: ao ser atingido, o sistema recusa novas chamadas com
uma mensagem clara, em vez de continuar gastando. E existe um limite de quantas perguntas cada aluno
pode fazer por minuto, para ninguém conseguir "torrar" a sua conta.

## 27. Aulas particulares

O aluno vê os professores cadastrados, com matéria e horários disponíveis, e agenda. O agendamento
aparece no seu painel para confirmar ou cancelar, e ele acompanha as aulas marcadas na própria tela.

## 28. Pagamento recorrente pelo Stripe

A assinatura é recorrente e processada pelo Stripe. **Nenhum dado de cartão passa pela plataforma** —
o pagamento acontece dentro do ambiente do Stripe, que é quem guarda o cartão e cobra todo mês.

Os planos são cadastrados por você no painel, com nome, valor, período e o que está incluso, e
aparecem automaticamente na página inicial e na tela de assinatura. Renovação, cobrança recusada e
cancelamento chegam sozinhos à plataforma e liberam ou bloqueiam o acesso do aluno sem você precisar
fazer nada. O aluno tem um portal onde troca o cartão, vê as faturas e cancela; ao cancelar, o acesso
continua até o fim do período já pago.

Você também pode exigir ou não a assinatura para usar a plataforma, com uma chave no painel — útil no
começo, para liberar acesso a um grupo de teste.

---

## O que preciso de você agora

Está tudo no arquivo do checklist, mas em resumo: a chave da OpenAI, a conta do Stripe ativada, o
domínio apontado, o e-mail de envio, a logo definitiva em arquivo vetorial e os vídeos das aulas.

Assim que isso chegar, coloco no ar e te mando o endereço funcionando.

Qualquer coisa que você quiser ajustar depois de assistir ao vídeo, é só falar.

Abraço,
Allan
