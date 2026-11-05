# Extração local e observação JEV

Implementação local de 05/11/2026. Os testes usam somente documentos sintéticos; este módulo, isoladamente, não demonstra cobertura, latência ou acurácia em produção.

## Contrato para OP02

`inspectFastExtraction(context, { mode })` recebe o mesmo contexto textual da extração atual (`pages`, `totalPages`, `isVision`, `canExtract`). Retorna:

```js
{
  accepted: false,
  route: 'general', // ou fast, exclusivamente em mode active e com validação completa
  reason: '...',
  extraction: null, // ou a extração validada, exclusivamente em active
  shadow: null // ou {eligible, parserVersion, fieldNames}, sem valores de identidade
}
```

Os modos são `off`, `shadow` (padrão) e `active`. O parser não consulta cadastros, não escolhe IDs clínicos, não faz upload e não autoriza entrega. Em `active`, somente `accepted === true` permite pular a chamada generativa; a saída segue pela persistência e pelas mesmas verificações operacionais existentes. Em qualquer dúvida, falha, alteração de campo pelo validador ou layout desconhecido, chama-se o extrator atual. O builder deve embutir, nesta ordem, `validateExamExtraction`, `parseHopeLabFastCandidate`, `validateFastExamCandidate` e `inspectFastExtraction`. Há teste de execução desse bundle sem importações nem variáveis externas.

## Cobertura deliberadamente estreita

Suportado: uma única página textual HopeLab, cabeçalho contíguo de seis linhas com colunas preservadas (tabulação ou pelo menos dois espaços), uma identificação inequívoca e os três blocos de hemograma com resultados numéricos. O parser exige pet, tutor, data de coleta válida, veterinário, CRMV com UF e laboratório. Espécie e protocolo/número do laudo são preservados quando estão nos rótulos suportados. Cada campo não nulo precisa de trecho literal do documento; todos os campos, inclusive opcionais, precisam sobreviver sem alteração ao `validateExamExtraction` existente.

Não suportado: texto com colunas colapsadas pelo extrator PDF nativo, nomes quebrados entre linhas, outros rótulos, mais de uma página, OCR/visão, identificação adicional ou ambígua, exame combinado, histórico, pedido, resultado cancelado/pendente ou seção sem resultado. Esses casos mantêm o extrator atual. Isso provavelmente limita bastante a taxa de acerto do caminho rápido: não há benchmark de corpus real para quantificá-la. Não reduzir esses limites com base apenas nos testes sintéticos.

## JEV em sombra, independente da entrega

`createJevRoutingRequest(context, localResult)` cria a requisição oficial da Decisions API para `typesafe/jev-1.14`, ou `null` quando o texto não é adequado ou o parser já é conclusivo. O envelope usa `questions.extraction_route` com `type: 'choice'` e critérios explícitos. O estado contém no máximo 6.000 caracteres de até quatro páginas e informa truncamento. O provider exige `zdr: true`, `data_collection: 'deny'` e `allow_fallbacks: false`.

`parseJevRoutingResponse(body)` aceita somente modelo esperado, opção conhecida e confiança numérica de 0 a 1. Retorna observação (`route`, `confidence`, `costUsd`), nunca campos de extração ou autorização operacional. As opções são `hopelab_parser_candidate`, `general_extraction` e `manual_review_candidate`; nenhuma opção descarta um documento ou substitui a extração atual.

`requestJevRoutingShadow(context, localResult, { enabled, requestDecision, timeoutMs })` injeta o transporte. Ele recebe `{url, body, signal, timeoutMs}`; autenticação pertence à credencial OpenRouter já existente no n8n. O endpoint é fixo (`https://openrouter.ai/api/alpha/decisions`), sem chave no módulo. A função está desligada por padrão, nunca repete uma chamada e limita o timeout a dois segundos; falha de transporte ou timeout retorna `undefined`. Resposta inválida retorna observação com `ok: false`.

Executar a observação em ramo independente, sem `await` nem join que bloqueie a entrega principal. A vida útil de promessas soltas em Code nodes do n8n não é garantia de conclusão: a integração deve usar um ramo/execução assíncrona explícita. Se esse isolamento não estiver disponível, deixar JEV desligado. Métricas devem guardar somente decisão, confiança, custo informado pelo provider, motivo do parser e duração; não duplicar texto clínico nem identidade em logs.

O JEV está preparado para medir ambiguidade de layout. A ativação futura de decisões que economizem uma chamada generativa exige benchmark com corpus representativo, revisão dos falsos positivos e manutenção da validação literal. Os testes presentes comprovam o contrato e as recusas previstas; não comprovam que o JEV acelera o fluxo real.

## Validação

```sh
node --test scripts/exames/fast-extraction.test.mjs scripts/exames/extraction-validation.test.mjs
```

57 testes aprovados em 05/11/2026 (17 novos + 40 do validador existente), incluindo textos adversariais, preservação de campos opcionais, composição do bundle, envelope oficial, resposta inválida, transporte falho e abort por timeout. Nenhuma chamada externa ou uso de dados reais foi necessário.

Referências oficiais consultadas: [Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) e [guia JEV](https://openrouter.ai/docs/guides/community/jev). JEV decide rótulos estruturados; não é substituto direto do gerador de JSON textual atual.
