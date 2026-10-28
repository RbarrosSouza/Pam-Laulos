import {useQuery} from '@tanstack/react-query'
import {supabase} from '@/lib/supabase'
import {useExamAuth} from '@/contexts/exam-auth'
import {isExamFailures, type ExamFailuresCursor} from '@/components/intake/ExamFailuresView'

export const EXAM_FAILURES_PAGE_SIZE=20
export function useExamIntakeFailures(cursor:ExamFailuresCursor|null=null,refreshVersion=0){
  const auth=useExamAuth()
  return useQuery({queryKey:['exam-intake-exam-failures-v1',auth.session?.user.id,cursor?.age_from??null,cursor?.document_id??null,refreshVersion],enabled:!!auth.session&&!!auth.membership,staleTime:30_000,refetchInterval:30_000,queryFn:async()=>{
    const {data,error}=await supabase.rpc('get_exam_intake_exam_failures',{p_limit:EXAM_FAILURES_PAGE_SIZE,p_offset:0,p_after_age_from:cursor?.age_from??null,p_after_document_id:cursor?.document_id??null})
    if(error)throw error
    if(!isExamFailures(data))throw new Error('A resposta da lista de exames está incompleta')
    return data
  }})
}
