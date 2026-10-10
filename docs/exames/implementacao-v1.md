# Novos exames — implementação e aplicação coordenada

Versão preparada em 10/10/2026. Banco, Edge Function, interfaces e workflows precisam ser publicados e homologados em conjunto. Esta alteração não ativa produção.

## Comportamento da equipe

- `/entrar`: conta Supabase Auth da clínica; acesso adicional por membro ativo. Não existe autoinscrição ou liberação automática de usuários.
- `/novos-exames`: documentos recebidos, envio manual de PDF, busca por tutor/pet/arquivo/ID e filtros de pendências. Drive, grupo, contato e Nexus são estados independentes. Paginação de 25 documentos.
- `/novos-exames/:documentId`: PDF autenticado, conferência de campos, busca e confirmação humana de paciente/itens, responsável, registro do contato por veterinária/gestão, etapas, correção, origem e histórico. Não há vínculo automático por nomes.
- O aviso de 24h começa no primeiro envio confirmado ao grupo. O contato exige paciente confirmado, itens selecionados, canal, anotação e autor; não é inferido pelo envio do PDF.
- Documentos ligados aparecem no Kanban e detalhe existentes com link para a conferência. Itens com documento não aceitam edição/exclusão/contato pelo caminho legado. Cards mistos exigem seleção explícita dos itens legados disponíveis. Arquivamento preserva evidências.
- Uma atualização periódica conserva campos/anotações em edição. Versão divergente bloqueia confirmação até atualização explícita; refresh de token não desmonta o formulário. Troca de usuário limpa caches.

O monitor inteiro exige sessão/membro porque as migrações também restringem o acompanhamento antigo. A equipe precisa estar provisionada antes do corte. O frontend usa apenas `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`; credenciais de serviço nunca pertencem ao navegador.

## Artefatos

- [Contrato do backend, migrações, segurança e recuperação](backend-v1.md).
- [Configuração e homologação dos seis fluxos n8n](automacao-n8n.md).
- Migrações compartilhadas somente neste repositório; PAM Nexus consome os campos em `exames`, abre anexos privados com sessão e oferece o link para este painel.

Comandos reproduzíveis:

```sh
npm ci
npm run test:exames
npm run build
npx --yes deno@2.9.6 check supabase/functions/exam-document-service/index.ts
```

Validação local: 40 cenários SQL, 14 cenários do handler Edge, 18 verificações de contrato/grafo/binário n8n, 16 regressões de componentes/hook do acompanhamento e 20 redirects. O conjunto SQL usa PostgreSQL em PGlite; testes de interface usam TS real com adaptadores isolados. Isso não comprova importação n8n, múltiplas conexões PostgreSQL, OAuth, status do provedor, entrega de mensagens ou anexação real. O PAM Nexus possui mais 11 testes específicos de acesso a arquivos e versões. Build local aprovado; aviso de chunk grande permanece.

## Antes de ativar

1. Corrigir a credencial de serviço encontrada no export legado e atualizar seus consumidores. Remoção do export não revoga um segredo publicado anteriormente. Não reescrever histórico ou trocar a chave compartilhada sem coordenar os consumidores.
2. Conferir ambiente real, importador legado ativo, equipe/IDs Auth, papéis, endereço n8n e credenciais selecionadas, Drive privado, Chatwoot fazer.ai/Baileys e conversa do grupo de teste.
3. Homologar migrações/Edge/duas interfaces juntas antes de restringir a RPC legada. Não aplicar a mesma migração pelo Nexus. Definições, permissões e políticas anteriores devem ser guardadas em snapshot privado.
4. Habilitar Drive/processamento com PDF sintético; validar hash e duplicatas, upload manual, revisão e acesso autorizado/outsider. Habilitar grupo e Nexus só depois dos testes dos respectivos destinos.
5. Registrar marco de corte e substituir o importador anterior sem processar a mesma janela em paralelo. Só então ativar a recepção operacional.
6. EXAMES-06 permanece desativado: captura automática WhatsApp requer payload/filtros Lua/Téo e replay durável antes de staging; EXAMES-05 não baixa novamente anexos originais do Chatwoot nesta versão. Até essa homologação, usar upload manual para arquivos recebidos somente por WhatsApp.

IDs reais, contas, grupo, chaves, PDFs e evidências clínicas não devem entrar neste repositório nem nos exports. A configuração auditada de conexão fica em documentação privada da implantação.
