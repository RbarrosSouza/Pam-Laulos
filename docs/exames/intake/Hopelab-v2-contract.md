# Hopelab: snapshot por aviso, candidato privado

O preparador está integrado como fonte local. Ele produz candidatos privados; não publica workflows nem executa recuperação de avisos antigos.

## Execução do preparador

```sh
node scripts/exames/intake/hopelab-notice-v2-build.mjs --baseline /caminho/export-gmail-atual.json --policy /caminho/politica-privada.json --out /caminho/novo-diretorio-privado
```

A política contém `cutover` UTC ISO, `replayNoticeIds` (lista explícita de no máximo 20 IDs Gmail) e `backendContract: "hopelab_notice_v2_hold_v1"`. O preparador exige corte recente ou futuro, preserva o objeto `cfg`, todos os ajustes e referências de credenciais. Apenas os corpos Code de `Extrair link Hopelab autorizado` e `Decidir recebimento` mudam. A versão anterior do Code deve corresponder ao retorno conhecido; divergência bloqueia a preparação.

Avisos anteriores ao corte mantêm integralmente a identidade antiga, salvo IDs escolhidos para recuperação. Cada aviso posterior recebe identidade por conta + ID Gmail + hash da URL dentro daquele aviso. A URL segue sendo somente uma relação entre snapshots; nenhuma URL é registrada nos metadados novos.

## Contrato obrigatório do backend

A reserva de uma origem v2 deve retornar, além do contrato atual:

```json
{"hopelab_notice_v2":{"contract":"hopelab_notice_v2_hold_v1","source_id":"UUID real","notice_id":"ID Gmail real","url_sha256":"hash real ou null quando falta link","group_hold_enforced":true}}
```

Sem esse recibo autenticado, o fluxo interrompe a origem antes do GET do PDF. O ACK só pode ser anunciado quando o registro durável de snapshots e o bloqueio de versões alteradas estiverem instalados na mesma transação.

O workflow existente mantém as actions HTTP `reserve_source` e `stage_file`. A rota Edge dessas actions precisa encaminhar, respectivamente, a `reserve_exam_intake_source` e `stage_exam_intake_file`; criar apenas novas actions com nomes diferentes não conecta o preparador às proteções. Os wrappers preservam a resposta antiga para origens sem protocolo v2. Upload manual mantém seu caminho próprio.

O backend deve capturar o `source_id` v2 antes de `stage_file`, que pode transferir a origem ao documento canônico. Serializar por conta e hash da URL; examinar também as origens legadas dessa relação para não tratar a primeira versão v2 como um pedido inteiramente novo. Origem nova não implica exame novo.

- Bytes iguais: associar o novo recibo ao canônico e preservar estados de entrega e bloqueios preexistentes.
- Bytes diferentes em linhagem conhecida, com documento realmente novo: preservar a nova versão, manter revisão pendente e impedir a reserva para grupo antes da decisão explícita.
- Bytes já conhecidos por outro canal: reutilizar o canônico sem reiniciar suas entregas ou inserir um bloqueio que altere seu fluxo anterior.
- Histórico incompleto: manter revisão, sem afirmar igualdade clínica.

O bloqueio deve ser uma condição no `WHERE` da função de reserva para grupo, antes de reclamar a tarefa. Não usar `group_exception_reason`: esse campo significa dispensa legítima e influencia a conclusão do documento. Não alterar entregas anteriores `sent`, `submitted` ou `uncertain`. Não usar `previous_document_id` para ligar pacientes pela URL.

A migração de snapshots e os wrappers de reserva/staging precisam prover esse contrato antes da ativação. Executar o preparador não altera o banco nem a Edge Function.

## Limite clínico e publicação

Hash diferente comprova bytes diferentes. A diferença pode ser técnica ou conter novos analitos, resultados corrigidos, observações ou imagens. Sem comparação clínica comprovada, revisão e aviso são obrigatórios; nunca assumir duplicidade por mesma URL, paciente ou requisição. Preservar cada snapshot e decisão auditada.

Um link mutável consultado hoje não prova o conteúdo que estava disponível no aviso antigo. Para recuperar o caso histórico, comparar o snapshot original já preservado com o novo snapshot; se o original faltar, registrar a limitação.

Antes de publicar: conferir catálogo e permissões; testar ACK antigo ausente, limite de corte, reentrega do mesmo aviso, duas notificações com mesma URL e bytes diferentes, bytes iguais entre canais e preservação de entregas incertas. Atualizar export a partir da versão remota fresca. Ativar apenas com backend compatível e corte explícito; não executar recuperação em massa.

Os testes padrão usam fixtures sintéticas. O teste opcional de compatibilidade com um export privado só lê o arquivo indicado por `EXAM_PRIVATE_GMAIL_EXPORT`; não existe caminho privado embutido nem leitura obrigatória de dados reais. Não colocar exports ou políticas privadas dentro do repositório.
