import { useDeferredValue, useState } from 'react'
import { DocumentQueue } from '@/components/documents/DocumentQueue'
import { useExamDocuments, DOCUMENT_PAGE_SIZE } from '@/hooks/useExamDocuments'
import type { DocumentFilter } from '@/hooks/useExamDocuments'

export function NewExams() {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<DocumentFilter>('open')
  const [page, setPage] = useState(0)
  const query = useExamDocuments(useDeferredValue(search), filter, page)
  return <DocumentQueue
    documents={query.data?.documents || []} total={query.data?.count || 0}
    page={page} pageSize={DOCUMENT_PAGE_SIZE} loading={query.isLoading}
    error={query.error} refreshing={query.isFetching} search={search} filter={filter}
    onRefresh={() => { void query.refetch() }}
    onSearchChange={value => { setSearch(value); setPage(0) }}
    onFilterChange={value => { setFilter(value); setPage(0) }}
    onPageChange={setPage}
  />
}
