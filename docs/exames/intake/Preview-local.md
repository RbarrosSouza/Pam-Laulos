# Prévia local da conferência

`npm run dev -- --host 127.0.0.1 --port 5178 --strictPort`

Abra `http://127.0.0.1:5178/dev/intake-preview.html` no navegador interno. Os três cenários são inteiramente fictícios: pendências, nenhuma coleta e filas vazias. A prévia usa somente `IntakeReceiptsView`, sem importar cliente Supabase, autenticação ou consultas de API. O ponto de entrada exige `import.meta.env.DEV` e não é entrada do build de produção.

O cenário sem coleta mantém os avisos de cobertura não comprovada mesmo com as filas zeradas. O cenário com pendências separa inventário completo de originais ainda pendentes, mostra entrega incerta, revisão de versão e limites das listas. O histórico anterior ao corte fica em seção própria. Os links de exames aceitam somente UUIDs validados.

Validação na raiz do repositório:

```sh
node --test scripts/exames/intake/exam-intake-panel.test.mjs
node --test scripts/exames/intake/intake-panel-view.test.mjs
npm run build
```

Esses testes e a prévia não comprovam coletas ou entregas reais em produção. A página autenticada `/recebimentos` requer o contrato da migration25.

A revisão de atualizações possui outra prévia inteiramente fictícia em `http://127.0.0.1:5178/dev/version-review-preview.html`, com papéis clínicos, decisão inconclusiva e original histórico indisponível. Ela não importa o cliente de dados nem executa a liberação. Os detalhes e limites estão em [Version-review.md](Version-review.md).
