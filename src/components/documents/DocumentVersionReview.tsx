import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useExamAuth } from '@/contexts/exam-auth'
import { DocumentVersionReviewView, hasVersionReviewNotice, isVersionReviewData } from './DocumentVersionReviewView'

export function DocumentVersionReview({documentId}:{documentId:string}){
  const auth=useExamAuth()
  const review=useQuery({queryKey:['exam-intake-version-review',auth.session?.user.id,documentId],enabled:!!auth.membership&&!!auth.session,refetchInterval:15_000,queryFn:async()=>{
    const {data,error}=await supabase.rpc('get_exam_intake_version_review',{p_document_id:documentId})
    if(error)throw error
    if(!isVersionReviewData(data)||data.document_id!==documentId)throw new Error('Conferência dos originais incompleta')
    return data
  }})
  if(review.isPending)return null
  if(review.isError)return <section className="my-5 rounded-xl border p-4 text-sm"><p role="alert">Não foi possível consultar os originais e seus envios ao grupo.</p><button type="button" className="mt-2 underline" onClick={()=>void review.refetch()}>Atualizar situação dos originais</button></section>
  if(!review.data||!hasVersionReviewNotice(review.data))return null
  return <DocumentVersionReviewView data={review.data}/>
}
