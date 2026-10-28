# Descoberta de recebimentos e worker — implementação local, 27/10/2026

Estado: código executável e testes locais; nenhuma conexão, credencial, agenda ou processo de produção foi ativado por este pacote.

## Arquivos e execução

- `collector-adapters.mjs`: adaptadores Gmail, Microsoft Graph/Outlook e Chatwoot; `paginatedDiscovery` e enumeração hierárquica de conversas/mensagens.
- `discovery-worker.mjs`: vínculo executável com as RPCs SQL23, armazenamento privado de continuação e entrada CLI.
- `collector-adapters.test.mjs` e `discovery-worker.test.mjs`: provedores HTTP determinísticos e ledger simulado, sem chamadas externas.

```sh
node --test collector-adapters.test.mjs discovery-worker.test.mjs
node discovery-worker.mjs --config /caminho/escopo-privado.json --wiring /caminho/runtime-autorizado.mjs
```

O segundo comando exige um módulo de integração real fornecido pelo responsável da implantação. Não configura acessos automaticamente. O módulo exporta:

```js
export async function http(request) { /* GET autorizado usando request.credentialRef */ }
export async function rpc(name, parameters) { /* conexão existente ao backend */ }
export const continuationStore = { load, save, clear };
export async function processMessages(context) { /* declarar origens e recibos de cada ID durável */ }
```

O contrato HTTP é `{method:'GET',url,headers,credentialRef,followRedirects:false,timeoutMs:30000}` → `{status,body}`. Nenhuma credencial é criada ou embutida. A camada HTTP deve vincular cada referência à conta autorizada configurada e aplicar timeout, bloqueio de redirects e retorno explícito de status. A RPC aceita resposta JSON direta ou `{data,error}`.

`processMessages({scope,sweepId,runToken,mode,ledger,rpc,budget})` deve ler os IDs persistidos da varredura, obter os metadados completos, declarar **todas** as origens/avisos e gravar um resultado por origem. Mensagens sem origens precisam de declaração vazia com política explícita, fundamentada nos metadados. Retorna `{complete:true}` somente depois desse trabalho; caso contrário retorna `{complete:false}` para continuar. A ausência desse adaptador impede o início do worker. O worker não cria recibos fictícios nem presume preservação a partir da descoberta.

## Escopo estável

Configuração mínima: `provider`, `accountId`, `collectorId`, `credentialRef`, `requestId` UUID, `receivedFrom`, `receivedThrough` e `initialReceivedFrom`. `mode` é `audit` por padrão. O marco final deve ser passado e menor ou igual ao relógio do servidor. Chatwoot também exige `baseUrl`, `chatwootAccountId` e `inboxId`; Outlook aceita `userId` opcional. Gmail aceita `includeSpamTrash` explícito. O manifesto enviado ao banco usa `policy_version:'intake_v2'` e `sender_policy:'all'`, com hash de escopo próprio.

O mesmo `requestId`, janela, coletor e manifesto devem permanecer fixos ao retomar uma varredura parcial. A agenda deve retomar o trabalho ativo antes de iniciar uma nova janela. Uma chamada concluída repete seu resultado de forma idempotente; outra janela exige outro UUID. O worker usa o token de fencing da mesma varredura e emite heartbeat; o SQL23 renova o prazo por evento válido e recusa tokens expirados. A instância responsável deve serializar chamadas do mesmo job/continuation store.

## Descoberta antes do processamento

Cada página é gravada em `page_discovered`, incluindo IDs e hashes dos cursores, **antes de solicitar a próxima página**. A gravação é aguardada. Depois são acrescentados timestamps conhecidos por `message_discovered`. O callback `recordDiscoveryPage` deve ser transacional para página e IDs; `createRpcDiscoveryLedger` usa exatamente a RPC SQL23 que fornece essa atomicidade.

Gmail usa somente filtros de janela temporal e a política explícita de Spam/Lixeira. Não filtra por anexo, nome, assunto, remetente ou leitura. A margem temporal de um segundo exige conferir `internalDate` nos metadados posteriores e registrar exclusões de janela por política explícita. Outlook lista a caixa inteira no intervalo, incluindo pastas, não exige `hasAttachments`, preserva o `@odata.nextLink` inteiro e envia `Prefer: IdType="ImmutableId"` em **todas** as páginas. IDs permanecem sensíveis a maiúsculas/minúsculas.

Chatwoot enumera todas as conversas da caixa com `status=all` e todos os IDs de mensagens das conversas, incluindo saídas, notas e mensagens sem anexo. Classificação e exclusão são posteriores à descoberta durável. Páginas de conversas têm `message_ids:[]` na partição `inbox-conversations`; mensagens ficam em `conversation:<id>`. A paginação por `before` continua até página vazia, sem limite histórico fixo que descarte o restante. Os totais do worker incluem todas as páginas e IDs por partição.

## Orçamento e continuação

Por padrão cada chamada usa no máximo 10 páginas, 1.000 registros ou 20 segundos, encerrando apenas entre páginas. Uma página inteira que ultrapasse o orçamento de registros é persistida integralmente; não há `slice` nem corte silencioso. Os adaptadores solicitam até 100 IDs por página para o contrato SQL23. Resposta acima de 100 falha explicitamente, preserva o cursor e não busca a página seguinte. Páginas de 21 mensagens Chatwoot são aceitas.

Orçamento atingido retorna `coverageComplete:false`, `scanFinished:false`, `checkpointAdvanced:false` e continuação obrigatória. Tokens/URLs brutos de paginação ficam somente no `continuationStore` privado, nunca em eventos SQL. O armazenamento em arquivo disponível usa nomes com hash, arquivos `0600` e gravação por arquivo temporário/rename; contém também IDs descobertos e o token da varredura, portanto deve permanecer privado e fora do Git.

`enumeration_complete` só é enviado após todas as partições terminarem. `finish_exam_intake_sweep` só é chamado após o processador confirmar conclusão. Cobertura, preservação, alertas e avanço operacional do checkpoint são decididos pelo banco e devolvidos sem substituir seus valores. Erros de HTTP, forma de página, ciclo, escopo ou persistência produzem falha explícita; não liberam checkpoint nem uma confirmação de sucesso.

## Fontes do contrato dos provedores

- Gmail `users.messages.list`: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- Microsoft Graph, listagem e paginação: https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
- Microsoft Graph, IDs imutáveis: https://learn.microsoft.com/en-us/graph/outlook-immutable-id
- Chatwoot, conversas e mensagens: https://developers.chatwoot.com/api-reference/conversations/conversations-list e https://developers.chatwoot.com/api-reference/messages/get-messages

Os testes locais demonstram o encadeamento e as barreiras com simuladores. Não comprovam contas OAuth, operação n8n, disponibilidade dos provedores, execução contra PostgreSQL real ou implantação do worker. A validação SQL23 com o banco de testes é relatada separadamente pelo responsável desse pacote.
