# Guia: Workflows N8n — Integração Completa com PAM Exam Monitor

## Visão Geral dos Workflows

Existem **2 workflows** que juntos formam o pipeline de exames:

| Workflow | Arquivo | Função |
|----------|---------|--------|
| **Email Lab Intake** | `n8n/workflow-email-result.json` | Recebe emails de labs, parseia com IA, sincroniza com exam_tracking + exam_card |
| **Orchestrator** | (no n8n) | Cron 15min: monitora pendências, detecta conversas no Chatwoot, alerta Pamela via WhatsApp |

---

## Workflow 1: Email Lab Intake

### Fluxo completo

```
Gmail IMAP (novo email)
  ↓
Config (URLs + keys)
  ↓
Supabase - Check Duplicate (via email_message_id)
  ↓
IF - Is New Email?
  ↓ (sim)
Extract PDF Text                        ← extrai texto do PDF anexado (continua mesmo sem PDF)
  ↓
OpenAI GPT-4.1 - Parse Email           ← recebe: assunto + corpo do email + texto do PDF
  ↓
Code - Extract Parsed Data
  ├─→ Supabase RPC - Update Exam Card  ← atualiza dashboard PAM
  └─→ Supabase - Match Existing Sale   ← fluxo exam_tracking
        ↓
      IF - Sale Match Found?
        ├─→ (sim) Supabase - Update Sale Tracking → Code - Resolve Tracking ID → Insert Log
        └─→ (não) Match Pet by Name → Prepare Insert → Insert New Tracking → Resolve Tracking ID → Insert Log
```

### O que o node novo faz

**"Supabase RPC - Update Exam Card"** chama a função `receive_email_result` no banco:

- Se existe um `exam_card` com status `aguardando_lab` e o pet/exame bate (score ≥ 50pts): marca o `exam_item` como `result_received = true` → card passa para `exame_pronto` no dashboard
- Se não há match: cria um card **órfão** no dashboard para triagem manual

O scoring funciona assim:

| Campo | Match exato | Match parcial |
|-------|-------------|---------------|
| pet_name | +40pts | +35pts |
| client_name | +25pts | +20pts |
| exam_type | +30pts | +25pts |
| lab_name | +20pts | +15pts |
| Único candidato | +10pts bônus | — |

**Threshold**: 50pts mínimo para considerar match.

---

## Importar o Workflow 1

1. No n8n: **Workflows → Import from File**
2. Selecione `n8n/workflow-email-result.json`
3. As credenciais existentes (IMAP e OpenAI) serão reconhecidas pelo ID
4. Ative o workflow

> Se você já tinha uma versão anterior, use **"Import"** para substituir (não cria duplicata se o instanceId bater).

---

## Credenciais necessárias

| Credencial | Tipo | Onde configurar |
|------------|------|-----------------|
| `IMAP account` (id: 1hFWIlvGPS81c5AU) | IMAP | Já configurada |
| `OpenAi account` (id: vKBno59QWhuUp1sz) | OpenAI API | Já configurada |
| Service Role Key | Embutida no node Config | Já no JSON |

O novo node "Supabase RPC - Update Exam Card" usa a mesma service role key do Config — **não precisa de nova credencial**.

---

## Testar manualmente (sem email)

No **SQL Editor** do Supabase ou via MCP:

```sql
-- Simula recebimento de resultado (substitua pelos dados reais)
SELECT receive_email_result(
  p_pet_name    := 'Barney',
  p_client_name := 'Ana Costa',
  p_exam_type   := 'Hemograma',
  p_lab_name    := 'PetLab',
  p_received_at := now()
);
```

Resposta de match:
```json
{ "success": true, "matched": true, "score": 95, "match_type": "exact" }
```

Resposta de card órfão criado:
```json
{ "success": true, "matched": false, "match_type": "orphan", "score": 20 }
```

---

## Workflow 2: Orchestrator (15min)

Monitora `exam_tracking` a cada 15min e:

1. Calcula horas decorridas
2. Conforme status atual, busca no Chatwoot se já houve conversa sobre o exame
3. Progressão automática de status: `recebido → aguardando_contato → em_andamento → enviado`
4. Se há exames `atrasado + critical` e ainda não alertou hoje → envia WhatsApp para Pamela via Chatwoot

> **Nota**: O Orchestrator opera sobre `exam_tracking`. O dashboard PAM opera sobre `exam_card`. Os dois sistemas são complementares: o Orchestrator cuida do CRM/Chatwoot, o dashboard PAM cuida da visualização clínica dos exames.

---

## Troubleshooting

| Problema | Solução |
|----------|---------|
| Card não aparece no dashboard após email | Verificar resposta do node "Supabase RPC - Update Exam Card" — se `matched: false`, o card existe mas sem score suficiente |
| Score baixo (card órfão) | O card pode estar com status diferente de `aguardando_lab`, ou o pet_name não bate. Verificar no dashboard se o card existe |
| Node RPC retorna 401 | A service_role key no Config está correta — verificar se o node usa `$('Config').item.json.SUPABASE_SERVICE_ROLE_KEY` |
| Duplicata de resultado | A RPC é idempotente: se o `exam_item` já tem `result_received=true`, a chamada é ignorada |
| Email não processado | Verificar se o IMAP está autenticado e o Gmail IMAP está ativo na conta Google |
