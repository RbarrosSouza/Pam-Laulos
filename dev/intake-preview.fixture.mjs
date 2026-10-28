// Entirely synthetic. No mailbox, patient, provider or production IDs.
export function intakePreviewFixture(scenario='pending') {
  const at='2026-10-27T21:00:00Z',from='2026-10-27T20:00:00Z',cutoff='2026-10-16T00:00:00Z'
  const docA='11111111-1111-4111-8111-111111111111',docB='22222222-2222-4222-8222-222222222222'
  const summary={notification_cutoff:cutoff,cutoff_configured:true,entries_without_document_total:0,unresolved_origin_total:0,saved_without_group_total:0,group_uncertain_total:0,pending_alert_total:0,version_hold_total:0,received_at_unknown_total:0}
  const value={contract:'exam_intake_panel_v2',as_of:at,summary,collectors:[],entries_without_document_total:0,entries_without_document_has_more:false,entries_without_document:[],unresolved_origin_total:0,unresolved_origins_has_more:false,unresolved_origins:[],saved_without_group_total:0,saved_without_group_has_more:false,saved_without_group:[],group_uncertain_total:0,group_uncertain_has_more:false,group_uncertain:[],pending_alert_total:0,pending_alert_has_more:false,pending_alerts:[],version_hold_total:0,version_hold_has_more:false,version_holds:[],incident_total:0,incident_has_more:false,incidents:[],receipt_total:0,receipt_has_more:false,receipts:[],alerts:[],historical:{cutoff,pre_cutoff_entries_without_document_total:0,pre_cutoff_entries_without_document_has_more:false,pre_cutoff_entries_without_document:[],pre_cutoff_unresolved_origin_total:0,pre_cutoff_unresolved_origins_has_more:false,pre_cutoff_unresolved_origins:[],pre_cutoff_saved_without_group_total:0,pre_cutoff_saved_without_group_has_more:false,pre_cutoff_saved_without_group:[]}}
  if(scenario==='none')return value
  const sweep={id:'fixture-sweep',mode:'audit',status:'committed',received_from:from,received_through:at,started_at:from,finished_at:at,coverageComplete:true,allPreserved:true,scanFinished:true,counts:{messages:7,pages:1,saved:2,excluded:5}}
  const collector={collector_id:'coleta-demonstrativa',provider:'gmail',monitored:false,heartbeat_at:at,progress_at:at,stale_after_seconds:900,last_success_at:at,latest_sweep:sweep,checkpoint:{received_through:null,revision:0}}
  value.collectors=[collector]
  if(scenario==='empty')return value
  value.collectors.push({...collector,collector_id:'outlook-demonstrativo',provider:'outlook',heartbeat_at:from,progress_at:from,last_success_at:null,latest_sweep:{...sweep,status:'failed',coverageComplete:true,allPreserved:false,scanFinished:false,counts:{messages:4,pages:1,saved:1,excluded:0}}},{...collector,collector_id:'whatsapp-demonstrativo',provider:'chatwoot',monitored:false,last_success_at:null,latest_sweep:null})
  const entry={message_id:'mensagem-demonstrativa-01',received_at:from,reason:'document_binding_pending'}
  const origin={id:'origem-demonstrativa-01',message_id:'mensagem-demonstrativa-01',attachment_id:'anexo-02',disposition:'pending',first_seen_at:from}
  const group={document_id:docA,original_name:'Documento demonstrativo01.pdf',received_at:from,group_status:'uncertain'}
  value.entries_without_document=[entry];value.entries_without_document_total=3;value.entries_without_document_has_more=true
  value.unresolved_origins=[origin,{...origin,id:'origem-demonstrativa-02',attachment_id:'anexo-03',disposition:'failed'}];value.unresolved_origin_total=4;value.unresolved_origins_has_more=true
  value.saved_without_group=[group,{document_id:docB,original_name:'Documento demonstrativo02.pdf',received_at:from,group_status:'pending',hold_reason:'changed_content_review'}];value.saved_without_group_total=2
  value.group_uncertain=[group];value.group_uncertain_total=1
  value.pending_alerts=[{id:'aviso-demonstrativo-01',status:'blocked',created_at:from},{id:'aviso-demonstrativo-02',status:'uncertain',created_at:from}];value.pending_alert_total=2
  value.version_holds=[{document_id:docB,original_name:'Documento demonstrativo02.pdf',reason:'changed_content_review',created_at:from}];value.version_hold_total=1
  value.incidents=[{id:'ocorrencia-demonstrativa',state:'open',code:'receipt_processing_overdue',last_seen_at:at}];value.incident_total=1
  value.receipts=[{id:'recibo-demonstrativo',document_id:docA,disposition:'saved',last_seen_at:at}];value.receipt_total=1
  for(const key of ['entries_without_document_total','unresolved_origin_total','saved_without_group_total','group_uncertain_total','pending_alert_total','version_hold_total'])value.summary[key]=value[key]
  value.summary.received_at_unknown_total=1
  value.historical.pre_cutoff_entries_without_document=[{...entry,message_id:'entrada-antiga-demonstrativa',received_at:'2026-10-10T12:00:00Z'}];value.historical.pre_cutoff_entries_without_document_total=1
  return value
}
