#!/bin/bash
# =============================================================
# Scripts de Teste End-to-End para PAM Exam Monitor
# =============================================================
#
# Uso:
#   export SUPABASE_URL="https://jvgquuahsxepphhxmshk.supabase.co"
#   export SUPABASE_SERVICE_KEY="sua-service-role-key"
#   export WEBHOOK_API_KEY="sua-webhook-api-key"
#   bash scripts/test-integration.sh
#
# =============================================================

SUPABASE_URL="${SUPABASE_URL:-https://jvgquuahsxepphhxmshk.supabase.co}"
SERVICE_KEY="${SUPABASE_SERVICE_KEY}"
WEBHOOK_KEY="${WEBHOOK_API_KEY}"

if [ -z "$SERVICE_KEY" ]; then
  echo "❌ SUPABASE_SERVICE_KEY não configurada"
  exit 1
fi

if [ -z "$WEBHOOK_KEY" ]; then
  echo "❌ WEBHOOK_API_KEY não configurada"
  exit 1
fi

echo "============================================"
echo "  PAM Exam Monitor - Testes de Integração"
echo "============================================"
echo ""

# ----- TESTE 1: Simular venda criando exam_tracking -----
echo "📋 TESTE 1: Simulando venda (INSERT em exam_tracking)"
echo "   Isso testa o trigger bridge_tracking_to_card"
echo ""

RESULT=$(curl -s -X POST \
  "$SUPABASE_URL/rest/v1/exam_tracking" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{
    "origin": "venda",
    "sale_id": "test-sale-001",
    "sale_product_name": "Hemograma Completo",
    "exam_type": "Hemograma Completo",
    "pet_name_parsed": "Luna",
    "client_name_parsed": "Maria Silva",
    "status": "aguardando_resultado",
    "email_received_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }')

echo "   Resposta: $RESULT"
echo ""

# Verifica se exam_card foi criado
sleep 1
CARD=$(curl -s -X GET \
  "$SUPABASE_URL/rest/v1/exam_card?sale_id=eq.test-sale-001&select=id,status,pet_name,origin" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY")

echo "   Card criado: $CARD"

if echo "$CARD" | grep -q "aguardando_lab"; then
  echo "   ✅ TESTE 1 PASSOU: Card criado com status aguardando_lab"
else
  echo "   ❌ TESTE 1 FALHOU: Card não encontrado ou status incorreto"
fi
echo ""

# ----- TESTE 2: Simular email de resultado (webhook) -----
echo "📧 TESTE 2: Simulando resultado de email (webhook-email-result)"
echo ""

WEBHOOK_RESULT=$(curl -s -X POST \
  "$SUPABASE_URL/functions/v1/webhook-email-result" \
  -H "Authorization: Bearer $WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "pet_name": "Luna",
    "exam_type": "Hemograma Completo",
    "lab_name": "PetLab",
    "received_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }')

echo "   Resposta: $WEBHOOK_RESULT"

if echo "$WEBHOOK_RESULT" | grep -q '"matched":true'; then
  echo "   ✅ TESTE 2 PASSOU: Match encontrado!"
elif echo "$WEBHOOK_RESULT" | grep -q '"matched":false'; then
  echo "   ⚠️  TESTE 2: Sem match (card órfão criado)"
else
  echo "   ❌ TESTE 2 FALHOU: Resposta inesperada"
fi
echo ""

# Verifica status do card
sleep 1
CARD_AFTER=$(curl -s -X GET \
  "$SUPABASE_URL/rest/v1/exam_card?sale_id=eq.test-sale-001&select=id,status" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY")

echo "   Card após resultado: $CARD_AFTER"

if echo "$CARD_AFTER" | grep -q "exame_pronto"; then
  echo "   ✅ Status mudou para exame_pronto (trigger funcionou!)"
else
  echo "   ⚠️  Status pode não ter mudado (verificar trigger handle_exam_item_update)"
fi
echo ""

# ----- TESTE 3: Testar idempotência -----
echo "🔄 TESTE 3: Testando idempotência (mesmo email duas vezes)"
echo ""

IDEM_RESULT=$(curl -s -X POST \
  "$SUPABASE_URL/functions/v1/webhook-email-result" \
  -H "Authorization: Bearer $WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "pet_name": "Luna",
    "exam_type": "Hemograma Completo",
    "lab_name": "PetLab"
  }')

echo "   Resposta: $IDEM_RESULT"

# Não deveria ter criado duplicata
CARDS_COUNT=$(curl -s -X GET \
  "$SUPABASE_URL/rest/v1/exam_card?sale_id=eq.test-sale-001&select=id" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Prefer: count=exact")

echo "   Cards com sale_id test-sale-001: $CARDS_COUNT"
echo ""

# ----- TESTE 4: Testar card órfão -----
echo "👻 TESTE 4: Testando criação de card órfão (sem match)"
echo ""

ORPHAN_RESULT=$(curl -s -X POST \
  "$SUPABASE_URL/functions/v1/webhook-email-result" \
  -H "Authorization: Bearer $WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "pet_name": "NomeQueNaoExiste123",
    "exam_type": "Exame Inexistente",
    "lab_name": "LabFake"
  }')

echo "   Resposta: $ORPHAN_RESULT"

if echo "$ORPHAN_RESULT" | grep -q '"match_type":"orphan"'; then
  echo "   ✅ TESTE 4 PASSOU: Card órfão criado corretamente"
else
  echo "   ❌ TESTE 4 FALHOU"
fi
echo ""

# ----- TESTE 5: Testar autenticação -----
echo "🔒 TESTE 5: Testando autenticação (sem API key)"
echo ""

AUTH_RESULT=$(curl -s -X POST \
  "$SUPABASE_URL/functions/v1/webhook-email-result" \
  -H "Content-Type: application/json" \
  -d '{"pet_name": "Test"}')

echo "   Resposta: $AUTH_RESULT"

if echo "$AUTH_RESULT" | grep -q "Unauthorized"; then
  echo "   ✅ TESTE 5 PASSOU: Request sem key foi rejeitado"
else
  echo "   ❌ TESTE 5 FALHOU: Request sem key não foi rejeitado"
fi
echo ""

# ----- CLEANUP -----
echo "🧹 LIMPEZA: Removendo dados de teste"
echo ""

# Remove card de teste
curl -s -X DELETE \
  "$SUPABASE_URL/rest/v1/exam_card?sale_id=eq.test-sale-001" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY" > /dev/null

# Remove exam_tracking de teste
curl -s -X DELETE \
  "$SUPABASE_URL/rest/v1/exam_tracking?sale_id=eq.test-sale-001" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY" > /dev/null

# Remove órfão de teste
curl -s -X DELETE \
  "$SUPABASE_URL/rest/v1/exam_card?pet_name=eq.NomeQueNaoExiste123" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY" > /dev/null

echo "   ✅ Dados de teste removidos"
echo ""
echo "============================================"
echo "  Testes finalizados!"
echo "============================================"
