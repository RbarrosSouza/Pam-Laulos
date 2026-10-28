# Exclusão de fichas no Pam Laudos

Implementação de 28/10/2026. O menu da ficha inclui **Excluir ficha**. O servidor exige sessão ativa da equipe, versão atual e confirmação literal **DELETAR**.

A exclusão remove os objetos privados/staging do Pam Laudos, dados extraídos, identificação, histórico da ficha, responsabilidade e detalhes de exibição dos recibos. O Google Drive é preservado por orientação explícita do usuário. Restam identificadores técnicos de origem/hash para impedir a recriação na coleta. O registro removido é invisível às consultas autenticadas.

O processo tem duas fases: bloquear tarefas e iniciar exclusão; remover os objetos via Storage; confirmar a ausência e finalizar a limpeza. Falhas permitem nova tentativa. A interface só informa sucesso para `state=deleted`.

Fichas com vínculos clínicos, versões compartilhadas, envios ao grupo já realizados ou operações/alertas em andamento recebem erro explicativo. A ação não remove prontuários do PAM Nexus. Um staging externo concluído (`reported`) admite supressão por hash; staging iniciado/incerto aguarda resolução antes de continuar.

## Reprocessamento

Gmail e WhatsApp reconhecem `deleting/deleted` e a resposta `excluded`. Auditoria de descoberta registra `excluded/user_deleted`, sem confirmar preservação fictícia. A mesma identidade continua reservada; outra origem com bytes idênticos é associada ao marcador de exclusão. Avisos Hopelab retornam antes de criar snapshots quando o conteúdo está excluído; bytes diferentes continuam como novo original, sem criar relação de versão com um registro removido.

## Validação

- `npm run build`
- `npm run test:exames`
- `npm run test:exames:exclusao`
- `node --test scripts/exames/operacional-workflows.test.mjs scripts/exames/whatsapp-intake-build.test.mjs scripts/exames/intake/n8n-discovery-audit.test.mjs`
- `supabase/tests/exam-deletion.test.mjs` aceita `PAM_DELETION_TEST_PG` (JSON de conexão) apenas para host `127.0.0.1`, banco descartável `pam_deletion_test`, com pacote `pg` disponível. Esse modo valida duas conexões simultâneas: exclusão primeiro bloqueia novas tarefas; worker primeiro impede exclusão enquanto houver reserva ativa. O teste cria schemas e deve usar banco vazio e isolado.
- `PAM_DELETION_COMPAT_DIR` permite executar antes da exclusão as migrações locais 28/30/31/33–39, verificando compatibilidade sem publicá-las ou incluí-las neste PR.

Foram executados PostgreSQL local e compatibilidade com as migrações concorrentes. A fronteira legada do fixture é reduzida, e Storage/serviço usam adaptadores isolados; isso não equivale a validação em produção.

## Implantação

Publicar de forma coordenada a migração `20261028000040_exam_document_deletion.sql`, a Edge Function `exam-document-service`, os workflows gerados OPERACIONAL-01 e OPERACIONAL-05 e o bundle atualizado da auditoria de descoberta. Os wrappers existentes de ingestão são preservados. Não publicar somente a interface. Revalidar no ambiente de destino a sequência de migrações (a migração 39 pertence a outro trabalho) antes de aplicar 40. A mudança não exige apagar nenhum arquivo no Drive.

Estado atualizado em 28/10/2026: após a publicação da interface, a tentativa de excluir retornou “Ação restrita ao worker” porque o serviço de produção ainda não continha a ação delete e SQL40 não estava instalada. A implantação foi concluída: SQL40 aplicada, index.ts do serviço publicado e conferido após recarga; os outros arquivos do serviço foram preservados. Sete workflows de Gmail/WhatsApp/Outlook foram publicados com os mesmos IDs, parâmetros e credenciais, ajustando somente Code para respeitar excluídos e evitar a recriação. O patch Outlook abaixo foi integrado ao runtime, incluindo a fila de retry; a reconferência WhatsApp passa a excluir somente a origem comprovadamente user_deleted e continua processando anexos irmãos faltantes.

Validação desta correção: 60 cenários locais do serviço, testes SQL/UI de exclusão e 58 testes direcionados de coletores aprovados. No banco de produção, registro fictício sem arquivo externo comprovou confirmação obrigatória, bloqueio de nova tarefa, início/finalização e repetição idempotente; tudo foi desfeito por ROLLBACK. ACL confirmou execução das RPCs somente pelo serviço, e o handler publicado continua exigindo sessão humana verificada. Não foi apagada ficha real nem exercitada exclusão de um arquivo real de Storage pela interface nesta validação. O Drive permanece fora da operação.
