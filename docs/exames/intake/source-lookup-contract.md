# Consulta de origens preservadas — SQL26

Implementação local de 27/10/2026. A migração cria apenas `lookup_exam_intake_sources(text,jsonb)`, função `STABLE`, `SECURITY DEFINER`, com autorização de serviço e `search_path` fixado. Não cria documentos, fontes, recibos, entregas, incidentes ou checkpoints; não reserva nem reconcilia tarefas.

A action Edge `intake_lookup_source` recebe `{collector_id,identities}` e chama a RPC com `{p_collector_id,p_identities}`. `identities` contém de 1 a 100 objetos `{account_id,message_id,attachment_id,partition_key?}`. Chaves adicionais são rejeitadas. O coletor precisa estar registrado e a conta de cada item precisa coincidir com seu manifesto. A action permanece exclusiva do worker; sessão de membro e segredo limitado do monitor não têm acesso.

Resposta: `{contract:'exam_intake_source_lookup_v1',items:[...]}`. Cada item conserva os IDs solicitados e informa `status`, `reason`, `match_kind`, IDs técnicos da fonte/documento, SHA-256, tamanho, estado do arquivo, `canonical_file_preserved` e estado agregado do grupo. Não devolve nomes, pacientes/tutores, texto clínico, caminhos, URLs Drive, IDs externos das mensagens ou tokens.

`saved` exige origem exata por canal/conta/mensagem/anexo, vínculo direto ao documento canônico e o registro de original salvo com SHA, tamanho positivo e referências de Drive. Essa é uma prova dos metadados de preservação já confirmados pelo sistema; não faz novo download nem comprova disponibilidade atual do provedor. O estado de envio ao grupo permanece separado da preservação do arquivo.

Aliases ainda não reconciliados ficam `pending/source_alias_binding_requires_review`, mesmo quando o canônico preservado é encontrado. Ciclos ou cadeias acima de oito vínculos ficam `pending/canonical_lineage_unresolved`; a consulta não os modifica. Erros de conta, origens ausentes e arquivos ainda não salvos são retornados por item com motivo explícito.

Para Hopelab legado, a busca alternativa exige conta, chave do anexo e **o `gmail_message_id` do próprio aviso** nos metadados da fonte antiga. O primeiro aviso pode apresentar `canonical_file_preserved:true`, mas fica `pending/legacy_notice_binding_requires_review` porque sua chave de mensagem sintética não satisfaz o vínculo literal exigido pelo recibo novo. Um segundo aviso que apenas repete a mesma URL não herda essa prova: sem origem própria fica `not_found/notice_origin_not_recorded`. Nada é renomeado ou atribuído retroativamente. Fontes v2 com identidade própria e bytes iguais podem compartilhar canônico e retornar `saved` de forma independente.

Testes: `node --test scripts/exames/intake/exam-intake-source-lookup.test.mjs`. Incluem ACL, metadados privados ausentes, conta/anexo, deduplicação, alias/ciclo, primeiro/segundo aviso legado, ausência de mutações em transação `READ ONLY` e módulo Edge real conectado ao PGlite. A implantação e a prova contra o backend publicado são verificações distintas.
