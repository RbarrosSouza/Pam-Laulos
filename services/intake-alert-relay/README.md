# Relay restrito dos alertas de recebimentos

Projeto pronto como fonte para revisão, com Dockerfile/Compose e testes locais. Nenhuma identidade, token, servidor, imagem ou contêiner foi criado; nada foi publicado. O monitor Google continua desativado.

O Apps Script guarda somente `RELAY_CAPABILITY_TOKEN` e a chave limitada do backend. O token nativo do Chatwoot fica exclusivamente neste relay, em arquivo de segredo do host. Depois da aprovação de acesso, usar um agente técnico dedicado, sem privilégio administrativo. A credencial nativa continua sujeita às permissões do Chatwoot; a capability entregue ao Google fica limitada pelos endpoints abaixo. Não há fallback por e-mail.

## Limite concreto de acesso

Conta, inbox, conversa, telefone e canal ficam na configuração do servidor, nunca no corpo enviado pelo monitor. Preencher o destino individual já aprovado na configuração privada; não usar grupo. O relay valida id/inbox/conta/telefone/canal e recusa flags de grupo e JIDs de grupo, broadcast ou newsletter antes de enviar. A associação deve coincidir com os valores privados já conferidos pelo responsável.

| Método/rota | Ação permitida |
| --- | --- |
| `GET /api/v1/accounts/<conta>/conversations/<conversa>` | Identidade mínima do destino configurado. |
| `GET .../messages?before=<id>` | Uma página completa de até 100 mensagens. Somente alertas deste relay têm conteúdo exposto; os demais retornam apenas metadados necessários à paginação. |
| `POST .../messages` | Texto de alerta com prefixo Pam Laudos, até 4096 bytes e correlação `pim-UUID` no atributo e no rodapé. Sempre saída pública, sem anexos. |
| `GET /v1/jobs/pim-UUID` | Estado e recibo do alerta persistido. Não envia nem tenta novamente. |
| `GET /healthz` | Saúde do processo, sem segredos ou chamada ao Chatwoot. |

Todas as rotas de negócio exigem `Authorization: Bearer <capability>`. Conta/conversa diferentes, métodos extras, query arbitrária, destinatário no corpo e anexos são recusados. O relay constrói a URL do provedor a partir de sua configuração, não aceita URL de cliente e não segue redirecionamentos. O token recebido do Google nunca é encaminhado ao Chatwoot. O GET do destino retorna `relay_contract:exam_intake_relay_v1`; o GAS exige esse ACK para não aceitar por engano uma URL nativa Chatwoot.

## Persistência e ACK perdido

SQLite local em volume persistente usa WAL e `synchronous=FULL`. Antes do único POST ao Chatwoot, o alerta é gravado e marcado `started`. A correlação identifica uma solicitação imutável: a mesma correlação com outro texto gera conflito. Qualquer repetição de uma solicitação existente só lê o estado; nunca faz outro POST.

Payloads e recibos ficam criptografados com AES-256-GCM, IV aleatório e AAD vinculada ao identificador do registro. Metadados mínimos de estado/horário e hashes ficam visíveis. A chave de criptografia fica em segredo separado do volume. Reinício converte `reserved/started` em `uncertain`; não há redispatch automático. Chave diferente da usada no volume impede a inicialização.

Somente GET de mensagens com texto/correlação exatos e estado `delivered/read` confirma a entrega. O rodapé permite readback mesmo quando o provedor omite atributos. Divergência entre atributo/rodapé ou recibos diferentes para a mesma correlação exige revisão; confirmação/externalId existentes não são sobrescritos por um ACK POST tardio. Mensagens com estado apenas criado/enviado continuam sem confirmação final.

Não apagar o volume, registros ou Script Properties para “tentar de novo”. Não restaurar snapshot antigo de estado durante operação. Não há rota de reenvio ou limpeza. Uma manutenção de chave/volume exige parada e revisão da evidência; guardar volume e chave separadamente nas cópias privadas.

## Preparação da implantação após aprovação

1. Rever fonte e escopo. Confirmar o agente técnico, o destino individual e o acesso novo antes de emitir credenciais.
2. Fora deste repositório, preparar três arquivos privados distintos: token do agente Chatwoot, capability aleatória forte e chave AES de 32 bytes em hex. Não usar token administrativo nem copiar token Chatwoot para o Google.
3. Copiar `.env.example` para `.env` privado e preencher os valores do destino e caminhos dos segredos. Não preencher variáveis de segredo em claro se a variante `_FILE` estiver configurada.
4. O Compose propõe um único sidecar não root, sistema de arquivos somente leitura, limites de recursos e porta publicada apenas em `127.0.0.1:8182`. O volume nomeado é inicializado a partir de `/data`, pertencente ao usuário `node` da imagem; não usar bind mount sem preparar a mesma propriedade/permissão. O processo grava o banco com modo 0600. No Compose local, secrets podem preservar a propriedade do arquivo do host: preparar arquivos de segredo legíveis pelo UID/GID do usuário `node` da imagem aprovada (normalmente 1000:1000), modo 0400, em diretório privado do host. Não presumir que opções uid/mode de Swarm sejam aplicadas a bind mounts locais. Validar leitura não root e persistência no host antes de ativar o monitor.
5. Integrar ao proxy HTTPS existente do host, com hostname próprio e sem autenticação/header logging contendo tokens. Não expor a porta HTTP diretamente na internet. A implantação real precisa conferir DNS/TLS, propriedade do volume, reinício e caminho do provedor. Nenhum desses recursos foi alterado nesta entrega.
6. Atualizar a fonte GAS a partir de `scripts/exames/intake/intake-monitor.gs`. Usar `RELAY_BASE_URL` e `RELAY_CAPABILITY_TOKEN`; remover propriedades antigas de token nativo Chatwoot. Manter `ENABLED=false` até preflight e confirmação de destino/credenciais.
7. Somente após a aprovação operacional, construir a imagem, iniciar o sidecar e executar a prova controlada de entrega/readback. Fixar o digest da imagem aprovada. O Dockerfile usa Node 24 LTS; o teste local foi feito com Node 22.18 e SQLite nativo, sem dependências npm externas. A imagem Docker não foi construída/testada nesta etapa de fonte.

O relay não depende de n8n, Supabase ou do banco de exames. Precisa do host/provedor Chatwoot para enviar WhatsApp; uma queda desse mesmo host também impede o aviso por esse canal. A única capability permite leitura limitada e alertas para o destino fixo, com limite padrão de 20 solicitações novas por hora. Esse limite pode deixar um aviso bloqueado para revisão, sem provocar reenvio incerto.

## Validação local

```sh
node --test services/intake-alert-relay/server.test.mjs
```

Os testes usam HTTP somente em loopback e um provedor em memória: não enviam WhatsApp nem acessam conta real. Cobrem destino/credencial/rota errados, redirect, ACK perdido, reinício, fence persistente, concorrência, criptografia, conflito, paginação, limites e correlação sem atributos.

Referências: [SQLite nativo Node 24](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [AES-GCM em node:crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html), [usuário da imagem Node](https://github.com/nodejs/docker-node/blob/main/24/bookworm-slim/Dockerfile), [secrets no Compose](https://docs.docker.com/reference/compose-file/services/#secrets). A configuração real da versão/edição do Chatwoot continua uma verificação de implantação, não uma conclusão dos testes offline.
