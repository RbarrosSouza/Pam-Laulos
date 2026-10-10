# Backend de documentos de exames — contrato v1

Implementado localmente em 10/10/2026. Migrações e Edge Function ainda não aplicadas em produção. Fonte única de migrações compartilhadas: este projeto PamLaudos; o PAM Nexus consome os mesmos campos, sem aplicar outra cópia das migrações.

## Verificações locais

Dependências de teste: Node 22+, TypeScript do projeto e `@electric-sql/pglite` **0.5.8**. O teste não precisa de banco, Docker, chaves ou PDFs reais. Instalar a dependência como devDependency fixada no lockfile antes de executar em CI.

```sh
npm ci
node supabase/tests/exam-documents.test.mjs
node supabase/tests/exam-document-service.test.mjs
npx --yes deno@2.9.6 check supabase/functions/exam-document-service/index.ts
```

Resultado local: **40 cenários de integração SQL** e **14 cenários do handler Edge** passaram. O teste SQL executa migrações, RLS, funções, constraints e triggers do legado em PGlite. O teste Edge executa o handler real, transpilado com TypeScript, usando adaptadores isolados para Supabase/Storage. O `deno check` real passou com o cliente Supabase JS fixado em **2.99.3**.

PGlite usa uma conexão: reservas repetidas/consecutivas são cobertas, mas contenção entre conexões reais precisa de homologação no PostgreSQL. Os testes não comprovam OAuth, n8n importado, envio WhatsApp, entrega do provedor ou configuração em produção.

## Persistência e segurança

`20261010000001_exam_documents.sql` cria `exam_document`, `exam_document_source`, `exam_document_item`, `exam_document_delivery`, `exam_document_event`, `exam_document_member` e `exam_document_configuration`. `20261010000002_exam_document_card_guards.sql` protege transições, fusão, exclusão, correções e evidências do acompanhamento existente.

O acesso é por Supabase Auth **e** membro ativo em `exam_document_member`. Os papéis são `admin`, `vet` e `reception`. Somente `admin`/`vet` registram contato e conferência humana de envio; exceção de envio exige `admin`. A tabela de membros permite ler apenas o próprio cadastro; ninguém se autoriza por uma gravação do navegador. Provisionamento e configuração são restritos ao serviço/administrador do banco.

O endurecimento inclui as tabelas de acompanhamento `exam_card`, `exam_item`, `exam_card_log` e `lab_shipment`. A função legada `receive_email_result`, em todos os overloads, passa a ser executável somente pelo `service_role`; seu algoritmo de nomes não é usado pelo pipeline novo. O trigger `bridge_tracking_to_card` passa a ter `SECURITY DEFINER`, `search_path` fixo e execução direta revogada, para preservar criação de solicitações por vendas no Nexus sem abrir acesso aos documentos.

Buckets novos: `exam_documents_staging` e `exam_documents_private`, ambos privados. Políticas restritivas impedem políticas amplas antigas de liberar esses buckets. Clientes não inserem, alteram ou excluem seus objetos diretamente; leitura exige membro ativo. A cópia definitiva usa `pet_id/document_id/original.pdf`. `exames.exam_document_id` é único; referências privadas usam `storage_bucket` e `storage_path`, sem URL assinada permanente. Anexos legados mantêm `arquivo_url`.

Novos exames automatizados não aceitam edição/exclusão direta por clientes. Correções são novos arquivos ligados à versão anterior, já com paciente confirmado. Contatos anteriores e originais são preservados. A exclusão de card com documentos arquiva o card; a fusão move os itens, arquiva a origem e conserva seu histórico, sem deduplicar por nomes.

## Contrato do frontend

`v_exam_documents` é uma view `security_invoker`, autenticada e submetida à RLS. Ela retorna todos os campos de `exam_document` e:

| Campo | Conteúdo |
|---|---|
| `display_code` | `EX-` e os primeiros oito caracteres do UUID |
| `sources` | Array de origens |
| `items` | Array de vínculos com ID do item/card, tipo e evidência específica de contato |
| `deliveries` | Array de tarefas e tentativas |
| `contact_status` | `pending`, `assigned`, `completed` |
| `group_status` | Estado da tarefa; ausência retorna `pending` |
| `nexus_status` | Estado da tarefa; ausência retorna `awaiting_link` |
| `process_status` | Estado da tarefa; ausência retorna `pending` |
| `oldest_group_sent_at` | Primeiro envio confirmado deste documento, sem reiniciar por retry |
| `completed` | Original no Drive, identidade/vínculo confirmados, todos os itens contatados, Nexus concluído e grupo confirmado ou exceção auditada |

Dimensões principais: `file_status` = `pending`/`saved`/`failed`; `identification_status` = `unidentified`/`suggested`/`confirmed`/`review`/`not_exam`. JSON canônico usa `pet_name`, `client_name`, `species`, `exam_type`, `exam_date`, `lab_name`; `tutor_name` é aceito como alias na extração. Ausência de data clínica é nula, nunca hoje por conveniência. Sem data, o vínculo/contato são possíveis, mas a anexação ao Nexus aguarda conferência. Data/laboratório ausentes podem ser preenchidos após contato, antes de anexar; campos já usados não podem ser trocados silenciosamente.

RPCs autenticadas, com nomes e argumentos reais:

| RPC | Argumentos |
|---|---|
| `is_exam_document_member` | nenhum; booleano |
| `search_exam_document_candidates` | `p_query text`, `p_limit integer=20`; retorna array `{pet_id,pet_name,species,client_code,client_name,tutor_name,items:[{id,exam_card_id,exam_type,result_received}]}` |
| `review_exam_document` | `p_document_id uuid`, `p_expected_version bigint`, `p_fields jsonb`, `p_classification text='exam'`, `p_reason text=null` |
| `confirm_exam_document_link` | `p_document_id uuid`, `p_pet_id uuid`, `p_item_ids uuid[]`, `p_expected_version bigint`, `p_confirmed jsonb` |
| `assign_exam_document` | `p_document_id uuid`, `p_assignee_id uuid` (nulo libera) |
| `record_exam_document_contact` | `p_document_id uuid`, `p_item_ids uuid[]`, `p_channel text`, `p_note text`, `p_contacted_at timestamptz=now()` |
| `release_exam_document_group` | `p_document_id uuid`, `p_expected_version bigint`, `p_reason text` |
| `confirm_exam_document_group_delivery` | `p_document_id uuid`, `p_expected_version bigint`, `p_external_id text`, `p_reason text` |
| `confirm_exam_document_group_exception` | `p_document_id uuid`, `p_reason text` |
| `retry_exam_document_delivery` | `p_delivery_id uuid`, `p_reason text` |
| `mark_exam_document_correction` | `p_document_id uuid`, `p_previous_document_id uuid`, `p_expected_version bigint`, `p_reason text` |

Versão ausente/nula ou divergente retorna conflito SQL `40001`: recarregar a tela e conferir. `p_item_ids=[]` reutiliza vínculos existentes; em documento ainda sem vínculos, cria uma solicitação externa explicitamente confirmada. Repetir a mesma confirmação não cria card nem apaga contato. Canais de contato: `whatsapp`, `phone`, `email`, `in_person`. Somente itens deste documento podem ser abrangidos. Envio ao grupo não registra contato.

Histórico: `SELECT ... FROM exam_document_event WHERE document_id=... ORDER BY created_at DESC`. Metadados de documento, origens, eventos e vínculos não têm gravação REST permitida ao frontend.

## Edge Function para workers e arquivos

Endpoint: `POST /functions/v1/exam-document-service`, corpo JSON `{ "action": "...", "payload": {...} }`. A configuração `verify_jwt=false` permite o segredo dedicado de worker; o código faz toda a autenticação: comparação com `EXAM_INGESTION_API_KEY` ou `getUser` mais membro ativo. Um token de usuário não executa ações de worker.

Segredos do servidor: `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` fornecidos pela plataforma; `EXAM_INGESTION_API_KEY` dedicado ao n8n; leitura privada do Drive usa `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`. `GOOGLE_DRIVE_ACCESS_TOKEN` é alternativa temporária, que expira. A credencial OAuth selecionada no n8n não configura automaticamente o servidor. Segredos nunca vão no export JSON, browser ou Git.

| Action | Payload e resultado |
|---|---|
| `reserve_source` | `{source:{channel,account_id,message_id,attachment_id,original_name,mime_type,received_at,metadata}}`; retorna `{document_id,duplicate,document}`. `metadata.missing_attachment` preserva notificação sem PDF; `unknown_sender` exige conferência humana. |
| `stage_file` | `{document_id,file:{sha256,size_bytes,drive_file_id,drive_folder_id,lease_token?},worker}`; deduplica por SHA-256/tamanho, persiste ID do Drive antes do upload, retorna ID canônico, `claimed`, `upload_required`, `delivery_id`, `lease_token`, `document`. |
| `confirm_file` | `{document_id,file:{sha256,size_bytes,drive_file_id,drive_folder_id,drive_name},lease_token}`; valida reserva/identidade e enfileira processamento. |
| `source_error` | `{document_id,error,review_reason}`; falha de obtenção/validação visível; não degrada arquivo já salvo. |
| `extraction` | `{document_id,delivery_id,lease_token,extraction:{fields,classification,single_patient,evidence,extractor_version,review_reason},drive_name?}`; exige lease ativo de processamento. |
| `reserve_tasks` | `{destination:'drive'|'processing'|'group'|'nexus',worker,limit:1}`; retorna `{tasks:[task+document+configured_destination],paused}`. |
| `task_result` | `{delivery_id,lease_token,outcome:{status,external_id,external_status,error,next_attempt_at,storage_bucket,storage_path,sha256,size_bytes}}`; recebe `submitted`, `sent`, `uncertain`, `failed`, `completed` segundo o destino. |
| `attach_nexus` | `{delivery_id,lease_token}`; servidor lê bytes privados, verifica hash, reutiliza/cria objeto determinístico, lê novamente e só então registra a linha e conclui. |
| `reconcile` | `{}`; retorna `{reconciled,drive_tasks,group_tasks}`. Leases expirados de grupo ficam `uncertain`; os demais ficam pendentes. |
| `file` | `{document_id,download?:boolean}`; retorna bytes privados, verificando hash/tamanho. Aceita sessão da equipe ou worker. |
| `file_url` | `{document_id}`; URL assinada de objeto privado por 60 segundos, sem persistência no banco. Para arquivo somente no Drive, usar `file`. |

Upload manual: multipart `action=upload`, `file=PDF`, `payload={"message_id":"id-estavel-do-upload"}`. Exige sessão da equipe; valida tamanho e cabeçalho PDF, grava cópia temporária privada e confirma seus bytes. O ID canônico é usado em retry, inclusive quando a primeira origem falhou depois da reserva. Em falha, mantém o arquivo no navegador para repetir; o servidor não anuncia sucesso com objeto ausente. Limite inicial: **20 MiB**, configurável até 50 MiB; revisar também limites do n8n, Drive, Chatwoot e staging antes de ampliá-lo.

## Reserva, confirmação e destino

Usar `worker` distinto por execução n8n. `stage_file` não rouba lease vigente, mesmo com nome de worker igual. Worker que reservou uma tarefa Drive previamente deve passar o mesmo token em `file.lease_token`. Sempre continuar com o ID canônico e o ID do Drive retornados, que podem diferir dos inicialmente propostos.

O upload usa ID pré-gerado no Drive, gravado antes do efeito externo. Consultar e confirmar bytes do mesmo ID antes de repetir. Não criar outro arquivo depois de timeout. Falhas confirmadas têm backoff 1/5/15/60 minutos e limite de tentativas. `submitted`/`uncertain` de grupo nunca voltam automaticamente ao envio; consultar a mensagem existente e, se não houver prova, pedir conferência humana no painel.

Resposta HTTP da API Chatwoot ou status genérico `sent` não confirma o envio do PDF. A confirmação automática aceita `external_status=delivered` ou `read`, observados no provedor. Se a instalação não expuser confirmação confiável, a equipe pode registrar `confirm_exam_document_group_delivery` após abrir/conferir arquivo no grupo; ID deve corresponder ao persistido quando existente. Nenhuma dessas ações registra contato. Exceção administrativa de envio bloqueia novas reservas e marca tarefas pendentes/falhas como `waived`; uma tarefa já reservada, submetida ou incerta exige reconciliação anterior, e a dispensa é recusada atomicamente. Completar/dispensar seguem ordem de lock documento → tarefa; locks de documento são `NO KEY UPDATE`, compatíveis com verificações de FK dos eventos.

Chave do destino: `chatwoot:{account_id}:{inbox_id}:{conversation_id}:{group_jid}`. Ela é gravada na tarefa na primeira reserva, e a reconciliação retorna esse destino real. Se a configuração global mudar, tarefa antiga não passa a ser enviada/reconciliada no outro grupo. Nova extração/revisão do mesmo documento não gera segunda tarefa de grupo.

## Aplicação coordenada e recuperação

1. Exportar definições/ACLs/policies relevantes do banco correto e conferir schema real; guardar snapshot privado sem dados clínicos/credenciais. Revisar efeitos em todos os usuários do acompanhamento compartilhado.
2. Mapear importador legado ativo. Antes de aplicar o bloqueio de RPC pública, migrar seu chamador para autenticação de backend e verificar funcionamento. Não desligá-lo até o corte coordenado; preservar um único processador por conjunto de origem/janela.
3. Conferir IDs Supabase Auth da equipe e provisionar papéis mínimos. Inserir membros somente pelo administrador/serviço, com IDs verificados. Nenhum usuário autenticado recebe acesso automaticamente.
4. Aplicar as duas migrações em ordem no ambiente de homologação compartilhado. Confirmar buckets privados, views `security_invoker`, permissões/RPCs, ponte de vendas, dados antigos e compatibilidade da versão Nexus. Não reaplicar a mesma migração pelo Nexus.
5. Publicar Edge Function, configurar segredos e testar sessão autorizada/outsider/anon, PDF sintético, upload manual e integridade. Depois publicar as interfaces compatíveis. Migrations não publicam o frontend/Edge automaticamente.
6. `exam_document_configuration.enabled_destinations` inicia **vazio**. Ativar apenas `drive`/`processing` no piloto de ingestão; grupo exige conversa verificada, filtros Lua/Téo, marco `notification_cutoff` e chave de destino. Nexus exige pet/data conferidos e teste de acesso privado. Configuração/marco são gravações administrativas explícitas.
7. Ativar recepção por último, com janela limitada e importador antigo devidamente substituído. Conferir origem, hash, Drive, documento, itens, grupo, contato e Nexus separadamente.

Recuperação: esvaziar `enabled_destinations` e pausar novos workers/recepção; preservar originais, fontes, contatos e schema aditivo. Upload manual ainda pode reter bytes privados em staging durante a pausa. Corrigir configuração/reconciliar efeitos existentes antes de retomar. Não apagar migrações/dados nem desfazer contatos/mensagens para tentar recuperar. Documentos antigos ao marco não são enviados automaticamente. Temporários não são limpos automaticamente nesta versão; definir retenção e confirmar original/cópia definitiva antes de qualquer limpeza administrativa.

Pendências externas: provisionamento real da equipe, configuração/versão de Chatwoot, grupo e confirmação do provedor, OAuth de servidor/n8n, importação binária no n8n, OCR, limite de PDFs reais e concorrência PostgreSQL multi-conexão. Falta de acesso/configuração aparece como erro/pause/pêndencia, sem declarar etapa concluída.
