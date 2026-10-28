# Monitor independente de recebimentos — pacote para integração

Fonte: `intake-monitor.gs`; manifesto proposto: `appsscript.intake-monitor.json`. Não foi criado projeto Apps Script, concedida autorização, instalado gatilho nem enviada mensagem. Os testes offline usam mocks separados e não pertencem ao projeto Apps Script.

O relógio de cinco minutos consulta o backend e o relay restrito de alertas. Não depende de execução n8n. O token nativo Chatwoot fica apenas no relay; o Google usa sua capability limitada. `intake_health` é uma ação operacional autorizada do worker: verifica atrasos e abre incidentes/outbox; não é uma leitura neutra. `intake_status` retorna apenas saúde e contagens. Um status vazio, coletor esperado ausente, desativado ou sem progresso válido nunca comprova cobertura.

## Script Properties

Preencher no projeto privado, fora do código. Manter `ENABLED=false` durante a preparação e validação.

| Propriedade | Contrato |
| --- | --- |
| `ENABLED` | Somente o literal `true` habilita o tick. Ausente/desativado não faz HTTP. |
| `BACKEND_URL` | Endpoint HTTPS `exam-document-service`, sem query/fragmento. |
| `BACKEND_AUTHORIZATION` | Valor exato do cabeçalho Authorization com o secret dedicado `EXAM_INTAKE_MONITOR_API_KEY`, distinto da chave ampla de ingestão. Nunca usar service-role nem `EXAM_INGESTION_API_KEY` no Google. |
| `BACKEND_APIKEY` | Opcional, somente se o gateway exigir. |
| `RELAY_BASE_URL` | Base HTTPS do relay restrito, sem barra final, query ou fragmento. |
| `RELAY_CAPABILITY_TOKEN` | Capability própria do relay. Nunca usar token nativo Chatwoot, de usuário ou administrador no Google. |
| `CHATWOOT_ACCOUNT_ID` | Conta confirmada. |
| `CHATWOOT_INBOX_ID` | Caixa confirmada da conversa individual. |
| `CHATWOOT_CONVERSATION_ID` | Conversa individual confirmada para alertas. Não reutilizar uma conversa de grupo ou canal operacional. |
| `EXPECTED_DESTINATION_PHONE` | Preencher somente nas propriedades privadas com o destino confirmado. `+5511999999999` é um exemplo fictício. |
| `EXPECTED_CHATWOOT_CHANNEL` | Valor exato do canal retornado por GET, previamente conferido; por exemplo, um canal API do provedor WhatsApp. Não presumir o valor. |
| `DESTINATION_KEY` | Mesma chave de destino habilitada em `exam_intake_alert_configuration`. |
| `EXPECTED_COLLECTOR_IDS` | JSON com os IDs exatos dos coletores operacionais Gmail, Outlook e Chatwoot. Obrigatório; sem valores inventados. |

O GET da conversa precisa confirmar `relay_contract:exam_intake_relay_v1`, id, inbox, conta quando presente, telefone do contato e canal configurados. Uma resposta nativa Chatwoot sem esse contrato é recusada. Identificadores de grupo são recusados. Essa verificação se repete antes de cada POST. Segredos e respostas privadas não são registrados em logs; Script Properties são acessíveis aos editores do projeto, portanto manter o projeto restrito.

## Contrato do backend

Todas as chamadas são POST JSON `{action,payload}` com `X-Exam-Intake-Monitor: 1`. Antes da instalação, o serviço precisa reconhecer `EXAM_INTAKE_MONITOR_API_KEY` e restringir essa credencial às cinco actions abaixo. Negar multipart, arquivos, upload, reserva de origens, extração e alterações de coletas. A chave dedicada não deve ser igual à chave ampla de ingestão; chave malformada ou igual desabilita somente a autenticação de monitor, preservando workers e membros válidos. Uma requisição com intenção explícita de monitor é recusada antes de RPC se não autenticar como monitor; ela não herda acesso de worker ou JWT. Sem essa indicação, um token igual ao worker é indistinguível do próprio worker e continua válido para esse papel, mas nunca recebe o ACK de monitor. O status acrescenta `authorization_scope:'intake_monitor'` somente quando a credencial distinta limitada foi autenticada. O preflight/tick exige esse ACK antes de qualquer ação operacional. As actions necessárias são:

- `intake_health`: `{stale_collectors: inteiro >= 0}`.
- `intake_status`: `{contract:'exam_intake_monitor_v1',authorization_scope:'intake_monitor',as_of,collectors:[{collector_id,provider,monitored,heartbeat_at,progress_at,last_success_at,stale_after_seconds}],open_incidents,pending_alerts}`. Não incluir recibos, documentos ou dados clínicos. O scope é atestado pela rota autenticada, não pelo cliente ou pelo SQL genérico.
- `intake_alert_reserve`: recebe `{worker:'google-apps-script-intake-v1'}`, retorna `{claimed,paused?}` ou `{claimed:true,alert:{id,lease_token,destination_key,...},incident:{stage,code,...}}`.
- `intake_alert_begin`: recebe `{alert_id,lease_token,destination_key,content}`; só autoriza com `{dispatch_allowed:true,alert_id,destination_key,content_sha256}` correspondentes. O hash é conferido localmente.
- `intake_alert_result`: recebe `{alert_id,lease_token,outcome:{status,content_sha256,external_id?,error_code?}}`, retorna `{alert_id,status}`. Só GET do provedor com `delivered/read` produz resultado final `sent`. `created/sent` do provedor continua `submitted`.

## Instalação futura e prova real

1. Publicar e verificar previamente o SQL e as actions do backend; cadastrar os três coletores com IDs reais e configurar a outbox/destino.
2. Criar projeto Apps Script privado com a fonte e o manifesto, mantendo `ENABLED=false`. Preencher as propriedades sem exportá-las para este pacote.
3. Executar `intakeMonitorValidate()`. Ela pode validar enquanto desativado e faz somente GET do destino e POST de leitura `intake_status`; não chama `intake_health`, não envia WhatsApp e não instala gatilho. Exigir `PREFLIGHT_OK`, incluindo os três provedores e dados de saúde atuais.
4. Conferir o destino e o canal retornados por GET com a identidade real aprovada. Somente então definir `ENABLED=true` e executar explicitamente `intakeMonitorInstallFiveMinuteTrigger()` com a autorização operacional correspondente.
5. Verificar uma execução real do relógio e um incidente controlado. Comprovar a mensagem por correlação e `delivered/read`; a simples criação da mensagem não prova entrega. Confirmar uma única recuperação e ausência de repetição após ACK perdido. Nenhuma dessas etapas reais foi executada nesta entrega.

## Persistência e falhas

A outbox SQL arbitra os incidentes persistentes. Uma fila local em Script Properties cobre indisponibilidade do backend/banco, cadastro incompleto e fila pausada; recuperação é uma mensagem separada por episódio. Um estado persistido `started` precede o único POST. Qualquer timeout, ACK desconhecido ou parada depois desse ponto fica incerto e só pode ser reconciliado por GET. Não existe reenvio automático desses estados. ACK perdido do `begin` também não autoriza POST.

O GET percorre até dez páginas de até cem mensagens, sem truncar páginas de 21. Valida IDs, progressão temporal, ciclos e correlação exata de conteúdo da mensagem de saída. Limite esgotado, resposta inválida, correlação duplicada ou mensagem não encontrada mantém incerteza. A correlação aparece também no texto para resistir a provedores que não preservam `content_attributes`.

`PIM_LAST_RUN_V1` contém somente código, horário, saúde e contagem de alertas não confirmados. `PIM_STATE_V1` e `PIM_JOB_V1_*` são parte da proteção contra duplicação: não apagar, copiar para outro projeto ou restaurar snapshot antigo durante operação. Não há função para forçar reenvio. Resolver estados incertos por auditoria da conversa/outbox, preservando a prova anterior.

Cada tick reconcilia até quatro alertas e reserva até um novo incidente, além de até um aviso local. Há budget total de três minutos e janela de 45 segundos para reconciliação, verificados entre chamadas; o HTTP solicita `timeoutSeconds` de no máximo 20 segundos conforme a referência consultada. O timeout precisa ser comprovado no runtime real: um budget entre chamadas não interrompe uma chamada que já começou. Mantém até 150 registros locais e 20 confirmações antigas, preservando os avisos do episódio atual e todos os incertos; capacidade esgotada exige manutenção sem descartar evidência. O código não usa Gmail nem fallback por e-mail.

A independência é em relação ao n8n. Credencial/destino do relay inválidos bloqueiam todo envio; indisponibilidade do relay, Chatwoot, Google Apps Script ou suas quotas pode impedir o próprio aviso. O intervalo de cinco minutos é configuração do relógio, não um SLA de entrega. O projeto do relay fica em `services/intake-alert-relay`; fonte e testes locais não confirmam sua implantação. A entrega real pelo provedor e a execução do relógio precisam de prova após instalação.

Referências oficiais consultadas em 27/10/2026: [gatilho em minutos](https://developers.google.com/apps-script/reference/script/clock-trigger-builder), [UrlFetchApp e timeout](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app), [quotas, seis minutos por execução e armazenamento de propriedades](https://developers.google.com/apps-script/guides/services/quotas).

Teste offline: `node --test scripts/exames/intake/intake-monitor.test.mjs`. Nenhum teste acessa rede, conta Google, backend ou Chatwoot real.
