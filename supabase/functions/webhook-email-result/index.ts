import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { validateApiKey } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase-client.ts";
import {
  findBestMatch,
  type EmailData,
  type CardCandidate,
} from "../_shared/matcher.ts";

serve(async (req: Request) => {
  // CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Apenas POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Autenticação
  if (!validateApiKey(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const startTime = Date.now();

    // Valida payload mínimo
    if (!body.pet_name && !body.exam_type && !body.lab_name) {
      return new Response(
        JSON.stringify({
          error: "Payload inválido: precisa de pelo menos pet_name, exam_type ou lab_name",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const emailData: EmailData = {
      pet_name: body.pet_name,
      exam_type: body.exam_type,
      lab_name: body.lab_name,
      arquivo_url: body.arquivo_url,
      received_at: body.received_at || new Date().toISOString(),
    };

    const supabase = getServiceClient();

    // Busca cards em aguardando_lab com items pendentes
    const { data: cards, error: queryError } = await supabase
      .from("exam_card")
      .select(
        `
        id,
        pet_name,
        exam_item!inner (
          id,
          exam_type,
          lab_name,
          result_received
        )
      `
      )
      .eq("status", "aguardando_lab")
      .eq("exam_item.result_received", false);

    if (queryError) {
      console.error("Query error:", queryError);
      return new Response(
        JSON.stringify({ error: "Erro ao buscar cards", details: queryError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Monta lista de candidatos (1 entrada por item pendente)
    const candidates: CardCandidate[] = [];
    for (const card of cards || []) {
      const items = Array.isArray(card.exam_item)
        ? card.exam_item
        : [card.exam_item];
      for (const item of items) {
        if (!item.result_received) {
          candidates.push({
            card_id: card.id,
            pet_name: card.pet_name,
            item_id: item.id,
            exam_type: item.exam_type,
            lab_name: item.lab_name,
          });
        }
      }
    }

    console.log(
      `[webhook-email-result] ${candidates.length} candidatos encontrados para matching`
    );

    // Tenta matching
    const match = findBestMatch(candidates, emailData);

    if (match) {
      // Match encontrado → atualiza exam_item
      const { error: updateError } = await supabase
        .from("exam_item")
        .update({
          result_received: true,
          result_received_at: emailData.received_at,
          arquivo_url: emailData.arquivo_url || null,
        })
        .eq("id", match.item_id)
        .eq("result_received", false); // Idempotência

      if (updateError) {
        console.error("Update error:", updateError);
        return new Response(
          JSON.stringify({ error: "Erro ao atualizar item", details: updateError.message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // O trigger handle_exam_item_update() cuida da mudança de status do card

      const duration = Date.now() - startTime;
      console.log(
        `[webhook-email-result] Match: card=${match.card_id} item=${match.item_id} score=${match.score} type=${match.match_type} (${duration}ms)`
      );

      return new Response(
        JSON.stringify({
          matched: true,
          card_id: match.card_id,
          item_id: match.item_id,
          score: match.score,
          match_type: match.match_type,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Sem match → cria card órfão
    console.log("[webhook-email-result] Sem match, criando card órfão");

    const { data: orphanCard, error: orphanError } = await supabase
      .from("exam_card")
      .insert({
        status: "aguardando_lab",
        alert_level: "warning",
        origin: "email",
        is_orphan: true,
        pet_name: emailData.pet_name || null,
      })
      .select("id")
      .single();

    if (orphanError) {
      console.error("Orphan creation error:", orphanError);
      return new Response(
        JSON.stringify({ error: "Erro ao criar card órfão", details: orphanError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Cria exam_item para o órfão
    await supabase.from("exam_item").insert({
      exam_card_id: orphanCard.id,
      exam_type: emailData.exam_type || "Exame",
      lab_name: emailData.lab_name || null,
      arquivo_url: emailData.arquivo_url || null,
      result_received: true,
      result_received_at: emailData.received_at,
    });

    // Log
    await supabase.from("exam_card_log").insert({
      exam_card_id: orphanCard.id,
      previous_status: null,
      new_status: "aguardando_lab",
      changed_by: "webhook",
      change_reason:
        "Email de resultado sem match — card órfão criado para triagem manual",
    });

    const duration = Date.now() - startTime;
    console.log(
      `[webhook-email-result] Órfão criado: card=${orphanCard.id} (${duration}ms)`
    );

    return new Response(
      JSON.stringify({
        matched: false,
        card_id: orphanCard.id,
        match_type: "orphan",
      }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[webhook-email-result] Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno", details: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
