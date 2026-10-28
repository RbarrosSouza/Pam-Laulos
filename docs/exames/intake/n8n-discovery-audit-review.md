# Runtime n8n da auditoria — candidato desativado

Preparado em 27/10/2026. Os dois workflows privados gerados não foram importados, publicados ou executados pelo autor deste pacote. Cada um tem 25 nós, `active:false`, configuração `enabled:false` e execução agendada bloqueada por `allowScheduled:false`. O modo é fixo em `audit`, com `monitoring:false`. A primeira janela cobre no máximo o último dia (`auditLookbackSeconds:86400`), respeitando o corte de recebimento já configurado. Uma retomada mantém exatamente a mesma janela.

O piloto manual autorizado é gerado separadamente com `--manual-pilot`, em pasta privada nova. Nesse artefato a configuração tem `enabled:true`, o workflow continua `active:false`, `allowScheduled:false`, e o próprio nó de agenda tem `disabled:true`. Só aceita execução `test`/`manual`. O piloto não altera OP01/OP05 nem a configuração dos artefatos anteriores. A geração não executa o workflow.

## Vínculos concretos

As referências de credenciais foram copiadas dos exports privados dos OP01/05, sem ler valores de autenticação:

- Gmail: **PAMVET — Gmail exames (somente leitura)**.
- WhatsApp/Chatwoot: **ChatWoot PAMVET**.
- Backend: **PAMVET — Backend exames (worker)**.

A Data Table **PAMVET — Intake audit continuation v1** foi criada e conferida pelo agente principal no projeto privado existente. Os candidatos usam seu ID confirmado. Schema: `collector_key:string`, `state_json:string`, `revision:number`, além dos campos internos do n8n.

HTTP Request nativo faz a autenticação; os nós Code não acessam segredos nem presumem suporte a `httpRequestWithAuthentication`. O nó Data Table 1.1 e os parâmetros de `get`/`insert`/`update` foram verificados no código oficial da versão n8n 2.10.2. O repositório oficial aplica os filtros de revisão e identidade no próprio UPDATE SQL, dentro de transação. O contexto real de contas, permissões e execução n8n continua exigindo validação antes de habilitar.

## Efeito autorizado e limites

Nos provedores há somente GET de identidade, listagem, inventário MIME e texto de aviso Hopelab reconhecido. No backend há somente `intake_begin`, `intake_event`, `intake_lookup_source` e `intake_finish`, sempre em modo **audit**. Não há acesso a URL de download, endpoint de anexo, decodificação de PDF, criação de documento clínico, gravação Drive, anexação no Nexus, conclusão de contato ou envio WhatsApp.

Cada página tem os IDs registrados no ledger antes dos metadados ou da próxima página. O estado com a página pendente é salvo primeiro na Data Table; depois do ACK do ledger há nova persistência antes de avançar. Resposta perdida mantém o mesmo evento e token para nova conferência. A identidade OAuth Gmail é conferida antes de tocar no ledger. WhatsApp confere a caixa configurada e valida a identidade da conversa/caixa nas páginas retornadas.

Gmail enumera todos os IDs da janela, incluindo spam e lixeira, sem filtros de assunto, remetente, leitura ou existência de anexo. O inventário MIME não contém `body.data` e detecta projeção truncada. Todas as partes com localizador de anexo ou nome de arquivo, mais PDFs inline, recebem identidades distintas por mensagem/parte/anexo. Imagens, DOCX, ZIP e outros incompatíveis ficam `pending` com `unsupported_attachment_requires_review`; não criam documento clínico.

Após provar ausência de PDF, um aviso Hopelab reconhecido recebe segunda leitura de texto MIME, mesmo quando contém imagens decorativas. Apenas texto plain/HTML é decodificado (máximo 1 MiB), com conferência de identidade, tamanho, UTF-8, estrutura e inventário de anexos. URLs visíveis e atributos `href` de anchors passam pela mesma allowlist canônica; script, style, comentários e hosts externos não fornecem uma origem. A mesma URL em texto e HTML gera uma origem por mensagem. Somente o hash da URL direta permitida sai dessa etapa; texto, URLs e nomes não entram no estado ou ledger. Um PDF ou mudança de anexos que apareça na segunda leitura falha explicitamente, preservando recibos dos anexos já descobertos e um aviso de falha. Mensagens sem origem comprovável preservam um aviso para revisão.

Chatwoot enumera todas as conversas da caixa e todos os IDs de mensagens, incluindo notas e saídas; exclusões por janela/tipo ocorrem depois da descoberta durável e ficam declaradas. A janela de um dia limita a classificação, mas a API de mensagens exige paginação histórica por ID; um histórico grande pode precisar de várias retomadas. Orçamento parcial não é cobertura concluída.

**A preservação de um documento existente exige prova.** O lookup SQL26 é somente leitura e consulta conta/mensagem/anexo em lotes de até 100 identidades. Apenas origem exata ligada diretamente ao documento canônico com hash, bytes e arquivo preservado produz recibo `saved`; o SQL23 confere novamente essa ligação ao gravar o recibo. Alias, vínculo antigo de aviso, ausência de arquivo ou origem inexistente ficam `pending` com motivo explícito. Dois avisos com a mesma URL mantêm seus IDs de mensagem separados. Um segundo aviso não herda a prova do primeiro. Nenhuma reserva ou reconciliação clínica é chamada para preencher a falta de prova.

Estados pendentes, incidentes e outbox desta auditoria são reais no ledger quando ela for executada. `monitoring:false` corresponde a `exam_intake_health.monitored=false` e não impede criação de incidentes. O piloto depende de alertas externos permanecerem desabilitados, como confirmado pelo agente principal. Uma janela que descobre e classifica origens pendentes pode ter `coverageComplete:true` e simultaneamente `allPreserved:false`, `scanFinished:false`; o checkpoint operacional fica inalterado. Esses sinais devem ser apresentados separadamente.

## Continuidade e revisão antes de habilitar

O orçamento padrão é 100 operações ou 180 segundos por execução, verificado entre as chamadas, com timeout de 30 segundos nos HTTP Request e limite n8n de 240 segundos. O próximo disparo retoma a mesma janela, UUID e token. Não usa `staticData` como persistência. O texto da Data Table contém cursores e tokens de lease e precisa permanecer no projeto privado. Não é compartilhado no painel de membros ou no Git.

A primeira persistência adquire lease de 15 minutos com dono igual ao ID de execução. Em linha existente, o UPDATE exige simultaneamente `collector_key`, `id` interno e revisão anterior; um concorrente com revisão velha não sobrescreve o estado. Uma leitura posterior exige a única linha com chave, ID, revisão e JSON exatos antes de qualquer chamada. Quem encontra lease válida de outro executor para sem tocar no ledger. Inserções iniciais concorrentes que produzam duplicatas falham explicitamente na leitura; não se escolhe uma linha arbitrária. Cada gravação renova a lease; saídas normais ou por orçamento a liberam por CAS antes do resumo. Crash preserva lease até expirar. O timeout do engine (240 s) é menor que a lease (900 s). O comportamento ainda requer prova no engine real antes de qualquer agenda.

Páginas acima de 100 IDs, ciclos, inventário MIME incompleto ou capacidade de estado excedida falham explicitamente. Falha de metadados de uma mensagem gera recibo de falha e permite conferir as demais. Se a lease expirar durante uma interrupção longa, o backend rejeita a retomada; revisar a varredura incompleta antes de recomeçar a janela, preservando a fila existente.

## Verificações locais

`n8n-discovery-audit.test.mjs` tem 21 casos: guardas, piloto autorizado exclusivamente manual, grafo/credenciais, CAS/lease, quatro PDFs com o mesmo nome, imagem/DOCX/ZIP/inline, HTML-only href e texto com o mesmo hash, aviso cujo corpo falha com anexos conhecidos preservados, lookup/prova inválida, lotes de 100, dois avisos com URL igual, ACK perdido, retomada por orçamento, falha isolada, 21 mensagens Chatwoot e ausência de truncamento silencioso. `n8n-discovery-audit-sql.test.mjs` tem três casos usando SQL23/24/26 em PGlite: quatro recibos pendentes sem fontes/documentos clínicos criados; inventário vazio com fila anterior preservada; origem existente com recibo saved e zero mutação em fontes/documentos/entregas/eventos clínicos. A saúde dos coletores de auditoria permanece não monitorada.

Esses testes não executam o engine n8n, OAuth real, Data Tables reais ou API clínica. Teste real manual, leitura dos recibos e revisão dos alertas são etapas distintas antes de qualquer ativação.

Referências: [Data Table n8n](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.datatable), [nó na versão 2.10.2](https://github.com/n8n-io/n8n/blob/n8n%402.10.2/packages/nodes-base/nodes/DataTable/DataTable.node.ts), [parâmetros de seleção](https://github.com/n8n-io/n8n/blob/n8n%402.10.2/packages/nodes-base/nodes/DataTable/common/selectMany.ts), [update](https://github.com/n8n-io/n8n/blob/n8n%402.10.2/packages/nodes-base/nodes/DataTable/actions/row/update.operation.ts), [UPDATE com filtros no repositório SQL](https://github.com/n8n-io/n8n/blob/n8n%402.10.2/packages/cli/src/modules/data-table/data-table-rows.repository.ts#L271-L317).
