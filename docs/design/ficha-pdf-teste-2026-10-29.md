# Ficha, cadastro e PDF — branch de teste

Implementação local autorizada por Rodrigo em 29/10/2026, após aprovação da prévia 03 e da aceleração da animação. **Sem autorização para produção.** Base: main `7dbb03d7b26a48ca236b6a3ab218faf1741c4d93`; branch `codex/ux-ficha-pdf-teste`.

## Comportamento

- Desktop: duas superfícies de mesmas dimensões. A ficha desliza sem mudar sua largura; o editor aparece suavemente. PDF atual/anterior ocupa a superfície esquerda enquanto o editor mantém seleção, rascunho e conferência.
- Até 900 px: navegação Ficha / PDF / Preencher. Campos persistem entre as áreas; PDF autenticado permite baixar/abrir em outra aba caso o navegador não incorpore o leitor.
- Cadastro: paciente escolhido com Trocar, tipo/data visíveis, informações adicionais e solicitações recolhidas, uma ação principal. Tipo e data precisam estar preenchidos; mudar campos/itens invalida a conferência. Classificação do documento (exame/conferência/não exame) mantém seu fluxo existente; não há classificação entre PDFs.
- Já anexado: resumo somente leitura, correção explicada em seção recolhida. Preservados bloqueios de versão, identificação concorrente, arquivos não salvos e retomada de anexação com falha.
- Originais: linha compacta, expansão suave, status independente e indisponibilidade explícita. Ambos enviados somente com dois recibos `sent`. Nenhuma alteração na captura, deduplicação ou envio de PDFs.
- Contato: preserva permissões e registra somente itens pendentes; clique duplo protegido. Falha de gravação não marca sucesso. Falha de leitura após uma gravação aceita informa “Contato salvo”, oferece atualizar e bloqueia outra gravação direta enquanto a confirmação não pode ser consultada.
- Conclusão: mesmos ícones centrais alternados/aro/check/partículas da proposta; etapa a cada 800 ms, conclusão em 3360 ms, saída em 5200–5520 ms, giro em 900 ms. A animação começa como “Salvando contato” durante a gravação. Só colore etapas comprovadas; “Card completo” exige estado global persistido e todas as etapas. Canais exibidos são os realmente existentes no produto (origem, grupo, cadastro, contato); não inventa uma confirmação independente de telefone. Fechamento manual, foco devolvido e movimento reduzido preservados.

## Testar sem dados reais

```sh
npm ci
npm run dev:exam-workspace
```

Abrir `http://127.0.0.1:4390/dev/exam-workspace-preview.html`.

A configuração dedicada substitui autenticação, consultas e gravações por módulos em memória; PDFs fictícios são gerados localmente. Não lê `.env` para conectar serviços, não faz solicitações ao Supabase/WhatsApp/PAM Nexus. A configuração recusa build, os cenários não entram no build normal e não há página de demonstração adicionada ao roteador do produto.

Cenários: Ficha, Já anexado, Etapas pendentes, Falha ao salvar, Falha de leitura, Falha de PDF e Anterior indisponível. Recarregar limpa as alterações fictícias.

## Verificações

- `npm run test:exames` — suíte existente e regressões adicionais do formulário compacto/contato direto.
- `node --test scripts/exames/intake/document-version-review-ui.test.mjs` — seis casos de originais e recibos.
- `npm run build` e ESLint dos arquivos TS/TSX alterados.
- Chrome desktop e 390×844: dimensões iguais, abertura/fechamento, rascunho após trocar PDFs, anexo fictício confirmado, resumo somente leitura, conclusão completa/parcial, erro de gravação/leitura/PDF e ausência de rolagem horizontal no celular.

Referência HTML aprovada foi preservada em `/Users/pameladecio/.codex/visualizations/2026/10/29/01a189de-9720-77e3-98b8-d4ac5accbb72/pam-laudos-proposta.html`. Evidências visuais 13–16 nessa mesma pasta. Testes sintéticos não comprovam operação clínica ou integrações em produção.

## Estado da entrega

Somente worktree/branch local de teste; sem push, PR, merge, deploy, migração ou alteração de dados reais. Produção permanece na base consultada. Próximo passo: revisão visual pelo usuário nesta implementação; eventual publicação depende de autorização específica.
