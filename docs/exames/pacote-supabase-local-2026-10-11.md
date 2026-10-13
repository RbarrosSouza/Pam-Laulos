# Pacote SQL local 01–04 — 11/10/2026

Preparado sem aplicar SQL, publicar, preencher navegador, consultar secrets ou criar usuário/token. A fonte única continua sendo `supabase/migrations/20261010000001...04`, no Pam Laudos. PAM Nexus usa o mesmo banco; não recebe outra cópia dessas migrações.

## Artefatos e execução do build

Builder: `scripts/exames/build-supabase-deployment.mjs`. Testes: `scripts/exames/build-supabase-deployment.test.mjs`.

Rodar o builder sem argumentos cria somente o template privado `../n8n-verificado-2026-10-11/SUPABASE-EXAMES-01-04-template-nao-aplicar.sql` e seu manifesto JSON, ambos `0600`. **Esse template não pode aplicar:** abre transação e lança uma exceção obrigatória por ausência de administrador verificado antes de qualquer DDL. Não contém email/UUID inventado.

**Complemento de 12/10/2026 — modo para revisão administrativa:** `administrative_review` exige arquivo privado de evidência, recebido pelo root após conferir a identidade e a direção de acesso solicitada. Forma: `userId` (UUID), `email` exato, `identityVerified:true`, `roleAuthorized:'admin'`, `verifiedAt` ISO com timezone e `projectRef` do alvo confirmado separadamente. `roleAuthorized` registra o papel solicitado; não significa concessão executada ou membership ativa. A CLI própria é:

```sh
node scripts/exames/build-supabase-deployment.mjs --admin-review-json <arquivo-privado-de-evidencia.json>
```

Produz `SUPABASE-EXAMES-01-04-revisao-administrativa-nao-aplicar.sql` e `.json` privados `0600`, sem imprimir a identidade. Inclui a identidade verificada e o seed proposto para revisão, mas lança uma **recusa obrigatória** no começo do guard, antes do lookup de Auth, dos locks, de qualquer DDL ou seed. O manifesto mantém `readyToApply:false`, `requiresSeparateApproval:true`, `reviewOnly:true`, `applicationBlocked:true` e `requiresFinalBrowserConfirmation:true`. O pacote de revisão não pode ser aplicado: a confirmação final no navegador e a coordenação de aplicativo, acesso inicial, importador e leitores são uma etapa separada. Não remover a recusa nem trocar o modo como consequência automática da confirmação da identidade.

O modo anterior `verified_admin` e sua CLI `--verified-admin-json <arquivo-privado>` foram preservados. Ele prepara o pacote de aplicação com os guards de identidade/catálogo e continua exigindo aprovação independente. Seu campo legado `readyToApply:true` informa a preparação técnica pelo builder; não comprova que UI, leitores, importador, janela ou confirmação final estejam resolvidos e não concede autorização de execução. Para a revisão inicial, usar o novo modo que recusa execução obrigatoriamente. Nenhum modo pede ou lê senha, token ou secret; somente o root deve gerar posteriormente o pacote privado com a identidade real conferida.

O modo `synthetic_fixture` existe somente para teste: identidade fake preexistente em PGlite, `projectRef:'offline_fixture'` e GUC explícita `pamvet.offline_fixture=true`. Seu manifesto nunca anuncia prontidão de produção. Não gera usuários no SQL do pacote; o setup fake de testes prepara seu próprio `auth.users` isolado.

## Proveniência e guardas

O build exige que SHA-256 de cada arquivo fonte coincida com a tabela da [revisão de implantação](revisao-implantacao-supabase-2026-10-11.md). Divergência interrompe o build. Remove somente os `BEGIN;`/`COMMIT;` externos pareados de 01, 02 e 04; 03 permanece integral, pois não tem wrapper externo. Os corpos das funções, SQL e fingerprints fontes não são editados. O manifesto registra hash original e hash após retirar wrappers, ordem, modo e hash do pacote.

O template utiliza os snapshots privados de catálogo (55 linhas) e definições (11 linhas) obtidos pelo root. O builder confere MD5 das oito funções capturadas contra o catálogo. SQL confere novamente, antes de DDL:

- usuário existente de `auth.users` com UUID **e email exatos**, retendo row lock `FOR SHARE`; ausência ou divergência aborta sem seed/alteração;
- formato completo do registro `supabase_migrations.schema_migrations`, além da ausência das quatro versões atuais;
- ausência de namespace/tabelas/índices/RPCs/colunas/buckets/policies/triggers novos, bloqueando instalação parcial ou colisão;
- colunas/tipos/nullable, owners/ACLs/RLS/opções, constraints capturadas, policies e conjunto de policies, funções legadas com MD5/ACL/security/search_path e definição atual da view;
- locks dos objetos legados conferidos e da view, além de lock do registry e advisory lock desta implantação. Conflito impede seguir; não tenta descartar/escrever por cima.

O snapshot real informa 123 versões registradas e nenhuma 01–04. O pacote **não reconstitui registros históricos** pelo nome dos arquivos nem reaplica setembro. Registra somente as quatro fontes efetivamente executadas, com `version/name/statements`, depois de DDL/seed/asserts e dentro do mesmo commit. Os `statements` armazenados são apenas os quatro SQL originais; não incluem identidade do administrador, secrets ou catálogo privado.

## Atomicidade e estado após instalação

Há um único `BEGIN` externo e um único `COMMIT` executável externo. Os wrappers existentes nas fontes ficam somente como texto no registro da fonte. Seed ocorre na mesma transação: um membro ativo `admin`, vinculado exclusivamente ao ID/email já conferidos de `auth.users`; não cadastra usuário ou outro membro por inferência.

Asserts antes do commit exigem uma configuração única com `enabled_destinations={}`, `notification_cutoff=NULL`, `group_destination_key=NULL`; um único admin esperado; tabelas novas de documentos/origens/filas/cursor sem dados. Instalação não inicia integração, cria exame histórico, processa email/PDF, envia mensagem, agenda n8n ou anexa no Nexus.

A execução precisa preservar a transação completa, verificando seu resultado e dando rollback ao erro; não executar cada fragmento por ferramenta que finalize transações separadamente. O pacote não chama nenhuma ferramenta de aplicação. Após commit, não existe rollback automático destrutivo: snapshots e conciliação orientam uma correção dirigida.

## Prova local e limites

Os testes usam PGlite e o bootstrap legado único já usado pelos fixtures do projeto. Os cenários de aplicação usam snapshots gerados desse banco fake; template e revisão administrativa usam também os metadados privados previamente capturados em arquivos locais, sem conexão ao alvo. Todas as identidades do teste são sintéticas e todos os bancos de execução são isolados. Testam criação atômica das fontes atuais, seed restrito, destinos vazios, registro dos hashes originais, recusas de identidade/colisão/drift, reaplicação bloqueada e rollback por erro **depois** de todas as migrações/seed/registro.

**13/13 grupos de teste passaram na atualização de 12/10**, sem instalar dependências ou usar banco/provider externo. O novo pacote de revisão recusou execução com identidade sintética presente e ausente; não mudou schema, grants, policies, view, usuários ou buckets do fixture. Uma escrita de instrumentação somente do teste dentro da transação foi desfeita pelo rollback após a recusa. A CLI própria e os arquivos `0600` foram conferidos. O template anterior conserva seu hash e as quatro fontes mantêm os fingerprints. Nenhuma prova local é apresentada como instalação real; nenhuma identidade real foi usada nesses testes.

O catálogo/definições capturados não cobrem todas as FKs/índices/definições de triggers/default privileges/role memberships. A referência do projeto é conferida pelo root no ambiente/cliente escolhido; SQL de catálogo não prova, sozinho, em qual projeto uma pessoa colou o arquivo. Aprovação empresarial, janela/coletor legado, segredo de serviço, usuários reais e runtime Edge/UI são verificações separadas. Locks PostgreSQL entre conexões, preservação da transação pelo executor remoto e comportamento com dados clínicos não foram provados por PGlite. Se uma pré-condição faltar, erro impede commit; não ajustar fonte/fingerprint/histórico para forçar a instalação.

## Variante opcional de primeiro acesso — 12/10/2026

`variant:'legacy_rpc_admin_transition'` acrescenta a quinta fonte auditada da revisão. O modo padrão continua selecionando quatro fontes; a variante precisa ser explícita:

```sh
node scripts/exames/build-supabase-deployment.mjs --admin-review-json <arquivo-privado-de-evidencia.json> --preserve-legacy-rpc
```

A API usa `buildDeployment({mode:'administrative_review', variant:'legacy_rpc_admin_transition', verifiedAdmin})`, ou `writeDeployment` com os mesmos argumentos. A saída de revisão recebe o prefixo `SUPABASE-EXAMES-01-05-legado-preservado`; continua privada `0600`, não aplicável e separada dos artefatos históricos 01–04. Nenhum pacote com identidade real é gerado pelos testes.

A fonte 05 recebe expectativas do RPC exclusivamente dos metadados privados capturados e de configuração local à transação. Exige uma assinatura exata, owner/executor, corpo MD5, definer, search_path e ACL restrito esperado após a 02. Rejeita grantor ou grant option que o executor não possa reproduzir, recompõe somente o ACL legado capturado e confere sua igualdade normalizada. Os valores reais do baseline não entram na documentação ou na fonte genérica. O registry da variante registra cinco SQL originais e seus fingerprints, sem incluir identidade ou expectativas privadas nos statements.

O manifesto declara `firstAccessPhase:'admin_and_legacy_collector_only'`, `documentIngestionBlocked:true` e `retirementImplemented:false`. A barreira BEFORE INSERT de `exam_document` é **incondicional**, habilitada ALWAYS, inclusive para serviço/owner e após fechar EXECUTE do RPC. O postassert verifica zero documentos, ACL/contrato final, vínculo da função do trigger, evento BEFORE INSERT por linha, ausência de argumentos/condição e habilitação ALWAYS. Não há novo grant direto em documentos, fontes, staging, buckets ou membros, e nenhum novo leitor/view.

Essa fase mantém o contrato legado e sua exposição anteriormente existente; não realiza o endurecimento final do RPC. Ingestão documental só poderá ser preparada depois de pausa/drain/corte do coletor antigo, ACLs fechados e futura remoção versionada da barreira com aprovação própria. Essa retirada não foi implementada. Um administrador de DDL pode deliberadamente alterar o schema; o caminho comum de INSERT e o papel de serviço não recebem bypass.

O prelude privilegiado agora põe `pg_catalog` antes de `public`. Assim, gerações novas do pacote padrão quatro também terão um novo SHA por essa ordem do guard, embora os quatro SQLs fonte estejam byte a byte preservados. Os artefatos históricos de template/revisão 01–04 não foram sobrescritos nem renomeados. O modo de revisão, com quatro ou cinco fontes, sempre recusa antes de DDL/seed; configuração de variante não libera aprovação de execução.

**Verificação final local: 17/17 testes passaram**, incluindo as 13 regressões anteriores e quatro grupos da variante. Foram provados ACL e corpo legados preservados, chamada sintética do RPC por anônimo/usuário comum/serviço com zero documentos, bloqueio de INSERT para serviço/owner após REVOKE e em modo de réplica, recusas de drift/overload/owner/grant option, rollback tardio e revisão não aplicável com cinco fontes/arquivos privados. Os testes não usam usuários reais, chave, banco/provider externo ou implantação. A suíte durou cerca de 325 segundos; um cenário PGlite concentrou o tempo, sem falha. Não houve teste PostgreSQL multiconexão.

O template padrão quatro produzido agora pelo build em memória tem SHA-256 `cdc1d47cbc117d83886784536fc08dd21c655570ae22da1e77b193653d11f5a7`, devido à ordem protegida de search_path. Isso não sobrescreve nem redefine o fingerprint de artefatos históricos. Os quatro fingerprints de fontes originais e o da quinta fonte foram conferidos; a revisão opcional continua local e sua retirada não foi executada.

## Auditoria local do instalador no pacote de release — 12/10/2026

`npm run test:exames` executa somente regressões autocontidas do domínio, backend e UI; não depende de workflow n8n experimental. `npm run test:exames:installer-local` é uma auditoria **local** do pacote SQL, separada dessa rotina. Requer, fora do repositório, o diretório privado irmão `../n8n-verificado-2026-10-11` com os snapshots de catálogo/definições e o template histórico não aplicável usados pela revisão. Esses insumos não são publicados, não contêm dados clínicos ou chaves e não devem ser copiados para Git/CI. Ausência de insumo ou divergência de fingerprint interrompe a auditoria.

A tela Novos exames conserva o recebimento de PDFs desabilitado e informa que ele ainda não foi liberado. A barreira do banco é a proteção efetiva da fase administrativa; a desativação visual evita convidar uma operação que seria recusada. Liberação documental exige a etapa versionada e a aprovação específica descritas acima.
