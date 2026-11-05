# Observação JEV independente

Template preparado em 05/11/2026, com workflow e configuração SQL desligados por padrão. Este documento descreve o artefato; publicação, ativação e chamadas do ambiente exigem registro separado com versão/execução verificadas. O observador mede decisões depois de uma extração concluída. Ele não reduz a latência do exame observado e não modifica identificação, card, paciente, entrega, fallback ou reação.

## Componentes

- `20261105000103_exam_jev_observer.sql`: configuração privada e fila/resultados próprios, sem trigger na entrega. O consumidor seleciona uma extração concluída após `observe_after` quando há capacidade ociosa. `document_id + sha256 + observer_version` impede observar novamente o mesmo conteúdo, mesmo após reextração ou falha.
- `jev-observer-service.ts`: adaptador das ações `jev_observe_reserve`, `jev_observe_begin`, `jev_observe_result`. Deve ser incluído no serviço depois da autorização de worker. Não adiciona essas ações ao acesso de navegador.
- `OBSERVACAO-JEV.json`: workflow separado, manual e a cada cinco minutos, uma observação por execução. Sem loops, webhooks ou chamada pelo OP02.
- `jev-observer-build.mjs`: gera o template neutro ou retorna um workflow com referências de credenciais existentes. Não aceita valores de chave.

## Limites e preservação do principal

Workflow e configuração SQL começam desligados. O corte inicial é a instalação; ao ativar o piloto, ajustar `observe_after` para o início desejado. O worker só reserva se não houver trabalho principal ativo ou imediatamente acionável. Reavalia essa condição antes de chamar o modelo e registra `skipped` se o principal voltar a trabalhar. Não toma nem prolonga leases do processamento principal.

Essa prioridade é cooperativa: um exame pode chegar depois da última checagem. O observador nunca bloqueia o início do principal; uma chamada já iniciada pode coexistir por até dois segundos. O piloto limita originais a 2 MiB e quatro páginas, verifica PDF/tamanho/hash e recusa metadados de paginação ausentes ou contraditórios. A extração local conclusiva não chama JEV. O envelope existente limita o texto enviado a 6.000 caracteres.

O início da chamada é registrado antes do HTTP. Não há retry automático em nenhum nó. Falha de download/texto, resposta inválida, erro HTTP e timeout encerram a observação; uma lease expirada termina em `failed` antes do início ou `uncertain` depois. Nenhum desses estados reabre uma tarefa clínica ou repete a chamada. A medição pode ser perdida em falhas transitórias; os exames mantêm seu fluxo normal.

Resultados guardam somente status, rota, confiança, custo informado, modelo, duração e código fixo de erro. Não persistem texto do PDF, corpos de resposta do provedor ou credenciais. Dados de execução n8n ficam desabilitados.

## Provedor e credencial

As fontes oficiais foram consultadas em 05/11/2026: a [referência Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) confirma `POST https://openrouter.ai/api/alpha/decisions`; o [guia JEV](https://openrouter.ai/docs/guides/community/jev) confirma `typesafe/jev-1.14` e uso da chave OpenRouter existente. O template público mantém a referência neutra `SELECT_EXISTING_OPENROUTER`; o candidato privado recebe apenas ID/nome/tipo da credencial verificada no ambiente. Não reutilizar uma referência OpenAI sem confirmar que contém a credencial OpenRouter autorizada.

O pedido usa o adaptador testado `createJevRoutingRequest`: decisões em sombra, ZDR, coleta de dados negada e fallback de provedor desabilitado. Timeout de 2.000 ms, redirecionamentos desabilitados e modelo/estrutura/confiança verificados antes de registrar uma decisão válida.

## Instalação e pausa

Aplicar a migration 103 depois de 100–102 e integrar o adaptador autorizado. Importar o candidato privado ainda inativo, conferir as referências de worker/OpenRouter e executar um canário exclusivamente sintético para comprovar o contrato HTTP. Depois, habilitar conscientemente a configuração `exam_jev_observer_configuration`, com `observe_after` correspondente ao início do piloto, e o workflow. Um canário isolado não demonstra desempenho em exames reais.

Para pausar, definir `exam_jev_observer_configuration.enabled=false` e desativar o workflow do observador. Isso não altera OP02/03/04, avisos, fallback ou dados clínicos. Uma chamada já iniciada pode terminar; manter a tabela `exam_jev_observation` e seus estados/IDs/hashes, sem apagar ou converter falhas para repetir chamadas. Preservar o ledger também ao substituir o workflow: a chave documento/hash/versão evita nova cobrança pelo mesmo conteúdo.

## Validação local

```sh
node --test scripts/exames/jev-observer.test.mjs supabase/tests/exam-jev-observer.test.mjs
```

Os testes verificam limites, credenciais por referência, HTTP inválido, paginação inconsistente, privilégios, corte/pausa, exclusividade, início durável, deduplicação após reextração, preempção, expiração terminal e ausência de mudanças no documento/entrega. Os testes SQL executam a migração em PGlite com esquema mínimo de fronteira; não demonstram instalação ou comportamento em produção.
