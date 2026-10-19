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

Revisão visual de Rodrigo antes de publicar o app. Depois, refinar Rastreamento, Enviar amostras, Histórico, Início e Conta. Revisar o tema escuro e conferir em iPhone físico antes da liberação. Fluxos autenticados com dados reais e mutações operacionais não foram testados nesta rodada de design.
