# Revisão local da implantação Supabase — 11/10/2026

**Conclusão:** as quatro migrações formam um pacote compartilhado Pam Laudos/PAM Nexus. A migração 01 também altera o acesso ao monitor existente; não deve ser aplicada isoladamente com a equipe e o coletor legado trabalhando normalmente. A instalação precisa coordenar as permissões, os membros e as interfaces compatíveis. Ela não ativa o n8n nem comprova processamento de exames.

Esta rodada foi uma revisão estática dos arquivos atuais, sem conexão ao banco real, leitura de dados clínicos/segredos, execução de migrações, publicação ou alteração de SQL. O usuário confirmou que o alvo continua sendo o mesmo Supabase compartilhado do PAM Nexus; catálogo, proprietários, permissões e histórico de migrações reais ainda precisam ser conferidos. IDs reais, contas da equipe, snapshots e configurações privadas ficam fora deste documento e do repositório.

## Arquivos revisados e ordem

| Ordem | Arquivo | Dependências e efeito |
|---|---|---|
| 1 | `supabase/migrations/20261010000001_exam_documents.sql` | Exige schema legado, `auth.users`, funções `auth.uid`/`auth.role`, papéis Supabase e Storage. Cria sete tabelas `exam_document_*`, evidência, filas, RPCs e view. Adiciona colunas em `exam_card` e `exames`; troca policies do monitor e cria dois buckets privados. |
| 2 | `supabase/migrations/20261010000002_exam_document_card_guards.sql` | Exige 01 e o acompanhamento legado completo. Substitui guards, transições, fusão/exclusão, `v_exam_cards` e RPCs; protege anexos Nexus ligados a documentos e restringe `receive_email_result` ao serviço. Torna a ponte de vendas `SECURITY DEFINER`. |
| 3 | `supabase/migrations/20261010000003_exam_document_staging_journal.sql` | Exige fonte/documento/helper de serviço da 01. Acrescenta um journal de dispatch por fonte e duas RPCs exclusivas do serviço. Não habilita o leitor Composio nem os fluxos OAuth. O caminho Gmail direto não depende de dispatch Composio. |
| 4 | `supabase/migrations/20261010000004_exam_collection_checkpoint.sql` | Exige fonte/documento/helper de serviço da 01. Acrescenta o único ledger de coleção, cursor, sweep, eventos e RPCs de CAS; preserva Outlook e admite manifesto Gmail v1 explícito. Não agenda nem inicia coleta. |

Dependências locais anteriores: `supabase-migration.sql`; ponte `20260324000001`; recebimento legado `20260324000002`; remessas `20260327000001`; fusão, movimento e exclusão legados; e estado de grupo `20260930000001`. Isso é uma lista de pré-condições para comparar com o catálogo, **não uma instrução para reaplicar migrações históricas**. A de setembro modifica estados antigos e não deve ser executada de novo para tentar preencher uma diferença de schema.

A fonte única das quatro migrações é o Pam Laudos. O Nexus usa o mesmo banco e não deve aplicar outra cópia. Os `CREATE TABLE`, índices/policies/triggers novos não tornam o pacote reaplicável: objetos existentes ou implantação parcial exigem conciliação do histórico e dos fingerprints, sem `DROP CASCADE`, force ou registro fictício de sucesso.

Fingerprints SHA-256 dos SQL revisados:

| Migração | SHA-256 |
|---|---|
| 01 | `e843cf1b8e7d97c06b44cca207d6d68ea582720d50142f324b974a2390f7e7b6` |
| 02 | `e9c11b19fde27a919f84add35ff453f59ec4db16b6e1302a0e81ead1bb36f99a` |
| 03 | `6e6c379506dfbe6d4cf89a2612f8a5ab181ddb58d7b4c24f401e2e8f0950b34e` |
| 04 | `be20bee3c42242505a6a0e19903afad49a5e8c5bb9ba228ac3f4829e8d56fefb` |

## Efeitos relevantes no acompanhamento atual

1. **Equipe e aplicativo:** a 01 cria `exam_document_member` vazia, remove todas as policies de `exam_card`, `exam_item`, `exam_card_log` e `lab_shipment`, revoga acesso de `anon` às tabelas e exige membro ativo para `authenticated`. Autenticação Supabase sozinha não concede acesso. Os novos dados/documentos ficam somente para membros; ninguém pode se cadastrar como membro pelo navegador.
2. **Intervalo entre 01 e 02:** a antiga `v_exam_cards` pode continuar lendo com privilégio do owner até a 02 trocar a view para `security_invoker` e revogar `anon`, dependendo dos ACLs existentes. Ao mesmo tempo, escritas anônimas e de não membros deixam de funcionar. Portanto 01 isolada cria uma transição incompleta de acesso. A ponte `bridge_tracking_to_card()` legada usa o chamador; somente a 02 a torna `SECURITY DEFINER` para a venda autorizada no Nexus continuar criando card/item sem dar acesso do monitor ao vendedor. O owner da função precisa conservar os privilégios necessários.
3. **Interface coordenada:** `src/App.tsx` protege todas as rotas de acompanhamento com `RequireExamAccess` e `ExamAuthProvider`. Publicar essa versão antes da tabela/RPC de membros existir também bloqueia o monitor. Aplicar as policies antes da interface compatível bloqueia a UI anônima anterior. Nenhuma transição de produção sem interrupção foi comprovada; não prometer zero downtime.
4. **Coletor anterior:** a 02 revoga execução de todas as assinaturas `receive_email_result` de `PUBLIC`, `anon` e `authenticated`; mantém `service_role`. Preserva a função legada, sem substituir sua lógica de matching. Mapear o chamador e autenticar seu backend antes dessa restrição. Não desativar o coletor anterior nem selecionar uma janela retroativa por consequência da instalação. A credencial de serviço exposta no export legado, já registrada em `implementacao-v1.md`, continua exigindo substituição coordenada dos consumidores; apagar o export não a revoga.
5. **Itens/cartões históricos:** a 02 permite o fluxo legado para itens sem documentos. Itens vinculados passam a exigir evidência de resultado/contato por documento; cartões com documentos são arquivados em vez de apagados. `exam_card_log` perde UPDATE/DELETE para `authenticated`, mas mantém o INSERT/SELECT utilizado pela interface. Remessas continuam por `lab_shipment`/`exam_item`, agora com sessão e membro.
6. **Anexos Nexus:** `exames.exam_document_id IS NULL` mantém o acesso permitido pelas policies antigas, mas a 02 impede usuários comuns de escrever/alterar anexos gerenciados por documento. Se `storage_bucket`/`storage_path` já existirem em anexos legados sem `exam_document_id`, o novo guard pode bloquear seu UPDATE; conferir essa colisão antes. Não tratar todos os exames antigos como documentos novos.
7. **Storage:** as novas boundaries restringem somente `exam_documents_private` e `exam_documents_staging`; policies de outros buckets continuam. Se os IDs já existirem, a 01 usa `ON CONFLICT` e força `public=false`. É necessário verificar ownership/uso anterior desses IDs; não mudar um bucket existente de outra finalidade inadvertidamente.

## Pré-verificações somente de metadados

Executar estas consultas apenas quando houver acesso administrativo ao alvo confirmado. Não foram executadas nesta rodada. Guardar resultados em snapshot privado; não incluir chaves, JWTs, URLs assinadas, corpos de emails ou linhas clínicas.

- Conferir identidade/versão do projeto, ambiente e histórico de migrações; comparar 01–04 ausentes, presentes ou parcialmente registrados. Verificar que `public.exames`, `pets`, `clients`, `veterinarios`, `exam_tracking` e o monitor pertencem ao mesmo schema esperado.
- Comparar nomes/tipos/nullable/FKs/índices das tabelas e colunas usadas pelos SQL. `IF NOT EXISTS` não confirma que uma coluna preexistente tem o tipo/FK correto. Confirmar particularmente `exam_card.group_sent_at/resolved_at`, `exam_item.sent_to_lab_at/sent_to_lab_by/shipment_id` e os campos de `exames`, `pets` e `clients` referenciados.
- Conferir constraint de status com `no_grupo`, constraint de origem e triggers instalados. Não presumir que a data do arquivo equivale à aplicação da migração.
- Capturar policies/ACLs/default privileges, owners e flags de segurança das views/RPCs do escopo, incluindo todas as assinaturas de `receive_email_result` e a ponte de vendas. Snapshot das definições anteriores é necessário para recuperação; não substituir uma definição real por uma cópia antiga do repositório.
- Conferir buckets/limites/MIME/visibilidade e existência de objetos nos dois IDs novos. Conferir collisions das policies `exam_document_private_*` e `restrict_document_exames_to_team`.
- Identificar o papel de autenticação do importador legado e os consumidores da credencial compartilhada sem imprimir seus valores. Confirmar que a interface de login e as contas da equipe estão prontas para o acesso por membro.

Exemplos de consultas de catálogo, sem leitura de conteúdo clínico:

```sql
SELECT n.nspname, c.relname, c.relkind,
       pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity, c.relforcerowsecurity, c.reloptions, c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('exam_card','exam_item','exam_card_log','lab_shipment','exames','exam_tracking',
   'pets','clients','veterinarios','v_exam_cards','v_exam_documents',
   'exam_document_member','exam_document_configuration',
   'exam_collection_cursor','exam_collection_sweep');

SELECT table_name, column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN
  ('exam_card','exam_item','exam_card_log','lab_shipment','exames','exam_tracking',
   'pets','clients','veterinarios')
ORDER BY table_name, ordinal_position;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE (schemaname='public' AND tablename IN
  ('exam_card','exam_item','exam_card_log','lab_shipment','exames'))
   OR (schemaname='storage' AND tablename='objects');

SELECT p.oid::regprocedure::text AS signature,
       pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proacl,
       ARRAY(SELECT setting FROM unnest(COALESCE(p.proconfig,'{}'::text[])) setting
             WHERE split_part(setting,'=',1)='search_path') AS search_path_config,
       md5(pg_get_functiondef(p.oid)) AS definition_fingerprint
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f' AND
  (p.proname LIKE '%exam_document%' OR p.proname LIKE '%exam_collection%'
   OR p.proname IN ('receive_email_result','bridge_tracking_to_card',
      'move_exam_card','merge_exam_cards','delete_exam_cards',
      'get_exam_card_summary','set_exam_group_sent_at','handle_exam_item_update'));

SELECT id, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id IN ('exam_documents_private','exam_documents_staging');
```

As contagens de linhas por tabela/estado/origem e a contagem de anexos legados com `storage_*` preenchido podem complementar a integridade, sem exportar registros. São leituras operacionais agregadas separadas do inventário de catálogo; executá-las somente no escopo autorizado, registrar antes/depois e não inventar equivalência de dados a partir de um HTTP 200.

## Sequência segura de instalação

1. **Preparar:** obter o snapshot privado, reconciliar o catálogo/histórico, resolver o chamador legado e a credencial de serviço conhecida. Preparar build/preview da interface autenticada e do Nexus compatível. Preparar os IDs Supabase Auth verificados e seus papéis; a caixa coletora de email não vira automaticamente uma conta da equipe. Não alterar corte, allowlist, destinos ou workflows reais nesta preparação.
2. **Definir o ponto de transição:** usar uma janela coordenada sem escritas concorrentes nesse escopo, ou uma estratégia de compatibilidade previamente implementada e testada. O estado atual não contém essa compatibilidade transitória. Não deixar 01 sozinha nem publicar a UI autenticada contra schema ausente. O coletor legado precisa continuar com backend autenticado após a mudança; pausar/substituir sua execução é uma decisão de corte separada.
3. **Aplicar uma vez, em ordem 01 → 02 → 03 → 04**, junto do provisionamento dos membros verificados. 01, 02 e 04 têm `BEGIN/COMMIT` próprios; 03 não tem wrapper explícito. Se a implantação exigir um único commit para policies, bridge e membros, preparar/revisar um pacote de execução que trate esses wrappers e o seed como uma única transação. Não presumir que concatenar `BEGIN` externos com os arquivos originais produz atomicidade: seus `COMMIT` internos encerram a transação. Não alterar/apagar silenciosamente o histórico de migrations.
4. **Validar o schema e acesso antes de liberar a janela:** views invoker, policies/ACLs, bucket privado, ponte de vendas, membros e configuração pausada. Qualquer incompatibilidade de catálogo deve impedir a conclusão, preservando o snapshot e o estado anterior, sem reinstalar constraints históricas sobre dados reais por tentativa.
5. **Disponibilizar os consumidores compatíveis na mesma transição:** Edge Function e segredos próprios do worker, Pam Laudos com login/equipe e Nexus com leitura autenticada do anexo. SQL não publica a Edge Function ou as interfaces. Conferir monitor/remessas/contato legado e uma venda sintética autorizada sem dar acesso de documentos ao usuário externo à equipe.
6. **Manter `enabled_destinations={}` e todos os HOLDs.** Instalar schema, membro e interface não autoriza ingestão retroativa, grupo ou anexo. Uma homologação futura pode habilitar somente `drive`/`processing` para um PDF sintético, após a configuração/credenciais necessárias e prova de integridade. Grupo e Nexus têm gates próprios; `notification_cutoff` e destino do grupo continuam sem preenchimento automático.

Não há seed universal no SQL. Mínimo técnico de acesso: um administrador ativo verificado; cada pessoa que usará acompanhamento/remessas precisa de membro ativo. Pessoas que registrarão contato/conferência de entrega precisam de `vet` ou `admin`; recepção usa `reception`. Atribuição exige um membro ativo. Gestão configura os membros pelo serviço/administrador, sem conceder acesso a todos os usuários autenticados. IDs/papéis devem vir de evidência da equipe, não de inferência ou da lista de emails recebidos.

## Pós-verificações e limite da prova

- Conferir objetos esperados e fingerprints dos SQL efetivamente aplicados; manter uma única origem do histórico de migrations. Confirmar que não houve duplicação ou alteração de owners não planejada.
- Confirmar `exam_document_configuration`: uma linha, destinos vazios, corte/destino não preenchidos por default; buckets privados; RLS ativo; views com `security_invoker`; nenhum EXECUTE público nas RPCs de serviço/coleta/staging. `is_exam_document_member` é intencionalmente chamável por anon/authenticated, mas retorna somente booleano.
- Confirmar a ponte `bridge_tracking_to_card()` definer com `search_path=public,pg_temp` e owner autorizado. `receive_email_result` deve conservar a definição legado aprovada e ser executável somente pelo backend de serviço.
- Validar sessão de membro ativo, membro inativo, authenticated externo e anon. Membro usa monitor/remessa; externo/anon não lê documentos nem chama RPC de serviço; vendedor autorizado continua criando o card pela ponte. Esses checks de comportamento são diferentes da conferência de metadados e devem ser feitos com contas/casos sintéticos, sem envio ou alteração clínica.
- Conferir contagens e estrutura anteriores do legado: instalar as quatro migrações não migra resultados históricos para documentos nem marca contato/envio. `exames` sem origem documental continua no caminho legado; casos com campos privados preexistentes exigem a compatibilidade já mencionada.
- Depois, em homologação explícita, provar PDF sintético, bytes/hash/leitura privada, retomada, duplicata e permissões do frontend/Edge. A versão local já tem testes de SQL/RLS/bridge e checkpoint Gmail/Outlook; o checkpoint preservado tem 22 cenários PGlite aprovados na rodada anterior. Nesta revisão não executei SQL nem revalidei esses testes. PGlite não substitui catálogo real, locks Postgres multiconexão, sessão do navegador ou contrato de provider.

## Recuperação possível

**Antes do commit do pacote controlado:** rollback da transação pode preservar o schema/ACLs anteriores. Verificar o resultado da transação e histórico antes de repetir; a existência de wrappers separados pode deixar fases já comprometidas, por isso a atomicidade precisa ser preparada.

**Depois do commit, com schema ainda vazio:** preferir correção dirigida de acesso/consumidores e preservar as tabelas aditivas. Snapshot privado permite restaurar definição de view/RPC/trigger/ACL afetada se houver uma decisão explícita de reversão. Reabrir policies anônimas antigas não é um remédio automático para login bloqueado. Não presumir que remover as tabelas é seguro só porque a coleta está em HOLD.

**Depois de fontes, arquivos, vínculos ou contatos:** pausar somente os novos workers/destinos sob controle da implantação e preservar originais, ledger, itens e evidências. Reconciliar leases/efeitos antes de retomar. Não usar `DROP CASCADE`, apagar buckets, alterar fontes ou desfazer contato/mensagem como rollback. Um restore completo desse banco compartilhado também poderia desfazer outras operações do PAM Nexus; recuperação de objetos/dados precisa de plano específico, não de restauração global por conveniência.

Esta revisão não decide publicação, janela de manutenção, papéis de pessoas ainda não identificadas ou marco de corte de emails. As pendências técnicas conhecidas são trabalhos de implantação e homologação, não novas perguntas genéricas ao usuário. Não foram executados comandos de banco, deploy, publicação ou alteração de workflows.

## Complemento — leitores existentes e janela de implantação (12/10/2026)

Este complemento resulta da leitura local do código e de snapshots privados de catálogo previamente capturados. Não houve nova consulta ao banco, leitura de credenciais ou linhas clínicas, execução de SQL, teste, deploy ou publicação. Os nomes reais dos papéis de integrações de leitura, contas e identificadores do projeto ficam fora deste documento. Os quatro fingerprints acima e os arquivos SQL permanecem inalterados.

**O pacote atual 01–04 não é uma instalação apenas de estrutura e seed.** Mesmo mantendo destinos vazios e a coleta em HOLD, ele muda imediatamente policies, acesso às views e RPCs legadas. Preparar o aplicativo, a equipe e os consumidores antigos é uma condição para preservar seu uso. Isso não exige definir agora uma janela retroativa de emails nem ativar o novo coletor.

### Papéis de integrações de leitura

O catálogo capturado contém grants de leitura do monitor para papéis de integrações de leitura além dos papéis padrão do Supabase. A 01 remove as policies permissivas existentes e cria `team_monitor_access` somente para `authenticated`. A 02 conserva grants não revogados explicitamente, mas transforma `v_exam_cards` em `security_invoker` e acrescenta dependências das tabelas de documentos.

Assim, conservar `SELECT` na view não comprova que um leitor continuará funcionando: a execução passa a depender dos privilégios sobre as relações subjacentes e das policies aplicáveis ao papel efetivo. O snapshot não prova herança, possibilidade de assumir outro papel, bypass de RLS ou qual consumidor usa cada papel. Mapear esses consumidores antes da implantação; não convertê-los indiscriminadamente em membros clínicos ou em serviço privilegiado.

As consultas abaixo leem somente atributos, memberships e grants de catálogo. Substituir o placeholder apenas na consulta administrativa privada, sem publicar nomes reais ou os resultados. Membership entre papéis PostgreSQL é diferente da membership clínica em `exam_document_member`. Um grant efetivo também não substitui a avaliação de RLS, do contexto Auth e da view invoker.

```sql
-- Atributos do papel de leitura; não consultar campos de senha.
WITH targets(role_name) AS (VALUES ('papel_de_leitura_a_verificar'))
SELECT r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls
FROM pg_roles r JOIN targets t ON t.role_name=r.rolname;

-- Grants diretos de membership, sem executar SET ROLE.
WITH targets(role_name) AS (VALUES ('papel_de_leitura_a_verificar'))
SELECT member_role.rolname AS member_role,
       parent_role.rolname AS granted_role, m.admin_option
FROM pg_auth_members m
JOIN pg_roles member_role ON member_role.oid=m.member
JOIN pg_roles parent_role ON parent_role.oid=m.roleid
JOIN targets t ON t.role_name=member_role.rolname;

-- Membership transitiva e privilégios herdados disponíveis sem SET ROLE.
WITH targets(role_name) AS (VALUES ('papel_de_leitura_a_verificar'))
SELECT consumer.rolname AS consumer_role, parent_role.rolname AS parent_role,
       pg_has_role(consumer.oid,parent_role.oid,'MEMBER') AS is_member,
       pg_has_role(consumer.oid,parent_role.oid,'USAGE') AS inherited_usage
FROM targets t JOIN pg_roles consumer ON consumer.rolname=t.role_name
JOIN pg_roles parent_role ON parent_role.oid<>consumer.oid
WHERE pg_has_role(consumer.oid,parent_role.oid,'MEMBER');

-- ACLs de relações existentes; inclui grants PUBLIC e de outros papéis.
SELECT n.nspname, c.relname,
       CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
       a.privilege_type, a.is_grantable
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
LEFT JOIN pg_roles grantee ON grantee.oid=a.grantee
WHERE n.nspname='public' AND c.relname IN
  ('exam_card','exam_item','exam_card_log','lab_shipment','v_exam_cards',
   'exam_document','exam_document_item','exam_document_delivery','v_exam_documents')
ORDER BY c.relname, grantee, a.privilege_type;

-- Privilégio efetivo de schema/relação; não comprova que RLS libera linhas.
WITH targets(role_name) AS (VALUES ('papel_de_leitura_a_verificar'))
SELECT consumer.rolname, n.nspname, c.relname,
       has_schema_privilege(consumer.oid,n.oid,'USAGE') AS schema_usage,
       has_table_privilege(consumer.oid,c.oid,'SELECT') AS effective_select,
       c.relrowsecurity, c.relforcerowsecurity, c.reloptions
FROM targets t JOIN pg_roles consumer ON consumer.rolname=t.role_name
JOIN pg_namespace n ON n.nspname='public'
JOIN pg_class c ON c.relnamespace=n.oid
WHERE c.relname IN
  ('exam_card','exam_item','exam_card_log','lab_shipment','v_exam_cards',
   'exam_document','exam_document_item','exam_document_delivery','v_exam_documents');

-- Grants das assinaturas legadas e dos endpoints novos, sem invocá-los.
SELECT p.oid::regprocedure::text AS signature, p.prorettype::regtype AS result_type,
       CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
       a.privilege_type, a.is_grantable
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
LEFT JOIN pg_roles grantee ON grantee.oid=a.grantee
WHERE n.nspname='public' AND p.prokind='f' AND
  (p.proname LIKE '%exam_document%' OR p.proname LIKE '%exam_collection%'
   OR p.proname IN ('receive_email_result','bridge_tracking_to_card',
      'move_exam_card','merge_exam_cards','delete_exam_cards','get_exam_card_summary',
      'set_exam_group_sent_at','handle_exam_item_update'))
ORDER BY signature, grantee;
```

Conferir o fechamento de `PUBLIC`/`anon` nas RPCs humanas legadas e de `PUBLIC`/`anon`/`authenticated` nas RPCs de serviço. A exceção intencional de `is_exam_document_member()` retorna somente booleano. As funções que retornam `trigger` não são endpoints comuns invocáveis fora de contexto de trigger; analisar sua definição, owner e caminho de execução, sem equiparar seu ACL ao de uma RPC de recebimento.

### Locks e atomicidade

O builder local mantém uma única transação e usa guards de identidade, catálogo, definições e colisões antes das migrações. Ele solicita lock de advisory da implantação, `SHARE ROW EXCLUSIVE NOWAIT` no registro de migrations e `ACCESS EXCLUSIVE NOWAIT` em `exam_card`, `exam_item`, `exam_card_log`, `lab_shipment`, `exames`, `exam_tracking`, `pets`, `clients`, `veterinarios` e `v_exam_cards`. Define também `lock_timeout` de cinco segundos para outras aquisições da transação.

`NOWAIT` faz a aquisição incompatível falhar; não transforma a implantação em operação sem impacto. Depois de adquiridos, os locks podem bloquear leituras e escritas concorrentes do monitor e do PAM Nexus até o commit/rollback. A validação de constraints e o restante do DDL também podem prolongar esse intervalo. Não encerrar sessões alheias nem repetir o pacote cegamente depois de uma falha. Conferir término/rollback, catálogo e registro antes de retentar na janela coordenada. A prova local de transação não prova contenção PostgreSQL multiconexão ou ausência de interrupção em produção.

### Checklist para a aprovação coordenada

- **Administrador:** identidade Auth existente e autorização verificadas em registro privado; o SQL deve conferir o ID e email exatos, sem criar usuário, token ou conta. O builder atual exige seed de exatamente um administrador ativo; não inclui automaticamente a equipe inteira.
- **Equipe:** identificar membros ativos e papéis necessários para monitor, remessas e contato. Preparar seu provisionamento restrito na transição. Se entrar apenas o administrador, registrar explicitamente que o restante da equipe ainda não terá acesso.
- **Aplicativo:** preparar a interface com login/membership e verificar a versão que será disponibilizada. A versão anterior anônima perde acesso após o SQL; a nova versão consulta schema/RPC de membros e não deve entrar contra banco ainda incompatível. Coordenar a disponibilização; não prometer zero downtime sem mecanismo transitório implementado e comprovado.
- **Importador e leitores:** confirmar o papel efetivo do chamador legado de `receive_email_result`, seus consumidores de credenciais e os papéis de integrações de leitura. Resolver os acessos mínimos antes da restrição e coordenar eventual substituição de credencial compartilhada sem expor valores. A instalação não implica desativar/substituir o importador antigo.
- **Janela e recuperação:** confirmar alvo, executor que preserve a transação única, ausência de colisões, snapshots atuais e disponibilidade da janela para os locks. Preservar as definições anteriores de view/RPC/trigger/ACL para recuperação dirigida; não restaurar globalmente o banco compartilhado por conveniência.
- **Após o commit:** conferir registro das quatro fontes, policies/ACLs, view invoker, owner da ponte e configuração pausada. Validar acessos e consumidores com contas/casos sintéticos autorizados antes de liberar o uso normal. Manter destinos vazios e HOLDs; nenhum corte de email, PDF real, grupo ou vínculo clínico é consequência automática dessa aprovação.

Se for necessária uma primeira fase que instale somente estrutura sem alterar o monitor, preparar um novo pacote aditivo revisado e registrar apenas o que ele realmente aplicar. Não retirar trechos das quatro fontes congeladas nem registrar 01–04 como concluídas após aplicação parcial. Este complemento documenta pré-condições; não executa nem aprova a transição.

### Conclusão sobre a compatibilidade dos leitores — 12/10/2026

Preservar as leituras diretas com policies de SELECT restritas aos papéis de integrações de leitura e às bases que já estavam autorizadas não resolve, por si só, a compatibilidade da `v_exam_cards` com `security_invoker`. Essa view passa a exigir os privilégios e as policies aplicáveis às relações subjacentes, incluindo as dependências documentais novas. Um leitor autorizado somente pela projeção antiga pode não ter SELECT nas bases; concedê-lo para contornar a falha ampliaria acesso. Não transformar esses leitores em `authenticated`, membros clínicos ou serviço privilegiado.

As alternativas permanecem pendentes de decisão e preparação:

- **Projeção legada dedicada:** uma view com comportamento de owner e barreira de segurança poderia reproduzir a definição legada capturada, mantendo somente os campos e JSON anteriores, sem joins ou campos documentais. Não concederia acesso às novas tabelas clínicas/documentais ou às bases antes negadas. Sua criação, ACL restrito e adaptação do endpoint do consumidor exigiriam revisão e aprovação específicas. Preservar a capacidade de leitura não significa conservar literalmente os mesmos nomes de objetos e ACLs; a barreira de segurança não substitui a revisão da projeção e do owner.
- **Pausa do consumidor:** se a troca de endpoint ou o novo objeto restrito não forem aceitos ou ainda não estiverem preparados, coordenar a pausa desse consumidor na transição. Isso não implica desativar automaticamente o coletor de emails ou conceder privilégios mais amplos.

Nenhuma dessas alternativas foi implementada, aplicada ou homologada nesta avaliação. Não foram criados SQL, grants, policies, usuários ou tokens; não houve teste, deploy ou publicação. Os arquivos SQL e seus fingerprints continuam preservados. A avaliação documental não libera gates de implantação ou operação e não comprova execução em produção.

### Direção de uso informada pelo usuário — 12/10/2026

O usuário confirmou que utiliza somente o Pam Laudos e não usa outros painéis ou robôs de exames. O acesso humano inicial solicitado permanece restrito a um único administrador verificado. Nesta etapa, preparar a transição do próprio Pam Laudos, seu login e o vínculo administrativo ativo; não preparar view dedicada ou ACL adicional para consumidores externos não relatados.

Essa declaração define o escopo humano solicitado, mas não é prova técnica de ausência de qualquer consumidor. Os papéis e grants encontrados no catálogo continuam sendo metadados existentes; sua existência, por si só, também não comprova uso ativo. Preservar essa distinção sem revogar acessos alheios por inferência. As alternativas de compatibilidade avaliadas acima permanecem sem execução e não integram a preparação atual.

A interface com login exige que tabela/RPC de membros e o vínculo ativo já estejam disponíveis na transição coordenada. O build local e o estado da proposta de código devem ser conferidos separadamente; não comprovam sessão autenticada ou acesso administrativo em produção. Esta direção não aplica SQL, publica a interface, define o corte de emails ou libera os HOLDs.

## Variante local opcional: primeiro acesso com coletor legado — 12/10/2026

Variante `legacy_rpc_admin_transition`: acrescenta uma quinta fonte após 01–04, mantendo as quatro fontes e o modo padrão inalterados. A quinta fonte recebe somente expectativas privadas de metadados, confere o inventário exato da assinatura legada, corpo/fingerprint, owner, definer, search_path e ACL restrito produzido pela 02. Recompõe exclusivamente o ACL capturado do RPC legado, incluindo grantor e grant option, sem liberar acesso direto a documentos, fontes, staging, buckets ou membros. Valores reais desse baseline não são publicados aqui.

| Migração opcional | SHA-256 |
|---|---|
| 05 | `ea934f18302da887c9404df23a8f9733014cda0fc7aa395241d2241624fd60b9` |

Fonte: `supabase/migrations/20261012000005_exam_legacy_rpc_admin_transition.sql`. Guarda adicional de zero documentos e lock exclusivo precede a restauração; checagem final revalida ACL e contrato. A fonte genérica não contém identidade de pessoa, configuração de conta, logs ou chave; as expectativas ficam somente no pacote privado e em configuração local à transação. A variante exige executor que preserve essa transação, sem etapas comprometidas separadamente.

**Fase parcial explícita:** acompanhamento legado e acesso do administrador podem ser preparados, mas ingestão documental permanece impossível pela barreira `BEFORE INSERT` incondicional em `exam_document`, habilitada como `ALWAYS`. Chamadas de serviço, owner, mudanças de destino ou fechamento dos ACLs legados não a liberam. Não há nova tabela, chave de ativação ou desbloqueio implícito. Um administrador com autoridade de DDL pode alterar o schema deliberadamente; isso não faz parte do caminho autorizado do worker.

O RPC legado continua definer e pode criar/alterar cards, itens e logs pelo contrato anterior. A abertura capturada é preservada temporariamente e não é tratada como endurecimento do RPC. A barreira impede introduzir documentos e misturar os dois pipelines nesta fase. Não acrescentar view ou ACL de leitor externo.

A remoção dessa barreira **não está implementada**. Exige uma futura migração versionada e aprovação separada, após pausa do coletor anterior, término das execuções em curso, definição do corte e fechamento dos ACLs legados. Restringir EXECUTE ao serviço, sozinho, não comprova que o coletor anterior parou e não permite documentos na variante atual. A retirada futura deve preservar dados e histórico; não usar remoção global de tabelas ou buckets.

O registro do pacote variante deve conter cinco fontes/fingerprints efetivamente executados. A 05 declara a exceção temporária ao ACL final previsto na 02; não registrar quatro fontes como se essa exceção não existisse. O material em modo `administrative_review` continua recusando obrigatoriamente antes de qualquer DDL/seed. Preparação local não aplica SQL, concede membership real, pausa coletor ou publica aplicativo.

Verificação local dessa variante: 17/17 testes do builder passaram, incluindo as 13 regressões do caminho padrão. O fixture provou RPC legado disponível com ACL/corpo preservados e zero documentos; a barreira bloqueou serviço/owner, inclusive após fechar ACLs e com modo de réplica. Drift de ACL/owner/definer, overload adicional e grant option não reproduzível impediram commit; a falha tardia desfez fontes, seed, registry, restauração e barreira. Essas verificações não equivalem a aplicação real, execução do coletor ou prova de concorrência PostgreSQL entre conexões. Nenhum gate operacional foi liberado.
