# PamVet Exam Monitor

Sistema de monitoramento de exames laboratoriais veterinários para a clínica PamVet. Centraliza o acompanhamento de exames desde o pedido até a entrega do resultado ao tutor.

## Stack

- **Frontend**: React 18 + TypeScript + Vite
- **UI**: Tailwind CSS + Framer Motion + Lucide Icons
- **State**: TanStack Query (React Query)
- **Backend**: Supabase (PostgreSQL + Auth + RLS + RPCs)
- **Automação**: Google Apps Script (processamento de emails de lab)

## Funcionalidades

### Dashboard
- Visão geral com contadores por status (aguardando laboratório, exame pronto, exames no grupo, contato realizado); o alerta de atraso aparece após 24 horas no grupo
- Cards com avatar do veterinário responsável
- Filtros por período, veterinário e busca textual

### Kanban de Exames (Tracking)
- Board com 4 colunas: Aguardando Lab / Exame Pronto / Atrasado / Contato Realizado
- Visualização em board ou tabela
- Detalhe do card com histórico, edição e ações rápidas
- Botão "Concluir contato" com vet pré-selecionado e timestamp automático

### Fusão de Cards (Merge)
- Fusão manual de cards órfãos com cards de venda
- Detecção automática de direção (qual card é o "keeper")
- Deduplicação de items na fusão (remove item sem resultado quando existe com resultado)
- Disponível em qualquer card ativo (exceto contato realizado)

### Envio de Amostras (Ship Samples)
- Registro de envio de amostras ao laboratório
- Seleção múltipla de exames pendentes
- Histórico de envios com filtros por data

### Matching Automático de Resultados
- **Google Apps Script** roda a cada 15 min, lê emails com PDF de labs veterinários
- **OpenAI (gpt-4.1-mini)** extrai pet_name, client_name, exam_type e lab_name do email/PDF
- **RPC `receive_email_result`** faz matching em 3 fases:
  - **Fase 1**: Match por item (pet + tutor + exam_type + lab_name, threshold 50pts)
  - **Fase 2**: Match por card (pet + tutor, threshold 70pts) — adiciona novo item ao card existente
  - **Fase 3**: Sem match — cria card órfão como "Exame Pronto" para triagem manual

### Sistema de Scoring (Matching)

| Campo        | Match exato | Match parcial |
|--------------|-------------|---------------|
| pet_name     | +40 pts     | +35 pts       |
| client_name  | +40 pts     | +30 pts       |
| exam_type    | +30 pts     | +25 pts       |
| lab_name     | +20 pts     | +15 pts       |
| Candidato unico | +10 pts bonus | —          |

## Fluxo de Dados

```
PamNexus (ERP) ──venda──> Supabase (exam_card + exam_items)
                                ↓
                          status: aguardando_lab
                                ↓
Lab (email com PDF) ──> Gmail ──> Google Apps Script ──> OpenAI ──> RPC receive_email_result
                                                                        ↓
                                                              Match? → atualiza item existente
                                                              Sem match? → card órfão (exame_pronto)
                                                                        ↓
                                                              Dashboard atualiza em tempo real
                                                                        ↓
                                                              Recepção contata tutor ──> contato_realizado
```

## Setup Local

```bash
npm install
npm run dev
```

Variáveis de ambiente (`.env`):
```
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

## Migrações SQL

As migrações ficam em `supabase/migrations/` e devem ser executadas no Supabase SQL Editor:

| Arquivo | Descrição |
|---------|-----------|
| `20260324000002_rpc_receive_email_result.sql` | RPC de matching automático (3 fases) |
| `20260327000001_lab_shipment_and_history.sql` | Tabela de envios ao lab + campos em exam_item |
| `20260327000002_merge_exam_cards.sql` | RPC de fusão de cards |

## Changelog Recente

### 2026-03-29
- **fix**: Matching agora busca em cards com status `aguardando_lab`, `exame_pronto` E `atrasado` (antes só buscava em `aguardando_lab`, causando duplicação)
- **fix**: Cards órfãos de email nascem como `exame_pronto` (nunca `aguardando_lab`, pois o resultado já chegou)
- **fix**: Proteção anti-duplicata na Fase 2 — verifica se item idêntico já existe antes de criar

### 2026-03-28
- **feat**: Parâmetro `client_name` adicionado ao matching (pet + tutor = identificação precisa)
- **fix**: MergeCardModal referenciando `isOrphan` inexistente → `card.is_orphan`

### 2026-03-27
- **feat**: Fusão/merge de cards com deduplicação automática
- **feat**: Fase 2 de matching por card (pet_name no nível do card)
- **feat**: Envio de amostras ao lab com histórico
- **feat**: Botão "Concluir contato" com vet pré-selecionado
- **fix**: Dropdown de veterinários no modal de edição
- **fix**: Avatares dos vets nos cards do kanban
