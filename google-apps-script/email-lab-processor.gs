/**
 * PAM Exam Monitor — Email Lab Processor
 *
 * Google Apps Script que substitui o workflow n8n.
 * Roda a cada 15 minutos, lê emails com PDF de labs veterinários,
 * extrai dados via OpenAI e atualiza o dashboard via Supabase RPC.
 *
 * Setup:
 * 1. Abra script.google.com → Novo Projeto
 * 2. Cole este código inteiro
 * 3. Vá em Configurações do Projeto → Propriedades do Script → adicione:
 *    - OPENAI_API_KEY: sua chave da OpenAI
 *    - SUPABASE_URL: https://jvgquuahsxepphhxmshk.supabase.co
 *    - SUPABASE_SERVICE_ROLE_KEY: sua service role key
 * 4. Execute processNewEmails() manualmente uma vez para autorizar
 * 5. Vá em Triggers → Adicionar Trigger:
 *    - Função: processNewEmails
 *    - Evento: Time-driven → Minutes timer → Every 15 minutes
 */

// ============================================================
// CONFIGURAÇÃO
// ============================================================

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    OPENAI_API_KEY: props.getProperty('OPENAI_API_KEY'),
    SUPABASE_URL: props.getProperty('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: props.getProperty('SUPABASE_SERVICE_ROLE_KEY'),
    LABEL_PROCESSADO: 'pam-processado',
    OPENAI_MODEL: 'gpt-4.1-mini',
    MAX_EMAILS_PER_RUN: 10
  };
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================

function processNewEmails() {
  const config = getConfig();

  // Validar configuração
  if (!config.OPENAI_API_KEY || !config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    Logger.log('ERRO: Configure as Script Properties (OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
    return;
  }

  // Criar label se não existir
  let label = GmailApp.getUserLabelByName(config.LABEL_PROCESSADO);
  if (!label) {
    label = GmailApp.createLabel(config.LABEL_PROCESSADO);
    Logger.log('Label "' + config.LABEL_PROCESSADO + '" criada');
  }

  // Buscar emails não processados com anexo
  const query = 'has:attachment -label:' + config.LABEL_PROCESSADO;
  const threads = GmailApp.search(query, 0, config.MAX_EMAILS_PER_RUN);

  Logger.log('Encontrados ' + threads.length + ' threads não processados');

  for (const thread of threads) {
    const messages = thread.getMessages();

    for (const message of messages) {
      try {
        processMessage(message, config);
      } catch (error) {
        Logger.log('ERRO ao processar email "' + message.getSubject() + '": ' + error.message);
      }
    }

    // Marcar thread como processado
    thread.addLabel(label);
  }

  Logger.log('Processamento concluído');
}

// ============================================================
// PROCESSAR UM EMAIL
// ============================================================

function processMessage(message, config) {
  const subject = message.getSubject();
  const from = message.getFrom();
  const body = message.getPlainBody() || '';
  const date = message.getDate();

  Logger.log('Processando: "' + subject + '" de ' + from);

  // Extrair texto dos PDFs anexados
  const pdfText = extractPdfText(message);

  // Se não tem PDF e o corpo é vazio, provavelmente não é email de lab
  if (!pdfText && body.length < 50) {
    Logger.log('  → Sem PDF e corpo vazio, ignorando');
    return;
  }

  // Chamar OpenAI para parsear
  const parsed = parseWithOpenAI(config, {
    subject: subject,
    from: from,
    body: body,
    pdfText: pdfText
  });

  if (!parsed) {
    Logger.log('  → OpenAI não retornou dados válidos');
    return;
  }

  // Se não tem pet_name E não tem exam_type, não é resultado de exame
  if (!parsed.pet_name && !parsed.exam_type) {
    Logger.log('  → Sem nome do pet e sem tipo de exame, ignorando');
    return;
  }

  Logger.log('  → Dados extraídos: ' + JSON.stringify(parsed));

  // Chamar Supabase RPC para atualizar exam_card
  const result = callSupabaseRPC(config, {
    p_pet_name: parsed.pet_name || null,
    p_client_name: parsed.client_name || null,
    p_exam_type: parsed.exam_type || null,
    p_lab_name: parsed.lab_name || null,
    p_received_at: date.toISOString()
  });

  Logger.log('  → Supabase RPC: ' + JSON.stringify(result));
}

// ============================================================
// EXTRAIR TEXTO DO PDF
// ============================================================

function extractPdfText(message) {
  const attachments = message.getAttachments();

  if (!attachments || attachments.length === 0) {
    return '';
  }

  let allText = '';

  for (const attachment of attachments) {
    const mimeType = attachment.getContentType();
    const fileName = attachment.getName();

    // Processar apenas PDFs
    if (mimeType !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
      continue;
    }

    Logger.log('  → Extraindo PDF: ' + fileName);

    try {
      // Método: Usar Google Drive OCR para converter PDF em texto
      const blob = attachment.copyBlob();

      // Criar arquivo temporário no Drive
      const tempFile = DriveApp.createFile(blob);

      // Converter para Google Doc usando OCR do Drive
      const docFile = Drive.Files.copy(
        { title: 'temp-pdf-extract', mimeType: 'application/vnd.google-apps.document' },
        tempFile.getId(),
        { ocr: true }
      );

      // Extrair texto do Google Doc
      const doc = DocumentApp.openById(docFile.id);
      const text = doc.getBody().getText();

      allText += text + '\n\n';

      // Limpar arquivos temporários
      DriveApp.getFileById(docFile.id).setTrashed(true);
      tempFile.setTrashed(true);

      Logger.log('  → PDF extraído: ' + text.substring(0, 100) + '...');
    } catch (error) {
      Logger.log('  → ERRO extraindo PDF "' + fileName + '": ' + error.message);

      // Fallback: tentar ler como texto simples
      try {
        const textContent = attachment.getDataAsString();
        if (textContent && textContent.length > 50) {
          allText += textContent + '\n\n';
        }
      } catch (e) {
        // PDF binário não pode ser lido como texto
      }
    }
  }

  return allText.trim();
}

// ============================================================
// CHAMAR OPENAI
// ============================================================

function parseWithOpenAI(config, emailData) {
  const systemPrompt = [
    'Você é um assistente que extrai informações de emails de laboratórios veterinários.',
    'Os resultados podem estar no corpo do email OU no PDF anexado (ou em ambos).',
    'Priorize as informações do PDF quando disponível, pois geralmente é mais completo.',
    'Se o email não for de um laboratório veterinário, retorne todos os campos como null.',
    'Retorne APENAS um objeto JSON válido, sem markdown, sem explicações.'
  ].join('\n');

  const userPrompt = [
    'Extraia os seguintes dados deste email de laboratório veterinário:',
    '- pet_name: nome do animal',
    '- client_name: nome do tutor/proprietário/responsável',
    '- exam_type: tipo de exame (ex: Hemograma, Bioquímico, Urinálise, Ultrassom, Raio-X, Citologia, etc.)',
    '- lab_name: nome do laboratório',
    '',
    'Assunto: ' + emailData.subject,
    'De: ' + emailData.from,
    '',
    'Corpo do email:',
    emailData.body || '(vazio)',
    '',
    'Texto extraído do PDF anexado:',
    emailData.pdfText || 'Nenhum PDF anexado',
    '',
    'Retorne SOMENTE o JSON, exemplo: {"pet_name": "Rex", "client_name": "Maria Silva", "exam_type": "Hemograma", "lab_name": "VetLab SP"}'
  ].join('\n');

  try {
    const response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + config.OPENAI_API_KEY
      },
      payload: JSON.stringify({
        model: config.OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1
      }),
      muteHttpExceptions: true
    });

    const statusCode = response.getResponseCode();
    if (statusCode !== 200) {
      Logger.log('  → OpenAI erro HTTP ' + statusCode + ': ' + response.getContentText());
      return null;
    }

    const data = JSON.parse(response.getContentText());
    const content = data.choices[0].message.content;

    // Limpar possível markdown
    const cleaned = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    return JSON.parse(cleaned);
  } catch (error) {
    Logger.log('  → ERRO OpenAI: ' + error.message);
    return null;
  }
}

// ============================================================
// CHAMAR SUPABASE RPC
// ============================================================

function callSupabaseRPC(config, params) {
  try {
    const response = UrlFetchApp.fetch(
      config.SUPABASE_URL + '/rest/v1/rpc/receive_email_result',
      {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'apikey': config.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + config.SUPABASE_SERVICE_ROLE_KEY
        },
        payload: JSON.stringify(params),
        muteHttpExceptions: true
      }
    );

    const statusCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (statusCode >= 200 && statusCode < 300) {
      try {
        return JSON.parse(responseText);
      } catch (e) {
        return { success: true, raw: responseText };
      }
    } else {
      Logger.log('  → Supabase erro HTTP ' + statusCode + ': ' + responseText);
      return { success: false, error: responseText };
    }
  } catch (error) {
    Logger.log('  → ERRO Supabase: ' + error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

/**
 * Execução manual para teste — processa apenas o email mais recente
 */
function testWithLatestEmail() {
  const config = getConfig();

  if (!config.OPENAI_API_KEY || !config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    Logger.log('ERRO: Configure as Script Properties primeiro');
    return;
  }

  const threads = GmailApp.search('has:attachment', 0, 1);
  if (threads.length === 0) {
    Logger.log('Nenhum email com anexo encontrado');
    return;
  }

  const message = threads[0].getMessages().pop(); // último message da thread
  Logger.log('Testando com: "' + message.getSubject() + '"');

  processMessage(message, config);
}

/**
 * Limpar label de processado (para re-processar tudo)
 */
function resetProcessedLabel() {
  const label = GmailApp.getUserLabelByName('pam-processado');
  if (!label) {
    Logger.log('Label não encontrada');
    return;
  }

  const threads = label.getThreads();
  Logger.log('Removendo label de ' + threads.length + ' threads');

  for (const thread of threads) {
    thread.removeLabel(label);
  }

  Logger.log('Labels removidas');
}
