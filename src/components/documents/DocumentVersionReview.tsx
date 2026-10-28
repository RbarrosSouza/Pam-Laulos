import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useExamAuth } from '@/contexts/exam-auth'
import { useDocumentAction } from '@/hooks/useExamDocuments'
import { buildVersionReviewSubmission, DocumentVersionReviewView, hasVersionReviewNotice, isVersionReviewData } from './DocumentVersionReviewView'
import type { VersionReviewDecision } from './DocumentVersionReviewView'

export function DocumentVersionReview({documentId,refresh}:{documentId:string;refresh:()=>Promise<unknown>}){
  const auth=useExamAuth(),client=useQueryClient(),action=useDocumentAction(),submitting=useRef(false)
  const [error,setError]=useState<string|null>(null),[completion,setCompletion]=useState<string|null>(null),[formRevision,setFormRevision]=useState(0)
  const review=useQuery({queryKey:['exam-intake-version-review',auth.session?.user.id,documentId],enabled:!!auth.membership&&!!auth.session,refetchInterval:15_000,queryFn:async()=>{
    const {data,error}=await supabase.rpc('get_exam_intake_version_review',{p_document_id:documentId})
    if(error)throw error
    if(!isVersionReviewData(data)||data.document_id!==documentId)throw new Error('Conferência da versão incompleta')
    return data
  }})
  const submit=async(decision:VersionReviewDecision)=>{
    if(!review.data||submitting.current||completion)return
    const args=buildVersionReviewSubmission(review.data,auth.role,decision,true)
    if(!args)return
    submitting.current=true;setError(null)
    try{
      const result=await action.mutateAsync({name:'release_exam_intake_hold',args})
      if(!result||result.document_id!==documentId||typeof result.hold_released!=='boolean')throw new Error('A decisão não foi confirmada. Atualize a conferência antes de tentar novamente.')
      setCompletion(result.hold_released?'Revisão registrada. O bloqueio desta versão foi liberado; os recibos anteriores foram preservados.':'Revisão inconclusiva registrada. O bloqueio da versão continua ativo.')
      void Promise.allSettled([review.refetch(),refresh(),client.invalidateQueries({queryKey:['intake-panel-v2']})])
    }catch(err){setError(err instanceof Error?err.message:'Não foi possível registrar a revisão. Atualize a conferência antes de tentar novamente.');void review.refetch()}
    finally{submitting.current=false}
  }
  if(review.isPending)return null
  if(review.isError)return <section className="my-5 rounded-xl border p-4 text-sm"><p role="alert">Não foi possível conferir se este exame possui uma atualização retida para revisão.</p><button type="button" className="mt-2 underline" onClick={()=>void review.refetch()}>Atualizar conferência de versões</button></section>
  if(!review.data||!hasVersionReviewNotice(review.data))return null
  const fingerprint=JSON.stringify([documentId,review.data.current.sha256,review.data.current.file_status,review.data.previous?.sha256,review.data.previous?.file_status,review.data.hold?.state,review.data.hold?.previous_document_id,review.data.review_allowed,review.data.can_link_previous,review.data.blocking_reason,auth.role,error,formRevision])
  return <DocumentVersionReviewView key={fingerprint} data={review.data} role={auth.role} saving={action.isPending} error={error} completion={completion} onSubmit={decision=>void submit(decision)} onRetry={()=>{void review.refetch().then(result=>{if(result.isSuccess){setCompletion(null);setError(null);setFormRevision(v=>v+1)}})}}/>
}
