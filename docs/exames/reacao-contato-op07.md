# OP07 — reação de contato concluído

Registro em 18/10/2026, horário de São Paulo. Este documento separa implementação, instalação, teste do canal e ativação. Não contém credenciais, respostas clínicas ou URLs temporárias.

## Comportamento

O OP07 consulta a cada minuto a fila de reações. Um exame fica elegível quando tem pelo menos um item vinculado, todos os seus itens possuem `contacted_at` e existe um evento `contact_recorded` salvo a partir do corte de ativação. A data clínica do contato pode ser anterior: vale o momento em que a confirmação foi persistida.

O alvo é a mensagem original registrada em `exam_document_delivery`: destino `group`, estado `sent`, ID externo numérico, timestamp de envio e destino configurado correspondentes. O documento deve continuar canônico, com original preservado e sem rejeição ou dispensa de grupo. Resumos diários não são alvos. A identidade do documento, a entrega e seu hash são conferidos também na mensagem do Chatwoot antes de qualquer reação.

A única alteração no canal é a reação ✅ pelo ator explicitamente configurado. Não há edição da mensagem, reenvio de PDF, novo resumo ou alteração de contato, resultado clínico, venda ou anexação ao Nexus. O RPC de contato existente foi preservado; falhar a reação não desfaz nem impede o contato salvo.

## Ativação prospectiva

A migração cria `exam_reaction_configuration` com `enabled=false`, `activation_cutoff=NULL` e `chatwoot_actor_id=NULL`. A instalação não habilita o envio nem percorre contatos históricos para marcá-los.

A ativação autorizada deve registrar o corte pelo relógio do servidor, fixar o ator e habilitar a rotina de um minuto. O ator 1 foi conferido no `/api/v1/profile` da credencial existente; o ID não é inferido do autor clínico, da veterinária ou de uma sessão deste chat.

Eventos de contato anteriores ao corte ficam fora da fila. Uma confirmação explicitamente salva de novo depois do corte pode ser elegível, conforme decisão do responsável; a unicidade do ledger impede outra reação para uma entrega já processada.

Estado conferido: SQL 14 e Edge instalados pelos hashes abaixo. Recurso ativado em 18/10/2026 às 23:23:27 BRT, corte do servidor `2026-10-19T02:23:27.070132+00:00`, ator 1. Workflow `alSjfGj4Mv9rVE2d` publicado às 23:24 BRT; exportação após recarregar confirmou `active=true`, 29 nós, código, conexões, credenciais existentes e configurações iguais à versão revisada. Primeira execução manual consultou o serviço com sucesso, encontrou zero contatos elegíveis e terminou sem POST ao canal. A primeira confirmação clínica real após o corte permanece sem observação.

| Campo | Estado registrado |
| --- | --- |
| Migração 14 | Instalada; recurso ativado |
| Edge | Instalado com as ações de reação |
| Ator autorizado | 1, identidade técnica verificada |
| Corte efetivo | `2026-10-19T02:23:27.070132+00:00` |
| Polling operacional de um minuto | Publicado e ativo; 29 nós |
| Contato clínico → reação em produção | Ainda não validado de ponta a ponta |

## Proteção contra toggle repetido

O endpoint de reação funciona como toggle: repetir o mesmo ✅ pode removê-lo. Por isso o backend persiste `submit_started` antes de liberar um único POST. A resposta de `begin` só concede `dispatch_allowed=true` uma vez, inclusive com o mesmo token. Timeout, ACK perdido, falha posterior, lease expirada ou reinício não liberam outra tentativa automática.

A fila separada `exam_document_reaction` é única por entrega/emoji e também por destino/mensagem/emoji/ator. Se dois registros apontarem para a mesma mensagem no destino, nenhum deles fica elegível enquanto o vínculo for ambíguo.

Uma consulta GET que comprova o ✅ do próprio ator pode concluir a tarefa sem POST (`already_present`). Reação de outra pessoa, outro emoji do próprio ator ou alvo não conferível não autorizam um toggle. Um resultado incerto permanece para conferência por GET; ausência da reação em uma leitura não autoriza reenviar.

| Estado | Próxima ação permitida |
| --- | --- |
| `pending` / `reserved`, sem início | Conferir identidade/alvo; `begin` pode liberar uma vez |
| `held`, falha antes do início | Somente consulta e conferência; nenhum POST |
| `started` / `submitted` / `uncertain` / `failed` | Somente reconciliação por GET; nenhum novo POST |
| `confirmed` | Encerrado; não repetir nem remover automaticamente |

## Contrato técnico

As tabelas e RPCs são exclusivas do serviço. As ações Edge usam a chave dedicada de worker já existente, sem nova credencial ou permissão de cliente.

| Ação Edge | Uso |
| --- | --- |
| `reaction_preview` | Consulta somente leitura; não reserva nem envia |
| `reaction_reserve_tasks` | Reserva elegíveis e retorna `reconcile_tasks` estritamente para GET |
| `reaction_begin` | Confere token, ator, destino, mensagem, emoji e estado completo; consome a permissão antes do POST |
| `reaction_result` | Registra resultado cercado por token/alvo/emoji/ator; confirmação exige prova do próprio ✅ |

Os arquivos operacionais são `n8n/exames/OPERACIONAL-07.json` e `OPERACIONAL-07-PREVIEW.json`, gerados por `scripts/exames/contact-reaction-build.mjs` e executando o runtime de mesmo prefixo. O backend está em `supabase/migrations/20261018000014_exam_contact_reaction.sql` e `supabase/functions/exam-document-service/index.ts`. Não há deploy de frontend associado a esta etapa.

## Evidência e limites

Validação local concluída:

- 19 verificações SQL com a migração real em PGlite, incluindo RPC real de contato em paciente sintético local, data clínica retroativa, todos os itens, corte, unicidade, fences, perda de ACK e fechamento/reabertura do banco.
- 42 cenários do handler Edge com adaptadores isolados, incluindo autorização e as quatro ações novas.
- 16 testes do runtime/builder n8n, incluindo zero POST em pausa, reação própria preexistente, prévia e reconciliação somente por GET.
- `git diff --check` passou. PGlite serializa pedidos concorrentes; esses testes não equivalem a um ensaio multiprocesso em PostgreSQL de produção.

Comandos locais:

```sh
node supabase/tests/exam-contact-reaction.test.mjs
node supabase/tests/exam-document-service.test.mjs
node --test scripts/exames/contact-reaction-runtime.test.mjs scripts/exames/contact-reaction-build.test.mjs
```

Prova isolada do canal, informada pelo responsável pela execução: em 18/10/2026 às 23:18:13 BRT houve um único POST na mensagem sintética 1498. A primeira leitura permaneceu pendente/incerta. Às 23:18:49, uma nova leitura GET reconheceu o ✅ do próprio ator, com estado do provedor `sent`, sem outro POST. A interface exibiu ✅ com contagem 1 na mensagem original.

Esse teste comprovou reação e leitura no canal. Não foi uma confirmação de contato clínico: a fixture original não tinha paciente confirmado ou itens vinculados, e nenhum bypass clínico foi criado em produção. A cadeia contato real → outbox → reação foi validada apenas em dados sintéticos locais até este registro.

Hashes do backend instalado, conferidos pelo responsável pela implantação:

```text
20261018000014_exam_contact_reaction.sql
7021c7109d7c1b3bf00889d5c2859a491534b067d863497d229fd4f9e34a9d2d

exam-document-service/index.ts
f453fd0ce1a85ce19deefab33bcbe5259cc46e255c8c95227d536a36e9c65ee3
```

Esses hashes identificam o backend instalado. O código versionado mantém templates neutros e pausados; o binding de produção, sem valores de credenciais, foi conferido na exportação privada após a publicação. O teste de canal não alterou paciente, contato clínico ou itens do fixture: a conferência final persistida manteve zero itens e nenhum paciente.
