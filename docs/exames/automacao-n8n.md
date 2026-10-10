# Automação de exames — configuração e homologação

Entrega local: seis workflows novos, **desativados**, em `n8n/exames/EXAMES-01.json` até `EXAMES-06.json`. O código usa o contrato implementado por `supabase/functions/exam-document-service` e a migration aditiva deste fluxo. Importar JSON não equivale a validar credenciais, entrega no grupo ou anexação em produção.

## Fluxos e ordem de ativação

| Export | Comportamento | Frequência entregue |
|---|---|---|
| EXAMES-01 | Outlook paginado → todas as origens/anexos → hash/reserva → ID fixo do Drive → readback/hash → confirmação | 5 min |
| EXAMES-02 | Original do Drive → PDF textual → extração documental validada ou revisão → renomear mesmo arquivo → persistir | 2 min, uma tarefa por execução |
| EXAMES-03 | Conferir conversa/caixa/JID → reservar tarefa → baixar/verificar PDF → um POST multipart → submissão ou incerteza | 2 min, uma tarefa por execução |
| EXAMES-04 | Reservar vínculo elegível → backend copia e verifica original no objeto privado/linha `exames` | 2 min, uma tarefa por execução |
| EXAMES-05 | Leases/pendências → temporários manuais para Drive → consultar/verificar uploads incompletos → consultar mensagens/correlação | 15 min |
| EXAMES-06 | Webhook autenticado → allowlist/entrada/arquivo → mesma reserva/hash/Drive do e-mail | Evento, etapa final |

Aplicar banco/backend e permissões primeiro; importar todos desativados. Configurar/testar 01/02/05 com destinos isolados, depois grupo de teste e Nexus. Ativar a recepção operacional após validar os workers e registrar o marco de corte. 06 só entra depois de confirmar o payload, as origens e os filtros Lua/Téo. Alterar frequência pelo Schedule Trigger; conservar limites e leases compatíveis.

## Credenciais a selecionar no n8n

Os exports **não contêm IDs ou valores de credenciais**. Selecione a credencial em cada HTTP Request ou Webhook. Não colar token em `Configuração`, parâmetros, query strings ou JSON de export.

| Credencial sugerida | Tipo | Nós | Conteúdo/configuração |
|---|---|---|---|
| PAMVET — serviço de documentos | Header Auth | Todos os HTTPs cujo URL é `serviceUrl` | Header `Authorization`, valor `Bearer <EXAM_INGESTION_API_KEY>`. Secret dedicado igual ao servidor; não é service-role exposta. |
| PAMVET — Outlook pessoal | OAuth2 API genérica | Nós `Graph - ...` | OAuth delegado Microsoft Graph; conta pessoal indicada pela equipe. App Microsoft suporta contas pessoais; endpoints `/consumers` ou `/common` conforme registro. Escopos `openid offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read`; callback exibido pelo n8n. |
| PAMVET — Drive da equipe | OAuth2 API genérica | Todos os `Drive - ...` | OAuth Google com acesso às pastas/arquivos configurados e API Drive habilitada. O escopo `drive.file` só alcança arquivos concedidos/criados pelo app; não supor que autorize pastas preexistentes. Conferir acessos reais antes do piloto. |
| PAMVET — Chatwoot grupo | Header Auth | HTTPs `Chatwoot - ...` de 03/05 | Header `api_access_token`, token de usuário/serviço autorizado na conta/caixa. Validar no servidor fazer.ai instalado. |
| PAMVET — extrator documental | Header Auth | `Extrair dados estruturados` de 02, se configurado | Endpoint compatível com chat-completions, header `Authorization: Bearer ...`, modelo escolhido entre serviços já disponíveis. Não contratar modelo/serviço implicitamente. |
| PAMVET — webhook Chatwoot validado | Webhook Header Auth | `Webhook Chatwoot autenticado` de 06 | Secret específico de entrada. Se a versão Chatwoot não emite header autenticado, usar encaminhador privado que valide a origem/assinatura disponível e injete esse header. Não expor webhook sem autenticação. |

O download de anexo WhatsApp usa URL assinada allowlisted **sem transmitir token do Chatwoot**. Redirecionamentos estão desativados. Se o payload real fornecer um endpoint com redirecionamento ou autenticação adicional, homologar uma resolução/proxy protegido que valide cada destino; não habilitar redirects indiscriminadamente nem enviar `api_access_token` para storage externo.

No runtime dos Code nodes, liberar apenas o builtin necessário `crypto` (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`; nas versões com task runner, configurar a allowlist no runner também). Os workers calculam hash a partir de `getBinaryDataBuffer`, inclusive quando n8n usa armazenamento binário em filesystem/serviço. Não pressupõem que `binary.data.data` seja base64.

O OAuth Google do backend é **separado** da credencial Drive do n8n. O servidor precisa ler o Drive para abrir arquivos no painel e para `attach_nexus`; configurar secrets OAuth de servidor conforme o manual do backend. Configurar/aplicar a Edge Function com a autenticação de worker dedicada prevista no código, inclusive a configuração de verificação JWT da função.

## Configuração não secreta

Cada workflow possui um Code node `Configuração`. O padrão `enabled: false` aborta antes de efeitos externos. Preencher dados verificáveis primeiro, selecionar credenciais e só então habilitar a execução de teste.

- `serviceUrl`: URL HTTPS da Edge Function `exam-document-service` no Supabase compartilhado confirmado.
- `maxBytes`: 20 MiB entregues; alinhar com limite do servidor/storage. Aumentar só após teste real.
- `driveFolders`: mapa de período de **recebimento** `AAAA-MM` → ID real da pasta mensal. Criar/conferir a estrutura `PAMVET/Exames recebidos/AAAA/MM`, preservar permissões privadas. Não procurar por nome ou criar pastas concorrentes durante ingestão. Mês sem ID fica pendente e recuperável; adicionar os próximos períodos antes da virada do mês.
- `notificationCutoff`: ISO da data/hora do piloto de avisos, igual ao valor da configuração de backend. Não notificar histórico anterior automaticamente.
- `worker`: prefixo legível; o código acrescenta `$execution.id`, distinguindo execuções concorrentes.

**01:** `mailbox` (conferida contra `/me` antes de reservar origens; `graphUserId` opcional para aliases previamente verificados), `folderIds` Graph reais de todas as pastas usadas por regras de fornecedores, `allowedSenders` minúsculos, `examSubjectHints` e `intakeCutoff` obrigatório. Remetente desconhecido com assunto de exame fica marcado na origem para conferência. E-mails pessoais sem allowlist/indício não passam. Não usar somente lido/não lido. A coleta usa `IdType="ImmutableId"`, `internetMessageId`, sobreposição de 120 minutos e toda a paginação. O watermark só avança quando todos os anexos do sweep terminam sem falha; download/validação inválidos são registrados no backend e conservam a janela recuperável. Reserva de upload ainda pendente/ocupada também impede avançar; duplicata canônica já salva não bloqueia. Static data persiste em execuções ativas de trigger, não depender de persistência em execução manual. Uma pasta movimentada para fora do conjunto monitorado requer acrescentar sua pasta real.

**02:** `extractorUrl` e `extractorModel` são opcionais. Vazios → revisão manual visível, sem chamada paga. Não há OCR instalado ou contratado nesta entrega. PDF digitalizado, protegido, falha de extração ou limites de páginas/texto → revisão preservando original. O nó PDF lê no máximo `maxPages + 1` páginas e conserva `numpages` total: excedentes vão para revisão, sem classificar o trecho truncado como documento completo. `maxPages` (100) e `maxTextChars` (80.000) limitam a chamada ao extrator. O teto de bytes protege a recepção; homologar uso de memória para PDFs de muitas páginas. Extração só sugere campos; nunca cria pet/clientes ou confirma vínculo.

**03:** `chatwootBaseUrl`, `accountId`, `inboxId`, `conversationId`, `groupJid` terminado em `@g.us`, `pamLaudosBaseUrl` HTTPS. Conferir esses IDs no servidor real. A conversa é lida e comparada antes da reserva; `configured_destination` precisa coincidir com `chatwoot:{account_id}:{inbox_id}:{conversation_id}:{group_jid}` antes do POST. `allowHttpChatwoot` vem false: habilitar somente se o endpoint privado efetivamente confirmado exige HTTP. No servidor, conferir `WHATSAPP_GROUPS_ENABLED`/legado e número participante com permissão. O link enviado é `/novos-exames/{document_id}` e requer sessão.

**05:** configurar Chatwoot conta/conversa para reconciliação. `providerConfirmationStatuses` default `delivered/read`; `sent` isolado não é aceito automaticamente, porque certas versões podem usá-lo antes da entrega ao provedor. Adicionar um estado somente quando a versão instalada e o evento/status correspondente tiverem sido comprovados. Sem essa prova, submissão permanece no painel para conferência humana auditada. A consulta de mensagens pagina por `before` até a data relevante; ausência não gera novo POST.

**06:** `accountId`, `inboxId`, `allowedConversationIds` e/ou `allowedSenderIds`, `destinationConversationId` obrigatório, `allowedDownloadOrigins` com origens HTTPS realmente presentes no payload. Exclui saídas, mensagens privadas, grupo de destino e marcador `[EXAM:...]`; enumera todos os anexos elegíveis. Mensagem permitida sem arquivo cria pendência com `missing_attachment`, sem marcar recebimento. Confirmar também que o fluxo Lua/Téo ignora grupos e saídas antes da ativação.

Configuração correspondente no banco: liberar destinos necessários (`drive`, `processing`, depois `group`/`nexus`) e configurar o destino de grupo/marco conforme o contrato backend. Os defaults do banco também permanecem pausados; habilitar Code nodes não contorna essa proteção.

## Contrato usado pelos exports

`POST serviceUrl`, body `{ "action": "...", "payload": {...} }`, autenticação de serviço dedicada. Nomes precisam continuar iguais ao backend; não apontar para o webhook antigo `receive_email_result`.

| Action | Origem no n8n | Garantia usada |
|---|---|---|
| `reserve_source` | 01/06 | Origem única por canal/conta/mensagem/anexo; retorna `document_id` estável e documento atual |
| `source_error` | 01/06 | Falha antes do upload registrada no documento e histórico, sem depender do log n8n |
| `stage_file` | 01/05/06 | Hash/tamanho + ID Drive pré-gerado persistidos **antes** do efeito; retorna ID canônico, `claimed`, `upload_required`, `drive_file_id`, `lease_token` |
| `confirm_file` | 01/05/06 | Só depois de readback SHA-256/tamanho; exige reserva; resultado pode apontar documento canônico diferente |
| `reserve_tasks` | 02/03/04 | Uma tarefa por execução, lease atômico; backend controla elegibilidade, corte e destino |
| `extraction` | 02 | Campos `client_name`, `pet_name`, `exam_type`, `exam_date` etc., evidências, classificação e `drive_name`; sem vínculo automático |
| `task_result` | 02/03/05 | Token da reserva; distingue `submitted`, `sent`, `uncertain`, `failed`, `completed` |
| `file` | 05, upload manual | Binário autenticado do staging/original; o worker usa `responseFormat=file`, não um JSON disfarçado de PDF |
| `attach_nexus` | 04 | Backend executa download/hash/objeto privado/readback/linha por origem única; pet/data confirmados |
| `reconcile` | 05 | Recupera pendências/leases e retorna `drive_tasks`/`group_tasks`; nunca enfileira reenvio cego de grupo |

Documentos retornados usam `file_status`, `extracted_data`, `confirmed_data`, `assigned_to`, `drive_file_id`, `sha256`, `size_bytes`. Tarefas usam `id`, `lease_token`, `external_id`, `document`.

O upload ao Drive usa ID previamente gerado por `files.generateIds`, registrado no backend, consulta esse ID e cria metadados apenas quando ausentes. Se o objeto já tem bytes, lê e compara antes de confirmar; se está vazio, grava bytes no mesmo ID. Falha após upload não cria uma segunda cópia cega. Em deduplicação, o ID, a pasta e o nome preservados pertencem ao documento canônico; o novo nome/origem não provoca outro upload. O nome definitivo renomeia o mesmo arquivo. Grupo envia **um arquivo de verdade** em `attachments[]` multipart; boundary fica a cargo do cliente.

O marcador `[EXAM:{document_id}:DELIVERY:{delivery_id}]` liga API/legenda à tarefa, inclusive se a resposta do POST se perde. Não prova contato com tutor nem leitura individual no grupo. Falhas de destino/download/hash antes do POST ficam `failed`, pois o envio não foi tentado, e podem ser repetidas com backoff. Timeout/5xx/429 depois do POST ficam `uncertain`; reconciliação consulta, não reenvia.

## Validação local e homologação externa

Regerar/validar artefatos:

```sh
python3 scripts/exames/generate-workflows.py
node scripts/exames/validate-workflows.mjs
```

O teste local cobre grafo e referências, compilação de todos os Code nodes, bloqueio por default, paginação/ImmutableId, três PDFs e anexos não suportados, identidade de objeto Drive, binário/hash, revisão sem OCR, evidências reais no texto e datas, multipart único, estados de submissão/timeout, paginação de reconciliação e filtros de WhatsApp. Esse teste não simula o motor completo do n8n nem prova a importação na versão instalada.

Homologação obrigatória na instalação real, usando PDFs **sintéticos** e destinos de teste:

1. Importar cada export desativado; conferir versões/nós/credenciais e layout. Executar primeiro os GETs de leitura com contas selecionadas.
2. E-mail com três PDFs, repetição do mesmo evento e dois workers concorrentes; verificar todas as origens, uma cópia por hash e nenhuma perda.
3. Mover mensagem entre pastas monitoradas e simular indisponibilidade maior que uma janela de polling; verificar recuperação pela sobreposição/watermark.
4. Cortar resposta após upload Drive; consultar ID reservado, conferir bytes e confirmar sem nova cópia. Confirmar que objeto divergente é bloqueado, sem overwrite.
5. PDF digitalizado/protegido, modelo ausente/JSON inválido/data impossível, multipaciente e homônimos → arquivo mantido e revisão explícita.
6. Grupo de teste: confirmar arquivo abre, nome/legenda/link corretos, um PDF por mensagem; HTTP 2xx fica submetido. Provar callback/status de provedor ou confirmação humana.
7. Simular timeout pós-POST e restart; localizar pela correlação/ID, persistir estado e garantir nenhum segundo POST cego.
8. Upload manual: staging protegido → Drive/hash → Novos exames; não concluir antes da cópia original confirmada.
9. Nexus: confirmar pet/data/itens, repetir ação e verificar uma linha/objeto privado, readback íntegro e bloqueio de acesso sem sessão/permissão.
10. WhatsApp: testar todos os allowlists, URL/redirects, saídas próprias, grupo destino, duplicata entre e-mail/WhatsApp e mensagens sem arquivo. Conferir Lua/Téo em paralelo antes do corte.

Guardar IDs de execução/documento/tarefa e evidências sanitizadas, não dados clínicos/pinData. Execuções de sucesso/erro/manual não são persistidas nos exports; para debug, habilitar logs só temporariamente com fixtures sintéticas e retornar à configuração entregue.

## Recuperação e limites conhecidos

Pausar `enabled`/workflows ou destinos do banco sem apagar arquivos/origens/contatos. Retomar pendências com leases. 01 interrompido conserva watermark; 03 inconclusivo requer consulta ou revisão. Não reativar o importador Gmail legado em paralelo: ele conserva associação automática histórica por nomes e não implementa este contrato. Os valores secretos hardcoded encontrados no export antigo foram removidos nesta alteração; a rotina antiga precisa de seleção de credenciais antes de qualquer uso e não é recomendada para o novo fluxo.

As pastas anuais/mensais são configuração prévia por ID (não criação automática). OCR não está conectado. Webhook 06 depende do mecanismo autenticado e payload da versão instalada. O modo entregue `onReceived` responde antes do processamento: falha anterior ao staging/Drive registra `source_error` (quando o banco responde), sem marcar arquivo como recebido. EXAMES-05 ainda não reconsulta automaticamente o anexo original no Chatwoot. Antes de habilitar 06, homologar replay durável do encaminhador/provedor ou implementar coleta periódica por mensagem/conversa; uma nova entrega do evento reutiliza a origem, e upload manual continua disponível. Se a reserva falhar por indisponibilidade do banco, o replay externo também é necessário. Captura automática do WhatsApp não está homologada e permanece desativada nesta entrega. IDs/versões/credenciais, regras Outlook, Drive, configuração Chatwoot/Baileys, grupo de teste, importação n8n e entregas/anexação reais só podem ser declarados aprovados depois da homologação acima.

Referências primárias: [paginação HTTP n8n](https://docs.n8n.io/code/cookbook/http-node/pagination/), [HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/), [Microsoft OAuth pessoal](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc), [IDs imutáveis Outlook](https://learn.microsoft.com/en-us/graph/outlook-immutable-id), [Drive IDs pré-gerados](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds), [upload Drive](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [Chatwoot multipart](https://developers.chatwoot.com/api-reference/messages/create-new-message).
