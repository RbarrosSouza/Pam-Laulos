# Recebimentos — acompanhamento pelo painel

Em 28/10/2026, o usuário definiu que os recebimentos com erro devem ficar visíveis na página de entrada e dispensou avisos operacionais por WhatsApp. O escopo vigente é **painel apenas**: erros, pendências, origens sem comprovação, entregas incertas e versões em revisão permanecem registrados para consulta e tratamento no sistema.

Os coletores e a auditoria de recebimentos continuam com seus próprios limites de cobertura, recibos e checkpoints. Preservação do original, identificação clínica e entrega regular de exames continuam sendo etapas separadas. Esta decisão retira os avisos de falha do escopo; não altera os fluxos existentes de envio dos próprios exames.

## Estado da infraestrutura de avisos

O plano de implantação do supervisor e do relay de WhatsApp foi cancelado antes da ativação. Existiu um projeto Google privado de preparação, mantido com `ENABLED=false` e sem gatilho. O relay não foi instalado, nenhum contêiner foi iniciado e não houve criação de agente Chatwoot ou emissão de capability para esse monitor. A preparação e seus testes locais não constituíram um serviço ativo.

Fontes, testes e manifesto do cliente GAS, junto com o projeto do relay, foram retirados da entrega vigente. O pacote privado de fontes e o commit `50cc22e` preservam a preparação anterior para rastreabilidade. Esse arquivo histórico não constitui autorização para implantar ou ativar os avisos.

## Compatibilidade e dados preservados

As tabelas, recibos, incidentes, snapshots, controles de revisão e registros de outbox já aplicados permanecem preservados. Não há instrução de apagar dados, remover papéis ou desfazer contratos publicados. A existência de uma linha de outbox não comprova envio de aviso nem autoriza um dispatcher.

As actions de saúde e status do backend continuam disponíveis aos chamadores já autorizados para conferir a situação e alimentar o painel. `intake_status` lê saúde e contagens; `intake_health` pode abrir ou resolver incidentes duráveis e não deve ser descrita como leitura neutra. Nenhuma dessas actions envia WhatsApp sozinha. A compatibilidade de autenticação já publicada permanece, sem ativação de credencial ou cliente de avisos.

O painel deve manter visível a ausência de cadastro, progresso ou comprovação. Lista vazia, falha de consulta e varredura incompleta não significam recebimento integral. Uma indisponibilidade completa do backend também impede consultar o painel; não há aviso externo independente contratado neste escopo.

Contratos vigentes: [cobertura do painel](Intake-panel-contract.md), [instalação e preservação do SQL](SQL-installation-and-pause.md), [consulta de origens](source-lookup-contract.md) e [revisão de versões](Version-review.md).
