# QA local da página real de exame

Este harness importa o componente real `ExamDocumentContent`, substituindo apenas autenticação e hooks de dados por fixtures em memória. Não contém credenciais, não lê os arquivos `.env` do aplicativo e bloqueia conexões externas via CSP. Não é usado pelo entrypoint/configuração de produção.

Na raiz do repositório:

```sh
npx vite --config scripts/exames/mobile-preview/vite.config.ts
```

Abra `http://127.0.0.1:4182/?scenario=pending`. Cenários disponíveis: `pending`, `linked`, `complete`, `partial`, `error`, `long`, `reception`.

- `pending`: cadastro pendente; permite buscar Luna/Helena, selecionar, confirmar e simular anexação concluída após 900 ms.
- `linked`: anexado ao cadastro, aguardando contato.
- `complete`: todas as etapas concluídas, sem contador do grupo.
- `partial`: dois itens, um contato concluído e outro pendente.
- `error`: cadastro vinculado; qualquer gravação falha sem alterar o estado.
- `long`: nomes e tipo do exame extensos.
- `reception`: sem permissão para registrar contato.

Todos os casos são fictícios. Responsabilidade, conferência, vínculo e contato persistem somente na memória da aba; recarregar restaura o cenário. O PDF é gerado localmente. O cenário é escolhido na URL para não inserir controles artificiais na área visual da página.

`?scenario=nexus-failed` mostra a falha de anexação mesmo com o contato concluído. O botão da ficha solicita uma tentativa, exibe andamento e simula conclusão após1800ms. `?scenario=nexus-retry-error` conserva a falha e mostra erro de solicitação. Estes cenários usam somente memória local, sem anexo ou paciente real.

Para reproduzir a edição da data no vínculo sem usar Supabase, execute `QA_PREVIEW_PORT=4193 npx vite --config scripts/exames/mobile-preview/vite.config.ts` e abra `http://127.0.0.1:4193/?scenario=missing-date`. O paciente já está identificado, mas a data não foi salva. Em **Adicionar exame ao cadastro**, digite a data e salve a identificação. O cenário `date-error` simula uma falha de gravação, preservando o formulário e o rascunho.

## Salvamento e contato — 19/10/2026

`QA_PREVIEW_PORT=4195 npx vite --config scripts/exames/mobile-preview/vite.config.ts`

- `?scenario=pending`: em **Opções → Conferir dados**, salve uma edição. O modal fecha após a resposta salva, com notificação central que pode ser dispensada. O botão inferior continua utilizável mesmo durante a notificação. Confirmar um paciente também fecha o modal.
- `?scenario=linked`: em **Entrei em contato**, deixe **Observação (opcional)** vazia e registre. A confirmação aparece no centro, sem toast duplicado; **Voltar ao exame**, X e Escape retornam à tela.
- `?scenario=date-error`: salve uma edição. O erro não fecha o modal nem apaga o rascunho. Fechar a notificação também preserva o editor.

A mudança de nota opcional no banco está preparada na migração `20261019000015_exam_contact_optional_note.sql`. Para produção, instalar a migração junto à publicação aprovada da UI; o harness em memória não comprova instalação no Supabase nem contato/reação no WhatsApp real.
