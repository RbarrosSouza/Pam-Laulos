# Publicação da redução de latência dos exames

Este documento descreve a ordem de publicação e o recuo seguro. Não é comprovante de deploy. A configuração, os IDs dos workflows privados e as credenciais permanecem nos ambientes autorizados; não colocar seus valores nos artefatos públicos do fluxo.

## Antes de publicar

- Guardar as definições/grants das funções SQL alteradas, configurações e versões privadas atuais de OP02/OP03/OP04 e das duas Edge Functions. Preservar destino, marco de corte, fontes, originais e recibos.
- Rodar `npm run test:exames:latencia`. O script cobre parser/evidência, apresentação, workflows, rotas/autorização, SQL real em PGlite, fallback, autenticação e scheduler. Não é um replay de documentos reais.
- Expressões HTTP precisam passar pelo delimitador real do n8n: objetos aninhados devem terminar em `} }) }}`, preservando espaços, porque `}}` interno encerra a expressão antecipadamente. O [ExpressionSplitter oficial](https://github.com/n8n-io/tournament/blob/main/src/ExpressionSplitter.ts) reconhece o primeiro fechamento adjacente. Os testes permanentes verificam essa fronteira; `OPERACIONAL_PARSER_PACKAGE=/caminho/temporario/package.json` habilita também Tournament e `Expression.renderExpression` reais. Em 05/11, 125 expressões passaram no parser e 33 testes focados passaram com n8n-workflow 2.10.1 instalado apenas em diretório temporário. Code fakes que removem `={{ ... }}` não substituem essa prova.
- Gerar a apresentação compartilhada com `node supabase/functions/exam-whatsapp-fallback/generate-exam-presentation.mjs`. Os testes conferem paridade exata com `notification-presentation.mjs`.
- Conferir Deno em diretório temporário para evitar alterações no `package-lock.json` ou instalação de dependências no checkout:

```sh
latency_tmp=$(mktemp -d)
mkdir -p "$latency_tmp/functions/exam-document-service"
cp -R supabase/functions/exam-whatsapp-fallback "$latency_tmp/functions/"
cp supabase/functions/exam-document-service/supabase-privileged-key.ts "$latency_tmp/functions/exam-document-service/"
cp supabase/functions/exam-document-service/composio-original-reader.ts "$latency_tmp/functions/exam-document-service/"
printf '%s\n' '{"nodeModulesDir":"auto","lock":false}' > "$latency_tmp/deno.json"
printf '%s\n' '{"private":true,"type":"module"}' > "$latency_tmp/package.json"
deno check --config "$latency_tmp/deno.json" --node-modules-dir=auto --no-lock "$latency_tmp/functions/exam-whatsapp-fallback/index.ts"
```

A cópia temporária pode ser removida depois. Em 05/11/2026, Deno 2.9.6 aprovou o grafo completo do fallback, incluindo `exam-presentation.generated.mjs` e `node:buffer`. Um smoke test sintético em Deno, sem permissão de rede, confirmou legenda, correção humana nula, link, nome do anexo, bytes, IDs, revisão e um único POST simulado. O hash do `package-lock.json` permaneceu inalterado. O script concentrado aprovou 251 testes nessa revisão.

## Ordem de publicação

1. Aplicar **100 → 101 → 102**, cada migration em sua transação:
   - `20261105000100_exam_group_dispatch_fence.sql`: aguarda processamento concluído ou a política compartilhada de falha/estagnação; apresentação atual, autorização única antes do POST e proteção de `uncertain`.
   - `20261105000101_exam_pipeline_workers_and_rename.sql`: exclusão por etapa, consumo limitado, expiração segura, fila independente de renomeação. Cria `exam_pipeline_configuration.enabled=false`.
   - `20261105000102_exam_fallback_presentation_fence.sql`: prepare + begin v2 do fallback, inclusive original verificado somente no Storage.
   As substituições cirúrgicas de funções abortam se a definição instalada divergir. Não contornar o erro aplicando uma definição presumida. A migration opcional `20261105000103_exam_jev_observer.sql` vem depois dessas três: cria somente configuração/fila/resultados de observação, inicialmente desligados, sem trigger ou alteração de entrega clínica.
2. Publicar **exam-document-service** com `pipeline-service-routes.ts` e os demais módulos vigentes. Se incluir o observador 103, incluir `jev-observer-service.ts` depois da autorização do worker, sem liberar essas ações ao navegador. Publicar **exam-whatsapp-fallback** com `chatwoot.ts`, `runner.ts`, `auth.ts`, `collector.ts`, `index.ts`, **exam-presentation.generated.mjs** e seus imports locais do serviço. O gerador é utilitário local, não dependência runtime. Preservar `verify_jwt=false` de `supabase/config.toml`: as funções validam suas próprias credenciais dedicadas; não abrir acesso anônimo na aplicação.
3. Atualizar os workflows privados **OP02/OP03/OP04** preservando IDs, credenciais, parâmetros e prompts do ambiente. OP02 cobre processamento/rename; OP03 grupo/reconcile; OP04 Nexus. Cada etapa tem um consumidor exclusivo, no máximo quatro tarefas/180 segundos por rodada; reservas são feitas uma a uma. Não publicar templates com placeholders.
4. Verificar os webhooks autenticados `/webhook/pamvet-exam-{processing,group,reconcile,rename,nexus}-wakeup`, suas credenciais Header Auth e os schedules de recuperação de cinco minutos. A versão nova deve estar ativa antes de habilitar os avisos. Configurar `fastExtractionMode` conscientemente: padrão `shadow`; `active` só aceita o layout estrito comprovado e volta ao extrator atual em qualquer dúvida.
5. Após o canário, habilitar os avisos duráveis no alvo conferido:

```sql
UPDATE public.exam_pipeline_configuration
SET n8n_base_url='https://n8n.joaoai.com', enabled=true
WHERE singleton;
```

O host é conferido também pela Edge; redirecionamentos não recebem a credencial. `enabled` controla apenas os avisos, não os schedules, reservas já abertas ou a configuração independente do fallback. Não alterar cutoff, destinos ou estado de entregas para ativar esta melhoria.

## Conferência do canário

- Uma entrada sintética autorizada precisa provar original preservado por tamanho/hash, extração persistida, card/item vinculado, tarefa `processing=completed`, legenda com os campos corretos, uma única submissão e recibo `delivered/read`. HTTP 200 ou `submitted` isoladamente não provam entrega.
- Confirmar nome físico no Drive após o recibo da renomeação. Indisponibilidade de rename mantém identificação/card/envio; alterações de `drive_name` ou Storage/Nexus não invalidam a legenda. Uma correção humana relevante entre prepare e begin deve impedir o POST antigo.
- Confirmar worker duplicado recusado, segunda tarefa recebendo seu próprio ID/token/binary, limite de rodada, continuação da fila e recuperação de aviso perdido pelo schedule. Teste estático de JSON não substitui execução no motor n8n.
- Exercitar negação antes do POST, resposta perdida e 4xx após grant: antes do grant é possível falhar sem envio; depois dele fica `uncertain` para reconciliação, sem novo POST. Fallback v2 deve manter o mesmo documento/delivery/hash, respeitar correção humana e continuar funcional sem Drive.
- Medir separadamente espera na fila, download/Drive, extração, persistência, submissão e confirmação. Não atribuir a duração total da tarefa à inferência do modelo.

## Recuo sem replay

O recuo inicial recomendado é `UPDATE public.exam_pipeline_configuration SET enabled=false WHERE singleton;`: desliga os avisos e conserva o consumidor novo pelo schedule de recuperação, com as mesmas guardas SQL e filas. Isso não interrompe execuções em andamento.

Se houver defeito no executor, desativar também os triggers/schedules afetados no n8n e aguardar as execuções já iniciadas terminarem/expirarem antes de substituir artefatos. Manter as migrations e corrigir a versão do consumidor que utiliza suas filas. Não restaurar cegamente o OP02 antigo: ele renomeia antes de persistir, enquanto a migration 101 separa o nome físico da extração. A reversão de funções SQL exige análise própria de compatibilidade com todos os consumidores e filas existentes.

Preservar `sent`, `submitted`, `uncertain`, IDs externos, hashes, eventos e tokens. Nunca converter uma submissão incerta em `pending`, apagar recibos ou reexecutar um original para testar. A expiração automática só libera como repetível uma reserva do protocolo novo com prova de que nenhum grant de POST foi consumido. Não desativar ou reinicializar o fallback para um problema restrito ao n8n; seu recuo tem configuração/cron próprios e conserva a fila.

## Limites do JEV

`fast-extraction.mjs` contém parser determinístico e adaptador da Decisions API do JEV. O builder integra o parser; **não instala automaticamente chamadas ao JEV**. O JEV permanece desligado por padrão e apenas observacional no adaptador: não gera campos, não identifica paciente no cadastro e não decide envio/descarte.

O workflow separado `OBSERVACAO-JEV.json` está preparado para essa medição, manual e a cada cinco minutos, uma observação por execução, sem join/await no caminho principal. O template e a configuração SQL começam desligados; o candidato do ambiente vincula a credencial OpenRouter por referência, sem salvar a chave no JSON. Publicação e ativação do ambiente devem ter prova própria, separada do estado neutro do template. O observador reavalia capacidade antes da chamada de dois segundos, não toma leases principais e registra falhas/expirações sem repetir o mesmo documento/hash/versão. Essa prioridade é cooperativa: um processamento pode começar após a checagem, sem ser bloqueado pelo observador. Para pausar, desligar `exam_jev_observer_configuration.enabled` e o workflow separado, conservando o ledger `exam_jev_observation`; nenhuma fila clínica deve ser reiniciada. Ver [contrato e limites](jev-observer.md).

Não usar promessa solta de Code node como garantia de execução. O corpus atual é sintético; não há benchmark real de acurácia, custo ou latência do JEV neste fluxo. Colunas PDF colapsadas, visão, múltiplas páginas e layouts desconhecidos continuam no extrator existente. Não declarar aceleração por JEV a partir dos ganhos de fila ou do parser local.
