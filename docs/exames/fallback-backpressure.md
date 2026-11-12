# Proteção do fallback durante indisponibilidade

O fallback continua agendado a cada minuto. Quando o banco ou a consulta ao provedor apresenta falha transitória, o processamento encerra a rodada e aguarda antes de começar outra. O agendamento não é desligado, o fluxo principal permanece prioritário e as pendências conservam seus próprios prazos e recibos.

## Pausa e retomada

- O singleton `exam_fallback_runtime` guarda falhas consecutivas e `cooldown_until`. As pausas nominais são 1, 2, 4, 8 e 15 minutos, com pequena variação positiva limitada ao teto de 15 minutos; a próxima execução ocorre no primeiro minuto elegível do cron.
- A lease existente permite apenas uma rodada de recuperação. Um checkpoint saudável, inclusive de uma varredura parcial sem erro, encerra a pausa. Um HTTP 200 sem checkpoint saudável não encerra o circuito.
- Cada nonce identifica a requisição do scheduler. Falhas anteriores ao claim, perda do checkpoint e timeout HTTP são reconciliados por status/timeout do `pg_net`; a mesma requisição não incrementa a contagem duas vezes. O código não lê conteúdo clínico nem cabeçalhos dessa resposta.
- A função Edge sai da rodada ao detectar falha geral, sem tentar o próximo item nem registrar uma cascata de eventos por item. Há no máximo uma tentativa curta de checkpoint; se ela falhar, o scheduler observa o resultado da requisição.
- Conflitos de negócio `PT409`, falta de autorização e erros de um PDF não são classificados como indisponibilidade geral. Erros nativos transitórios, como serialização `40001`, não são convertidos em conflitos determinísticos.

## Redução de chamadas repetidas

As varreduras recentes e históricas continuam sobrepostas para encontrar anexos tardios. Antes de acessar o banco, as origens são unidas por canal, conta, mensagem e anexo. O envio ao banco usa lotes limitados; a marca de progresso só avança depois da confirmação integral de todos os lotes.

`exam_fallback_discovery_ack` guarda apenas a identidade da origem, sua impressão digital e a classificação do resultado. A impressão digital exclui a URL assinada e inclui os metadados estáveis. URLs atuais ficam somente na memória da rodada. Uma origem inalterada já confirmada não repete a reserva e o enfileiramento; a fila pendente continua sendo consultada e a reconciliação de entregas incertas continua somente por leitura do provedor.

O cache não concede autorização: a função verifica o escopo atual antes de utilizá-lo. Mudanças de anexos, disponibilidade da mídia e reclassificação humana precisam continuar elegíveis. A confirmação do cache e o enfileiramento pertencem à mesma transação; uma resposta perdida pode ser repetida sem avançar indevidamente o cursor.

## Publicação

1. Aplicar `20261112020832_exam_fallback_backpressure.sql` e `20261112020843_exam_fallback_discovery_dedupe.sql`, nessa ordem. As funções anteriores continuam disponíveis durante a transição.
2. Publicar o bundle completo de `exam-whatsapp-fallback`, incluindo dependências relativas. Preservar `verify_jwt=false`: esta função exige Bearer dedicado ou HMAC com nonce de uso único no próprio handler.
3. Não reinstalar o arquivo completo `exam-whatsapp-fallback-scheduler.sql` na produção existente: o instalador original deixa o cron inativo. A migração de proteção substitui as funções necessárias sem mudar a atividade do cron, configurações ou cutoff.
4. Relê-las em produção, comparar configurações e observar ciclos naturais. Não criar exames nem forçar reenvios para validar a implantação.

## Conferência e reversão

Consultar somente estado agregado do runtime, cron e cache, sem expor chaves ou conteúdo clínico. Confirmar execuções saudáveis, crescimento inicial dos acknowledgements seguido de reaproveitamento e ausência de falhas das novas RPCs. A pausa deve ser exercitada nos testes com respostas sintéticas, não provocando indisponibilidade real.

`supabase/operations/exam-fallback-backpressure-rollback.sql` desabilita somente a pausa automática por uma flag e preserva o histórico. Para reverter também a redução de chamadas, republicar os arquivos da versão anterior da Edge Function; as estruturas adicionais podem permanecer sem uso. Não apagar fila, cache, recibos, documentos ou originais como procedimento de reversão.

Essa proteção reduz trabalho desnecessário e tentativas durante falhas. Ela não demonstra a causa da indisponibilidade de 11/11/2026 nem garante isolamento completo de aplicações que compartilham o mesmo PostgreSQL.
