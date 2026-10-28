# Revisão humana de versões

Migration27 adiciona `get_exam_intake_version_review(uuid)` para membros ativos e complementa `release_exam_intake_hold(uuid,text,text)`, preservando proprietário e ACL da liberação existente. O detalhe de exame mostra o estado, a razão do bloqueio e os links locais dos originais atual e anterior. A captura automática de um primeiro original não é apresentada como revisão humana.

Somente veterinário ou administrador pode escolher uma decisão. Nenhuma vem selecionada; a pessoa deve confirmar explicitamente a comparação. Códigos aceitos:

- `clinical_complement_confirmed`: complemento clínico confirmado.
- `clinical_correction_confirmed`: correção confirmada.
- `inconclusive`: registra a revisão e mantém a versão retida.

As decisões confirmadas usam o SHA atual esperado e a função clínica existente `mark_exam_document_correction`. Ela continua exigindo originais canônicos preservados com bytes distintos, anterior com paciente confirmado, novo documento ainda sem paciente/vínculo anterior e ausência de ciclo na cadeia. Se essas condições faltarem, a decisão não libera a versão nem muda a relação clínica. A interface mostra o bloqueio; a comparação inconclusiva continua disponível quando o original atual está preservado.

Não há associação clínica automática pela URL do laboratório. Um novo documento já identificado ou anexado não é desvinculado automaticamente para contornar a guarda: esse caso exige regularização específica. Um original histórico não preservado continua sem comprovação; abrir a URL atual não recupera o conteúdo antigo.

A transação confirmada grava `exam_document.previous_document_id`, a decisão e o ator e libera o hold. Não altera originais, SHA, snapshots, fontes ou recibos de entrega, não repete envios sent/submitted/uncertain e não executa registro no cadastro clínico. Repetir a mesma decisão já confirmada é idempotente; trocá-la posteriormente é recusado. A interface não repete uma mutação automaticamente e pede nova leitura após falha ou conflito.

Os eventos `intake_version_reviewed` e `intake_version_review_inconclusive` têm rótulos legíveis no histórico. A comparação do PDF usa as rotas locais autenticadas; nenhum link público do Drive ou token de despacho é retornado pelo RPC.

Validação local:

```sh
node --test supabase/tests/exam-intake-version-review.test.mjs scripts/exames/intake/document-version-review-ui.test.mjs
node scripts/exames/document-detail.test.cjs
npm run build
```

A prévia `http://127.0.0.1:5178/dev/version-review-preview.html` usa apenas dados fictícios e simula a decisão em memória. Ela intercepta os links dos PDFs fictícios e não chama APIs. Abra somente pelo navegador interno. Aplicar migration27 e publicar a interface são etapas separadas; os testes locais não representam revisão ou liberação de um exame real.
