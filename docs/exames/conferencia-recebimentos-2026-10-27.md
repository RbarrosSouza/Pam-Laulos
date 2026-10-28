# Conferência técnica dos recebimentos — 27/10/2026

Registro técnico das correções de coleta verificadas nessa data. Esta versão pública contém somente comportamento do sistema, contagens agregadas e limites da validação. As evidências operacionais integrais foram preservadas em armazenamento privado; não fazem parte deste repositório.

Atualização de escopo em 28/10/2026: o usuário optou por acompanhar erros e pendências na página de entrada, sem avisos operacionais por WhatsApp. O supervisor externo e o relay foram preparados como fonte, mas seu plano de implantação foi cancelado antes da ativação. O projeto Google de preparação permaneceu desativado e sem gatilho; não houve instalação do relay ou criação de acesso Chatwoot para ele. Os dados e contratos do backend já aplicados foram preservados. O [escopo vigente é painel apenas](intake/Panel-only-operation.md).

No recorte investigado, houve relatos de entradas sem registro e de um lote cujo número de originais aparentava divergir do recebido. A conferência identificou quatro originais com hashes distintos e quatro entregas únicas. Uma dessas entregas ocorreu após um novo encaminhamento, portanto o resultado posterior não comprova sucesso do primeiro recebimento nem atraso natural do processamento. Preservação do original, identificação clínica, entrega e vínculo no cadastro são etapas distintas.

## Causas e correções

A identidade de uma origem Gmail combina mensagem, parte MIME e identificador do anexo. No WhatsApp, combina mensagem e identificador do anexo. A deduplicação de documentos usa SHA-256 e tamanho: nomes ausentes ou iguais não bastam para fundir conteúdos diferentes.

O coletor de e-mail anterior podia interromper toda a varredura quando uma mensagem falhava na leitura MIME ou na reserva da origem. O runtime corrigido registra a falha local e continua as demais mensagens e anexos. O resumo compara o número esperado de anexos de cada mensagem com seus recibos. Quatro anexos esperados e três recibos produzem resultado incompleto; falha, pendência, exclusão explícita e original já salvo permanecem resultados distintos.

A classificação clínica anterior dependia do assunto. Um assunto genérico de encaminhamento podia deixar um PDF clínico sem esse sinal, mesmo quando seu nome indicava a modalidade. A correção mantém a regra de assunto e acrescenta um indício pelo nome do próprio anexo: extensão `.pdf`, modalidade explicitamente configurada e título iniciado pela modalidade permitida. Termos financeiros bloqueiam esse indício. Arquivos opacos, títulos genéricos e anexos irmãos não herdam a classificação. O motivo é registrado como `attachment_filename`, preservando as flags de remetente desconhecido e autorizado, sem inferir paciente ou responsável.

O coletor WhatsApp anterior dependia do webhook. Foi acrescentada uma conferência periódica para recuperar notificações que falhassem antes da reserva da origem. Ela percorre conversas e mensagens da caixa configurada, inclusive conversas resolvidas, e reutiliza a mesma identidade e o mesmo caminho de preservação do webhook.

Uma resposta real da API trouxe 21 mensagens, ultrapassando o limite anterior de 20. O limite validado foi corrigido para 100 por resposta. Páginas incompletas, cíclicas ou acima dos limites continuam sendo falhas explícitas; o limite não representa sucesso nem autoriza truncamento silencioso.

## Separação entre implementação e prova

Na verificação operacional deste recorte, o workflow de e-mail tinha 53 nós e o de WhatsApp 55. A alteração isolada de classificação pelo nome do anexo preservou configuração, referências de credenciais, identidades e conexões. A versão técnica publicada nessa etapa tinha prefixo `009a150f…`.

A varredura real do WhatsApp conferiu 61 origens: 59 já preservadas, 2 recuperadas e 0 falhas. A consulta do lote no destino percorreu 3 páginas e 87 mensagens e confirmou 4 entregas únicas. São evidências agregadas desse recorte, não uma declaração de cobertura integral do histórico nem de conclusão clínica.

A agenda de cinco minutos estava configurada na verificação, mas um ciclo automático posterior ainda não tinha sido observado naquele momento. A nova classificação por nome também ainda exigia um novo recebimento após sua publicação para prova operacional. Não houve reenvio de exame para fabricar essa validação.

Os testes locais exercitam runtime, código dos nós e fixtures sintéticas. A execução real do engine, as credenciais e a prova de entrega precisam ser verificadas separadamente. Instalação, publicação e funcionamento observado não são equivalentes. As extensões posteriores de ledger, incidentes, revisão de versões e monitoramento estão documentadas em [intake](intake/SQL-installation-and-pause.md), com seus próprios limites.

## Preparação segura da implantação

O helper `scripts/exames/prepare-intake-reconciliation.mjs` recebe exports atuais dos workflows. Ele preserva configuração literal, referências de credenciais, identidade, webhook, metadados e personalizações fora da correção; drift incompatível é recusado. Os arquivos preparados e o manifesto com hashes/diferenças ficam em diretório privado externo, com modo 0600. O helper não importa, publica nem ativa workflows.

```sh
node scripts/exames/prepare-intake-reconciliation.mjs \
  --gmail-export /caminho/privado/gmail-atual.json \
  --whatsapp-export /caminho/privado/whatsapp-atual.json \
  --out /caminho/privado/conferencia-preparada
```

Limpar seleção manual exige `--clear-manual-selection`; o manifesto registra somente os campos limpos. Antes da aplicação, revisar configuração e diferenças contra o export atual. Não publicar exports operacionais, dados clínicos, referências privadas de recebimentos ou segredos junto com o código.

## Limites e verificação

- O resumo agregado em `staticData` não é checkpoint nem trava; sua persistência e atualidade precisam de prova na execução ativa. Falhas anteriores ao resumo podem deixar o último resultado antigo.
- A classificação por nome atua em novas origens. Uma reserva duplicada não atualiza retroativamente os metadados da origem antiga. Recuperações históricas exigem tratamento específico e auditado, preservando entregas realizadas.
- Preservação, elegibilidade de grupo, revisão clínica, vínculo no cadastro e contato são confirmações independentes. Uma entrega incerta deve ser conferida pelo recibo existente antes de qualquer nova tentativa.
- A implantação nos workflows e a publicação deste código são etapas separadas. Este registro público não contém evidência de publicação de código ou conclusão do histórico completo.

Validação direcionada:

```sh
node --test scripts/exames/operacional-workflows.test.mjs \
  scripts/exames/hopelab-intake.test.mjs \
  scripts/exames/whatsapp-intake-runtime.test.mjs \
  scripts/exames/whatsapp-intake-build.test.mjs \
  scripts/exames/prepare-intake-reconciliation.test.mjs
npm run test:exames
```

Referências públicas: [conversas Chatwoot](https://developers.chatwoot.com/api-reference/conversations/conversations-list) e [mensagens Chatwoot](https://developers.chatwoot.com/api-reference/messages/get-messages).
