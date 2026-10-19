# Pam Laudos — primeira rodada web e mobile

Pedido de 18/10/2026, concluído localmente em 19/10/2026. Branch `codex/pam-laudos-web-mobile`, criada de `origin/main` em `f70791c`.

## Direção e limites

Refinar a aplicação por etapas, seguindo o oliva, o fundo claro, a tipografia e a simplicidade aprovados na página do exame. Rodrigo confirmou que usa **Enviar amostras** e **Histórico de envios**: ambas continuam na navegação. O detalhe do exame preserva sua composição e suas ações.

Esta rodada prepara login, navegação, conta e fila de PDFs recebidos. Não altera banco, permissões, hooks de dados, serviços, Supabase, n8n ou envios. A branch e o PR #3 da reação no WhatsApp permanecem separados; não reimplantar backend a partir desta branch visual.

## Mudanças

- Navegação em Início, Exames, Amostras e Conta. Exames mantém Recebidos e Rastreamento; Amostras mantém Enviar amostras e Histórico de envios. As rotas anteriores continuam válidas, inclusive com barra final.
- Login com campos grandes, rótulos explícitos, mostrar senha acessível e menos texto. Redirecionamento, autenticação e distinção entre falta de acesso e falha de conferência preservados.
- Recebidos usa cartões no celular e linhas no desktop. Busca, oito filtros, paginação e links do documento preservados. Nome completo, data do exame e responsável continuam visíveis; progresso usa a regra existente, incluindo conclusão e tempo no grupo.
- Sair fica em Conta. A barra de ações de Rastreamento aparece quando há seleção; alertas de cartões ficam nas telas correspondentes.
- Retirados o botão de adicionar PDF permanentemente desativado, formulário inacessível, texto de perfil sem link e arquivos iniciais sem referências. Nenhuma função operacional foi excluída.
- Páginas carregam sob demanda, com estado de espera e recuperação de erro. Fontes locais e movimento reduzido respeitado.

## Prévia isolada

Execute `npm run dev -- --host 127.0.0.1 --port 4192 --strictPort` e abra `http://127.0.0.1:4192/design-preview.html`.

Os seletores permitem comparar login/aplicação e celular/web. São dados fictícios, sem Supabase ou autenticação; o formulário não transmite dados. As demais páginas exibem um aviso de funcionalidade preservada, pois seu conteúdo será refinado depois. A entrada separada existe apenas em desenvolvimento e não integra o build de produção.

## Verificações locais

- Build TypeScript/Vite, lint dos arquivos alterados e `git diff --check` passaram.
- 72 verificações existentes passaram: redirecionamento de login (25), link curto (7), rastreamento (16), detalhe (13) e progresso (11). Mais oito casos offline de navegação com barra final passaram.
- Prévia conferida em 320, 390, 768 e 1440 px: sem rolagem horizontal; busca, filtros, vazios, conclusão e navegação de Amostras/Histórico exercitados. Login local de 390 px conferido sem enviar credenciais.
- Confirmada ausência da entrada de prévia e dos dados fictícios no build de produção. Nenhuma mudança nos hooks, tipos, helper de progresso, Supabase ou n8n.
- JS inicial do build local caiu de aproximadamente 1.214 KB para 640 KB, somando entrada e dependências pré-carregadas. Isso mede arquivos locais, não tempo de carregamento real ou desempenho de produção.

## Próximas etapas

Revisão visual de Rodrigo antes de publicar o app. Depois, refinar Enviar amostras, Histórico, Início e Conta. Revisar o tema escuro e conferir em iPhone físico antes da liberação. Fluxos autenticados com dados reais e mutações operacionais não foram testados nesta rodada de design.

## Rodada 02 — Rastreamento, 19/10/2026

Rodrigo confirmou que a prévia abriu, aprovou o caminho visual e autorizou continuar o Rastreamento na mesma branch de testes. Isso não autoriza publicação do app.

- Busca sempre visível, com descrição fiel aos campos consultados: pet, tutor e veterinária. Filtros de etapas, responsável, criação da ficha e ordenação ficam em painel acessível. O período não representa a data do laudo. “Hoje” usa o dia local do navegador.
- No desktop, as quatro colunas permanecem. No celular, um seletor apresenta uma etapa por vez; a lista também se adapta a cartões. Nomes completos, exames, laboratório, veterinária, origem, resultados e etapa continuam acessíveis. Contatos concluídos não mostram cronômetro em aberto.
- Abrir, selecionar e arrastar têm controles separados, com áreas de toque de pelo menos 44 px. O arraste parte somente da alça. Durante o arraste mobile, os botões das etapas ficam disponíveis como destinos, inclusive etapas vazias. Alvos invisíveis são excluídos das colisões; o destino sob o ponteiro tem prioridade sobre o centro do card.
- Seleção restrita aos resultados filtrados, avanço com status atual e confirmação de autoria do contato preservados. Exclusão em lote usa diálogo com foco inicial em Cancelar, confirmação explícita e distinção entre exclusão e arquivamento documental. O backend mantém a autoridade sobre todas essas ações.
- Estados de carregamento, erro, dados anteriores e consulta vazia são distintos. A ficha detalhada, seus links documentais e os limites entre itens gerenciados por documento e itens legados permanecem.
- A prévia passou a incluir Rastreamento: `http://127.0.0.1:4192/design-preview.html?screen=tracking`. Todas as interações usam fichas fictícias e estado local, sem autenticação, banco ou mensagens.

Verificações: build, lint dos arquivos alterados e diffcheck aprovados; 16 regressões existentes do rastreamento e seis novos casos de colisão passaram. Revisão offline adicional conferiu seleção filtrada, payloads de avanço/DnD, confirmação da veterinária, estados de consulta e diálogo. QA no navegador em 320/390/768/1440 px sem rolagem horizontal; lista/quadro, filtros combinados, período, vazio, seleção e cancelamento de exclusão conferidos. Um arraste real pela UI mobile moveu somente uma ficha fictícia para `stage-no_grupo`.

Nenhuma alteração em hooks, tipos, banco, Supabase, n8n, detalhe documental, envio de amostras ou histórico. A entrada da prévia e os fixtures continuam fora do build de produção. Tema escuro, aparelho físico, mutações clínicas reais e operação autenticada em produção não foram validados nesta rodada.

## Rodada 03 — Enviar amostras e Histórico de envios, 19/10/2026

Rodrigo aprovou o caminho do Rastreamento e autorizou refinar as duas telas de amostras na mesma branch de testes. Sem autorização de publicar o aplicativo.

- Amostras aparecem primeiro, agrupadas por pet e tutor completo. Busca consulta pet, tutor, exame e laboratório, sem distinguir acentos. Seleção por exame, por pet ou por resultados visíveis; itens já enviados/com resultado ficam fora. A seleção não some ao buscar: a barra informa quantos selecionados ficaram fora da busca.
- Revisão em painel Radix com todas as amostras, remetente obrigatório e laboratório opcional. No celular a ação fixa aparece somente após selecionar; no desktop há resumo lateral. Registro concluído abre o Histórico, em vez de voltar ao Início.
- Amostra avulsa usa painel separado, exige pet/exame e aceita tutor/laboratório opcionais. A inclusão coloca a amostra nos pendentes; não registra um envio automaticamente.
- Adaptador envia um snapshot dos IDs elegíveis e dos cartões afetados, com nomes aparados e guarda síncrona contra dois envios/criação simultâneos. Mutações existentes preservadas. Como o backend grava em etapas, falha orienta conferir o histórico e não provoca repetição automática; esta rodada não torna o backend transacional.
- Histórico com Hoje, 7 dias (hoje e seis datas anteriores) e Todos; limites e apresentação usam America/Sao_Paulo. O hook de **leitura** recebeu início inclusivo/fim exclusivo UTC, mantendo os parâmetros antigos como alternativa. Nenhuma alteração nas mutações do hook, banco ou permissões.
- Cartões de envio abrem detalhes com pet/tutor completos, exame e observações; resumo mantém laboratório, remetente, quantidade original e data/hora/ano. Ausência de detalhes não apaga a contagem. Erro, dados anteriores, vazio e carregamento são distintos.
- A prévia DEV passou a incluir Amostras e Histórico, com inclusão e envio **simulados em estado local**. Sem autenticação, rede operacional ou gravações: `http://127.0.0.1:4192/design-preview.html?screen=samples`. O histórico pode ser aberto pela navegação interna ou pelo seletor da prévia.

Verificações locais: build TypeScript/Vite, lint dos arquivos alterados e diffcheck aprovados. Revisões offline dos callbacks e consultas verificaram IDs obsoletos, payload congelado, clique duplo, criação avulsa, erros sem retry, limites UTC/SP, sete dias, virada do ano e ano bissexto. Estados e semântica do histórico conferidos isoladamente. QA via navegador em 320/390/768/1440 px sem rolagem horizontal; seleção escondida pela busca, revisão completa, foco ao fechar, lote simulado → histórico, inclusão avulsa sem envio, filtros e expansão de detalhes/observações/ausência de itens exercitados. Entrada e fixtures DEV ausentes do build.

Capturas locais na pasta `design-web-mobile-20261019`: `04-amostras-revisao-mobile.png`, `05-historico-mobile.png`, `06-amostras-web.png`, `07-historico-web.png` e `08-amostras-mobile.png`.

Resultado somente local na branch de testes; nenhuma chamada clínica, envio ao grupo, alteração Supabase/n8n, push/merge/deploy do app nesta rodada. Revisão visual destas duas telas, tema escuro, iPhone físico e operações autenticadas reais ficam pendentes. Próxima etapa visual: Início e Conta, após revisão.
